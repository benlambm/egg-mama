#!/usr/bin/env node
/*
 * Egg Mama — pace in the REAL loop: 1x speed, real touch swipes, 3+ minutes (run by hand; NOT `node --test`).
 *
 *   node tests/e2e/soak-pace.mjs [--seconds 230] [--lead 0.07] [--seed S] [--flock 3] [--shots]
 *
 *   --seconds N  stop after N game seconds even if the next landscape's flag has not been reached (default 230: all of Meadow, which
 *                lasts 220 s, and the crossing into Clover Mill). --seconds 90 is a short run.
 *   --lead S     fire each swipe this many seconds before the planned moment (default 0.07: the span between the CDP touchStart and the
 *                moment the drag passes the swipe threshold plus the page's own latency; the run prints the latency it actually got)
 *   --flock N    ducklings Mama starts with, so that one mistimed swipe on a loaded machine is a hit, not the end of the run (default 3)
 *
 * WHAT IT DOES: the Node planner bot (tests/bot.mjs; jump-only, the oracle of tests/levels.test.mjs) plans Meadow from the start flag to
 * the flag that opens Clover Mill and its actions are pinned to exact sim steps (tools/soak-driver.mjs). The page then runs that Meadow
 * at 1x in its ordinary rAF loop (iPhone 13 landscape 844x390 @3, the software rasteriser, adaptive dpr off) while this script sends
 * each action as a REAL touch swipe through the DevTools protocol (swipe up = jump) a few milliseconds ahead of its time. A recorder
 * in the page logs every rAF frame (wall clock, game seconds run, Mama's x, flag, landscape) and the moment each swipe reached the game.
 * The same actions are replayed headless in Node (the reference). Then:
 *   - game seconds advance at 1.00 s per wall second (whole run and every 30 s window): the fixed-step accumulator neither runs fast nor
 *     loses time on this machine;
 *   - Mama's x against the headless reference at the same game time, and against the ideal cruise line x0 + 110 (t - roll-in loss): the
 *     real loop covers 110 u/s;
 *   - the game time at which every flag, and the crossing into Clover Mill, happens, in the page and in the headless reference
 *     (chapter timing == headless sim) and against the designed 220 s;
 *   - the swipes: how many, all classified as jumps, and the latency from the planned moment to the moment the game got the action;
 *   - zero hits, zero falls, the flock untouched, no errors; frame pacing (gaps between rAF frames, share over 20 / 33 ms).
 */
import { chromium, startRepoServer, soakBoot, startPlaying, nodeLevel, parseArgs, reporter, swipe, shot, sleep, f1, pct, longTasks, playLevel, BOT_OPTS } from './soak-lib.mjs';
import { traceOf, resolveSteps, freshGame, replayTrace } from '../../tools/soak-driver.mjs';
import { ROLLIN_LOSS } from '../bot.mjs';
import { CHAPTERS, paceBand } from '../../docs/js/chapters.mjs';
import { T } from '../../docs/js/tuning.mjs';
import { step, drainEvents } from '../../docs/js/sim.mjs';

const args = parseArgs();
const SEED = args.seed ?? 20261123;
const MAX_SECONDS = args.seconds ?? 230;
const LEAD = args.lead ?? 0.07;
const FLOCK = args.flock ?? 3;
const t = reporter(`pace at 1x with real swipes (seed ${SEED}, lead ${LEAD * 1000} ms, up to ${MAX_SECONDS} game s)`);
const errors = [];

/** Swipes inside the play area (CSS px), away from the pause button. */
const UP = [{ x: 300, y: 330 }, { x: 300, y: 220 }];
// two moves of 55 px: the first one already passes the swipe threshold (31 px at this height), so the game gets the action one protocol
// round trip after the touch starts (a slower drag would add its own ~80 ms)
const doJump = (cdp) => swipe(cdp, UP[0], UP[1], { steps: 2, stepMs: 0 });

const { level } = nodeLevel(SEED, 1);
const stopFlag = level.chapters[1].flag;
const startX = level.checkpoints[0].x;

/* ───────── Node: plan Meadow, pin the steps, run the headless reference ───────── */
const tp = Date.now();
const plan = playLevel(level, { ...BOT_OPTS, startCheckpoint: 0, stopAtCheckpoint: stopFlag, tOffset: 0, trace: true, maxSeconds: 400 });
const rs = resolveSteps(level, 0, traceOf(plan), { phase: 0, stopCp: stopFlag });
console.log(`planner: Meadow ${plan.ok ? 'cleared' : 'FAILED'} in ${plan.t.toFixed(1)} game s with ${rs.steps.length} jumps (planned in ${((Date.now() - tp) / 1000).toFixed(1)} s, ${rs.unresolved} unresolved)`);
const ref = { x: [], flagTime: {}, enter: null };
{
  const g = freshGame(level, 0, { phase: 0 });
  let n = 0, cp = g.checkpoint, slot = g.slot;
  const out = replayTrace(g, rs.steps, {
    stopCp: stopFlag, maxSeconds: 400,
    stepOnce: (gg) => { step(gg, {}, T.step); drainEvents(gg); },
    onStep: (gg) => {
      if (++n % 6 === 0) ref.x.push(gg.mama.x);
      if (gg.checkpoint !== cp) { cp = gg.checkpoint; ref.flagTime[cp] = gg.stats.time; }
      if (gg.slot !== slot) { slot = gg.slot; ref.enter = gg.stats.time; }
    },
  });
  ref.end = out;
}
const refX = (time) => { const f = time / 0.05, i = Math.floor(f), a = ref.x[Math.min(ref.x.length - 1, Math.max(0, i - 1))], b = ref.x[Math.min(ref.x.length - 1, Math.max(0, i))]; return a + (b - a) * (f - i); };

/* ───────── the page ───────── */
const server = await startRepoServer();
const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
let failures = 1;
try {
  const { context, page, cdp } = await soakBoot(browser, server, { journeySeed: SEED, circuit: 1, errors, device: 'iphone13' });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlaying(page, cdp);                                    // a real tap on Continue
  await sleep(600);
  // a clean run from Meadow's first flag, started exactly like a fresh run (game.t = 0, ease-in); then the REAL loop takes over
  await page.evaluate(([flock, cap]) => {
    window.__drv.restartAt(0, { phase: 0, carry: { eggs: 0, score: 0, flock } });
    const e = window.__egg;
    e.setSpeed(1); e.resetPerf();
    window.__acts = [];
    const inp = e.input, orig = inp.onAction;
    inp.onAction = (a) => { window.__acts.push({ a, time: e.game().stats.time, wall: performance.now() }); return orig.call(inp, a); };
    const P = window.__pace = { n: 0, wall: new Float64Array(cap), time: new Float64Array(cap), x: new Float64Array(cap), cp: new Int16Array(cap), slot: new Int8Array(cap), status: [] };
    (function rec(now) {
      const g = e.game(), i = P.n;
      if (i < cap) { P.wall[i] = now; P.time[i] = g.stats.time; P.x[i] = g.mama.x; P.cp[i] = g.checkpoint; P.slot[i] = g.slot; P.n++; }
      window.__paceStatus = g.status;
      requestAnimationFrame(rec);
    })(performance.now());
  }, [FLOCK, 60 * (MAX_SECONDS + 60)]);
  const t0 = Date.now();

  /* ── send the swipes ── */
  const todo = rs.steps.map(([s, a]) => ({ rel: s * T.step, a }));
  let k = 0, sent = 0, lastLog = 0;
  for (;;) {
    const [time, status, cp] = await page.evaluate(() => { const g = window.__egg.game(); return [g.stats.time, g.status, g.checkpoint]; });
    if (status !== 'running') { console.log(`  run ended: status ${status} at ${time.toFixed(1)} s`); break; }
    if (cp >= stopFlag || time >= MAX_SECONDS) break;
    if (time - lastLog >= 30) { lastLog = time; const x = await page.evaluate(() => window.__egg.game().mama.x); console.log(`  ${time.toFixed(0).padStart(4)} game s  x ${Math.round(x)}  (${((Date.now() - t0) / 1000).toFixed(0)} s wall, ${sent} swipes sent)`); }
    if (k < todo.length && time >= todo[k].rel - LEAD - 0.012) {
      // close in on the exact moment with short polls, then send
      for (;;) {
        const tt = await page.evaluate(() => window.__egg.game().stats.time);
        if (tt >= todo[k].rel - LEAD) break;
        if (todo[k].rel - LEAD - tt > 0.02) await sleep(4);
      }
      await doJump(cdp);
      sent++; k++;
      continue;
    }
    await sleep(todo[k] && todo[k].rel - time < 0.5 ? 3 : 60);
  }
  await sleep(300);

  /* ── collect ── */
  const rec = await page.evaluate(() => {
    const P = window.__pace, n = P.n;
    return { n, wall: Array.from(P.wall.subarray(0, n)), time: Array.from(P.time.subarray(0, n)), x: Array.from(P.x.subarray(0, n)), cp: Array.from(P.cp.subarray(0, n)), slot: Array.from(P.slot.subarray(0, n)), acts: window.__acts, perf: window.__egg.perfStats(), state: window.__egg.state(), stats: { ...window.__egg.game().stats }, flock: window.__egg.game().flock };
  });
  const lt = await longTasks(page);
  const s = rec.state;
  await shot(page, 'soak-pace-end');

  /* ── analysis ── */
  const N = rec.n;
  const i0 = rec.time.findIndex((v) => v > 0.05), i1 = N - 1;
  const gameSec = rec.time[i1] - rec.time[i0], wallSec = (rec.wall[i1] - rec.wall[i0]) / 1000;
  const ratio = gameSec / wallSec;
  let worst = { lo: 9, hi: 0 };
  for (let a = i0; a < i1; ) {            // 30 s windows
    let b = a; while (b < i1 && rec.wall[b] - rec.wall[a] < 30000) b++;
    if (rec.wall[b] - rec.wall[a] >= 29000) { const r = (rec.time[b] - rec.time[a]) / ((rec.wall[b] - rec.wall[a]) / 1000); worst.lo = Math.min(worst.lo, r); worst.hi = Math.max(worst.hi, r); }
    a = b;
  }
  console.log(`\n== ${gameSec.toFixed(1)} game s in ${wallSec.toFixed(1)} s of wall time: ${ratio.toFixed(4)} game s per wall s (30 s windows ${worst.lo.toFixed(4)}..${worst.hi.toFixed(4)})`);
  t.ok(wallSec >= 180 || MAX_SECONDS < 190, `the run lasted ${wallSec.toFixed(0)} s of wall time (3+ minutes)`);
  t.ok(ratio > 0.985 && ratio < 1.015, `game time runs at 1.00x wall time (${ratio.toFixed(4)})`);
  t.ok(worst.lo > 0.97 && worst.hi < 1.03 || wallSec < 60, `and so does every 30 s window (${worst.lo.toFixed(3)}..${worst.hi.toFixed(3)})`);

  // position
  let maxDev = 0, sumDev = 0, nDev = 0, ideal = 0;
  for (let i = i0; i < N; i++) {
    if (rec.time[i] > ref.end.seconds) break;
    const d = rec.x[i] - refX(rec.time[i]);
    maxDev = Math.max(maxDev, Math.abs(d)); sumDev += Math.abs(d); nDev++;
  }
  const last = i1, tLast = rec.time[last], xLast = rec.x[last];
  ideal = startX + T.cruise * (tLast - ROLLIN_LOSS);
  console.log(`  at ${tLast.toFixed(1)} game s Mama is at x ${xLast.toFixed(0)}; the ideal 110 u/s line says ${ideal.toFixed(0)} (${(xLast - ideal).toFixed(1)} u); the headless reference ${refX(tLast).toFixed(0)}`);
  t.ok(Math.abs(xLast - ideal) < 60, `Mama's x is on the 110 u/s cruise line after ${tLast.toFixed(0)} game s (${(xLast - ideal).toFixed(1)} u off, a jump or a roll-in is worth a few units)`);
  t.ok(maxDev < 30 && sumDev / Math.max(1, nDev) < 8, `her x follows the headless sim at the same game time: max ${maxDev.toFixed(1)} u, mean ${(sumDev / Math.max(1, nDev)).toFixed(2)} u apart (the swipes arrive within a few ms of the planned moment)`);

  // flags and the crossing
  const pageFlag = {};
  for (let i = i0; i < N; i++) if (!(rec.cp[i] in pageFlag) && rec.cp[i] > 0) pageFlag[rec.cp[i]] = rec.time[i];
  let maxFlag = 0; const rows = [];
  for (const [c, tr] of Object.entries(ref.flagTime)) { if (pageFlag[c] === undefined) continue; const d = pageFlag[c] - tr; maxFlag = Math.max(maxFlag, Math.abs(d)); rows.push(`${c}:${d >= 0 ? '+' : ''}${(d * 1000).toFixed(0)}ms`); }
  console.log(`  flag times, page minus headless: ${rows.join(' ')}`);
  t.ok(Object.keys(ref.flagTime).every((c) => pageFlag[c] !== undefined) || rec.time[last] < ref.end.seconds - 2, `every flag the headless run crosses was crossed in the page (${Object.keys(pageFlag).length} flags)`);
  t.ok(maxFlag < 0.1, `each flag came within ${(maxFlag * 1000).toFixed(0)} ms (game time) of the headless sim's`);
  const enterRow = rec.slot.findIndex((v, i) => i >= i0 && v === 1);
  const pageEnter = enterRow >= 0 ? rec.time[enterRow] : null;
  const [lo, hi] = paceBand(0);
  console.log(`  crossing into Clover Mill: page ${pageEnter === null ? 'not reached' : pageEnter.toFixed(2) + ' s'}, headless ${ref.enter === null ? '-' : ref.enter.toFixed(2) + ' s'}, designed ${CHAPTERS[0].seconds} s (band ${lo}-${hi}), ideal ${((level.chapters[1].x0 - startX) / T.cruise + ROLLIN_LOSS).toFixed(2)} s`);
  if (MAX_SECONDS >= 225) {
    t.ok(pageEnter !== null && Math.abs(pageEnter - ref.enter) < 0.1 && pageEnter >= lo && pageEnter <= hi, `Meadow lasted ${pageEnter && pageEnter.toFixed(1)} game s in the real loop: the headless sim says ${ref.enter && ref.enter.toFixed(1)}, the design ${CHAPTERS[0].seconds} s +-10 %`);
    t.ok(s.audio.song === 'clover-mill' || s.audio.song === 'meadow', `the music followed (${s.audio.song})`);
  }

  // swipes
  const acts = rec.acts, lat = [];
  for (let i = 0; i < Math.min(acts.length, todo.length); i++) lat.push((acts[i].time - todo[i].rel) * 1000);
  console.log(`  swipes: ${sent} sent, ${acts.length} reached the game (${acts.filter((a) => a.a === 'jump').length} jumps); game-time latency vs plan p50 ${f1(pct(lat, 0.5))} ms, p95 ${f1(pct(lat, 0.95))}, min ${f1(Math.min(...lat))}, max ${f1(Math.max(...lat))}`);
  t.ok(acts.length === sent && acts.every((a) => a.a === 'jump'), `every real swipe up reached the game as exactly one jump (${acts.length} of ${sent})`);
  t.ok(lat.length && pct(lat, 0.5) > -40 && pct(lat, 0.95) < 60, `the swipes landed within a few frames of their planned moment (p50 ${f1(pct(lat, 0.5))} ms, p95 ${f1(pct(lat, 0.95))} ms)`);
  t.ok(s.errors === 0 && errors.length === 0, 'no errors', errors.slice(0, 3));
  t.ok(rec.stats.hits === 0 && rec.stats.falls === 0 && rec.state.status === 'running', `no hit, no fall: the real swipes cleared everything the planner cleared (hits ${rec.stats.hits}, falls ${rec.stats.falls}, flock ${rec.flock} from ${FLOCK} + hatched)`);
  // frame pacing
  const gaps = []; for (let i = Math.max(i0, 1); i < N; i++) gaps.push(rec.wall[i] - rec.wall[i - 1]);
  const over = (ms) => gaps.filter((g) => g > ms).length / gaps.length;
  console.log(`  frames: ${gaps.length}; rAF gap p50 ${f1(pct(gaps, 0.5))} ms, p95 ${f1(pct(gaps, 0.95))}, p99 ${f1(pct(gaps, 0.99))}, max ${f1(Math.max(...gaps))}; over 20 ms ${(100 * over(20)).toFixed(2)}%, over 33 ms ${(100 * over(33)).toFixed(2)}%; long tasks (>= 50 ms) ${lt.length}`);
  // where did the long tasks and the slow frames happen? (the recorder's clock is the page's performance clock, like the long task entries)
  const where = (w) => { let i = rec.wall.findIndex((v) => v >= w); if (i < 0) i = N - 1; return `game ${rec.time[i].toFixed(1)} s, x ${Math.round(rec.x[i])}, landscape ${rec.slot[i] + 1}, flag ${rec.cp[i]}`; };
  for (const l of lt) console.log(`    long task ${f1(l.d)} ms at ${where(l.s)}`);
  const slow = []; for (let i = Math.max(i0, 1); i < N; i++) if (rec.wall[i] - rec.wall[i - 1] > 25) slow.push(`${(rec.wall[i] - rec.wall[i - 1]).toFixed(0)} ms at ${where(rec.wall[i - 1])}`);
  if (slow.length) console.log(`    slow frames (> 25 ms): ${slow.slice(0, 12).join('; ')}`);
  t.ok(over(20) < 0.03 && pct(gaps, 0.95) < 18, `the loop held 60 fps (${(100 * over(20)).toFixed(2)}% of frames over 20 ms)`);
  failures = t.done();
  await context.close();
} catch (e) {
  console.error('\nUNCAUGHT:', e);
} finally {
  await browser.close();
  server.stop();
}
process.exitCode = failures ? 1 : 0;
