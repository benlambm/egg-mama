#!/usr/bin/env node
/*
 * Egg Mama — the circuit soak: the whole one-hour world, in the real page, landscape by landscape (run by hand; NOT `node --test`).
 *
 *   node tests/e2e/soak-circuit.mjs [--quick] [--landscapes N] [--seed S] [--no-frames] [--shots]
 *
 *   --quick        the first 3 landscapes (Meadow, Clover Mill, Reedwater; about 12 game minutes), the beacon is forced, then 2
 *                  landscapes of circuit 2: about 50 s of wall time. Without it: all 13 landscapes to the REAL beacon (58.9 game
 *                  minutes), Keep Going, 4 landscapes of circuit 2, reload, 13 Continue checks: about 2-2.5 minutes (the replay runs
 *                  ~500x faster than real time; the planner in Node needs about 30 s; each landscape then spends ~4 s on the frame sample).
 *   --landscapes N play only the first N landscapes before the beacon is forced (1..12; 13 = all)
 *   --seed S       journey seed (default 20261123)
 *   --no-frames    skip the per-landscape frame-cost sample (2.2 s of the real rAF loop + a 90-frame bench each)
 *   --shots        screenshots into $GAME_SHOTS (default <tmp>/egg-mama-shell; point it at your scratch directory, never at the repo)
 *
 * HOW: the Node planner bot (tests/bot.mjs, the oracle of tests/levels.test.mjs: jump-only) plays each landscape continuously from its
 * first flag to the next landscape's first flag; its traced actions are replayed on the page's REAL game object, one T.step at a time
 * through window.__egg.fastForward (so main.mjs's own event handling runs: checkpoint autosaves, chapter-enter -> song crossfade, the
 * beacon -> next-circuit save). If the bot ever dies the soak records the exact spot and carries on from the next flag (the "teleport
 * past it" of the brief). tools/soak-driver.mjs explains the replay; tests/e2e/soak-fairness.mjs proves page == headless to the digit.
 *
 * CHECKS, per landscape (real Chromium, iPhone 13 landscape 844x390 @3, software rasteriser, adaptive dpr OFF so cost is comparable):
 *   - exactly one 'chapter-enter' per crossing, every flag's 'checkpoint' event exactly once, zero hits / falls;
 *   - the landscape's song starts (audio.playSong log) once and in order; players stay <= 3, voices bounded;
 *   - the checkpoint autosave lands in localStorage (right circuit / chapter / flag / totals, playSeconds growing);
 *   - JS heap (after a forced GC, from the DevTools protocol), DOM nodes and JS event listeners: flat; sprite cache and decoded
 *     paintings: bounded;
 *   - no NaN or infinity in the sim state or the camera; no console or page error;
 *   - frame cost (real loop p50/p95 + a 90-frame bench with the rasteriser's read-back) does not grow with world x;
 *   - the game time of each landscape and of the whole circuit is inside the designed pace bands (chapters.mjs paceBand, T.journeyMinutes).
 * THEN: the beacon -> finish screen -> Keep Going (real touch): circuit 2 is generated (the world Node would make), totals are carried,
 * the fade returns, Meadow's song plays, she rolls; the first landscapes of circuit 2 are played too (the heap must plateau now that
 * every song is built); reload -> Continue resumes circuit 2 at its saved flag with the same totals; and the stored
 * save of every landscape is re-opened in a fresh browser context through the real Continue button (right landscape, right flag).
 *
 * Related: soak-fairness.mjs (100+ random segments, human noise), soak-pace.mjs (1x real time with real swipes), soak-perf.mjs
 * (frame cost, long tasks, CPU throttle), soak-audio.mjs (the audio lifecycle in the integrated build).
 */
import { chromium, startRepoServer, soakBoot, startPlaying, nodeLevel, memSample, parseArgs, reporter, tapSelector, shot, sleep, f1, playLevel, BOT_OPTS, longTasks } from './soak-lib.mjs';
import { traceOf, resolveSteps } from '../../tools/soak-driver.mjs';
import { CHAPTERS, paceBand } from '../../docs/js/chapters.mjs';
import { T } from '../../docs/js/tuning.mjs';
import { flagOf } from '../../docs/js/save.mjs';

const args = parseArgs();
const QUICK = !!args.quick;
const NL = Math.max(1, Math.min(13, args.landscapes ?? (QUICK ? 3 : 13)));       // landscapes played by the bot; 13 = to the real beacon
const TO_BEACON = NL >= 13;
const SEED = args.seed ?? 20261123;
const FRAMES = !args['no-frames'];
const SHOTS_ON = !!args.shots;

const t = reporter(`circuit soak (${QUICK ? 'quick' : 'full'}: ${TO_BEACON ? 'all 13 landscapes to the beacon' : NL + ' landscapes, then the beacon is forced'}), journey seed ${SEED}`);
const errors = [];
const log = (s) => console.log(s);

/* ───────────────────────── Node: plan a landscape ───────────────────────── */

/**
 * The planner plays landscape k from its first flag to the next landscape's first flag (the beacon for the last). Returns the parts
 * to replay: [{ from, to, trace, phase }] and the spots where the planner failed (skipped by restarting at the next flag).
 */
function planLandscape(level, k, phase) {
  const flagA = level.chapters[k].flag;
  const flagB = k + 1 < level.chapters.length ? level.chapters[k + 1].flag : null;
  const last = level.checkpoints.length - 1;
  const parts = [], fails = [];
  let from = flagA, guard = 0;
  while ((flagB === null ? from <= last : from < flagB) && guard++ < 40) {
    const res = playLevel(level, { ...BOT_OPTS, startCheckpoint: from, stopAtCheckpoint: flagB ?? undefined, tOffset: phase, trace: true, maxSeconds: 800 });
    if (res.ok) { parts.push({ from, to: flagB, trace: traceOf(res), phase, planner: { x: res.x, t: res.t } }); break; }
    // failure: replay up to the last flag before it, record it, carry on from the next flag
    let c = from;
    for (let i = from; i < level.checkpoints.length; i++) if (level.checkpoints[i].x <= res.x) c = i; else break;
    fails.push({ landscape: CHAPTERS[k].name, x: +res.x.toFixed(1), flagFrom: c, flagTo: c + 1, reason: res.reason });
    if (c > from) parts.push({ from, to: c, trace: traceOf(res), phase });
    from = c + 1;
    if (flagB !== null && from >= flagB) break;
  }
  return { parts, fails };
}

/* ───────────────────────── the soak ───────────────────────── */

const server = await startRepoServer();
const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
let failures = 1;
const rows = [];
const storedSaves = [];
const unfair = [];
try {
  const n1 = nodeLevel(SEED, 1);
  const level = n1.level;
  log(`Node: circuit 1 of journey ${SEED}: ${level.platforms.length} platforms, ${level.pickups.length} pickups, ${level.checkpoints.length} flags, ${Math.round(level.endX)} u, generated in ${f1(n1.genMs)} ms, fingerprint ${n1.fp}`);

  const { context, page, cdp } = await soakBoot(browser, server, { journeySeed: SEED, circuit: 1, errors, device: 'iphone13' });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  const pageFp = await page.evaluate(() => ({ fp: window.__drv.levelFingerprint(window.__egg.level()), genMs: window.__egg.state().genMs }));
  t.ok(pageFp.fp === n1.fp, `the page builds the same world as Node (fingerprint ${pageFp.fp}); the page needed ${f1(pageFp.genMs)} ms to generate it`);

  await startPlaying(page, cdp);                                         // a REAL touch on Play: audio is unlocked, the real run begins
  // spy on the music: every playSong request, with what was playing before it
  await page.evaluate(() => {
    const a = window.__egg.audio, orig = a.playSong.bind(a);
    window.__songLog = [];
    a.playSong = (id, opts) => { window.__songLog.push({ id, fade: opts && opts.fade, prev: a._songId, x: Math.round(window.__egg.game().mama.x) }); return orig(id, opts); };
  });
  const base = await memSample(cdp);
  log(`baseline after Play: heap ${base.heapMB} MB, ${base.nodes} DOM nodes, ${base.listeners} JS event listeners`);
  const t00 = Date.now();

  /** Play landscapes `ks` of circuit `circuitNo` (replayed planner traces), checking everything per landscape. */
  async function playLandscapes(level, circuitNo, ks) {
    const rows = [];
    let totalSeconds = 0;
    for (const k of ks) {
      const name = CHAPTERS[k].name, tagC = circuitNo > 1 ? ` (circuit ${circuitNo})` : '';
      const tp = Date.now();
      const phase = (k * 0.7) % 11;
      const plan = planLandscape(level, k, phase);
      for (const f of plan.fails) { unfair.push({ seed: SEED, circuit: circuitNo, ...f }); log(`  !! planner failed at x ${f.x} (${f.landscape}, flags ${f.flagFrom}->${f.flagTo}, ${f.reason}); the soak carries on from the next flag`); }
      const planMs = Date.now() - tp;

      const row = { k, name, flags: 0, seconds: 0, wallMs: 0, planMs, steps: 0, events: {}, hits: 0, falls: 0, problems: [], reasons: [] };
      const songLogBefore = await page.evaluate(() => window.__songLog.length);
      const ltBefore = (await longTasks(page)).length;
      row.unresolved = 0; row.exact = 0; row.parts = plan.parts.length;
      for (const part of plan.parts) {
        const tr = Date.now();
        const rs = resolveSteps(level, part.from, part.trace, { phase: part.phase, stopCp: part.to });
        row.unresolved += rs.unresolved;
        const r = await page.evaluate(([flag, actions, stop, ph]) => {
          const d = window.__drv;
          const g = d.restartAt(flag, { phase: ph });
          const problems = [];
          let n = 0;
          const res = d.replayInPage(actions, { stopCp: stop, maxSeconds: 900, onStep: (gg) => { if (++n % 600 === 0) { const p = d.scanSim(gg, null); if (p.length) problems.push(...p.slice(0, 3)); } } });
          const p = d.scanSim(window.__egg.game(), null); if (p.length) problems.push(...p.slice(0, 3));
          res.problems = problems;
          return res;
        }, [part.from, rs.steps, part.to, part.phase]);
        if (part.planner && Math.abs(r.x - part.planner.x) < 1e-3 && Math.abs(r.seconds - part.planner.t) < 1e-6) row.exact++;
        row.wallMs += Date.now() - tr;
        row.seconds += r.seconds; row.steps += r.steps; row.hits += r.hits; row.falls += r.falls; row.problems.push(...r.problems); row.reasons.push(r.reason);
        for (const e in r.events) row.events[e] = (row.events[e] || 0) + r.events[e];
        row.flags += r.events.checkpoint || 0;
        row.last = r;
      }
      totalSeconds += row.seconds;
      // ── this landscape's bookkeeping ──
      const st = await page.evaluate(() => { window.__egg.flushSave(); return window.__egg.state(); });
      const songs = await page.evaluate((n) => window.__songLog.slice(n), songLogBefore);
      const starts = songs.filter((s) => s.id !== s.prev).map((s) => s.id);
      const cache = await page.evaluate(() => window.__drv.cacheStats(window.__egg.renderer));
      const mem = await memSample(cdp);
      Object.assign(row, { st, songs: starts, cache, mem });
      if (circuitNo === 1) storedSaves.push(st.stored ? JSON.stringify(st.stored) : null);

      // frame cost with the real loop and a still-frame bench (Mama stands at the next landscape's first flag, on safe ground)
      if (FRAMES) {
        await sleep(1500);                                                 // sprites and the painting of the new landscape bake in the first frames
        await page.evaluate(() => window.__egg.resetPerf());
        const lt0 = (await longTasks(page)).length;
        await sleep(2200);
        row.measuredIn = CHAPTERS[(await page.evaluate(() => window.__egg.state().chapter))].name;
        row.loop = await page.evaluate(() => window.__egg.perfStats());
        row.ltLoop = (await longTasks(page)).slice(lt0).length;
        row.bench = await page.evaluate(() => window.__egg.bench(90, { advance: false }));
        row.camera = await page.evaluate(() => ({ x: window.__egg.renderer.camera.x, y: window.__egg.renderer.camera.y, problems: window.__drv.scanSim(window.__egg.game(), window.__egg.renderer) }));
        row.problems.push(...row.camera.problems);
      }
      row.lt = (await longTasks(page)).slice(ltBefore);
      rows.push(row);
      if (SHOTS_ON && circuitNo === 1 && (k === 0 || k === 5 || k === 8 || k === 12)) await shot(page, `soak-circuit-${k}`);

      // ── per-landscape assertions ──
      const lastLand = k === 12;
      const flagA = level.chapters[k].flag, flagB = lastLand ? level.checkpoints.length - 1 : level.chapters[k + 1].flag;
      const expectEnter = lastLand ? 0 : 1;
      if (plan.fails.length === 0) {
        t.ok((row.events['chapter-enter'] || 0) === expectEnter, `${String(k + 1).padStart(2)} ${name}: the crossing into the next landscape fired exactly ${expectEnter} chapter-enter (${row.events['chapter-enter'] || 0})`);
        t.ok(row.flags === flagB - flagA, `${name}: every flag fired its checkpoint event exactly once (${row.flags} of ${flagB - flagA})`);
        t.ok(row.hits === 0 && row.falls === 0, `${name}: the bot got through with zero hits and zero falls (${row.seconds.toFixed(1)} game s in ${(row.wallMs / 1000).toFixed(1)} s wall)`);
        t.ok(row.exact === row.parts && row.unresolved === 0, `${name}: the page ended exactly where the Node planner ended (same x and game time; ${row.unresolved} unresolved actions)`);
      }
      if (!lastLand) {
        const want = CHAPTERS[k + 1].song;
        t.ok(starts.length >= 1 && starts[starts.length - 1] === want && starts.filter((s) => s === want).length === 1, `${name}: the ${want} song started once at the crossing (starts ${JSON.stringify(starts)}; playing ${st.audio.song}; players ${st.audio.players})`);
        const f = flagOf(level, flagB);
        const sv = st.stored;
        t.ok(sv && sv.circuit === circuitNo && sv.chapter === f.chapter && sv.flag === f.flag && sv.eggs === st.eggs && sv.score === st.score && sv.flock === st.flock, `${name}${tagC}: the autosave in localStorage is chapter ${f.chapter} flag ${f.flag} with the totals (${sv && sv.eggs} eggs, ${sv && sv.score} pts, flock ${sv && sv.flock})`, { sv, eggs: st.eggs, score: st.score, flock: st.flock });
      }
      t.ok(row.problems.length === 0, `${name}: no NaN or infinity in the sim or camera`, row.problems.slice(0, 3));
      t.ok(st.audio.players <= 3 && st.audio.voices <= 150, `${name}: audio players ${st.audio.players} and voices ${st.audio.voices} stay bounded`);
      t.ok(st.errors === 0 && !st.crashed, `${name}: the game logged no errors`);
      log(`     heap ${mem.heapMB} MB, nodes ${mem.nodes}, listeners ${mem.listeners}, sprites ${cache.sprites} (${cache.spriteMB} MB), paintings ${cache.decoded}, eggs ${st.eggs}, flock ${st.flock}, saved ${st.stored ? st.stored.chapter + ':' + st.stored.flag : '-'}${FRAMES ? `; frame in ${row.measuredIn} p50/p95 ${f1(row.bench.withRaster.p50)}/${f1(row.bench.withRaster.p95)} ms (bench), loop gap ${row.loop.gapP50}/${row.loop.gapP95} ms` : ''}`);
    }
    return { rows, totalSeconds };
  }

  const { rows: rows1, totalSeconds } = await playLandscapes(level, 1, Array.from({ length: NL }, (_, i) => i));
  rows.push(...rows1);

  /* ───────── across landscapes ───────── */
  log('\n== across the circuit');
  const first = rows.length > 2 ? rows[1] : rows[0];
  const heap = rows.map((r) => r.mem.heapMB), nodes = rows.map((r) => r.mem.nodes), lis = rows.map((r) => r.mem.listeners);
  const grow = rows[rows.length - 1].mem.heapMB - first.mem.heapMB;
  log(`  heap after GC per landscape (MB): ${heap.join(' ')}`);
  log(`  DOM nodes: ${nodes.join(' ')}   JS event listeners: ${lis.join(' ')}`);
  log(`  sprite cache entries: ${rows.map((r) => r.cache.sprites).join(' ')}   decoded paintings: ${rows.map((r) => r.cache.decoded).join(' ')}`);
  t.ok(grow < 6, `the JS heap is flat after warm-up (${first.mem.heapMB} MB after landscape ${first.k + 1} -> ${rows[rows.length - 1].mem.heapMB} MB after landscape ${rows.length}: ${grow >= 0 ? '+' : ''}${grow.toFixed(1)} MB over ${rows.length - first.k - 1} landscapes)`);
  t.ok(Math.max(...heap) - Math.min(...heap) < 14, `the heap never strays far (range ${Math.min(...heap)}..${Math.max(...heap)} MB after GC)`);
  t.ok(Math.max(...nodes) - Math.min(...nodes) <= 12, `live DOM nodes stay constant (${Math.min(...nodes)}..${Math.max(...nodes)})`);
  t.ok(Math.max(...lis) - Math.min(...lis) <= 4, `JS event listeners stay constant (${Math.min(...lis)}..${Math.max(...lis)})`);
  t.ok(rows.every((r) => r.cache.decoded <= 4), `at most ${Math.max(...rows.map((r) => r.cache.decoded))} decoded paintings are ever held`);
  const sp = rows.map((r) => r.cache.sprites);
  t.ok(Math.max(...sp) < 1200 && sp[sp.length - 1] <= Math.max(...sp.slice(0, -1), 0) * 1.35 + 40, `the sprite cache is bounded (${Math.min(...sp)}..${Math.max(...sp)} entries, ${Math.max(...rows.map((r) => r.cache.spriteMB))} MB at most)`);
  const sec = rows.map((r) => r.seconds);
  log(`  game seconds per landscape: ${sec.map((s, i) => `${CHAPTERS[i].name} ${s.toFixed(0)}`).join(', ')}`);
  for (const r of rows) {
    const [lo, hi] = paceBand(r.k);
    t.ok(r.seconds >= lo - 1 && r.seconds <= hi + 1, `${r.name}: ${r.seconds.toFixed(0)} game s from flag to the next landscape's flag, designed ${CHAPTERS[r.k].seconds} s (band ${lo}-${hi})`);
  }
  if (FRAMES) {
    const p50 = rows.map((r) => r.bench.withRaster.p50), p95 = rows.map((r) => r.bench.withRaster.p95), sc = rows.map((r) => r.bench.stats.scanned);
    log(`  measured in:                  ${rows.map((r) => r.measuredIn).join(', ')}`);
    log(`  bench p50 per landscape (ms): ${p50.map(f1).join(' ')}`);
    log(`  bench p95 per landscape (ms): ${p95.map(f1).join(' ')}   items scanned per frame: ${sc.join(' ')}`);
    log(`  real loop frame-to-frame p50/p95 (ms): ${rows.map((r) => `${r.loop.gapP50}/${r.loop.gapP95}`).join('  ')}`);
    const half = Math.max(1, Math.floor(rows.length / 2));
    const early = Math.max(...p95.slice(0, half)), late = Math.max(...p95.slice(half));
    t.ok(late <= early * 1.4 + 1.5 || rows.length < 4, `frame cost does not grow with world x: worst p95 in the later landscapes ${f1(late)} ms vs ${f1(early)} ms in the earlier ones`);
    t.ok(Math.max(...sc) <= 400, `the renderer scans a constant handful of items per frame whatever x is (${Math.min(...sc)}..${Math.max(...sc)}; the world holds ${level.platforms.length + level.pickups.length} platforms and pickups)`);
    t.ok(rows.every((r) => r.loop.gapP95 < 34), `the real rAF loop holds ~60 fps at x up to ${Math.round(rows[rows.length - 1].st.mama.x)} (worst p95 ${Math.max(...rows.map((r) => r.loop.gapP95))} ms)`);
  }
  const ltAll = rows.reduce((a, r) => a + (r.ltLoop || 0), 0);
  log(`  long tasks (>= 50 ms) during the ${rows.length} real-loop samples: ${ltAll}`);

  /* ───────── to the beacon, finish, Keep Going ───────── */
  log('\n== the beacon, the finish screen and Keep Going');
  let preFinish;
  if (TO_BEACON) {
    const st = await page.evaluate(() => window.__egg.state());
    t.ok(st.status === 'beacon' || st.status === 'running', `the bot reached the beacon (status ${st.status}, x ${Math.round(st.mama.x)}, beacon at ${Math.round(level.beacon.x)})`);
  } else {
    await page.evaluate(() => window.__drv.restartAt(window.__egg.level().checkpoints.length - 1));       // the last flag, then the real loop rolls her to the beacon
    t.ok(await page.evaluate(() => window.__egg.forceBeacon()), 'forceBeacon: Mama is put 70 u before the beacon (the real loop does the rest)');
  }
  const ltFinish0 = (await longTasks(page)).length;
  await page.waitForFunction(() => window.__egg.state().status === 'beacon', null, { timeout: 15000, polling: 50 });
  const sBeacon = await page.evaluate(() => window.__egg.state());
  const sv0 = sBeacon.stored;
  t.ok(sv0 && sv0.circuit === 2 && sv0.chapter === 0 && sv0.flag === 0 && sv0.beacons >= 1, `the lit beacon saved circuit 2's Meadow at once (circuit ${sv0 && sv0.circuit}, chapter ${sv0 && sv0.chapter}, beacons ${sv0 && sv0.beacons})`, sv0);
  const songEnd = await page.evaluate(() => window.__songLog.slice(-3));
  t.ok(sBeacon.audio.song === 'beacon', `the beacon song plays (${sBeacon.audio.song})`, songEnd);
  await page.waitForFunction(() => window.__egg.state().ui === 'finish', null, { timeout: 15000, polling: 100 });
  await sleep(700);
  preFinish = await page.evaluate(() => window.__egg.state());
  const finishText = await page.evaluate(() => document.querySelector('[data-screen=finish]').innerText.replace(/\s+/g, ' '));
  t.ok(finishText.replace(/,/g, '').includes(String(preFinish.eggs)), `the finish screen names the recovered eggs (${preFinish.eggs}): "${finishText.slice(0, 120)}"`);
  if (SHOTS_ON) await shot(page, 'soak-circuit-finish');
  const memFinish = await memSample(cdp);
  const level1Fp = await page.evaluate(() => window.__drv.levelFingerprint(window.__egg.level()));
  const n2 = nodeLevel(SEED, 2);
  await tapSelector(page, cdp, '[data-screen=finish] [data-action=keep-going]');
  await page.waitForFunction(() => { const s = window.__egg.state(); return s.mode === 'playing' && s.circuit === 2; }, null, { timeout: 20000, polling: 50 });
  await sleep(1500);
  const s2 = await page.evaluate(() => window.__egg.state());
  const fp2 = await page.evaluate(() => window.__drv.levelFingerprint(window.__egg.level()));
  t.ok(s2.circuit === 2 && fp2 === n2.fp && fp2 !== level1Fp, `Keep Going opened circuit 2 with fresh terrain: the world Node makes for it (fingerprint ${fp2}, was ${level1Fp}); generating it took ${f1(s2.genMs)} ms in the page`);
  t.ok(s2.eggs >= preFinish.eggs && s2.eggs - preFinish.eggs <= 25 && s2.score >= preFinish.score && s2.flock >= preFinish.flock, `the totals were carried (eggs ${preFinish.eggs} -> ${s2.eggs} after ~2 s of circuit 2, flock ${preFinish.flock} -> ${s2.flock}; the save itself holds exactly ${s2.stored && s2.stored.eggs})`);
  t.ok(s2.fade === 0 && s2.status === 'running' && s2.renderMode === 'play', `the fade came back and she is rolling in play mode (fade ${s2.fade}, ${s2.status})`);
  t.ok(s2.chapter === 0 && s2.checkpoint === 0 && s2.audio.song === 'meadow', `it is Meadow again with the Meadow song (landscape ${s2.chapter + 1}, flag ${s2.checkpoint}, ${s2.audio.song})`);
  t.ok(s2.stored && s2.stored.circuit === 2 && s2.stored.chapter === 0 && s2.stored.flag === 0 && s2.stored.eggs === preFinish.eggs, 'the save says circuit 2, Meadow, with the totals', s2.stored);
  const ltFinish = (await longTasks(page)).slice(ltFinish0);
  log(`  long tasks (>= 50 ms) from the beacon to Mama rolling in circuit 2: ${ltFinish.length}${ltFinish.length ? ' [' + ltFinish.map((l) => f1(l.d) + ' ms').join(', ') + ']' : ''} (circuit 2 was generated in ${f1(s2.genMs)} ms, on the static finish screen)`);
  t.ok(ltFinish.length <= 6 && ltFinish.every((l) => l.d < 400), `the beacon -> finish -> Keep Going hand-over costs at most a few short hitches, none over 400 ms (${ltFinish.map((l) => f1(l.d)).join(', ') || 'none'})`);
  const x2a = s2.mama.x; await sleep(800);
  t.ok((await page.evaluate(() => window.__egg.state().mama.x)) > x2a + 40, 'and she rolls on by herself');
  if (SHOTS_ON) await shot(page, 'soak-circuit-circuit2');
  const mem2 = await memSample(cdp);
  log(`  heap: ${memFinish.heapMB} MB at the finish screen -> ${mem2.heapMB} MB in circuit 2 (two worlds resident); nodes ${mem2.nodes}, listeners ${mem2.listeners}`);
  t.ok(mem2.heapMB - memFinish.heapMB < 20, `a second world is cheap enough (${f1(mem2.heapMB - memFinish.heapMB)} MB)`);
  // the menu screens are built the first time they are shown and then kept (finish adds ~170 nodes once): what must hold is "no growth after that"
  t.ok(mem2.nodes - memFinish.nodes <= 12 && mem2.listeners - memFinish.listeners <= 4, `DOM nodes and listeners did not grow with Keep Going (finish screen ${memFinish.nodes}/${memFinish.listeners} -> circuit 2 ${mem2.nodes}/${mem2.listeners}; they were ${base.nodes}/${base.listeners} before any menu had been opened)`);

  // circuit 2, fresh terrain: its first landscapes again. Every song and sprite family is warm by now, so the heap must PLATEAU
  // (the steady climb through circuit 1 was each landscape's song being built for the first time)
  const N2 = QUICK ? 2 : 4;
  log(`\n== circuit 2: the first ${N2} landscapes of the new world`);
  const { rows: rows2 } = await playLandscapes(n2.level, 2, Array.from({ length: N2 }, (_, i) => i));
  const h2 = rows2.map((r) => r.mem.heapMB);
  log(`  heap after GC per landscape (MB): ${h2.join(' ')}   (circuit 1 ended at ${rows[rows.length - 1].mem.heapMB} MB, circuit 2 began at ${mem2.heapMB} MB)`);
  t.ok(Math.max(...h2) - mem2.heapMB < 2.5, `second time round the heap is flat: it does not climb through ${N2} landscapes of circuit 2 (${mem2.heapMB} -> ${h2.join(' -> ')} MB)`);
  t.ok(rows2.every((r) => Math.abs(r.mem.nodes - mem2.nodes) <= 12 && Math.abs(r.mem.listeners - mem2.listeners) <= 4), `DOM nodes and listeners stay constant in circuit 2 (${rows2.map((r) => r.mem.nodes + '/' + r.mem.listeners).join(', ')})`);

  // circuit 2: reload -> Continue resumes wherever the soak had got to
  const svR = await page.evaluate(() => { window.__egg.flushSave(); return window.__egg.state().stored; });
  const wantFlagR = n2.level.chapters[svR.chapter].flag + svR.flag;
  await page.reload();
  await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 45000 });
  await sleep(500);
  const titleTxt = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
  t.ok(/Continue/.test(titleTxt) && /circuit 2/i.test(titleTxt), `after a reload the title offers Continue for circuit 2: "${titleTxt.slice(Math.max(0, titleTxt.indexOf('Continue')), titleTxt.indexOf('Continue') + 70)}"`);
  await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]');
  await page.waitForFunction(() => window.__egg.state().mode === 'playing', null, { timeout: 15000 });
  const s3 = await page.evaluate(() => window.__egg.state());
  t.ok(s3.circuit === 2 && s3.chapter === svR.chapter && s3.checkpoint === wantFlagR && s3.eggs === svR.eggs && s3.flock === Math.min(5, svR.flock), `Continue after a reload resumes circuit 2 at its saved flag (landscape ${s3.chapter + 1}, flag ${s3.checkpoint}; ${s3.eggs} eggs, flock ${s3.flock})`, { s3: { c: s3.circuit, ch: s3.chapter, cp: s3.checkpoint, eggs: s3.eggs }, svR, wantFlagR });

  // menu churn with real taps: open the pause menu and resume six times; nothing may pile up
  const chBefore = await memSample(cdp);
  for (let i = 0; i < 6; i++) {
    await tapSelector(page, cdp, '#pause-btn');
    await page.waitForFunction(() => window.__egg.state().ui === 'pause', null, { timeout: 5000, polling: 50 });
    await sleep(450);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
    await page.waitForFunction(() => window.__egg.state().mode === 'playing', null, { timeout: 5000, polling: 50 });
    await sleep(300);
  }
  const chAfter = await memSample(cdp);
  const pauseNodes = chAfter.nodes - s3.nodes;
  t.ok(chAfter.listeners - chBefore.listeners <= 1 && chAfter.nodes - chBefore.nodes <= 260 && chAfter.heapMB - chBefore.heapMB < 3, `pause/resume x6 with real taps leaves nothing behind (nodes ${chBefore.nodes} -> ${chAfter.nodes} incl. the pause menu built once, listeners ${chBefore.listeners} -> ${chAfter.listeners}, heap ${chBefore.heapMB} -> ${chAfter.heapMB} MB)`);
  void pauseNodes;
  const w = await page.evaluate(() => window.__egg.state());
  t.ok(w.audio.players === 1 && w.audio.scheduler === true && w.errors === 0, `after the pause cycles there is one music player and the loop is healthy (players ${w.audio.players}, errors ${w.errors})`);

  log(`\n  total: ${(totalSeconds / 60).toFixed(1)} game minutes in ${((Date.now() - t00) / 1000).toFixed(0)} s of wall time`);
  if (TO_BEACON) {
    const [a, b] = T.journeyMinutes;
    t.ok(totalSeconds / 60 >= a && totalSeconds / 60 <= b, `the whole circuit took ${(totalSeconds / 60).toFixed(1)} game minutes (designed ${a}-${b})`);
    t.ok(sBeacon.playSeconds > 3000, `the save counted ${Math.round(sBeacon.playSeconds)} s played`);
  }
  t.ok(unfair.length === 0, `no unwinnable spot met along the way${unfair.length ? ': ' + JSON.stringify(unfair) : ''}`);
  t.ok(errors.length === 0, 'no console or page errors in the whole soak', errors.slice(0, 4));
  await context.close();

  /* ───────── every landscape's stored save, re-opened through the real Continue button ───────── */
  log('\n== Continue from each stored save, in a fresh browser context');
  const picks = QUICK ? storedSaves.map((s, i) => [s, i]).filter(([s, i]) => s && (i === 0 || i === storedSaves.length - 1)) : storedSaves.map((s, i) => [s, i]).filter(([s]) => s);
  for (const [raw, i] of picks) {
    const sv = JSON.parse(raw);
    const { context: c2, page: p2, cdp: d2 } = await soakBoot(browser, server, { errors, driver: false, init: `try { if (!localStorage.getItem('egg-mama-save-v2')) localStorage.setItem('egg-mama-save-v2', ${JSON.stringify(raw)}); } catch (e) {}` });
    try {
      const txt = await p2.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
      await startPlaying(p2, d2, { action: 'continue' });
      const s = await p2.evaluate(() => window.__egg.state());
      const lvl = await p2.evaluate(() => { const l = window.__egg.level(); return { cps: l.checkpoints.map((c) => c.x), chap: l.chapters.map((c) => c.flag) }; });
      const wantFlag = lvl.chap[sv.chapter] + sv.flag, wantX = lvl.cps[wantFlag];
      t.ok(s.circuit === sv.circuit && s.chapter === sv.chapter && s.checkpoint === wantFlag && Math.abs(s.mama.x - wantX) < 40 && s.eggs >= sv.eggs && s.eggs - sv.eggs <= 4 && s.score >= sv.score && s.score - sv.score <= 50 && s.flock === Math.min(5, sv.flock) && s.status === 'running',
        `Continue from the save after ${CHAPTERS[i].name} (${CHAPTERS[Math.min(12, sv.chapter)].name}, flag ${wantFlag}): landscape ${s.chapter + 1}, flag ${s.checkpoint}, x ${Math.round(s.mama.x)} (flag at ${Math.round(wantX)}), ${s.eggs} eggs; the title said "${txt.slice(Math.max(0, txt.indexOf('Continue')), txt.indexOf('Continue') + 50)}"`, { s: { circuit: s.circuit, chapter: s.chapter, checkpoint: s.checkpoint, x: s.mama.x, eggs: s.eggs }, sv });
    } finally { await c2.close(); }
  }
  t.ok(errors.length === 0, 'no console or page errors after the Continue checks', errors.slice(0, 4));
  failures = t.done();
} catch (e) {
  console.error('\nUNCAUGHT:', e);
} finally {
  await browser.close();
  server.stop();
}
process.exitCode = failures ? 1 : 0;
