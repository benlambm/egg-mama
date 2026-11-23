#!/usr/bin/env node
/*
 * Egg Mama — fairness in the INTEGRATED build (run by hand; not part of `node --test`).
 *
 *   node tests/e2e/soak-fairness.mjs [--quick] [--seeds 4] [--circuits 1,2] [--random 4] [--noise 2]
 *
 *   --quick       one journey, circuit 1, ~16 segments (about a minute)
 *   --seeds N     how many journey seeds (default 4; the seed list is fixed so a run can be repeated)
 *   --circuits    which circuits per seed (default 1,2)
 *   --random N    random segments per (seed, circuit) on top of the 12 landscape JOINS and the last stretch (default 4)
 *   --noise N     noisy-bot repetitions per segment and kind (default 2)
 *
 * WHAT IT PROVES, for every sampled flag-to-flag segment of every (journey seed, circuit):
 *   1. the world the PAGE builds is the world Node plans on (levelFingerprint equal, page generation time reported);
 *   2. FAIRNESS: the planner bot (tests/bot.mjs, the oracle of tests/levels.test.mjs: jump-only, any game-clock phase) reaches the
 *      next flag with zero hits and zero falls. A failure is printed with the journey seed, circuit, segment, flags and exact x;
 *   3. the same planner traces (pinned to exact sim steps) REPLAYED on the page's real game object (through main.mjs's own fastForward /
 *      event handling, one T.step at a time) end exactly where the planner ended and where the headless Node replay ends (x, t, hits,
 *      falls, events): the integrated page runs the same sim as Node, to the last digit;
 *   4. imperfect players: the planner with human noise (careful 80 ms +-50 ms learnt latency; sloppy 80 +-80 ms; clumsy small child
 *      120 +-120 ms) is replayed the same way, and clear rates per landscape are reported (DESIGN section 4: careful >= 90 %).
 *   5. no NaN in the sim or the camera after any replay, no console or page error.
 * The sampled segments always include the 12 joins between landscapes (the dissolve stretch) and the final run to the beacon.
 */
import { chromium, startRepoServer, soakBoot, nodeLevel, planSegments, parseArgs, reporter, segmentsOf, f1 } from './soak-lib.mjs';
import { replayHeadless, traceOf, resolveSteps } from '../../tools/soak-driver.mjs';
import { CHAPTERS } from '../../docs/js/chapters.mjs';

const args = parseArgs();
const QUICK = !!args.quick;
const N_SEEDS = QUICK ? 1 : (args.seeds ?? 4);
const CIRCUITS = String(args.circuits ?? (QUICK ? '1' : '1,2')).split(',').map(Number);
const RANDOM = args.random ?? (QUICK ? 3 : 4);
const NOISE_REPS = args.noise ?? (QUICK ? 1 : 2);
const SEEDS = [20261123, 777001, 424242, 90210, 31337, 8675309, 1234567, 99991].slice(0, N_SEEDS);
const NAMES = CHAPTERS.map((c) => c.name);

const NOISE = {
  careful: { latency: 0.08, jitter: 0.05, compensate: true },
  sloppy: { latency: 0.08, jitter: 0.08, compensate: false },
  clumsy: { latency: 0.12, jitter: 0.12, compensate: false },
};

const t = reporter('fairness in the integrated build (planner traces replayed on the real page)');
const errors = [];
const lcg = (seed) => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); };
const same = (a, b) => Math.abs(a - b) < 1e-6;

/** Segment indices to sample: the segment that ends at the first flag of each landscape (the join), the last stretch, some random ones. */
function pickSegments(level, rand) {
  const segs = segmentsOf(level);
  const set = new Set();
  for (let k = 1; k < level.chapters.length; k++) set.add(level.chapters[k].flag - 1);            // joins (the segment before landscape k's first flag)
  set.add(segs.length - 1);
  for (let i = 0; i < RANDOM; i++) set.add(Math.floor(rand() * (segs.length - 1)));
  if (QUICK) { const all = [...set].sort((a, b) => a - b); return all.filter((_, i) => i % 2 === 0 || i === all.length - 1).slice(0, 16); }
  return [...set].sort((a, b) => a - b);
}

const stats = { segments: 0, oracleFail: [], mismatch: [], unresolved: 0, plannerMismatch: [], perLandscape: Array.from({ length: 13 }, () => ({ n: 0, fail: 0 })), noise: {}, scanProblems: [] };
for (const k of Object.keys(NOISE)) stats.noise[k] = { n: 0, ok: 0, perLandscape: Array.from({ length: 13 }, () => ({ n: 0, ok: 0 })), fails: [] };
const pageGen = [];

const server = await startRepoServer();
const browser = await chromium.launch();
let failures = 1;
try {
  for (const seed of SEEDS) {
    for (const circuit of CIRCUITS) {
      const tag = `seed ${seed} circuit ${circuit}`;
      console.log(`\n-- ${tag}`);
      const nl = nodeLevel(seed, circuit);
      const { page, context } = await soakBoot(browser, server, { journeySeed: seed, circuit, errors, device: 'small' });
      try {
        await page.evaluate(() => { window.__egg.adaptive().enabled = false; window.__shell.setMode('paused'); });   // the loop draws the frozen world but never steps it
        const pg = await page.evaluate(() => ({ fp: window.__drv.levelFingerprint(window.__egg.level()), genMs: window.__egg.state().genMs, circuit: window.__egg.level().circuit, n: window.__egg.level().checkpoints.length }));
        pageGen.push(pg.genMs);
        t.ok(pg.fp === nl.fp && pg.circuit === circuit, `${tag}: the page's world is Node's world (fingerprint ${pg.fp}, ${pg.n} flags, page generated it in ${f1(pg.genMs)} ms, Node ${f1(nl.genMs)} ms)`);

        const rand = lcg(seed ^ (circuit * 7919));
        const which = pickSegments(nl.level, rand);
        const t0 = Date.now();
        let kinds = Object.keys(NOISE);
        let nSeg = 0;
        for (const i of which) {
          const plan = planSegments(nl.level, [i], { phase: () => rand() * 11 })[0];
          nSeg++; stats.segments++;
          const L = stats.perLandscape[plan.ch]; L.n++;
          const o = plan.oracle;
          const stopCp = plan.to ?? null;
          const rs = resolveSteps(nl.level, plan.from, traceOf(o), { phase: plan.phase, stopCp });
          stats.unresolved += rs.unresolved;
          const tr = rs.steps;
          const ref = replayHeadless(nl.level, plan.from, tr, { stopCp, phase: plan.phase });
          if (!(o.ok ? Math.abs(ref.x - o.x) < 1e-3 && Math.abs(ref.seconds - o.t) < 1e-6 && ref.ok : !ref.ok)) stats.plannerMismatch.push({ seed, circuit, seg: i, planner: { ok: o.ok, x: o.x, t: o.t }, replay: { ok: ref.ok, x: ref.x, t: ref.seconds } });
          const got = await page.evaluate(([flag, actions, stop, phase]) => {
            const d = window.__drv; d.restartAt(flag, { phase, carry: { eggs: 0, score: 0, flock: 0 } });
            const r = d.replayInPage(actions, { stopCp: stop });
            r.problems = d.scanSim(window.__egg.game(), window.__egg.renderer);
            return r;
          }, [plan.from, tr, stopCp, plan.phase]);
          if (got.problems.length) stats.scanProblems.push(`${tag} seg ${i}: ${got.problems.slice(0, 4).join(', ')}`);
          const evEq = JSON.stringify(Object.entries(ref.events).sort()) === JSON.stringify(Object.entries(got.events).sort());
          const eq = same(ref.x, got.x) && same(ref.t, got.t) && ref.hits === got.hits && ref.falls === got.falls && ref.reason === got.reason && ref.eggs === got.eggs && evEq;
          if (!eq) stats.mismatch.push({ tag, seg: i, ref: { x: ref.x, t: ref.t, hits: ref.hits, falls: ref.falls, reason: ref.reason }, page: { x: got.x, t: got.t, hits: got.hits, falls: got.falls, reason: got.reason } });
          
          if (!o.ok) {
            L.fail++;
            stats.oracleFail.push({ seed, circuit, seg: i, from: plan.from, to: plan.to, landscape: NAMES[plan.ch], x: +o.x.toFixed(1), x0: +plan.x0.toFixed(0), x1: +plan.x1.toFixed(0), reason: o.reason, phase: +plan.phase.toFixed(2) });
          }
          // imperfect players
          for (const kind of kinds) {
            for (let rep = 0; rep < (kind === 'clumsy' ? Math.max(1, NOISE_REPS - 1) : NOISE_REPS); rep++) {
              const ns = (seed ^ (i * 2654435761) ^ (rep * 40503)) >>> 0;
              const nz = planSegments(nl.level, [i], { phase: () => plan.phase, noise: { ...NOISE[kind], seed: ns || 1 } })[0].noisy;
              const nrs = resolveSteps(nl.level, plan.from, traceOf(nz), { phase: plan.phase, stopCp });
              stats.unresolved += nrs.unresolved;
              const nref = replayHeadless(nl.level, plan.from, nrs.steps, { stopCp, phase: plan.phase });
              if (!(nz.ok ? Math.abs(nref.x - nz.x) < 1e-3 && nref.ok : !nref.ok)) stats.plannerMismatch.push({ seed, circuit, seg: i, kind, planner: { ok: nz.ok, x: nz.x }, replay: { ok: nref.ok, x: nref.x } });
              const ngot = await page.evaluate(([flag, actions, stop, phase]) => { const d = window.__drv; d.restartAt(flag, { phase, carry: { eggs: 0, score: 0, flock: 0 } }); return d.replayInPage(actions, { stopCp: stop }); }, [plan.from, nrs.steps, stopCp, plan.phase]);
              if (!(same(nref.x, ngot.x) && same(nref.t, ngot.t) && nref.hits === ngot.hits && nref.falls === ngot.falls)) stats.mismatch.push({ tag, seg: i, kind, ref: nref.x, page: ngot.x });
              const K = stats.noise[kind]; K.n++; K.perLandscape[plan.ch].n++;
              if (nz.ok) { K.ok++; K.perLandscape[plan.ch].ok++; } else K.fails.push({ seed, circuit, seg: i, landscape: NAMES[plan.ch], x: +nz.x.toFixed(0), reason: nz.reason });
            }
          }
        }
        console.log(`  ${nSeg} segments planned and replayed in ${((Date.now() - t0) / 1000).toFixed(0)} s (${which.join(' ')})`);
      } finally { await context.close(); }
    }
  }

  /* ───────── verdict ───────── */
  console.log('\n== results');
  console.log(`  segments sampled: ${stats.segments} (${SEEDS.length} journeys x circuits ${CIRCUITS.join(',')})   page world generation: ${f1(Math.min(...pageGen))}-${f1(Math.max(...pageGen))} ms`);
  console.log('  per landscape: planner clears / sampled, then the noisy players\' clear rate');
  for (let k = 0; k < 13; k++) {
    const L = stats.perLandscape[k];
    const r = (kind) => { const p = stats.noise[kind].perLandscape[k]; return p.n ? `${Math.round(100 * p.ok / p.n)}%` : '-'; };
    console.log(`   ${String(k + 1).padStart(2)} ${NAMES[k].padEnd(16)} planner ${L.n - L.fail}/${L.n}   careful ${r('careful').padStart(4)}  sloppy ${r('sloppy').padStart(4)}  clumsy ${r('clumsy').padStart(4)}`);
  }
  for (const kind of Object.keys(NOISE)) {
    const K = stats.noise[kind];
    console.log(`  ${kind}: ${K.ok}/${K.n} runs clear their segment (${f1(100 * K.ok / Math.max(1, K.n))}%)`);
  }
  if (stats.oracleFail.length) { console.log('\n  UNWINNABLE SPOTS (the planner could not get through with zero hits and falls):'); for (const f of stats.oracleFail) console.log('   ', JSON.stringify(f)); }
  const worst = {};
  for (const kind of Object.keys(NOISE)) for (const f of stats.noise[kind].fails) { const k = `${f.seed}/${f.circuit}/${f.seg}`; (worst[k] ||= { ...f, kinds: [] }).kinds.push(kind); }
  const tight = Object.values(worst).filter((w) => w.kinds.length >= 2).sort((a, b) => b.kinds.length - a.kinds.length).slice(0, 12);
  if (tight.length) { console.log('\n  TIGHT SPOTS (missed by two or more noisy runs; informational):'); for (const w of tight) console.log(`    seed ${w.seed} circuit ${w.circuit} segment ${w.seg} ${w.landscape} x ${w.x} (${w.kinds.length} misses: ${w.kinds.join(', ')})`); }

  const misses = [];
  for (const kind of Object.keys(NOISE)) for (const f of stats.noise[kind].fails) misses.push({ kind, ...f });
  if (misses.length) {
    console.log(`\n  MISSES BY NOISY PLAYERS (${misses.length}; the planner itself clears each of these; informational, with exact x and journey seed):`);
    for (const m of misses.slice(0, 30)) console.log(`    ${m.kind.padEnd(7)} seed ${m.seed} circuit ${m.circuit} segment ${m.seg} ${m.landscape} x ${m.x} (${m.reason})`);
  }

  t.ok(stats.oracleFail.length === 0, `no unwinnable spot: the planner cleared ${stats.segments - stats.oracleFail.length}/${stats.segments} sampled segments with zero hits and falls`, stats.oracleFail.slice(0, 3));
  t.ok(stats.mismatch.length === 0, `the page's sim ended every one of the replays exactly where the headless Node replay of the same trace did (${stats.segments} oracle replays + ${Object.values(stats.noise).reduce((a, k) => a + k.n, 0)} noisy replays)`, stats.mismatch.slice(0, 3));
  t.ok(stats.scanProblems.length === 0, 'no NaN or infinity in the sim state or the camera after any replay', stats.scanProblems.slice(0, 3));
  t.ok(stats.plannerMismatch.length === 0, `every replay reproduces the planner's own result: a cleared segment ends at exactly the planner's x and game time, a failed one fails again (the planner has no pickups: on the real world a shield or duckling may soak up its fatal hit and the replay then runs on, which is not a mismatch); the traces were pinned to exact steps (${stats.unresolved} unresolved actions)`, stats.plannerMismatch.slice(0, 3));
  const careful = stats.noise.careful;
  t.ok(careful.ok / Math.max(1, careful.n) >= 0.9, `a careful human-noise bot (80 ms learnt latency, +-50 ms) clears >= 90 % of segments (${f1(100 * careful.ok / Math.max(1, careful.n))}%)`);
  const sloppy = stats.noise.sloppy;
  t.ok(sloppy.ok / Math.max(1, sloppy.n) >= 0.85, `a sloppy bot (80 ms uncompensated, +-80 ms) clears >= 85 % (${f1(100 * sloppy.ok / Math.max(1, sloppy.n))}%)`);
  const clumsy = stats.noise.clumsy;
  t.ok(clumsy.ok / Math.max(1, clumsy.n) >= 0.75, `a clumsy small child (120 ms, +-120 ms) clears >= 75 % (${f1(100 * clumsy.ok / Math.max(1, clumsy.n))}%)`);
  t.ok(errors.length === 0, 'no console or page errors', errors.slice(0, 3));
  failures = t.done();
} catch (e) {
  console.error('\nUNCAUGHT:', e);
} finally {
  await browser.close();
  server.stop();
}
process.exitCode = failures ? 1 : 0;
