/*
 * Egg Mama — tests for the world generator and its fairness bot (DESIGN.md section 4, "Validation").
 *
 *   node --test tests/levels.test.mjs            a spread sample of segments, circuits 1-4 for the static checks (about 2 minutes)
 *   FULL=1 node --test tests/levels.test.mjs     every segment of every landscape (bot circuits 1-3), static checks on circuits 1-6
 *
 * (a) planner bot, jump-only, reaches the next flag with zero hits and zero falls     [bot, sampled / FULL]
 * (b) human-noise bot (latency, jitter) survives in >= 90 % of runs                    [bot, sampled / FULL]
 * (c) pacing: each landscape within paceBand(i), the circuit within T.journeyMinutes   [geometry + bot clean times]
 * (d) deterministic, pure, fast generation                                             [static]
 * (e) fairness rules 1-7 (and 8 for later circuits)                                    [static]
 * (f) restoring at every flag works                                                    [sim]
 * (g) difficulty ramps slowly and never steps at a landscape join                      [demand score: the generator's own yardstick]
 * (h) template variety and each landscape's signature element                          [static]
 *
 * LEVELS-2 (the measures below read the BUILT geometry through tests/felt.mjs, never the generator's curves):
 * (A) felt ramp: required events per minute rise Meadow -> Summit, THREAT-WEIGHTED (a moth is as much of an event as the share of
 *     the time a Mama who never jumps is hit by it) and counted whole, chains lengthen, windows shrink, simultaneous demands
 *     appear, the early landscapes stay gentle; the planner bot's JUMPS a minute ramp too (Fogwood no longer a hole in the ramp)
 * (B) no dead stretches: required-event gap, p90 of it, the share of runs over 26 s and the optional-aware gap, per landscape
 * (C) variety: no beat above ~30 % of a landscape, no geometry fingerprint above ~40 %, >= 10 beat types from Clover on, 3+
 *     structural variants of every signature, distinct set pieces that end in a golden-egg crown
 * (D) steering pays: the optional ice and spring sequences can be completed in the real sim ONLY with a push / brake swipe,
 *     never by jump-only play, and they are never required (an unbroken main route runs under every optional platform)
 * (E) child-friendliness: spike room and windows, a little help before the first hazards, imperfect-player clear rates (a
 *     button-masher, a calm but sloppy player at 80 ms / +-80 ms, a clumsy small child at 120 ms / +-120 ms)
 * (F) takeoff windows MEASURED in the real sim, circuits 1-4 (1-6 under FULL)
 *
 * LEVELS-3: circuits saturate (a circuit never starts harder than circuit 2's Meadow and no window ever drops below the floor,
 * in circuits 1-6 and a few huge ones); the flyer threat model agrees with an idle Mama in the real sim; walls are rare and the first
 * one has a caption; the dead-stretch guard leaves no wait over 26 s.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { T, jumpDistance } from '../docs/js/tuning.mjs';
import { CHAPTERS, paceBand, difficulty, JOURNEY_SECONDS } from '../docs/js/chapters.mjs';
import { levelDifficulty, D_MAX, RATE, circuitRate } from '../docs/js/levels/params.mjs';
import { LIMIT_U, LIMIT_EARLY_U } from '../docs/js/levels/densify.mjs';
import { generateLevel, levelSeed } from '../docs/js/levelgen.mjs';
import { beatNames, actNames, miniLevel, BEATS, ELEMENT_INTRO } from '../docs/js/segments.mjs';
import { jumpWindow, trainFeasible, spikeWindow, springLanding, MAX_RISE, flightTime, flyerThreat as flyerThreatModel } from '../docs/js/levels/phys.mjs';
import { measureDemand, eventsIn } from '../docs/js/levels/demand.mjs';
import { createGame, startRun, step, act, respawn, snapshotCarry } from '../docs/js/sim.mjs';
import { rng, mixSeed } from '../docs/js/rng.mjs';
import { playLevel, segmentsOf, ROLLIN_LOSS, clearRates } from './bot.mjs';
import { feltOf, feltSummary, requiredEvents, optionalActivity, spearman as spearmanOf, flyerThreat } from './felt.mjs';
import { flagOf, resolveFlag } from '../docs/js/save.mjs';

const FULL = !!process.env.FULL;
const JOURNEY = 20261122;
const EXTRA_JOURNEYS = process.env.JOURNEYS ? process.env.JOURNEYS.split(',').map(Number) : [7, 424242, 0xdecaf, 31337];   // the hard rules (e1-e7) also hold for other random journeys (JOURNEYS=1,2,3 to sweep more)
const CIRCUITS = FULL ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4];     // the static checks: every one of these circuits is generated and checked
const BOT_CIRCUITS = [1, 2, 3];                                  // the planner bot plays these (a circuit is ~10 s of bot time per pass)
const cache = new Map();
const levelOf = (circuit, journey = JOURNEY) => {
  const key = circuit + ':' + journey;
  if (!cache.has(key)) cache.set(key, generateLevel({ circuit, seed: levelSeed(journey, circuit) }));
  return cache.get(key);
};
const C = T.cruise;
const kindOf = (k) => (k === 'ground' ? 'ground' : 'ledge');
const stat = (p) => ({ x: p.x, end: p.x + p.w, top: p.y, kind: kindOf(p.kind) });
const main = (lv) => lv.platforms.filter((p) => !p.o);
/** Lifts and movers are dynamic; a thin ledge that merely bobs a few units (Reedwater's logs) is analysed as a static one. */
const isDyn = (p) => !!p.motion && !(p.kind === 'ledge' && p.motion.amp <= 10);
const mainStatic = (lv) => main(lv).filter((p) => !isDyn(p));

/** Merge adjacent, walkable ground platforms into runs { x0, x1, y }. Steps up of <= stepUp are walkable; walls and gaps break a run. */
function groundRuns(lv) {
  const runs = [];
  for (const p of main(lv)) {
    if (p.kind !== 'ground' || p.motion) continue;
    const last = runs[runs.length - 1];
    if (last && p.x <= last.x1 + 0.5 && p.y >= last.y - T.stepUp) { last.x1 = Math.max(last.x1, p.x + p.w); last.y = p.y; }
    else runs.push({ x0: p.x, x1: p.x + p.w, y: p.y });
  }
  return runs;
}
const runAt = (runs, x) => runs.find((r) => x >= r.x0 && x <= r.x1);

/** Anything dangerous between x0 and x1: hazards, walkers, flyers, springs. */
function dangersIn(lv, x0, x1) {
  const out = [];
  for (const h of lv.hazards) if (h.x + h.w >= x0 && h.x <= x1) out.push('spikes@' + h.x);
  for (const e of lv.enemies) {
    const a = e.kind === 'walker' ? e.x0 - 20 : e.cx - e.ax - 20, b = e.kind === 'walker' ? e.x1 + 20 : e.cx + e.ax + 20;
    if (b >= x0 && a <= x1) out.push(e.kind + '@' + Math.round(a));
  }
  for (const s of lv.springs) if (s.x >= x0 - 20 && s.x <= x1 + 20) out.push('spring@' + s.x);
  return out;
}

/* ═════════════════ physics model vs the real sim ═════════════════ */

test('phys.jumpWindow matches the real sim (conservatively) for gaps between ground, ledges and crumbles', () => {
  const lvl = (plats, sx) => ({ circuit: 1, seed: 1, start: { x: sx, y: plats[0].y }, endX: 1e6, platforms: plats.map((p, i) => ({ id: i, ...p })), pickups: [], enemies: [], hazards: [], springs: [], checkpoints: [{ id: 0, x: sx, y: plats[0].y, platform: 0 }], beacon: null, cues: [], beats: [], water: null });
  const trial = (plats, xt) => {
    const g = createGame(lvl(plats, xt - 300), { flock: 0 });
    startRun(g);
    let jumped = false;
    for (let i = 0; i < 120 * 7; i++) {
      if (!jumped && g.mama.x >= xt) { act(g, 'jump'); jumped = true; }
      step(g, {});
      if (g.status !== 'running' || g.stats.falls) return false;
      if (jumped && g.mama.onGround && g.mama.ground.id === 1) return true;
    }
    return false;
  };
  const mk = (k, x, y, w) => ({ kind: { g: 'ground', l: 'ledge', k: 'crumble' }[k], x, y, w, h: k === 'g' ? 100 : 14 });
  const cases = [['g', 'g', 50, 0, 400], ['g', 'g', 68, 0, 400], ['g', 'g', 40, -40, 400], ['l', 'l', 50, 0, 100], ['l', 'l', 55, -60, 100], ['g', 'l', 36, 0, 120], ['k', 'k', 40, 0, 90], ['g', 'g', 44, 0, 70]];
  for (const [ak, bk, gap, dy, bw] of cases) {
    const A = mk(ak, 0, 292, 1000), Bp = mk(bk, 1000 + gap, 292 + dy, bw);
    const w = jumpWindow({ end: 1000, top: A.y, kind: kindOf(A.kind) }, { x: Bp.x, end: Bp.x + Bp.w, top: Bp.y, kind: kindOf(Bp.kind) });
    let lo = null, hi = null;
    for (let xt = 880; xt <= 1040; xt += 1) if (trial([A, Bp], xt)) { if (lo === null) lo = xt; hi = xt; }
    assert.ok(lo !== null, `${ak}${bk} gap ${gap} dy ${dy}: sim finds a window`);
    // the model must never promise a takeoff the sim fails (conservative), and not be wildly pessimistic either
    assert.ok(w.lo + 1000 >= lo - 1.5 && w.hi + 1000 <= hi + 1.5, `${ak}${bk} gap ${gap}: model window [${w.lo.toFixed(1)}, ${w.hi.toFixed(1)}] inside sim [${lo - 1000}, ${hi - 1000}]`);
    assert.ok(w.width >= (hi - lo) - 9, `${ak}${bk} gap ${gap}: model within 9 u of the sim window`);
  }
});

test('phys.spikeWindow matches the real sim', () => {
  const g0 = 292;
  for (const w of [22, 30, 36]) {
    const sx = 1000;
    const pr = spikeWindow(sx, w);
    let lo = null, hi = null;
    for (let xt = sx - 120; xt <= sx + 10; xt += 1) {
      const level = { circuit: 1, seed: 1, start: { x: xt - 300, y: g0 }, endX: 1e6, platforms: [{ id: 0, kind: 'ground', x: 0, y: g0, w: 3000, h: 100 }], pickups: [], enemies: [], hazards: [{ id: 0, kind: 'spikes', x: sx, y: g0, w }], springs: [], checkpoints: [{ id: 0, x: xt - 300, y: g0, platform: 0 }], beacon: null, cues: [], beats: [], water: null };
      const g = createGame(level, { flock: 0 });
      startRun(g);
      let jumped = false, hit = false;
      for (let i = 0; i < 120 * 8 && !hit; i++) { if (!jumped && g.mama.x >= xt) { act(g, 'jump'); jumped = true; } step(g, {}); if (g.stats.hits) hit = true; }
      if (!hit) { if (lo === null) lo = xt; hi = xt; }
    }
    assert.ok(pr.lo >= lo - 1.5 && pr.hi <= hi + 1.5, `spike ${w}: model [${pr.lo.toFixed(1)}, ${pr.hi.toFixed(1)}] inside sim [${lo}, ${hi}]`);
  }
});

test('spring launches land where springLanding says', () => {
  const g0 = 292, sx = 800;
  for (const rise of [0, 100, 150]) {
    const land = springLanding(sx, rise);
    const plats = [{ id: 0, kind: 'ground', x: 0, y: g0, w: sx + 40, h: 100 }, { id: 1, kind: 'ground', x: sx + 40, y: g0 - rise, w: 600, h: 100 }];
    const level = { circuit: 1, seed: 1, start: { x: 300, y: g0 }, endX: 1e6, platforms: plats, pickups: [], enemies: [], hazards: [], springs: [{ id: 0, x: sx, y: g0 }], checkpoints: [{ id: 0, x: 300, y: g0, platform: 0 }], beacon: null, cues: [], beats: [], water: null };
    if (rise > 0) level.platforms[1] = { id: 1, kind: 'ledge', x: land - 60, y: g0 - rise, w: 120, h: 14 };
    const g = createGame(level, { flock: 0 });
    startRun(g);
    let landedX = null, launched = false;
    for (let i = 0; i < 120 * 12 && landedX === null; i++) {
      step(g, {});
      if (g.springs[0].bounceT > 0) launched = true;
      if (launched && g.mama.onGround && g.mama.ground.id === 1) landedX = g.mama.x;
    }
    assert.ok(launched && landedX !== null, `spring rise ${rise}: she lands on the platform`);
    if (rise === 0) assert.ok(Math.abs(landedX - land) < 6, `flat spring landing ${landedX} vs ${land}`);
  }
});

/* ═════════════════ (d) determinism, purity, speed, shape ═════════════════ */

test('(d) generation is deterministic, pure and fast', () => {
  const seed = levelSeed(JOURNEY, 1);
  const a = generateLevel({ circuit: 1, seed });
  const b = generateLevel({ circuit: 1, seed });
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same inputs, same level');
  const c = generateLevel({ circuit: 1, seed: seed + 1 });
  assert.notEqual(JSON.stringify(a), JSON.stringify(c), 'a different seed gives a different world');
  assert.notEqual(JSON.stringify(a), JSON.stringify(generateLevel({ circuit: 2, seed })), 'a different circuit gives a different world');
  assert.equal(levelSeed(1, 1), levelSeed(1, 1));
  assert.notEqual(levelSeed(1, 1), levelSeed(1, 2));
  assert.ok(levelSeed(123456789, 3) >>> 0 === levelSeed(123456789, 3));
  // purity: never touches Math.random / Date
  const mr = Math.random, dn = Date.now;
  Math.random = () => { throw new Error('Math.random used'); };
  Date.now = () => { throw new Error('Date.now used'); };
  try { generateLevel({ circuit: 2, seed: 99 }); } finally { Math.random = mr; Date.now = dn; }
  // speed: best of three warm runs (phones are ~3x slower; the budget is 150 ms here)
  const times = [];
  for (let i = 0; i < 4; i++) { const t0 = performance.now(); generateLevel({ circuit: 1 + (i % 3), seed: seed + i }); times.push(performance.now() - t0); }
  const best = Math.min(...times.slice(1));
  assert.ok(best < 150, `generation took ${best.toFixed(0)} ms (budget 150)`);
  // compact
  const bytes = JSON.stringify(a).length;
  assert.ok(bytes < 4e6, `level is ${(bytes / 1e6).toFixed(2)} MB`);
});

test('level shape: sorted arrays, id === index, chapters, checkpoints, cues, beacon', () => {
  for (const circuit of CIRCUITS) {
    const lv = levelOf(circuit);
    for (const [name, key] of [['platforms', (p) => p.x], ['pickups', (p) => p.x], ['hazards', (h) => h.x], ['springs', (s) => s.x], ['checkpoints', (c) => c.x]]) {
      lv[name].forEach((item, i) => assert.equal(item.id, i, `${name} id === index`));
      for (let i = 1; i < lv[name].length; i++) assert.ok(key(lv[name][i]) >= key(lv[name][i - 1]), `${name} sorted by x (circuit ${circuit}, #${i})`);
    }
    lv.enemies.forEach((e, i) => assert.equal(e.id, i));
    for (let i = 1; i < lv.enemies.length; i++) assert.ok((lv.enemies[i].x0 ?? lv.enemies[i].cx - lv.enemies[i].ax) >= (lv.enemies[i - 1].x0 ?? lv.enemies[i - 1].cx - lv.enemies[i - 1].ax), 'enemies sorted');
    for (let i = 1; i < lv.cues.length; i++) assert.ok(lv.cues[i].x >= lv.cues[i - 1].x, 'cues sorted');
    assert.equal(lv.circuit, circuit);
    assert.equal(lv.chapters.length, CHAPTERS.length);
    lv.chapters.forEach((ch, k) => {
      assert.equal(ch.index, k);
      if (k) assert.equal(ch.x0, lv.chapters[k - 1].x1, 'landscapes are contiguous');
      assert.ok(ch.x1 > ch.x0);
      assert.equal(lv.checkpoints[ch.flag].ch, k, 'chapters[k].flag opens landscape k');
    });
    assert.equal(lv.chapters[0].x0, 0);
    assert.equal(lv.checkpoints[0].x, lv.start.x, 'checkpoints[0] is the world start');
    for (const p of lv.platforms) { assert.ok(p.ch >= 0 && p.ch < 13); assert.ok(p.w >= 0 && Number.isFinite(p.x + p.y + p.w + p.h)); }
    for (const c of lv.checkpoints) {
      const p = lv.platforms[c.platform];
      assert.ok(p && p.kind === 'ground' && !p.motion, 'a flag stands on static ground');
      assert.ok(c.x >= p.x && c.x <= p.x + p.w && c.y === p.y, 'flag on its platform top');
      assert.equal(c.ch, lv.chapters.findIndex((ch, k) => c.x >= ch.x0 && (k === 12 || c.x < ch.x1)), 'flag carries its landscape');
    }
    assert.ok(lv.beacon && lv.beacon.x > 0);
    assert.equal(lv.endX, lv.beacon.x + 140);
    assert.equal(lv.chapters[12].x1, lv.endX);
    assert.ok(lv.water && typeof lv.water.y === 'number');
    assert.ok(lv.cues.every((c) => typeof c.text === 'string' && c.text.length > 3));
    assert.ok(lv.start.y === T.groundY);
    for (const p of lv.platforms) if (p.motion) { assert.ok(p.motion.amp <= 90 && p.motion.period >= 3.0 && p.motion.period <= 6.5 || p.kind === 'ledge'); }
    for (const e of lv.enemies) assert.ok(Number.isFinite(e.id));
    for (const q of lv.pickups) assert.ok(['egg', 'gold', 'shield', 'magnet'].includes(q.kind) && q.y < T.killY);
  }
});

/* ═════════════════ (e) fairness rules 1-7 (+8) ═════════════════ */

for (const circuit of CIRCUITS) {
  test(`(e1) circuit ${circuit}: the first 900 u of the world and 700 u of every landscape are quiet`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE1(levelOf(circuit, journey), circuit, journey);
  });
  function checkE1(lv, circuit, journey) {
    const runs = groundRuns(lv);
    for (const ch of lv.chapters) {
      const lo = ch.x0 < 0 ? 0 : ch.x0, hi = ch.x0 + (ch.index === 0 ? 900 : 700);
      assert.deepEqual(dangersIn(lv, lo - 100, hi), [], `landscape ${ch.index}: nothing dangerous in its first stretch`);
      const run = runAt(runs, hi - 1) && runAt(runs, Math.max(lo, ch.index ? ch.x0 - 200 : 0));
      assert.ok(run && run.x1 >= hi && run.x0 <= (ch.index ? ch.x0 - 200 : 0) + 1, `landscape ${ch.index}: one unbroken run of ground over its opening, no required jump`);
      assert.equal(lv.platforms.filter((p) => !p.o && p.x < hi && p.x + p.w > lo && (p.motion || p.kind !== 'ground')).length, 0, 'only plain ground in the opening');
    }
    if (circuit === 1) {
      const gold = lv.pickups.find((q) => q.kind === 'gold');
      assert.ok(gold.x <= 700, `Meadow's first golden egg is within its first 700 u (x=${gold.x})`);
      const run = runAt(runs, gold.x);
      assert.ok(run && gold.x >= run.x0 + 100 && gold.x <= run.x1 - 100, 'the first golden egg sits on flat safe ground');
      assert.ok(gold.y >= run.y - 40 && gold.y <= run.y - 15, 'within reach of a rolling Mama (no jump needed)');
      const firstGap = mainStatic(lv).find((p, i, a) => a[i + 1] && a[i + 1].x > p.x + p.w);
      assert.ok(firstGap, 'Meadow has a first gap');
      const next = mainStatic(lv)[mainStatic(lv).indexOf(firstGap) + 1];
      const gap = next.x - (firstGap.x + firstGap.w);
      assert.ok(gap <= 46 && gap >= 24, `the first gap is forgiving (${gap} u)`);
      assert.ok(next.w >= 160, `with a wide landing (${next.w} u)`);
      assert.ok(firstGap.x + firstGap.w > 900, 'after the quiet start');
      const tip = lv.cues.find((c) => c.text === CHAPTERS[0].tip);
      assert.ok(tip, "the 'Swipe up to jump' caption exists");
      const d = firstGap.x + firstGap.w - tip.x;
      assert.ok(d >= 150 && d <= 340, `...about 250 u before the first gap (${d})`);
    }
  }

  test(`(e2) circuit ${circuit}: every required jump is possible at default cruise with one swipe`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE2(levelOf(circuit, journey), circuit, journey);
  });
  function checkE2(lv, circuit, journey) {
    const plats = main(lv);
    let chain = [], jumps = 0, worstSecs = Infinity, worst = null;
    const flush = () => {
      if (chain.length >= 2) {
        const r = trainFeasible(chain.map(stat), { minSecs: T.minWindow });
        assert.ok(r.ok, `chain at x=${chain[0].x} (${chain.length} platforms) is feasible jump-only (min window ${r.minSecs.toFixed(3)} s)`);
        if (r.minSecs < worstSecs) { worstSecs = r.minSecs; worst = chain[0].x; }
      }
      chain = [];
    };
    for (let i = 0; i + 1 < plats.length; i++) {
      const p = plats[i], q = plats[i + 1];
      if (isDyn(p) || isDyn(q)) { flush(); continue; }
      const gap = q.x - (p.x + p.w), rise = p.y - q.y;
      if (gap <= 0 && rise <= T.stepUp) { flush(); continue; }                      // simply continues / a drop
      jumps++;
      assert.ok(gap <= T.maxGapHard, `gap ${gap} at x=${p.x + p.w} within maxGapHard`);
      assert.ok(q.w >= T.minLanding, `landing ${q.w} u wide at x=${q.x} (>= ${T.minLanding})`);
      assert.ok(rise <= MAX_RISE, `rise ${rise} at x=${q.x} within one swipe`);
      assert.ok(gap < jumpDistance() + 20, 'gap below jump distance + forgiveness');
      const w = jumpWindow(stat(p), stat(q));
      assert.ok(w.secs >= T.minWindow, `takeoff window ${w.secs.toFixed(3)} s at x=${p.x + p.w} (>= ${T.minWindow})`);
      if (chain.length === 0) chain.push(p);
      chain.push(q);
    }
    flush();
    assert.ok(jumps > 200, `a circuit has plenty of required jumps (${jumps})`);
    // moving platforms: phase-robust by construction. Check the whole sweep stays within one swipe of both neighbours.
    const ordered = plats;
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      if (!isDyn(m)) continue;
      const a = ordered[i - 1], e = ordered[i + 1];
      assert.ok(m.w >= 150 || m.kind === 'ledge', `moving platforms are >= 150 u wide (${m.w})`);
      if (m.motion.axis === 'y') {
        assert.ok(m.motion.amp <= 90 && m.motion.period >= 3.2 && m.motion.period <= 6.5, 'lift swing within limits');
        if (a && !a.motion) assert.ok(a.y - (m.y - m.motion.amp) <= MAX_RISE, `entry rise to the lift's highest point <= ${MAX_RISE}`);
        if (e && !e.motion) {
          assert.ok(m.y + m.motion.amp - e.y <= MAX_RISE, `exit rise from the lift's lowest point <= ${MAX_RISE}`);
          const gapE = e.x - (m.x + m.w);
          assert.ok(gapE >= 8 && gapE <= T.maxGapHard, `lift exit gap ${gapE}`);
        }
        if (a && !a.motion) { const gapA = m.x - (a.x + a.w); assert.ok(gapA >= 8 && gapA <= T.maxGapHard, `lift entry gap ${gapA}`); }
      } else {
        assert.ok(m.motion.amp <= 30, 'movers swing so that both banks stay within one jump');
        if (a && !a.motion) assert.ok(m.x - m.motion.amp - (a.x + a.w) >= 0 && m.x + m.motion.amp - (a.x + a.w) <= T.maxGapHard, 'mover reachable from the near bank at every phase');
        if (e && !e.motion) assert.ok(e.x - (m.x + m.w + m.motion.amp) >= 0 && e.x - (m.x + m.w - m.motion.amp) <= T.maxGapHard, 'far bank reachable from the mover at every phase');
      }
    }
    // crumbles: every crumble ledge is a real landing and short enough to be crossed in time
    for (const p of plats) if (p.kind === 'crumble') assert.ok(p.w >= T.minLanding - 6 && p.w <= 120, `crumble width ${p.w}`);
  }

  test(`(e3) circuit ${circuit}: checkpoint flags on static ground with safe room, at least every 35 s`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE3(levelOf(circuit, journey), circuit, journey);
  });
  function checkE3(lv, circuit, journey) {
    const runs = groundRuns(lv);
    const cps = lv.checkpoints;
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (i) assert.ok(c.x > cps[i - 1].x, 'flags numbered by x');
      const run = runAt(runs, c.x);
      assert.ok(run, `flag ${i} on a main-route ground run`);
      if (i > 0) assert.ok(c.x - run.x0 >= 250, `flag ${i}: >= 250 u of ground before it (${(c.x - run.x0).toFixed(0)})`);
      assert.ok(run.x1 - c.x >= 350, `flag ${i}: >= 350 u of ground after it (${(run.x1 - c.x).toFixed(0)})`);
      assert.deepEqual(dangersIn(lv, c.x - 250, c.x + 350), [], `flag ${i}: no hazard in the 250 u before / 350 u after`);
      if (i) assert.ok((c.x - cps[i - 1].x) / C <= 35, `flag ${i}: ${((c.x - cps[i - 1].x) / C).toFixed(1)} s after the previous flag (<= 35)`);
    }
    // a flag before every demanding sequence: nothing dangerous within 350 u after any flag (above) and every hazard has a flag
    // within 35 s behind it by the spacing rule. Also the last flag precedes the beacon.
    assert.ok(cps[cps.length - 1].x < lv.beacon.x - 300);
    assert.ok((lv.beacon.x - cps[cps.length - 1].x) / C <= 35);
  }

  test(`(e4) circuit ${circuit}: required landings and hazards are on screen in time, platforms in the readable band`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE4(levelOf(circuit, journey), circuit, journey);
  });
  function checkE4(lv, circuit, journey) {
    for (const p of main(lv)) {
      const lo = p.y - (p.motion && p.motion.axis === 'y' ? p.motion.amp : 0), hi = p.y + (p.motion && p.motion.axis === 'y' ? p.motion.amp : 0);
      assert.ok(p.motion ? lo >= 130 && hi <= 340 && p.y >= 150 && p.y <= 310 : p.y >= 150 && p.y <= 310, `platform ${p.id} (${p.kind}) at y=${p.y}`);
    }
    // nothing may be read within 300 u of the camera's left edge after a checkpoint restore: the flags' safe zone (e3) covers it.
    // lifts / movers have room: no other main-route platform intrudes on their sweep
    const plats = main(lv);
    for (const m of plats) {
      if (!m.motion) continue;
      const ax = m.motion.axis === 'x' ? m.motion.amp : 0;
      for (const o of plats) {
        if (o === m) continue;
        assert.ok(o.x + o.w <= m.x - ax - 4 || o.x >= m.x + m.w + ax + 4, `platform ${o.id} stays clear of ${m.kind} ${m.id}'s sweep`);
      }
    }
    // every hazard / walker is ahead of at least 1.2 s of visible approach: the approach is flat ground (>= 120 u), see (e5)
    // and no required jump sits right on top of a camera snap: the flags guarantee 350 u of safe ground (e3).
  }

  test(`(e5) circuit ${circuit}: enemies, spikes and flyers obey the fairness rules`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE5(levelOf(circuit, journey), circuit, journey);
  });
  function checkE5(lv, circuit, journey) {
    const runs = groundRuns(lv);
    for (const e of lv.enemies) {
      if (e.kind === 'walker') {
        assert.ok(e.x1 - e.x0 >= 90, `walker patrol ${e.x1 - e.x0} >= 90`);
        assert.ok(e.speed <= 55, `walker speed ${e.speed} <= 55`);
        const run = runAt(runs, e.x0) || null;
        // either a long ground run, or its own island between two gaps: it always walks on one ground platform
        const plat = lv.platforms.find((p) => !p.o && p.kind === 'ground' && !p.motion && e.x0 >= p.x - 0.5 && e.x1 <= p.x + p.w + 0.5 && Math.abs(p.y - e.y) < 1);
        const walkable = run && run.x0 <= e.x0 - 100 && e.x0 >= run.x0;
        assert.ok(plat || walkable, `walker at ${e.x0} walks on ground`);
        const ground = plat ? { x1: plat.x + plat.w } : run;
        assert.ok(ground.x1 - e.x1 >= 120, `walker at ${e.x0}: >= 120 u of flat ground beyond its patrol (${(ground.x1 - e.x1).toFixed(0)})`);
        assert.ok(e.x0 - (plat ? plat.x : run.x0) >= 120, `walker at ${e.x0}: a run-up of >= 120 u`);
      } else {
        const a = e.cx - e.ax - 30, b = e.cx + e.ax + 30;
        const run = runAt(runs, e.cx);
        assert.ok(run && run.x0 <= a - 60 && run.x1 >= b + 120, `flyer at ${e.cx} is only over ground, never over a landing (needs ${a - 60}..${b + 120}, run ${run && run.x0}..${run && run.x1})`);
        assert.ok(e.cy < run.y - 36, 'flyer above the ground');
        assert.ok(e.ax <= 90 && e.ay <= 40 && e.period >= 3 && e.period <= 6);
      }
    }
    for (const h of lv.hazards) {
      assert.ok(h.w <= 60 && h.w >= 5 && h.w <= 10, `spike width ${h.w} (5-10 u: the art is drawn much bigger than the hitbox on purpose)`);
      const spikeJump = spikeWindow(h.x, h.w);
      assert.ok(spikeJump.secs >= 0.40, `spike ${h.w} wide has a ${spikeJump.secs.toFixed(3)} s takeoff window (spikes are the tightest element: a clumsy child at 120 ms needs >= 0.40 s)`);
      const run = runAt(runs, h.x);
      assert.ok(run, 'spikes sit on main-route ground');
      assert.ok(h.x - run.x0 >= 120, `spikes at ${h.x}: >= 120 u approach (${(h.x - run.x0).toFixed(0)})`);
      assert.ok(run.x1 - (h.x + h.w) >= 100, `spikes at ${h.x}: room beyond to land (${(run.x1 - h.x - h.w).toFixed(0)})`);
      if (h.cycle) assert.ok(h.cycle.up < h.cycle.period && h.cycle.period >= 2 && h.cycle.up >= 0.8);
      const under = lv.platforms.find((p) => !p.o && p.kind === 'ground' && !p.motion && h.x >= p.x && h.x + h.w <= p.x + p.w);
      assert.ok(under && under.y === h.y, 'spike height = the ground top under it');
    }
    // a hazard never sits within a flag's safe zone (e3) and not on a moving / crumbling platform
    for (const h of lv.hazards) assert.ok(lv.platforms.some((p) => p.kind === 'ground' && !p.motion && h.x >= p.x && h.x + h.w <= p.x + p.w && p.y === h.y));
  }

  test(`(e6) circuit ${circuit}: eggs, golden eggs, shields and magnets`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE6(levelOf(circuit, journey), circuit, journey);
  });
  function checkE6(lv, circuit, journey) {
    const runs = groundRuns(lv);
    const groundTop = (x) => lv.platforms.filter((q) => x >= q.x && x <= q.x + q.w && q.kind === 'ground' && !q.o).sort((a, b) => a.y - b.y)[0];
    // nothing buried in the ground
    for (const q of lv.pickups) {
      const under = lv.platforms.find((p) => !p.motion && q.x >= p.x && q.x <= p.x + p.w && q.y > p.y - 12 && q.y < p.y + p.h);
      assert.ok(!under, `pickup ${q.id} (${q.kind}) at ${q.x},${q.y} is not inside / touching platform ${under && under.id}`);
    }
    const eggs = lv.pickups.filter((q) => q.kind === 'egg').length;
    assert.ok(eggs > 5000 && eggs < 20000, `${eggs} ordinary eggs`);
    for (const ch of lv.chapters) {
      const golds = lv.pickups.filter((q) => q.kind === 'gold' && q.x >= ch.x0 && q.x < ch.x1);
      // a golden egg sitting above an OPTIONAL ledge is an upper-route (riskier) one; the rest must be within an easy jump of the path
      const onUpper = (q) => lv.platforms.some((p) => (p.o && q.x >= p.x - 4 && q.x <= p.x + p.w + 4 && q.y >= p.y - 60 && q.y <= p.y - 12) || (p.kind === 'lift' && q.x >= p.x && q.x <= p.x + p.w && q.y < p.y - p.motion.amp - 30));
      const optGold = golds.filter(onUpper);
      const mainPl = main(lv);
      const overGap = (q) => mainPl.some((p, i) => mainPl[i + 1] && q.x >= p.x + p.w - 30 && q.x <= mainPl[i + 1].x + 30 && q.y >= Math.min(p.y, mainPl[i + 1].y) - 130 && q.y <= Math.max(p.y, mainPl[i + 1].y) - 10);   // the arc over a main-route gap
      const mainGold = golds.filter((q) => { const p = groundTop(q.x); return !onUpper(q) && ((p && p.kind === 'ground' && q.y >= p.y - 130 && q.y <= p.y - 10) || overGap(q)); });
      assert.ok(mainGold.length >= 5, `landscape ${ch.index}: >= 5 golden eggs reachable from the main route with at most one easy jump (${mainGold.length})`);
      assert.ok(optGold.length >= 1, `landscape ${ch.index}: upper-route golden eggs (${optGold.length})`);
      // cadence: roughly one per 40-60 s on the main route; never a drought of more than ~100 s
      const xs = mainGold.map((q) => q.x).sort((a, b) => a - b);
      let worst = xs[0] - ch.x0;
      for (let i = 1; i < xs.length; i++) worst = Math.max(worst, xs[i] - xs[i - 1]);
      worst = Math.max(worst, ch.x1 - xs[xs.length - 1]);
      assert.ok(worst / C <= 100, `landscape ${ch.index}: longest wait for a main-route golden egg ${(worst / C).toFixed(0)} s`);
      const shields = lv.pickups.filter((q) => q.kind === 'shield' && q.x >= ch.x0 && q.x < ch.x1).length;
      const magnets = lv.pickups.filter((q) => q.kind === 'magnet' && q.x >= ch.x0 && q.x < ch.x1).length;
      if (ch.index >= 2) assert.ok(shields >= 1, `landscape ${ch.index}: a shield (${shields})`);
      else assert.equal(shields, 0, 'no shields before the 3rd landscape');
      void magnets;
    }
    const mags = lv.pickups.filter((q) => q.kind === 'magnet').map((q) => q.x);
    assert.ok(mags.length >= 7, `${mags.length} magnets in a circuit (about one per 3 minutes)`);
    for (let i = 1; i < mags.length; i++) assert.ok(mags[i] - mags[i - 1] <= 40000, `magnets are never more than ~6 minutes apart (${((mags[i] - mags[i - 1]) / C / 60).toFixed(1)})`);
    // shields / magnets sit on safe, flat ground
    for (const q of lv.pickups.filter((p) => p.kind === 'shield' || p.kind === 'magnet')) {
      const p = groundTop(q.x);
      const onLedge = lv.platforms.some((l) => l.o && q.x >= l.x && q.x <= l.x + l.w && q.y >= l.y - 50 && q.y <= l.y - 12);
      assert.ok(onLedge || (p && q.y >= p.y - 80), `${q.kind} at ${q.x},${q.y} within reach`);
    }
    void runs;
  }

  test(`(e7) circuit ${circuit}: the beacon is last, on safe ground well after the final hazard`, () => {
    for (const journey of [JOURNEY, ...EXTRA_JOURNEYS]) checkE7(levelOf(circuit, journey), circuit, journey);
  });
  function checkE7(lv, circuit, journey) {
    const b = lv.beacon;
    const lastHazard = Math.max(...lv.hazards.map((h) => h.x + h.w), ...lv.enemies.map((e) => (e.kind === 'walker' ? e.x1 : e.cx + e.ax)), ...lv.springs.map((s) => s.x));
    assert.ok(b.x - lastHazard >= 300, `beacon is ${(b.x - lastHazard).toFixed(0)} u after the last hazard`);
    const runs = groundRuns(lv);
    const run = runAt(runs, b.x);
    assert.ok(run && run.x1 >= lv.endX + 100 && b.x - run.x0 >= 300, 'beacon on a long safe ground run');
    const lastMain = main(lv).reduce((m, p) => Math.max(m, p.x + p.w), 0);
    assert.ok(lastMain <= run.x1 + 1, 'nothing main-route lies beyond the beacon run: no required jump after it');
    assert.ok(main(lv).filter((p) => p.x > run.x0 + 1).every((p) => p.kind === 'ground' && !p.motion), 'only plain ground in the final run');
    assert.equal(b.y, run.y);
    assert.ok(lv.platforms.every((p) => p.o || p.x <= lv.endX + 300), 'the world ends at the beacon');
    assert.ok(lv.cues.some((c) => c.text === CHAPTERS[12].tip && c.x < b.x && c.x > b.x - 500));
  }
}

test('(e8) later circuits: fresh terrain, circuit 2 starts at 4.5 and from circuit 3 on nothing gets harder (the ramp saturates), same fairness', () => {
  const sig = (lv) => lv.platforms.filter((p) => !p.o).map((p) => `${p.kind}:${Math.round(p.w)}`).join(',');
  const lvs = [1, 2, 3, 4].map((c) => levelOf(c));
  for (let i = 0; i < 3; i++) assert.notEqual(sig(lvs[i]), sig(lvs[i + 1]), `circuit ${i + 1} and ${i + 2} are different worlds`);
  // arrangement differs: the act sequence is not the same
  for (let i = 0; i < 3; i++) assert.notDeepEqual(lvs[i].acts.map((x) => x.id), lvs[i + 1].acts.map((x) => x.id));
  // the difficulty the generator scales with: circuit 1 is chapters.difficulty() (0 -> ~11), circuit 2 the same 4.5 higher, and from
  // circuit 3 on EXACTLY circuit 2's ramp: a circuit starts no harder than circuit 2's Meadow, ends no harder than circuit 2's Summit, and
  // D_MAX caps every one (the windows depend on it, see the floor test)
  for (let i = 0; i < 13; i++) for (const w of [0, 0.5, 1]) {
    assert.equal(levelDifficulty(i, 1, w), difficulty(i, 1, w), 'circuit 1 is chapters.difficulty()');
    const d2 = levelDifficulty(i, 2, w);
    assert.ok(Math.abs(d2 - Math.min(D_MAX, difficulty(i, 1, w) + 4.5)) < 1e-9, 'circuit 2 is 4.5 higher (capped)');
    for (const c of [3, 4, 5, 9, 99, 1e6]) assert.equal(levelDifficulty(i, c, w), d2, `circuit ${c} is no harder than circuit 2 (landscape ${i}, ${w})`);
    assert.ok(d2 <= D_MAX);
  }
  assert.ok(Math.abs(levelDifficulty(0, 2, 0) - 4.5) < 1e-9);
  // what grows is only the number of events a minute, a little, saturating: circuitRate
  assert.equal(circuitRate(5, 1), 0);
  for (let i = 0; i < 13; i++) {
    assert.ok(circuitRate(i, 2) === 0.8 && circuitRate(i, 3) >= circuitRate(i, 2) && circuitRate(i, 4) >= circuitRate(i, 3) && circuitRate(i, 99) <= 1.7 + 1e-9, `circuit rate lift saturates (landscape ${i})`);
  }
  assert.equal(circuitRate(0, 3), 0.8, 'Meadow asks the same lift in every later circuit');
  assert.ok(RATE(12, 0.5, 99) <= 13.8 && RATE(0, 0.5, 99) <= RATE(0, 0.5, 2) + 1e-9, 'a later circuit starts as gently as circuit 2');
  // the generated Meadow and Summit of circuits 3-6 are as demanding as circuit 2's (the model windows of their hops are not narrower)
  const med = (lv, i) => { const w = requiredEvents(lv).filter((e) => e.ch === i && e.cls === 'hop' && Number.isFinite(e.secs)).map((e) => e.secs).sort((p, q) => p - q); return w[w.length >> 1]; };
  for (const c of [3, 4, 5, 6]) {
    const lv = levelOf(c);
    assert.ok(med(lv, 0) >= med(lvs[1], 0) - 0.04, `circuit ${c}'s Meadow hops (median window ${med(lv, 0).toFixed(2)} s) are as roomy as circuit 2's (${med(lvs[1], 0).toFixed(2)} s)`);
    assert.ok(med(lv, 12) >= med(lvs[1], 12) - 0.04, `circuit ${c}'s Summit hops are no tighter than circuit 2's`);
  }
  // every circuit keeps the first-minutes gentleness
  for (const lv of lvs.slice(1)) assert.deepEqual(dangersIn(lv, 0, 900), []);
});

test('no required window is ever below the floor, in ANY circuit (1-6, a few huge ones and other journeys): every hop >= 0.36 s and every spike >= 0.40 s in the model', () => {
  for (const [c, j] of [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 11], [12, 11], [20, 3], [99, 3], [1000, 3], [4096, 8]]) {
    const lv = generateLevel({ circuit: c, seed: levelSeed(j, c) });
    for (const e of requiredEvents(lv)) {
      if (!Number.isFinite(e.secs)) continue;
      assert.ok(e.secs >= (e.cls === 'spike' ? 0.40 : 0.36), `circuit ${c}: the ${e.kind} at x=${e.x} (${NAMES[e.ch]}) has a window of ${e.secs.toFixed(3)} s`);
    }
  }
});

/* ═════════════════ (c) pacing ═════════════════ */

for (const circuit of CIRCUITS) {
  test(`(c) circuit ${circuit}: each landscape within paceBand(i), the circuit within T.journeyMinutes (geometry)`, () => {
    const lv = levelOf(circuit);
    const cps = lv.checkpoints;
    let total = 0;
    for (let i = 0; i < 13; i++) {
      const a = cps[lv.chapters[i].flag].x;
      const b = i < 12 ? cps[lv.chapters[i + 1].flag].x : lv.beacon.x;
      const secs = (b - a) / C;
      const [lo, hi] = paceBand(i);
      assert.ok(secs >= lo && secs <= hi, `landscape ${i} (${CHAPTERS[i].name}): ${secs.toFixed(1)} s within [${lo}, ${hi}]`);
      total += secs;
    }
    assert.ok(total / 60 >= T.journeyMinutes[0] && total / 60 <= T.journeyMinutes[1], `circuit: ${(total / 60).toFixed(1)} min within ${T.journeyMinutes}`);
    assert.ok(Math.abs(total - JOURNEY_SECONDS) < JOURNEY_SECONDS * 0.02, 'about the target hour');
    // landscape lengths in units follow chapters[i].seconds * cruise
    for (const ch of lv.chapters.slice(0, 12)) assert.ok(Math.abs((ch.x1 - ch.x0) - CHAPTERS[ch.index].seconds * C) <= CHAPTERS[ch.index].seconds * C * T.paceTolerance);
  });
}

/* ═════════════════ (f) restoring at every flag ═════════════════ */

test('(f) restoring at every flag puts her safely on its platform and she rolls on', () => {
  for (const circuit of CIRCUITS) {
    const lv = levelOf(circuit);
    const idx = lv.checkpoints.map((_, i) => i);                       // every flag of every circuit (cheap)
    for (const i of idx) {
      const cp = lv.checkpoints[i];
      const g = createGame(lv, { eggs: 7, score: 70, flock: 2 }, { checkpoint: i });
      assert.equal(g.checkpoint, i);
      assert.equal(g.mama.ground.id, cp.platform);
      assert.ok(Math.abs(g.mama.x - cp.x) < 1e-6 && g.mama.y === cp.y && g.mama.onGround, `flag ${i}: placed on the flag`);
      assert.equal(g.slot, lv.chapters.findIndex((c, k) => cp.x >= c.x0 && (k === 12 || cp.x < lv.chapters[k + 1].x0)));
      startRun(g);
      for (let s = 0; s < 120 * 3; s++) step(g, {});
      assert.equal(g.status, 'running', `flag ${i}: alive after 3 s`);
      assert.equal(g.stats.hits + g.stats.falls, 0);
      assert.ok(g.mama.x > cp.x + 60 && g.mama.onGround, `flag ${i}: rolled on`);
      assert.ok(g.flock >= 2 && g.eggs >= 7);
      // a fall sends her back here
      const before = g.flock, shielded = g.shield;
      g.mama.y = T.killY + 5; g.mama.onGround = false;
      step(g, {}); step(g, {});
      assert.equal(g.flock, shielded ? before : before - 1, shielded ? 'a shield absorbed the fall' : 'a survivable fall used a duckling');
      assert.ok(Math.abs(g.mama.x - cp.x) < 3 && g.mama.onGround, `flag ${i}: respawn on the flag`);
    }
  }
});

test('tools/level-report.mjs prints the per-landscape table and the per-act trace', () => {
  const out = JSON.parse(execFileSync(process.execPath, ['tools/level-report.mjs', '--json', '--circuit', '2', '--journey', '5'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 1 << 26 }));
  assert.equal(out.circuit, 2);
  assert.equal(out.landscapes.length, 13);
  assert.ok(out.landscapes.every((r) => r.cleanS >= r.band[0] && r.cleanS <= r.band[1] && r.flags >= 8 && r.golds >= 5 && r.eggs > 300));
  assert.ok(out.acts.length >= 80 && out.acts.every((a) => a.id && Number.isFinite(a.score) && Number.isFinite(a.d0)));
  const text = execFileSync(process.execPath, ['tools/level-report.mjs', '--acts'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.ok(/per-act difficulty trace/.test(text) && /gapsTeach/.test(text) && /summitClose/.test(text));
});

test('save integration: flagOf / resolveFlag round-trip every checkpoint of every circuit', () => {
  for (const circuit of CIRCUITS) {
    const lv = levelOf(circuit);
    for (let i = 0; i < lv.checkpoints.length; i++) {
      const { chapter, flag } = flagOf(lv, i);
      assert.equal(chapter, lv.checkpoints[i].ch, 'the landscape a save names is the flag\'s landscape');
      assert.equal(resolveFlag(lv, { chapter, flag }), i, `flag ${i} (landscape ${chapter}, #${flag})`);
    }
    for (const ch of lv.chapters) assert.equal(resolveFlag(lv, { chapter: ch.index, flag: 0 }), ch.flag, 'flag 0 of a landscape is the flag that opens it');
  }
});

/* ═════════════════ (g) difficulty: slow ramp, gentle sawtooth, no step at joins ═════════════════ */

const spearman = (xs, ys) => {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};

for (const circuit of CIRCUITS) {
  test(`(g) circuit ${circuit}: the demand score ramps up slowly with a gentle sawtooth and never steps at a landscape join`, () => {
    const lv = levelOf(circuit);
    const rows = lv.acts.map((a) => ({ ...a, m: measureDemand(lv, a.x0, a.x1) }));
    const live = rows.filter((r) => r.role !== 'breather' && r.role !== 'opening' && r.m.n > 0);
    const dExpected = live.map((r) => levelDifficulty(r.ch, circuit, ((r.x0 + r.x1) / 2 - lv.chapters[r.ch].x0) / (lv.chapters[r.ch].x1 - lv.chapters[r.ch].x0)));
    const rho = spearman(dExpected, live.map((r) => r.m.score));
    assert.ok(rho >= 0.7, `demand vs levelDifficulty(): Spearman ${rho.toFixed(2)} >= 0.7`);
    // per-landscape mean: climbs (gentle sawtooth: no landscape more than 1.5 below the previous one's level, overall rising)
    const land = lv.chapters.map((ch) => { const rs = live.filter((r) => r.ch === ch.index); return rs.reduce((s, r) => s + r.m.score, 0) / rs.length; });
    assert.ok(spearman(land.map((_, i) => i), land) >= 0.85, `landscape means rise (${land.map((v) => v.toFixed(1)).join(' ')})`);
    for (let i = 1; i < land.length; i++) assert.ok(land[i] >= land[i - 1] - 3.0, `landscape ${i} is not much easier than ${i - 1}`);
    // the end of the circuit is clearly more demanding than the start, but the slope is slow
    const head = land.slice(0, 3).reduce((s, v) => s + v, 0) / 3, tail = land.slice(10).reduce((s, v) => s + v, 0) / 3;
    assert.ok(tail > head + 4, `the last landscapes (${tail.toFixed(1)}) are clearly more demanding than the first (${head.toFixed(1)})`);
    // no difficulty step at a join: the first two live acts of landscape i+1 are within ~3.8 points of the last three of i (measured worst
    // over 6 circuits x 8 journeys: 3.6; single acts are noisy: a closing is a breather, a recall act re-plays an earlier lesson)
    const avg = (rs) => rs.reduce((s, r) => s + r.m.score, 0) / rs.length;
    for (let i = 0; i < 12; i++) {
      const prev = live.filter((r) => r.ch === i).slice(-3), next = live.filter((r) => r.ch === i + 1).slice(0, 2);
      assert.ok(avg(next) <= avg(prev) + 3.8, `join ${i}->${i + 1}: first acts ${avg(next).toFixed(2)} vs previous ${avg(prev).toFixed(2)}`);
      assert.ok(next[0].m.score <= Math.max(...prev.map((r) => r.m.score)) + 4.0, `join ${i}->${i + 1}: first act ${next[0].m.score.toFixed(2)} stays near the previous peak`);
    }
    // by construction the difficulty() the generator scales with is continuous across joins: the first act of a landscape is at most
    // ~1 difficulty point above the last act of the previous one
    for (let i = 0; i < 12; i++) {
      const prevLast = rows.filter((r) => r.ch === i).slice(-1)[0], nextFirst = rows.filter((r) => r.ch === i + 1)[0];
      assert.ok(nextFirst.d0 <= prevLast.d1 + 1.0, `join ${i}->${i + 1}: d ${nextFirst.d0} after ${prevLast.d1}`);
    }
    // gentle sawtooth: consecutive live acts never jump by more than ~9 points (breathers sit between peaks)
    for (let i = 1; i < live.length; i++) assert.ok(live[i].m.score - live[i - 1].m.score <= 9.5, `acts ${live[i - 1].id} -> ${live[i].id} steps up by ${(live[i].m.score - live[i - 1].m.score).toFixed(1)}`);
    // circuit 1's difficulty() really does go 0 -> ~11
    if (circuit === 1) { assert.equal(difficulty(0, 1, 0), 0); assert.ok(Math.abs(difficulty(12, 1, 1) - 11) < 0.1); }
  });
}

test('(g) the very first minutes are trivial and gentle', () => {
  const lv = levelOf(1);
  const early = lv.acts.filter((a) => a.ch === 0).slice(0, 3);
  for (const a of early) { const m = measureDemand(lv, a.x0, a.x1); assert.ok(m.peak <= 4.5 && m.score <= 6.5, `${a.id}: peak ${m.peak.toFixed(1)} score ${m.score.toFixed(1)}`); }
  // Meadow has no enemies, spikes, springs or crumbles until its very last act, and then only a gentle snail
  const ch0 = lv.chapters[0];
  const lastAct = lv.acts.filter((a) => a.ch === 0).slice(-1)[0];
  assert.equal(lv.hazards.filter((h) => h.x < ch0.x1).length, 0);
  assert.equal(lv.springs.filter((s) => s.x < ch0.x1).length, 0);
  assert.equal(lv.platforms.filter((p) => p.x < ch0.x1 && (p.motion || p.kind === 'crumble')).length, 0);
  const walkers = lv.enemies.filter((e) => e.x0 < ch0.x1);
  assert.ok(walkers.length >= 1, 'Meadow ends with a first, gentle snail');
  assert.ok(walkers.every((e) => e.kind === 'walker' && e.x0 >= lastAct.x0 && e.speed <= 30 && e.x0 > ch0.x1 * 0.8), 'only a gentle snail, only very late');
});

/* ═════════════════ (h) variety and signatures ═════════════════ */

const SIGNATURE = [
  /* 0 Meadow    */ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'gap' || e.kind === 'step'),
  /* 1 Clover    */ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'walker'),
  /* 2 Reedwater */ (lv, a) => lv.platforms.filter((p) => !p.o && p.kind === 'ledge' && p.x >= a.x0 && p.x < a.x1).map((p) => ({ x: p.x, h: 0 })),
  /* 3 Orchard   */ (lv, a) => lv.springs.filter((s) => s.x >= a.x0 && s.x < a.x1).map((s) => ({ x: s.x, h: 0 })),
  /* 4 Amber     */ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'crumble'),
  /* 5 Fogwood   */ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'flyer'),
  /* 6 Ember     */ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'spikes'),
  /* 7 Glass     */ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'lift'),
  /* 8 Lantern   */ (lv, a) => lv.platforms.filter((p, i, all) => p.kind === 'lift' && p.x >= a.x0 && p.x < a.x1 && all[i + 1] && all[i + 1].kind === 'crumble').map((p) => ({ x: p.x, h: 0 })),   // a lift that steps onto a crumbling ledge
  /* 9 Frostline */ (lv, a) => lv.platforms.filter((p) => p.ice && p.x >= a.x0 && p.x < a.x1).map((p) => ({ x: p.x, h: 0 })),
  /* 10 Moonridge*/ (lv, a) => eventsIn(lv, a.x0, a.x1).filter((e) => e.kind === 'mover'),
  /* 11 Dawnbridge*/ (lv, a) => lv.platforms.filter((p) => !p.o && p.kind === 'ground' && p.h === 140 && p.x >= a.x0 && p.x < a.x1).map((p) => ({ x: p.x, h: 0 })),   // the thick bridge deck
  /* 12 Summit   */ (lv, a) => [...lv.platforms.filter((p) => p.kind === 'lift' && p.x >= a.x0 && p.x < a.x1).map((p) => ({ x: p.x, h: 0 })), ...lv.springs.filter((s) => s.x >= a.x0 && s.x < a.x1).map((s) => ({ x: s.x, h: 0 }))],   // lifts and springs (the final climb is no longer lifts alone: bridges, walkers, spikes and movers join them)
];

test('(h) no two consecutive acts use the same template; each landscape is varied', () => {
  for (const circuit of CIRCUITS) {
    const lv = levelOf(circuit);
    for (let i = 1; i < lv.acts.length; i++) {
      assert.notEqual(lv.acts[i].id, lv.acts[i - 1].id, `acts ${i - 1}/${i} (circuit ${circuit}) repeat ${lv.acts[i].id}`);
    }
    for (const ch of lv.chapters) {
      const mine = lv.acts.filter((a) => a.ch === ch.index);
      assert.ok(mine.length >= 5 && mine.length <= 10, `landscape ${ch.index} has ${mine.length} acts`);
      assert.ok(new Set(mine.map((a) => a.id)).size === mine.length, 'a landscape does not repeat a template');
      const roles = new Set(mine.map((a) => a.role));
      for (const need of ['opening', 'breather', 'setpiece', 'closing']) if (circuit === 1) assert.ok(roles.has(need) || need === 'opening', `landscape ${ch.index} has a ${need} act`);
      for (const a of mine) { const len = (a.x1 - a.x0) / C; assert.ok(len >= 8 && len <= 86, `${a.id} lasts ${len.toFixed(0)} s (8..86: set pieces average ~60 s, the rest 15-45 s)`); }
    }
  }
  assert.ok(actNames().length >= 60, `${actNames().length} act templates`);
  assert.ok(beatNames().length >= 38, `${beatNames().length} beats`);
  const used = new Set(CIRCUITS.flatMap((c) => levelOf(c).acts.map((a) => a.id)));
  assert.ok(used.size >= 60, `${used.size} different act templates used across three circuits`);
});

test('(h) each landscape introduces its signature element alone, then grows it', () => {
  const lv = levelOf(1);
  for (let i = 0; i < 13; i++) {
    const acts = lv.acts.filter((a) => a.ch === i);
    const counts = acts.map((a) => SIGNATURE[i](lv, a).length);
    const first = counts.findIndex((n) => n > 0);
    assert.ok(first >= 0, `${CHAPTERS[i].name}: signature present`);
    if (i > 0) {
      assert.equal(acts[first].role, 'teach', `${CHAPTERS[i].name}: introduced in its teaching act (${acts[first].id})`);
      assert.ok(first >= 1, 'after a recall act');
    }
    // repeated with growing intensity: the later acts together carry more of it than the teaching act, and its peak act is later
    const teach = counts[first];
    const later = counts.slice(first + 1).reduce((s, n) => s + n, 0);
    assert.ok(later > teach * 1.2, `${CHAPTERS[i].name}: signature grows (${teach} then ${later})`);
    assert.ok(counts.slice(first + 1).filter((n) => n > 0).length >= 2, `${CHAPTERS[i].name}: appears in at least two later acts`);
    // intensity (mean hardness of its events) is lowest at the start: the first act is not the hardest
    const hs = acts.map((a, k) => { const ev = SIGNATURE[i](lv, a); return ev.length ? ev.reduce((s, e) => s + e.h, 0) / ev.length : null; });
    const live = hs.filter((h) => h !== null && h > 0);
    if (live.length >= 3) assert.ok(Math.max(...live.slice(1)) >= live[0] - 1.0, `${CHAPTERS[i].name}: the first signature act (${live[0].toFixed(1)}) is not harder than all later ones`);
  }
});

test('(h) new elements are introduced in order: nothing appears before its landscape', () => {
  const lv = levelOf(1);
  const kindsIn = (x0, x1) => {
    const k = new Set();
    for (const e of lv.enemies) { const x = e.x0 ?? e.cx; if (x >= x0 && x < x1) k.add(e.kind === 'walker' ? 'walker' : 'flyer'); }
    if (lv.hazards.some((h) => h.x >= x0 && h.x < x1)) k.add('spikes');
    if (lv.springs.some((s) => s.x >= x0 && s.x < x1)) k.add('spring');
    for (const p of lv.platforms) {
      if (p.x < x0 || p.x >= x1) continue;
      if (p.kind === 'crumble') k.add('crumble');
      if (p.kind === 'lift') k.add('lift');
      if (p.kind === 'mover') k.add('mover');
      if (p.ice) k.add('ice');
      if (!p.o && p.kind === 'ledge') k.add('logs');
    }
    return k;
  };
  const meadow = lv.chapters[0];
  for (const a of lv.acts) {
    for (const k of kindsIn(a.x0, a.x1)) {
      const intro = ELEMENT_INTRO[k];
      if (k === 'walker' && a.ch === 0) continue;            // Meadow's very last act: the gentle snail (tested separately)
      assert.ok(intro <= a.ch, `${k} appears in ${a.id} (landscape ${a.ch}) before landscape ${intro}`);
    }
  }
  void meadow;
  // the new element of a landscape is ALONE in its teaching act: no element introduced in a LATER landscape appears there
  for (const a of lv.acts.filter((x) => x.role === 'teach')) {
    const ks = kindsIn(a.x0, a.x1);
    for (const k of ks) assert.ok(ELEMENT_INTRO[k] <= a.ch);
  }
});

test('cues: story near the start, trail lines at their fractions, tips before first appearances, never crowded', () => {
  for (const circuit of CIRCUITS) {
    const lv = levelOf(circuit);
    const cues = lv.cues;
    for (let i = 1; i < cues.length; i++) assert.ok(cues[i].x - cues[i - 1].x >= 340, `cues ${i - 1}/${i} too close (${cues[i].x - cues[i - 1].x})`);
    for (const ch of lv.chapters) {
      const c = CHAPTERS[ch.index];
      const story = cues.find((q) => q.text === c.story);
      assert.ok(story && story.kind === 'story' && story.x >= (ch.index ? ch.x0 : lv.start.x) && story.x <= ch.x0 + 450, `${c.name}: story near its start`);
      const L = ch.x1 - ch.x0;
      for (const line of c.trail) {
        const q = cues.find((t) => t.text === line.text);
        assert.ok(q && q.kind === 'trail', `${c.name}: trail line present`);
        assert.ok(Math.abs((q.x - ch.x0) / L - line.at) <= 0.1, `${c.name}: trail line near its fraction (${((q.x - ch.x0) / L).toFixed(2)} vs ${line.at})`);
      }
      const tip = cues.find((t) => t.text === c.tip);
      assert.ok(tip && tip.kind === 'tip' && tip.x > ch.x0, `${c.name}: tip present`);
    }
    // tips come BEFORE the first appearance of the thing (checked for the signature kinds with a geometric first-appearance)
    const firstX = {
      1: lv.enemies.find((e) => e.kind === 'walker' && e.x0 >= lv.chapters[1].x0)?.x0,
      3: lv.springs.find((s) => s.x >= lv.chapters[3].x0)?.x,
      4: lv.platforms.find((p) => p.kind === 'crumble' && p.x >= lv.chapters[4].x0)?.x,
      5: lv.enemies.find((e) => e.kind === 'flyer' && e.cx >= lv.chapters[5].x0)?.cx,
      6: lv.hazards.find((h) => h.x >= lv.chapters[6].x0)?.x,
      7: lv.platforms.find((p) => p.kind === 'lift' && p.x >= lv.chapters[7].x0)?.x,
      9: lv.platforms.find((p) => p.ice && p.x >= lv.chapters[9].x0)?.x,
    };
    for (const [i, x] of Object.entries(firstX)) {
      const tip = cues.find((t) => t.text === CHAPTERS[i].tip);
      assert.ok(x === undefined || tip.x < x - 60, `${CHAPTERS[i].name}: tip (${tip.x}) comes before its first appearance (${x})`);
    }
  }
});

/* ═════════════════ (a)(b) the bot ═════════════════ */

/** A spread sample: per landscape the most demanding segment and one seeded-random one (FULL: all segments). */
function sample(lv, circuit) {
  const segs = segmentsOf(lv);
  if (FULL) return segs.map((s) => s.from);
  const r = rng(mixSeed(JOURNEY, circuit, 77));
  const picks = new Set();
  for (const ch of lv.chapters) {
    const mine = segs.filter((s) => s.ch === ch.index && s.x0 >= ch.x0);
    const scored = mine.map((s) => ({ s, d: measureDemand(lv, s.x0, s.x1).score }));
    scored.sort((a, b) => b.d - a.d);
    picks.add(scored[0].s.from);
    picks.add(r.pick(mine).from);
    if (ch.index % 4 === 0) picks.add(r.pick(mine).from);
  }
  picks.add(0); picks.add(segs.length - 1);
  return [...picks].sort((a, b) => a - b);
}

for (const circuit of BOT_CIRCUITS) {
  test(`(a) circuit ${circuit}: the planner bot reaches the next flag with zero hits and zero falls (jump-only, any clock phase)`, { timeout: 900000 }, () => {
    const lv = levelOf(circuit);
    const segs = segmentsOf(lv);
    const r = rng(mixSeed(JOURNEY, circuit, 5));
    const fails = [];
    let n = 0, cleanSum = 0, geoSum = 0;
    for (const i of sample(lv, circuit)) {
      const s = segs[i];
      const phase = r.range(0, 11);
      const res = playLevel(lv, { startCheckpoint: i, stopAtCheckpoint: s.to ?? undefined, allowSteer: false, iceBrake: false, tOffset: phase });
      n++;
      if (!res.ok) fails.push(`seg ${i} (landscape ${s.ch}, x ${Math.round(s.x0)}..${Math.round(s.x1)}, phase ${phase.toFixed(2)}): ${res.reason} at x=${Math.round(res.x)} (unsolved ${res.unsolved})`);
      else if (s.to !== null) {
        // the geometric clean time must be what the bot actually needs (no stalls, no extra waiting)
        const geo = (s.x1 - s.x0) / C;
        cleanSum += res.clean; geoSum += geo;
        assert.ok(Math.abs(res.clean - geo) <= 1.5, `seg ${i}: clean time ${res.clean.toFixed(1)} s vs ${geo.toFixed(1)} s from the geometry`);
      }
    }
    assert.deepEqual(fails, [], `${fails.length}/${n} segments failed:\n${fails.join('\n')}`);
    assert.ok(n >= 25, `${n} segments sampled`);
    assert.ok(Math.abs(cleanSum - geoSum) <= 0.01 * geoSum + 5, 'summed clean times match the geometry');
  });

  test(`(b) circuit ${circuit}: a human-noise bot (latency + jitter) gets through >= 90 % of runs`, { timeout: 900000 }, () => {
    const lv = levelOf(circuit);
    const segs = segmentsOf(lv);
    const r = rng(mixSeed(JOURNEY, circuit, 9));
    const runs = FULL ? 4 : 3;
    let ok = 0, total = 0;
    const bad = [];
    const byLand = new Map();
    for (const i of sample(lv, circuit)) {
      const s = segs[i];
      for (let k = 0; k < runs; k++) {
        const res = playLevel(lv, { startCheckpoint: i, stopAtCheckpoint: s.to ?? undefined, allowSteer: false, iceBrake: false, tOffset: r.range(0, 11), noise: { latency: 0.08, jitter: 0.05, seed: mixSeed(i, k, circuit), compensate: true } });
        total++;
        const L = byLand.get(s.ch) || { ok: 0, n: 0 };
        L.n++;
        if (res.ok) { ok++; L.ok++; } else bad.push(`seg ${i} (landscape ${s.ch}) run ${k}: ${res.reason} at ${Math.round(res.x)}`);
        byLand.set(s.ch, L);
      }
    }
    assert.ok(ok / total >= 0.9, `${ok}/${total} survived (${(100 * ok / total).toFixed(1)} %). Failures:\n${bad.slice(0, 12).join('\n')}`);
    for (const [ch, L] of byLand) assert.ok(L.ok / L.n >= 0.7, `landscape ${ch}: ${L.ok}/${L.n}`);
  });
}

test('(b) circuit 1: even a player who has NOT learnt their own 80 ms latency gets through almost always', { timeout: 600000 }, () => {
  const lv = levelOf(1);
  const segs = segmentsOf(lv);
  const r = rng(mixSeed(JOURNEY, 1, 13));
  let ok = 0, total = 0;
  const idx = FULL ? segs.map((s) => s.from) : sample(lv, 1);
  for (const i of idx) {
    const s = segs[i];
    for (let k = 0; k < 2; k++) {
      const res = playLevel(lv, { startCheckpoint: i, stopAtCheckpoint: s.to ?? undefined, allowSteer: false, iceBrake: false, tOffset: r.range(0, 11), noise: { latency: 0.08, jitter: 0.05, seed: mixSeed(i, k, 99), compensate: false } });
      total++; if (res.ok) ok++;
    }
  }
  assert.ok(ok / total >= 0.85, `${ok}/${total} survived without compensating latency`);
});

test('the bot only uses what a thumb has: jump-only on the main route (brake only on ice), actions at least 0.15 s apart', () => {
  const lv = levelOf(1);
  const segs = segmentsOf(lv);
  let acts = 0;
  for (const i of [2, 20, 45, 70, 95, 120, 140]) {
    const s = segs[i];
    const res = playLevel(lv, { startCheckpoint: i, stopAtCheckpoint: s.to ?? undefined, allowSteer: false, tOffset: 0.9, trace: true });
    assert.ok(res.ok, `seg ${i}`);
    const ice = lv.platforms.some((p) => p.ice && p.x < s.x1 && p.x + p.w > s.x0);
    for (let k = 0; k < res.log.length; k++) {
      const [t, a] = res.log[k];
      acts++;
      assert.ok(a === 'jump' || (ice && a === 'brake'), `seg ${i}: ${a} used outside ice`);
      if (k) assert.ok(t - res.log[k - 1][0] >= 0.15 - 1e-6, `seg ${i}: actions ${(t - res.log[k - 1][0]).toFixed(3)} s apart`);
    }
    assert.equal(res.steers, 0, 'no steering needed');
    assert.equal(res.hits + res.falls, 0);
  }
  assert.ok(acts >= 10);
  // with steering allowed the bot is never worse
  const s = segs[60];
  assert.ok(playLevel(lv, { startCheckpoint: 60, stopAtCheckpoint: s.to, allowSteer: true, tOffset: 2.2 }).ok);
});

test('FULL: the planner bot plays a whole circuit in ONE continuous run (no restarts) and lights the beacon in about an hour', { skip: !FULL, timeout: 3600000 }, () => {
  for (const circuit of BOT_CIRCUITS) {
    const lv = levelOf(circuit);
    const res = playLevel(lv, { allowSteer: false, maxSeconds: 4600, tOffset: 0.3 });
    assert.ok(res.ok, `circuit ${circuit}: ${res.reason} at x=${Math.round(res.x)} (beacon ${lv.beacon.x})`);
    assert.equal(res.reason, 'beacon');
    assert.ok(res.t / 60 >= T.journeyMinutes[0] && res.t / 60 <= T.journeyMinutes[1], `circuit ${circuit}: ${(res.t / 60).toFixed(1)} game minutes`);
    assert.ok(res.jumps > 300);
  }
});

test('(c) FULL pacing from the bot: summed clean times land in the journey window', { skip: !FULL, timeout: 3600000 }, () => {
  for (const circuit of BOT_CIRCUITS) {
    const lv = levelOf(circuit);
    const segs = segmentsOf(lv);
    const per = new Array(13).fill(0);
    for (const s of segs) {
      if (s.to === null) { per[12] += (lv.beacon.x - s.x0) / C; continue; }
      const res = playLevel(lv, { startCheckpoint: s.from, stopAtCheckpoint: s.to, allowSteer: false, tOffset: s.from * 1.3 });
      assert.ok(res.ok, `seg ${s.from}`);
      per[s.ch] += res.clean;
    }
    per.forEach((secs, i) => { const [lo, hi] = paceBand(i); assert.ok(secs >= lo && secs <= hi, `circuit ${circuit} landscape ${i}: ${secs.toFixed(1)} s in [${lo}, ${hi}]`); });
    const total = per.reduce((s, v) => s + v, 0) / 60;
    assert.ok(total >= T.journeyMinutes[0] && total <= T.journeyMinutes[1], `circuit ${circuit}: ${total.toFixed(1)} min`);
  }
});

/* ═════════════════ templates one by one ═════════════════ */

test('every beat template, at several difficulties and clock phases, is fair for the bot (jump-only)', { timeout: 900000 }, () => {
  const names = beatNames();
  const ds = FULL ? [0, 2, 5, 8, 11, D_MAX, 20] : [0, 6, 11, D_MAX];       // (the generator never asks beyond D_MAX; FULL also plays 20)
  const phases = FULL ? [0.2, 1.7, 4.9, 7.3] : [0.2, 3.1];
  const fails = [];
  let built = 0;
  for (const name of names) {
    let okBuilds = 0;
    const timed = FULL || /lift|mover|ferry|drop|descent|valley|cycle|logs|walker|flyer|moth|crumble|ice|bridgeWalker|spring/i.test(name);
    for (const d of ds) for (const seed of FULL ? [1, 2] : [1]) for (const k of [0.15, 0.9]) {
      const m = miniLevel(name, d, seed, { k });
      if (m.bad) continue;
      okBuilds++; built++;
      for (const tOffset of timed ? phases : phases.slice(0, 1)) {        // (only beats with something that moves on the clock need two game-clock phases)
        const res = playLevel(m.level, { allowSteer: false, stopAtCheckpoint: 1, tOffset });
        if (!res.ok) fails.push(`${name} d=${d} seed=${seed} k=${k} phase=${tOffset}: ${res.reason} at ${Math.round(res.x - m.x0)}/${Math.round(m.x1 - m.x0)}`);
      }
    }
    assert.ok(okBuilds >= 2, `${name}: builds at most difficulties`);
  }
  // Reedwater's logs bob: check them too (the beat only bobs in landscape 2)
  for (const d of ds) for (const seed of [1, 2]) for (const k of [0.15, 0.9]) {
    const m = miniLevel('logs', d, seed, { k, ch: 2 });
    if (m.bad) continue;
    assert.ok(m.level.platforms.some((p) => p.motion), 'the logs bob in Reedwater');
    for (const tOffset of phases) {
      const res = playLevel(m.level, { allowSteer: false, stopAtCheckpoint: 1, tOffset });
      if (!res.ok) fails.push(`bobbing logs d=${d} seed=${seed} k=${k} phase=${tOffset}: ${res.reason} at ${Math.round(res.x - m.x0)}/${Math.round(m.x1 - m.x0)}`);
    }
  }
  assert.deepEqual(fails, [], fails.join('\n'));
  assert.ok(built >= names.length * 2);
});

test('optional routes pay off: rolling onto a spring reaches the ledge in the branches; one swipe reaches an upper ledge', { timeout: 300000 }, () => {
  // springs: no swipe at all, she rolls onto the spring and must land on the optional ledge (and grab its golden egg)
  let landed = 0, tried = 0;
  for (const beat of ['springLedge', 'springTwo']) for (const d of [0, 8, 20]) for (const seed of [1, 2, 3]) {
    const m = miniLevel(beat, d, seed, {});
    assert.ok(!m.bad);
    const g = createGame(m.level, { flock: 0 });
    startRun(g);
    const seen = new Set();
    let golds = 0;
    for (let i = 0; i < 120 * 60 && g.status === 'running'; i++) {
      step(g, {});
      if (g.mama.onGround && g.mama.ground.o) seen.add(g.mama.ground.id);
      if (g.mama.x > m.x1 + 200) break;
    }
    golds = g.stats.golds;
    tried++;
    assert.equal(g.stats.falls + g.stats.hits, 0, `${beat} d=${d}: rolling over the spring is safe`);
    if (seen.size >= (beat === 'springTwo' ? 2 : 1) && golds >= 1) landed++;
  }
  assert.equal(landed, tried, 'every spring ledge is reached just by rolling onto the spring');
  // upper ledges: a swipe at the nominal takeoff (and inside its window) lands on the ledge
  for (const d of [0, 10, 20]) for (const seed of [1, 2, 3]) {
    const m = miniLevel('upper', d, seed, { k: 0.9 });
    const ledges = m.level.platforms.filter((p) => p.o);
    assert.ok(ledges.length >= 1);
    for (const L of ledges) {
      const rise = m.level.start.y - L.y;
      const F = C * flightTime(-rise);
      let ok = 0, n = 0;
      for (const f of [0.2, 0.5, 0.8]) {
        const xt = L.x - 7 + (L.w + 14) * f - F;
        const g = createGame(m.level, { flock: 0 });
        startRun(g);
        g.mama.x = xt - 200; g.mama.px = g.mama.x; g.mama.vx = C; g.mama.rollIn = 5;
        let jumped = false, onLedge = false;
        for (let i = 0; i < 120 * 6 && !onLedge; i++) {
          if (!jumped && g.mama.x >= xt) { act(g, 'jump'); jumped = true; }
          step(g, {});
          if (g.mama.onGround && g.mama.ground.id === L.id) onLedge = true;
        }
        n++; if (onLedge) ok++;
      }
      assert.ok(ok >= 2, `ledge at ${L.x} (rise ${rise}) is reachable with one swipe (${ok}/${n})`);
    }
  }
});

test('egg trails trace the real jump: a jump-only bot collects most of the eggs placed in the air over main-route gaps', { timeout: 600000 }, () => {
  const lv = levelOf(1);
  const segs = segmentsOf(lv);
  const plats = main(lv);
  let want = 0, got = 0, segsUsed = 0;
  for (let i = 4; i < segs.length - 1 && segsUsed < 22; i += 6) {
    const s = segs[i];
    const res = playLevel(lv, { startCheckpoint: i, stopAtCheckpoint: s.to, allowSteer: false, collect: true, tOffset: 1.1 });
    assert.ok(res.ok, `seg ${i}`);
    const taken = new Set(res.got);
    let any = false;
    for (let j = 0; j + 1 < plats.length; j++) {
      const p = plats[j], q = plats[j + 1];
      if (p.motion || q.motion || p.x < s.x0 + 80 || q.x > s.x1 - 80) continue;
      const gap = q.x - (p.x + p.w);
      if (gap < 20) continue;
      // the arc over this gap: eggs between the takeoff area and the landing, clear of the ground
      for (const e of lv.pickups) {
        if (e.kind !== 'egg' || e.x < p.x + p.w - 60 || e.x > q.x + 60 || e.y > Math.min(p.y, q.y) - 34 || e.y < Math.min(p.y, q.y) - 140) continue;
        want++; any = true;
        if (taken.has(e.id)) got++;
      }
    }
    if (any) segsUsed++;
  }
  assert.ok(want >= 40, `the sampled segments contain enough arcs over gaps (${want} eggs)`);
  assert.ok(got / want >= 0.6, `the bot collected ${got}/${want} (${(100 * got / want).toFixed(0)} %) of the arc eggs: the trails follow the real jump`);
});

test('rolling without ever jumping ends the attempt at the first real gap (the first gap needs the swipe)', () => {
  const lv = levelOf(1);
  const g = createGame(lv, { flock: 0 });
  startRun(g);
  let steps = 0;
  while (g.status === 'running' && steps++ < 120 * 200) step(g, {});
  assert.equal(g.status, 'dead', 'rolling without jumping ends the attempt');
  const first = lv.platforms.find((p, i) => lv.platforms[i + 1] && lv.platforms[i + 1].x > p.x + p.w + 38);
  assert.ok(g.mama.x < first.x + first.w + 60, `she is stopped by the first gap wider than she can mantle across (x ${Math.round(g.mama.x)} vs ${first.x + first.w})`);
  assert.ok(g.stats.falls >= 1);
});

test('the sim lets her walk across gaps of up to ~38 u between ground islands, so the generator never relies on them being required', () => {
  const mk = (gap) => ({ circuit: 1, seed: 1, start: { x: 600, y: 292 }, endX: 1e6, platforms: [{ id: 0, kind: 'ground', x: 0, y: 292, w: 1000, h: 100 }, { id: 1, kind: 'ground', x: 1000 + gap, y: 292, w: 800, h: 100 }], pickups: [], enemies: [], hazards: [], springs: [], checkpoints: [{ id: 0, x: 600, y: 292, platform: 0 }], beacon: null, cues: [], beats: [], water: null });
  const crossed = (gap) => { const g = createGame(mk(gap), { flock: 0 }); startRun(g); for (let i = 0; i < 120 * 8; i++) step(g, {}); return g.stats.falls === 0 && g.mama.x > 1000 + gap; };
  assert.equal(crossed(30), true, 'a 30 u gap is walked across');
  assert.equal(crossed(46), false, 'a 46 u gap needs a jump');
  assert.ok(levelOf(1).platforms.every((p, i, a) => !a[i + 1] || p.o || a[i + 1].o || p.motion || a[i + 1].motion || a[i + 1].x - p.x - p.w < 1 || a[i + 1].x - p.x - p.w >= 22), 'no gap narrower than 22 u between static platforms (lifts and movers have their own entry/exit rules, see e2)');
});

test('snapshotCarry / restore keeps flock and eggs across a flag restart', () => {
  const lv = levelOf(1);
  const g = createGame(lv, { eggs: 5, score: 50, flock: 3 }, { checkpoint: 4 });
  assert.deepEqual(snapshotCarry(g), { eggs: 5, score: 50, flock: 3 });
  assert.ok(typeof respawn === 'function' && typeof ROLLIN_LOSS === 'number' && typeof flightTime === 'function');
});

/* ═════════════════════════════════════════════════════════════════════════════
 * LEVELS-2. The measures below read the BUILT geometry (tests/felt.mjs); none of them looks at difficulty(), params.mjs or
 * any generator curve, so "it ramps" is no longer a statement about the generator's own yardstick.
 * ═════════════════════════════════════════════════════════════════════════════ */

const FELT_JOURNEYS = Array.from({ length: FULL ? 24 : 16 }, (_, j) => 900 + j * 7919);
const feltCache = new Map();
const feltOfCircuit = (circuit) => {
  if (!feltCache.has(circuit)) {
    const levels = FELT_JOURNEYS.map((j) => levelOf(circuit, j));
    feltCache.set(circuit, { levels, sum: feltSummary(levels), rows: levels.map(feltOf) });
  }
  return feltCache.get(circuit);
};
const avgOf = (a) => a.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / a.length;
const NAMES = CHAPTERS.map((c) => c.name);

/* ─────────────── (A) the felt ramp ─────────────── */

/**
 * What "required events a minute" means (tests/felt.mjs documents each): `density` counts every required event of a landscape over
 * its whole length (breathers, flag stations, opening and join included: what a child gets per minute of play); `liveDensity` only the
 * live acts without the flag stations; `liveInclDensity` everything but breathers and stations (opening and join in). Each exists
 * RAW (a moth, a spring that carries a gap, a cycling spike count as a whole event) and THREAT-WEIGHTED (`w...`: a moth counts the share
 * of the time a Mama who never jumps is hit by it, ~0.35; a high one she rolls under 0; a spring that carries a gap 0.25). The raw
 * count is the one Fogwood used to fool (25 moths = 25 events, 3.3 real events a minute): the threat-weighted ramp is the claim.
 */
for (const circuit of CIRCUITS) {
  test(`(A) circuit ${circuit}: required events per minute rise slowly from Meadow to the Summit, threat-weighted and raw, with and without the opening, the join, the breathers and the flag stations`, () => {
    const { sum } = feltOfCircuit(circuit);
    const R = sum.ramps, fmt = (k) => R[k].values.map((v) => v.toFixed(1)).join(' ');
    // the claim: the threat-weighted density, everything counted (Spearman >= 0.95, no landscape under 90 % of the one before)
    assert.ok(R.wDensity.spearman >= 0.95, `threat-weighted density: Spearman ${R.wDensity.spearman.toFixed(3)} >= 0.95 (${fmt('wDensity')})`);
    assert.ok(R.wDensity.minRatio >= 0.9, `threat-weighted density: lowest landscape / previous ${R.wDensity.minRatio.toFixed(2)} >= 0.9 (${fmt('wDensity')})`);
    // ...and with the breathers and flag stations left out (live acts only; or everything but them, opening and join counted)
    for (const k of ['wLiveDensity', 'wLiveInclDensity']) {
      assert.ok(R[k].spearman >= 0.93 && R[k].minRatio >= 0.88, `${k}: Spearman ${R[k].spearman.toFixed(3)} >= 0.93, lowest ratio ${R[k].minRatio.toFixed(2)} >= 0.88 (${fmt(k)})`);
    }
    // the raw count (a moth is a whole event, a spring too) climbs a little less cleanly by construction: Fogwood and Orchard carry more
    // moths and springs than their neighbours, which is exactly why it is not the claim
    for (const k of ['density', 'liveDensity', 'liveInclDensity']) {
      assert.ok(R[k].spearman >= 0.9 && R[k].minRatio >= 0.86, `${k} (raw): Spearman ${R[k].spearman.toFixed(3)} >= 0.9, lowest ratio ${R[k].minRatio.toFixed(2)} >= 0.86 (${fmt(k)})`);
    }
    const d = R.wDensity.values;
    assert.ok(d[0] >= 4.6 && d[0] <= (circuit === 1 ? 6.1 : 6.5), `Meadow asks ${d[0].toFixed(1)} threat-weighted events a minute (about 5-6)`);
    assert.ok(d[12] >= 10.3 && d[12] <= 13.0, `the Summit asks ${d[12].toFixed(1)} a minute (about 11-12)`);
    assert.ok(d[12] >= 1.7 * d[0], 'the Summit is clearly busier than Meadow');
    // the hole the first audit found: Fogwood (25 moths, few real events) must sit between its neighbours, not under them
    assert.ok(d[5] >= 0.95 * d[4] && d[5] <= 1.15 * d[6], `Fogwood (${d[5].toFixed(1)}) sits between Amber Quarry (${d[4].toFixed(1)}) and Ember Canyon (${d[6].toFixed(1)}); Orchard Heights (${d[3].toFixed(1)}) is no lower than ${(0.92 * d[2]).toFixed(1)}`);
    assert.ok(d[3] >= 0.92 * d[2], `Orchard Heights ${d[3].toFixed(1)} >= 92 % of Reedwater ${d[2].toFixed(1)}`);
    // the early game stays gentle: well under what the first generator asked (Meadow 7.2, Clover 7.2, Reedwater 11.9 a minute)
    const gentle = circuit === 1 ? [6.1, 6.8, 8.1] : [6.5, 7.1, 8.4];
    for (let i = 0; i < 3; i++) assert.ok(d[i] <= gentle[i], `${NAMES[i]} stays gentle (${d[i].toFixed(1)} <= ${gentle[i]})`);
  });

  test(`(A) circuit ${circuit}: chains lengthen, takeoff windows shrink, simultaneous demands appear, a failure never costs much to re-earn`, () => {
    const { sum } = feltOfCircuit(circuit);
    const L = sum.lands;
    const head = (k, n = 4) => avgOf(L.slice(0, n).map((l) => l[k])), tail = (k, n = 4) => avgOf(L.slice(13 - n).map((l) => l[k]));
    assert.ok(tail('chainMean') >= 1.25 * head('chainMean'), `mean chain length (events a second or two apart: singles, doubles, triples): ${head('chainMean').toFixed(2)} in the first four landscapes, ${tail('chainMean').toFixed(2)} in the last four`);
    assert.ok(tail('chain3') >= 1.5 * Math.max(0.05, head('chain3')), `share of events in a chain of three or more: ${head('chain3').toFixed(2)} -> ${tail('chain3').toFixed(2)}`);
    assert.ok(head('winMed', 3) - tail('winMed', 3) >= 0.05, `the median takeoff window shrinks: ${head('winMed', 3).toFixed(2)} s -> ${tail('winMed', 3).toFixed(2)} s`);
    for (const l of L) assert.ok(l.worst.winMin >= 0.36, `${NAMES[l.ch]}: no required hop or spike has a takeoff window under 0.36 s in the model (${l.worst.winMin.toFixed(2)})`);
    assert.ok(tail('comboShare', 6) >= head('comboShare', 6) + 0.02, `events with a different kind of demand right beside them (spike + gap, walker + gap, lift + hop): ${head('comboShare', 6).toFixed(2)} -> ${tail('comboShare', 6).toFixed(2)} of all events`);
    for (const l of L) assert.ok(l.flagToHardest <= 14, `${NAMES[l.ch]}: the hardest event of a segment is ${l.flagToHardest.toFixed(1)} s after its flag (<= 14 s to re-earn)`);
    // the early landscapes are singles and doubles; no chain longer than 4 events until the second half (whatever the circuit)
    for (const l of L.slice(0, 6)) assert.ok(l.worst.chainMax <= 4, `${NAMES[l.ch]}: longest chain ${l.worst.chainMax} (<= 4)`);
    for (const l of L) assert.ok(l.worst.chainMax <= 7, `${NAMES[l.ch]}: longest chain ${l.worst.chainMax} (<= 7)`);
  });
}

/** Spearman and lowest ratio of a series. */
const rampOf = (v) => ({ spearman: spearmanOf(v.map((_, i) => i), v), minRatio: Math.min(...v.slice(1).map((x, i) => x / v[i])) });

test('(A) the planner bot\'s JUMPS a minute climb too, and match the threat-weighted count landscape by landscape (Fogwood and Orchard are no longer holes in the ramp)', { timeout: 300000 }, () => {
  // a jump-only bot that jumps only when something needs it: the count of what a calm player really does, per minute of play
  const per = [];
  for (const [circuit, journey, stride] of [[1, JOURNEY, 1], [1, 7, 1]]) {
    const lv = levelOf(circuit, journey);
    const jumps = new Array(13).fill(0), secs = new Array(13).fill(0);
    for (const s of segmentsOf(lv)) {
      if (s.to === null || s.from % stride) continue;
      const r = playLevel(lv, { startCheckpoint: s.from, stopAtCheckpoint: s.to, allowSteer: false, tOffset: (s.from * 1.37) % 11 });
      assert.ok(r.ok, `segment ${s.from} cleared`);
      jumps[s.ch] += r.jumps; secs[s.ch] += (s.x1 - s.x0) / C;
    }
    per.push({ jumps, secs, w: feltOf(lv).map((r) => r.wDensity) });
  }
  const jpm = Array.from({ length: 13 }, (_, i) => (per[0].jumps[i] + per[1].jumps[i]) / ((per[0].secs[i] + per[1].secs[i]) / 60));
  const w = Array.from({ length: 13 }, (_, i) => (per[0].w[i] + per[1].w[i]) / 2);
  const fmt = jpm.map((v) => v.toFixed(1)).join(' ');
  const r = rampOf(jpm);
  assert.ok(r.spearman >= 0.9, `planner jumps a minute (${fmt}): Spearman ${r.spearman.toFixed(3)} >= 0.9`);
  assert.ok(r.minRatio >= 0.82, `planner jumps a minute (${fmt}): lowest landscape / previous ${r.minRatio.toFixed(2)} >= 0.82`);
  assert.ok(jpm[0] >= 4 && jpm[0] <= 6.5, `Meadow: ${jpm[0].toFixed(1)} jumps a minute`);
  assert.ok(jpm[12] >= 9.5 && jpm[12] <= 13, `Summit: ${jpm[12].toFixed(1)} jumps a minute`);
  // the first audit: Fogwood 3.5 jumps a minute (8.2 in Amber Quarry), Orchard 5.8 (7.4 counted)
  assert.ok(jpm[5] >= 0.9 * Math.min(jpm[4], jpm[6]), `Fogwood ${jpm[5].toFixed(1)} jumps a minute is no hole between Amber Quarry ${jpm[4].toFixed(1)} and Ember Canyon ${jpm[6].toFixed(1)}`);
  assert.ok(jpm[3] >= 0.9 * jpm[2], `Orchard Heights ${jpm[3].toFixed(1)} jumps a minute vs Reedwater ${jpm[2].toFixed(1)}`);
  // the weights are right: jumps a minute track the threat-weighted events a minute everywhere
  jpm.forEach((v, i) => assert.ok(v / w[i] >= 0.8 && v / w[i] <= 1.25, `${NAMES[i]}: ${v.toFixed(1)} planner jumps a minute vs ${w[i].toFixed(1)} threat-weighted events (ratio ${(v / w[i]).toFixed(2)} in [0.8, 1.25])`));
});

test('the threat model: every flyer\'s threat in the generator (phys.flyerThreat) and in the test measure (felt.flyerThreat) agree, and match a Mama who never jumps in the REAL sim, beat by beat', { timeout: 120000 }, () => {
  // 1. the generator's coarse estimate against the independent one, for every flyer of four circuits
  let n = 0;
  for (const circuit of [1, 2, 3, 4]) {
    const lv = levelOf(circuit);
    for (const e of lv.enemies) {
      if (e.kind !== 'flyer') continue;
      const gy = lv.platforms.filter((p) => !p.o && e.cx >= p.x && e.cx <= p.x + p.w).reduce((m, p) => Math.min(m, p.y), Infinity);
      const a = flyerThreatModel(e.ax, e.ay, gy - e.cy, e.period), b = flyerThreat(e, gy);
      assert.ok(Math.abs(a - b) <= 0.1, `flyer at ${e.cx}: generator ${a.toFixed(2)} vs test ${b.toFixed(2)}`);
      n++;
    }
  }
  assert.ok(n >= 50, `${n} flyers compared`);
  // 2. beat by beat: an idle Mama (never jumps) rolling through a built beat at 40 game-clock offsets, in the real sim
  const idleRate = (level) => {
    let hit = 0;
    const phases = 40;
    for (let k = 0; k < phases; k++) {
      const g = createGame(level, { flock: 0 }, { checkpoint: 0 });
      g.t = k * 0.37 + 0.11;
      startRun(g);
      for (let i = 0; i < 120 * 40 && g.status === 'running'; i++) {
        step(g, {});
        if (g.stats.hits > 0) { hit++; break; }
        if (g.stats.falls > 0 || g.mama.x > level.endX - 50) break;
      }
    }
    return hit / phases;
  };
  const rates = {};
  for (const beat of ['flyer1', 'flyerHigh', 'flyerPair', 'mothLane', 'mothSwarm', 'mothHill', 'mothDip']) {
    const sim = [], model = [];
    for (const seed of [1, 2, 3]) for (const d of [3, 6]) {
      const { level, bad } = miniLevel(beat, d, seed, { ch: 5 });
      if (bad) continue;
      sim.push(idleRate(level));
      model.push(1 - requiredEvents(level).filter((e) => e.cls === 'flyer').reduce((p, e) => p * (1 - e.w), 1));        // P(at least one hit)
    }
    const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    rates[beat] = { sim: m(sim), model: m(model) };
    assert.ok(sim.length >= 4, `${beat} builds`);
    if (beat === 'mothHill') assert.ok(rates[beat].sim <= rates[beat].model + 0.05, 'mothHill: she has to hop up to the plateau first, so an idle Mama never reaches the moth');
    else assert.ok(Math.abs(rates[beat].sim - rates[beat].model) <= 0.2, `${beat}: an idle Mama is hit ${(100 * rates[beat].sim).toFixed(0)} % of the time in the sim, the model says ${(100 * rates[beat].model).toFixed(0)} %`);
  }
  assert.ok(rates.flyerHigh.sim <= 0.05 && rates.flyerHigh.model <= 0.05, 'a high moth is passed UNDER: an idle Mama is never hit');
  for (const beat of ['flyer1', 'flyerPair', 'mothLane', 'mothSwarm', 'mothDip']) assert.ok(rates[beat].sim >= 0.1 && rates[beat].sim <= 0.85, `${beat}: a low moth is a real, but not certain, threat (${(100 * rates[beat].sim).toFixed(0)} %)`);
});

/* ─────────────── (B) no dead stretches ─────────────── */

for (const circuit of CIRCUITS) {
  test(`(B) circuit ${circuit}: no dead stretches: the wait for a required event stays short in every landscape (tail included), and something optional is always near`, () => {
    const { sum, rows, levels } = feltOfCircuit(circuit);
    let over = 0, total = 0;
    for (const lr of rows) for (const r of lr) { total++; if (r.gapMax > 26) over++; }
    assert.ok(over / total <= 0.01, `${(100 * over / total).toFixed(1)} % of landscape runs have a required-event gap over 26 s (<= 1 %)`);
    for (const l of sum.lands) {
      assert.ok(l.over26 <= 0.05, `${NAMES[l.ch]}: ${(100 * l.over26).toFixed(0)} % of its runs wait over 26 s for a required event (<= 5 %)`);
      assert.equal(l.over30, 0, `${NAMES[l.ch]}: no run waits over 30 s for a required event`);
      assert.ok(l.worst.gapMax <= 28, `${NAMES[l.ch]}: the longest wait for a required event outside a breather is ${l.worst.gapMax.toFixed(1)} s (<= 28; the dead-stretch guard carves a hop into any wait over ${(LIMIT_U / C).toFixed(0)}-${(LIMIT_EARLY_U / C).toFixed(0)} s)`);
      assert.ok(l.gapP90 <= 18.5, `${NAMES[l.ch]}: the typical long wait (p90 of the gaps) is ${l.gapP90.toFixed(1)} s (<= 18.5)`);
      assert.ok(l.worst.gapP90 <= 20, `${NAMES[l.ch]}: even the worst run's p90 is ${l.worst.gapP90.toFixed(1)} s (<= 20)`);
      assert.ok(l.worst.optGapMax <= 22, `${NAMES[l.ch]}: counting optional activity (egg arcs that want a jump, upper ledges, springs, golden eggs) nothing is ever quiet for more than ${l.worst.optGapMax.toFixed(1)} s (<= 22)`);
      assert.ok(l.worst.gapBreatherMax <= 42, `${NAMES[l.ch]}: even around a breather act the required-event gap is ${l.worst.gapBreatherMax.toFixed(1)} s (<= 42)`);
    }
    for (const lv of levels) for (const a of lv.acts) if (a.role === 'breather') assert.ok((a.x1 - a.x0) / C <= 30, `a breather act lasts ${((a.x1 - a.x0) / C).toFixed(0)} s (<= 30) and carries optional egg arcs`);
  });
}

test('(B) the dead-stretch guard: carved hops are ordinary, roomy, fairly placed gaps (flat ground each side, clear of flags, never in the opening, the join or a breather)', () => {
  let carved = 0;
  for (const circuit of CIRCUITS) for (const journey of [JOURNEY, 7, 424242]) {
    const lv = levelOf(circuit, journey);
    const beatsAt = lv.acts.flatMap((a) => a.beats.map((b, k) => ({ b, x: a.beatX[k], a })));
    for (const { b, x, a } of beatsAt) {
      if (b !== 'gapCarve') continue;
      carved++;
      assert.notEqual(a.role, 'breather', 'no hop in a breather');
      const ch = lv.chapters[a.ch];
      assert.ok(x >= ch.x0 + 1100 && x <= ch.x1 - 400, `a carved hop at ${x} keeps out of its landscape's opening and join`);
      const left = main(lv).find((p) => p.kind === 'ground' && !p.motion && Math.abs(p.x + p.w - x) <= 1);
      assert.ok(left && left.w >= 260, `a carved hop at ${x}: >= 260 u of ground before the gap (${left && left.w})`);
      const right = main(lv).find((p) => p.kind === 'ground' && !p.motion && p.x > x && p.x - x <= 70);
      assert.ok(right && right.w >= 260 && right.y === left.y, `a carved hop at ${x}: a level landing of >= 260 u`);
      const gap = right.x - (left.x + left.w);
      assert.ok(gap >= 40 && gap <= 62, `the carved gap is ${gap} u`);
      for (const c of lv.checkpoints) assert.ok(c.x <= x - 480 || c.x >= right.x + 330, `a carved hop at ${x} keeps clear of the flag at ${c.x} (>= 480 u of ground after a flag, >= 330 u before one)`);
    }
  }
  assert.ok(carved >= 20, `${carved} carved hops over ${CIRCUITS.length * 3} levels`);
});

/* ─────────────── (C) variety ─────────────── */

/** Beats that are structural variants of each landscape's signature element (names as the generator labels them). */
const SIG_VARIANTS = [
  /* Meadow     */ ['gap1', 'gapPair', 'gapChain', 'stepUp', 'stairs', 'gapHill', 'cliffHop'],
  /* Clover     */ ['walker1', 'walkerIsland', 'walkerPair', 'walkerStep', 'walkerWide'],
  /* Reedwater  */ ['logs', 'logsZig', 'logsRaft', 'logsLane', 'logsStairs'],
  /* Orchard    */ ['springLedge', 'springTwo', 'springGap', 'springTall', 'springChain', 'springHops', 'springBrake', 'springPush', 'branchSteps'],
  /* Amber      */ ['crumbleUpper', 'crumbleChain', 'crumbleBridge', 'crumbleStairs', 'crumbleSkip'],
  /* Fogwood    */ ['flyer1', 'flyerHigh', 'flyerPair', 'mothLane', 'mothSwarm', 'mothHill', 'mothDip'],
  /* Ember      */ ['spike1', 'spikeRow', 'spikeCycle', 'gapSpike', 'spikeStep'],
  /* Glass      */ ['liftRide', 'liftClimb', 'liftFerry', 'liftDrop', 'liftHop'],
  /* Lantern    */ ['liftCrumble', 'liftDescent', 'liftCrumbleChain', 'crumbleChain', 'crumbleSkip'],
  /* Frostline  */ ['iceRun', 'iceSteps', 'iceLeap', 'iceSpring'],
  /* Moonridge  */ ['moverFerry', 'ferryTwo', 'ferryStep', 'ferryWalker'],
  /* Dawnbridge */ ['bridge', 'bridgeMissing', 'bridgeArch', 'bridgePillars', 'bridgeWalker'],
  /* Summit     */ ['springGap', 'springHops', 'liftRide', 'liftClimb', 'liftHop', 'liftFerry', 'liftCrumble'],
];

for (const circuit of CIRCUITS) {
  test(`(C) circuit ${circuit}: variety: no beat type above ~33 % of a landscape, no geometry fingerprint above ~40 %, 10+ beat types from Clover on, 3+ structural variants of every signature`, () => {
    const { sum, rows, levels } = feltOfCircuit(circuit);
    for (const l of sum.lands) {
      assert.ok(l.worst.topShare <= 0.34, `${NAMES[l.ch]}: the most common beat type is ${(100 * l.worst.topShare).toFixed(0)} % of the landscape's beats (<= 34 %)`);
      if (l.ch >= 1) assert.ok(l.minDistinct >= 10, `${NAMES[l.ch]}: ${l.minDistinct} distinct beat types (>= 10)`);
      // the geometry fingerprint (felt.mjs: platform kinds, gap width, rise or drop for a hop; patrol length for a walker; width for spikes...)
      assert.ok(l.fpShare <= (l.ch === 0 ? 0.36 : 0.40), `${NAMES[l.ch]}: the biggest geometry fingerprint is ${(100 * l.fpShare).toFixed(0)} % of its required events on average (<= ${l.ch === 0 ? 36 : 40} %)`);
      assert.ok(l.worst.fpShare <= 0.5, `${NAMES[l.ch]}: and ${(100 * l.worst.fpShare).toFixed(0)} % in its worst run (<= 50 %)`);
    }
    // Dawnbridge used to be 88 % plain hops; walkers, spikes, movers, lifts and moths now share the broken bridge
    assert.ok(sum.lands[11].hopShare <= (circuit === 1 ? 0.72 : 0.82), `Dawnbridge: ${(100 * sum.lands[11].hopShare).toFixed(0)} % of its required events are plain hops (<= ${circuit === 1 ? 72 : 82} %)`);
    // the Summit is not just lifts: lift rides and exits are well under half of its events and springs, bridges, walkers, spikes... all turn up
    const lifts = sum.lands[12].fps.lift + sum.lands[12].fps.liftExit;
    const events = Object.values(sum.lands[12].fps).reduce((a, b) => a + b, 0);
    assert.ok(lifts / events <= 0.34, `Beacon Summit: lifts are ${(100 * lifts / events).toFixed(0)} % of its required events (<= 34 %)`);
    levels.forEach((lv, k) => {
      for (let i = 1; i < 13; i++) {
        const tally = rows[k][i].tally;
        const present = SIG_VARIANTS[i].filter((n) => tally[n]);
        assert.ok(present.length >= (circuit === 1 ? 3 : 2), `${NAMES[i]}: ${present.length} structural variants of its signature (${present.join(', ')}); needs >= 3`);
      }
      // set pieces: one per landscape, scripted, all different, each ends in the golden-egg crown
      const seqs = new Set();
      for (let i = 0; i < 13; i++) {
        const sp = lv.acts.filter((a) => a.ch === i && a.role === 'setpiece');
        assert.equal(sp.length, 1, `${NAMES[i]} has one set piece`);
        const beats = sp[0].beats;
        assert.equal(beats[beats.length - 1], 'crown', `${NAMES[i]}: the set piece ends in the golden-egg crown`);
        assert.ok(new Set(beats).size >= (i === 0 ? 2 : 3), `${NAMES[i]}: the set piece uses ${new Set(beats).size} different beats (>= ${i === 0 ? 2 : 3})`);
        seqs.add(beats.join(','));
      }
      if (circuit === 1) assert.equal(seqs.size, 13, 'every landscape has its own set piece (13 different sequences)');
    });
  });
}

/* ─────────────── (C) walls: the world does not stop her dead (F9) ─────────────── */

test('(C) walls: a zero-gap rise higher than she steps onto makes Mama stop dead, so it is rare (about 1 a landscape), and the first one of a journey has a caption before it', () => {
  let walls = 0, levels = 0;
  for (const circuit of CIRCUITS) for (const journey of [JOURNEY, 7, 31337, 424242]) {
    const lv = levelOf(circuit, journey);
    const ev = requiredEvents(lv).filter((e) => e.kind === 'step');
    levels++; walls += ev.length;
    assert.ok(ev.length <= 14, `circuit ${circuit} journey ${journey}: ${ev.length} walls in a whole circuit (<= 14)`);
    const perLand = new Array(13).fill(0);
    for (const e of ev) perLand[e.ch]++;
    perLand.forEach((n, i) => assert.ok(n <= 5, `${NAMES[i]}: ${n} walls (<= 5)`));
    if (ev.length) {
      const first = ev[0];
      const cue = lv.cues.find((c) => c.kind === 'tip' && /wall/i.test(c.text));
      assert.ok(cue && cue.x < first.x - 60, `the first wall (x=${first.x}, ${NAMES[first.ch]}) has a caption before it (${cue ? cue.x : 'none'})`);
    }
  }
  assert.ok(walls / levels <= 9, `${(walls / levels).toFixed(1)} walls a circuit on average (the first generator built about 30; <= 9)`);
});

/* ─────────────── (D) steering pays ─────────────── */

/** One scripted attempt at a spring sequence in the real sim: roll onto the spring, swipe `kind` (or nothing) `tau` s after launching. Returns golden eggs collected. */
function springAttempt(lv, kind, tau) {
  const sp = lv.springs[0];
  const g = createGame(lv, { flock: 0 }, { checkpoint: 0 });
  startRun(g);
  let launched = null, acted = false, golds = 0;
  for (let i = 0; i < 120 * 20 && g.status === 'running'; i++) {
    const m = g.mama;
    if (launched === null && !m.onGround && m.x > sp.x - 30 && m.vy < -300) launched = g.t;
    if (launched !== null && !acted && kind && g.t - launched >= tau) { act(g, kind); acted = true; }
    step(g, {});
    for (const e of g.events) if (e.type === 'gold') golds++;
    g.events.length = 0;
    if (m.x > sp.x + 700) break;
  }
  return golds;
}

/** An attempt at iceLeap: jump up onto the first optional ledge, wait `wait` s, (push), jump at its end. Returns golden eggs collected. */
function leapAttempt(lv, L1, L2, wait, edge, push) {
  const g = createGame(lv, { flock: 0 }, { checkpoint: 0 });
  startRun(g);
  const rise = lv.checkpoints[0].y - L1.y;
  const x1 = L1.x + 34 - C * flightTime(-rise);
  let landedAt = null, pushed = false, jumped2 = false, jumped1 = false, golds = 0;
  for (let i = 0; i < 120 * 16 && g.status === 'running'; i++) {
    const m = g.mama;
    if (!jumped1 && m.x >= x1) { act(g, 'jump'); jumped1 = true; }
    if (jumped1 && landedAt === null && m.onGround && m.ground && m.ground.id === L1.id) landedAt = g.t;
    if (landedAt !== null && push && !pushed && g.t - landedAt >= wait) { act(g, 'push'); pushed = true; }
    if (landedAt !== null && !jumped2 && m.x >= L1.x + L1.w - edge) { act(g, 'jump'); jumped2 = true; }
    step(g, {});
    for (const e of g.events) if (e.type === 'gold') golds++;
    g.events.length = 0;
    if (m.x > L2.x + L2.w + 100) break;
  }
  return golds;
}

test('(D) springs: a swipe in mid-air reaches the ledge a plain launch misses (brake: it is ~45 u short of where she lands, push: ~30 u beyond); with no steering she never collects it', () => {
  for (const [beat, want, ch] of [['springBrake', 'brake', 3], ['springPush', 'push', 3], ['iceSpring', null, 9]]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { level, bad } = miniLevel(beat, 8, seed, { ch });
      assert.ok(!bad, `${beat} builds (${bad})`);
      const ledge = level.platforms.find((p) => p.o), sp = level.springs[0];
      assert.ok(ledge && sp && ledge.o === 1, `${beat}: an optional ledge and a spring`);
      const kinds = want ? [want] : ['brake', 'push'];
      let best = 0;
      for (const kind of kinds) { let ok = 0; for (let tau = 0; tau <= 1.0001; tau += 0.05) if (springAttempt(level, kind, tau) > 0) ok++; best = Math.max(best, ok); }
      assert.ok(best >= 8, `${beat} seed ${seed}: ${best} of 21 swipe timings (a window of ${(best * 0.05).toFixed(2)} s) carry her to the golden egg`);
      assert.equal(springAttempt(level, null, 0), 0, `${beat} seed ${seed}: with no steering she flies past the ledge`);
    }
  }
});

test('(D) ice: a push just before the edge carries her over the 112 u leap to the golden egg; jump-only play never collects it', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { level, bad } = miniLevel('iceLeap', 8, seed, { ch: 9 });
    assert.ok(!bad, 'iceLeap builds');
    const [L1, L2] = level.platforms.filter((p) => p.o);
    const gap = L2.x - L1.x - L1.w;
    assert.ok(gap >= 108 && gap <= 118, `the leap is ${gap} u (beyond the ~105 u a jump at cruise can span)`);
    assert.ok(L1.ice && L2.ice, 'the optional ledges are slippery');
    let withPush = 0, without = 0;
    for (let wait = 0; wait <= 1.8; wait += 0.1) for (const edge of [-9, -6, -3, 0, 4, 8, 12]) {
      if (leapAttempt(level, L1, L2, wait, edge, true) > 0) withPush++;
      if (leapAttempt(level, L1, L2, wait, edge, false) > 0) without++;
    }
    assert.ok(withPush >= 15, `seed ${seed}: ${withPush} of ${19 * 7} push + jump timings reach the golden egg`);
    assert.equal(without, 0, `seed ${seed}: no jump-only timing reaches it`);
  }
});

test('(D) ice, measured: a push helps the leap only within ~0.6 s before the takeoff or ~0.25 s into the jump (a push 0.9 s before has run out); a brake never helps', () => {
  const { level, bad } = miniLevel('iceLeap', 8, 2, { ch: 9 });
  assert.ok(!bad);
  const [L1, L2] = level.platforms.filter((p) => p.o);
  // push `tb` s before reaching the edge (and jump at the edge), or `ta` s after the takeoff; kind 'push' | 'brake'
  const attempt = ({ before = null, after = null, kind = 'push' }) => {
    const g = createGame(level, { flock: 0 }, { checkpoint: 0 });
    startRun(g);
    const rise = level.checkpoints[0].y - L1.y;
    const x1 = L1.x + 34 - C * flightTime(-rise);
    let jumped1 = false, landed = false, jumpedT = null, golds = 0, pushedA = false, pushedB = false;
    for (let i = 0; i < 120 * 16 && g.status === 'running'; i++) {
      const m = g.mama;
      if (!jumped1 && m.x >= x1) { act(g, 'jump'); jumped1 = true; }
      if (jumped1 && !landed && m.onGround && m.ground && m.ground.id === L1.id) landed = true;
      if (landed && jumpedT === null) {
        const tt = (L1.x + L1.w - m.x) / Math.max(60, m.vx);
        if (before !== null && !pushedB && tt <= before) { act(g, kind); pushedB = true; }
        if (m.x >= L1.x + L1.w) { act(g, 'jump'); jumpedT = g.t; }
      }
      if (jumpedT !== null && after !== null && !pushedA && g.t - jumpedT >= after) { act(g, 'push'); pushedA = true; }
      step(g, {});
      for (const e of g.events) if (e.type === 'gold') golds++;
      g.events.length = 0;
      if (m.x > L2.x + L2.w + 100) break;
    }
    return golds > 0;
  };
  for (const tb of [0, 0.2, 0.4, 0.55]) assert.ok(attempt({ before: tb }), `a push ${tb} s before the takeoff carries her across`);
  for (const tb of [0.8, 1.0, 1.3]) assert.ok(!attempt({ before: tb }), `a push ${tb} s before the takeoff has run out`);
  for (const ta of [0, 0.1, 0.2]) assert.ok(attempt({ after: ta }), `a push ${ta} s into the jump still carries her across`);
  for (const ta of [0.4, 0.6]) assert.ok(!attempt({ after: ta }), `a push ${ta} s into the jump is too late`);
  for (const tb of [0, 0.3, 0.6, 1.0, 1.5]) assert.ok(!attempt({ before: tb, kind: 'brake' }), `a brake ${tb} s before the takeoff never helps`);
});

test('(D) optional means optional: every optional platform hangs over an unbroken main route, and the steering beats add nothing required', () => {
  for (const circuit of [1, 2]) for (const journey of [JOURNEY, 7, 31337]) {
    const lv = levelOf(circuit, journey);
    const mainP = main(lv).filter((p) => !isDyn(p));            // Reedwater's logs bob a little: they still carry her
    for (const p of lv.platforms) {
      if (!p.o) continue;
      const under = (x) => mainP.some((m) => x >= m.x && x <= m.x + m.w && m.y > p.y + 20);
      assert.ok(under(p.x + 2) && under(p.x + p.w / 2) && under(p.x + p.w - 2), `optional ${p.kind} at ${p.x},${p.y}: main-route ground (or a log) under both ends and the middle, so falling costs nothing`);
      assert.ok(under(p.x + p.w + 36) || mainP.some((m) => p.x + p.w + 36 >= m.x - 7 && p.x + p.w + 36 <= m.x + m.w + 7), `optional ${p.kind} at ${p.x},${p.y}: stepping off its end lands on the main route (not in a pit)`);
    }
  }
  for (const [beat, ch] of [['iceLeap', 9], ['springBrake', 3], ['springPush', 3], ['iceSpring', 9]]) {
    for (const seed of [1, 2, 3]) {
      const { level, bad } = miniLevel(beat, 8, seed, { ch });
      assert.ok(!bad);
      const mainEv = requiredEvents(level);
      assert.equal(mainEv.length, 0, `${beat}: no required event (${mainEv.map((e) => e.kind).join(',')}) inside the optional sequence`);
    }
  }
});

test('(D) Frostline carries several optional ice sequences, the later landscapes recall them lightly, and the chapter words are true to the mechanic', () => {
  for (const circuit of [1, 2]) {
    const { rows } = feltOfCircuit(circuit);
    rows.forEach((r, k) => {
      const ice = (r[9].tally.iceLeap || 0) + (r[9].tally.iceSpring || 0);
      assert.ok(ice >= (circuit === 1 ? 2 : 1), `circuit ${circuit} journey ${k}: Frostline has ${ice} optional ice sequences (>= ${circuit === 1 ? 2 : 1})`);
    });
  }
  const { rows } = feltOfCircuit(1);
  const mean = (i, names) => avgOf(rows.map((r) => names.reduce((s, n) => s + (r[i].tally[n] || 0), 0)));
  assert.ok(mean(9, ['iceLeap', 'iceSpring']) >= 2.5, `Frostline: ${mean(9, ['iceLeap', 'iceSpring']).toFixed(1)} ice sequences a landscape on average (>= 2.5)`);
  assert.ok(mean(3, ['springBrake', 'springPush']) >= 2, `Orchard: ${mean(3, ['springBrake', 'springPush']).toFixed(1)} spring steering sequences (>= 2)`);
  // every ice platform is in Frostline (iceMode) or one of the optional recalls
  const lv = levelOf(1, JOURNEY);
  for (const p of lv.platforms) if (p.ice && !p.o) assert.equal(p.ch, 9, 'required ice only in Frostline');
  // words: EXACTLY true. Measured in the sim (iceLeap, the 112 u leap): a push carries her across only if it is issued within about the last
  // 0.6 s before the takeoff or up to ~0.25 s into the jump (a push issued 0.7 s or more before has run out, on ice and on plain ground
  // alike), a brake never helps, and ice only makes her slow to speed up and slow to slow down. So the words say that, modestly.
  const f = CHAPTERS[9];
  for (const text of [f.story, f.learn, f.tip]) assert.ok(/ice|slippery|frost/i.test(text), `${text}: about ice`);
  assert.ok(/slow to speed up/i.test(f.learn) && /slow to slow down/i.test(f.learn) && /push/i.test(f.learn) && /just before you jump|mid-air/i.test(f.learn), 'the learn text says what ice does (slow to speed up and slow down) and when a push pays (just before the jump or in mid-air)');
  assert.ok(!/early/i.test(`${f.story} ${f.learn} ${f.tip}`), 'no word asks for an EARLY push or brake (an early push has run out; an early brake is never rewarded)');
  assert.ok(!/must|have to|required/i.test(`${f.story} ${f.learn} ${f.tip}`), 'no word says a swipe is required');
  assert.ok(/steer/i.test(CHAPTERS[3].learn) && /mid-air/i.test(CHAPTERS[3].learn), 'Orchard teaches steering in mid-air');
});

/* ─────────────── (E) child-friendliness ─────────────── */

test('(E) spikes: generous room after a landing, the first two spike landscapes never ask for a spike and a gap together, and a little help comes before the first hazards', () => {
  for (const circuit of [1, 2]) for (const journey of [JOURNEY, 7, 424242]) {
    const lv = levelOf(circuit, journey);
    const plats = main(lv).filter((p) => p.kind === 'ground' && !p.motion);
    const ev = requiredEvents(lv);
    for (const h of lv.hazards) {
      const ch = lv.platforms.find((p) => p.kind === 'ground' && h.x >= p.x && h.x + h.w <= p.x + p.w && p.y === h.y).ch;
      const own = plats.find((p) => h.x >= p.x && h.x + h.w <= p.x + p.w && p.y === h.y);
      assert.ok(h.x - own.x >= (ch <= 7 ? 160 : 120) || own.x === plats[0].x, `spikes at ${h.x} (${NAMES[ch]}): ${(h.x - own.x).toFixed(0)} u after the start of their platform`);
      if (ch === 6 || ch === 7) {
        // nothing required within 2 s AFTER a spike (no spike -> gap in Ember and Glass Coast)
        const next = ev.find((e) => e.x > h.x + h.w + 10 && e.cls !== 'spike');
        assert.ok(!next || next.x - (h.x + h.w) >= 2.2 * C, `spikes at ${h.x} (${NAMES[ch]}): the next required event is ${((next.x - h.x - h.w) / C).toFixed(1)} s later (>= 2.2 s)`);
      }
    }
    // the first walkers, moths and spikes each get a golden egg on the flag before them (and, from the 3rd landscape on, a shield)
    for (const [i, shield] of [[1, false], [5, true], [6, true]]) {
      const ch = lv.chapters[i];
      const teach = lv.acts.find((a) => a.ch === i && a.role === 'teach');
      const near = lv.pickups.filter((q) => q.x >= teach.x0 - 20 && q.x < teach.x0 + 900);
      assert.ok(near.some((q) => q.kind === 'gold'), `${NAMES[i]}: a golden egg on the flag before the first hazard`);
      if (shield) assert.ok(near.some((q) => q.kind === 'shield'), `${NAMES[i]}: a shield too`);
      void ch;
    }
  }
});

/**
 * Imperfect players, segment by segment (flag to flag, no flock, so every hit ends the try). Thresholds are the measured rates of the
 * generator with a margin for the sample, not the old loose floors (sloppy >= 70 % per landscape / 90 % overall when the actual was 100 %;
 * mash >= 12 % / 25 % when it was 36 %): a regression of a few points now fails.
 */
test('(E) imperfect players: a calm but sloppy bot (80 ms unnoticed latency, +-80 ms jitter), a clumsy small child (120 ms, +-120 ms) and a button-mashing toddler each make sensible progress through every landscape', { timeout: 900000 }, () => {
  const pool = (kind, circuits, o) => {
    const ok = new Array(13).fill(0), runs = new Array(13).fill(0);
    for (const [c, j] of circuits) { const r = clearRates(levelOf(c, j), { kind, ...o }); r.ok.forEach((v, i) => { ok[i] += v; runs[i] += r.runs[i]; }); }
    return { rates: ok.map((v, i) => v / Math.max(1, runs[i])), overall: ok.reduce((a, b) => a + b, 0) / runs.reduce((a, b) => a + b, 0), runs };
  };
  const pct = (r) => r.rates.map((v) => (100 * v).toFixed(0)).join(' ');
  // sloppy: measured 100 % everywhere
  const sloppy = pool('sloppy', FULL ? [[1, JOURNEY], [2, JOURNEY], [1, 7]] : [[1, JOURNEY], [2, JOURNEY]], { trials: 1, stride: FULL ? 1 : 4, seed: 5 });
  sloppy.rates.forEach((r, i) => assert.ok(r >= 0.75, `${NAMES[i]}: the sloppy bot clears ${(100 * r).toFixed(0)} % of its flag-to-flag segments (>= 75 %) [${pct(sloppy)}]`));
  assert.ok(sloppy.overall >= 0.97, `the sloppy bot clears ${(100 * sloppy.overall).toFixed(0)} % overall (>= 97 %)`);
  // clumsy: every jump arrives 0-240 ms late. Spikes were the one element that caught it (Ember Canyon 62 %); narrow thorns (window 0.44 s
  // against 0.35 s) bring it to ~90 %: measured Ember 88-91 %, Glass 96-100 %, nothing under 83 %, overall 94-97 %
  const clumsy = pool('clumsy', FULL ? [[1, JOURNEY], [2, JOURNEY], [1, 7], [3, JOURNEY]] : [[1, JOURNEY], [2, JOURNEY]], { trials: 1, stride: FULL ? 1 : 2, seed: 7 });
  const floor = FULL ? 0.8 : 0.72;
  clumsy.rates.forEach((r, i) => assert.ok(r >= (i === 6 || i === 7 ? (FULL ? 0.8 : 0.75) : floor), `${NAMES[i]}: the clumsy child clears ${(100 * r).toFixed(0)} % of its segments (Ember / Glass >= ${FULL ? 80 : 75} %, the rest >= ${(100 * floor).toFixed(0)} %) [${pct(clumsy)}]`));
  assert.ok(clumsy.overall >= (FULL ? 0.93 : 0.91), `the clumsy child clears ${(100 * clumsy.overall).toFixed(0)} % overall`);
  // the mashing toddler (no plan: jumps the instant she lands, random extra jumps and swipes)
  const mash = pool('mash', [[1, JOURNEY], [2, JOURNEY]], { trials: 6, seed: 3 });
  mash.rates.forEach((r, i) => assert.ok(r >= 0.11, `${NAMES[i]}: the mashing toddler (no ducklings, no shield: one hit ends the try) still clears ${(100 * r).toFixed(0)} % of segments (>= 11 %) [${pct(mash)}]`));
  assert.ok(mash.overall >= 0.26, `the mashing toddler clears ${(100 * mash.overall).toFixed(0)} % of all segments (>= 26 %) [${pct(mash)}]`);
  assert.ok(avgOf(mash.rates.slice(0, 3)) >= 0.36, `the first three landscapes are the kindest to her (${(100 * avgOf(mash.rates.slice(0, 3))).toFixed(0)} % >= 36 %)`);
  assert.ok(mash.rates[0] >= 0.4 && mash.rates[1] >= 0.38, `Meadow ${(100 * mash.rates[0]).toFixed(0)} % >= 40 %, Clover Mill ${(100 * mash.rates[1]).toFixed(0)} % >= 38 %`);
  // Fogwood stays the masher's hardest landscape before Ember (a button-masher jumps INTO moths; measured 17-21 % against 25-37 % around it,
  // and 22 % before the rebuild): it must not get worse
  assert.ok(mash.rates[5] >= 0.15, `Fogwood: the masher clears ${(100 * mash.rates[5]).toFixed(0)} % (>= 15 %)`);
});

/* ─────────────── (F) takeoff windows measured in the REAL sim ─────────────── */

/**
 * LEVELS-2 audit. phys.jumpWindow / spikeWindow are the generator's own model (checked against the sim only for a handful of
 * synthetic cases), and tests/felt.mjs reads its windows from that model. This measures every hop and spike of the BUILT world by
 * playing it: a one-runway world with just the departing platform and the landing, a real Mama rolling at cruise, a swipe up at
 * every 3 u of takeoff position, and a count of the takeoffs that land on the next platform (or clear the spike) without a hit
 * or a fall. Lifts and movers are skipped (their windows depend on the clock; the bot sweeps cover them).
 */
function simTrial(plats, hazards, xj, done) {
  const lv = {
    circuit: 1, seed: 1, start: { x: plats[0].x + 5, y: plats[0].y }, endX: 1e9,
    platforms: plats.map((p, i) => ({ id: i, h: p.kind === 'ground' ? 100 : 14, ch: 0, ...p })),
    pickups: [], enemies: [], hazards, springs: [], checkpoints: [{ id: 0, x: plats[0].x + 10, y: plats[0].y, platform: 0, ch: 0 }],
    beacon: null, cues: [], beats: [], water: null,
  };
  const g = createGame(lv, { flock: 0 });
  startRun(g);
  let jumped = false;
  for (let i = 0; i < 120 * 6; i++) {
    if (!jumped && g.mama.onGround && g.mama.x >= xj) { act(g, 'jump'); jumped = true; }
    step(g, {});
    if (g.events.length) g.events.length = 0;
    if (g.status !== 'running' || g.stats.falls || g.stats.hits) return false;
    if (jumped && g.mama.onGround && done(g)) return true;
  }
  return false;
}
const iceOf = (p) => (p.ice ? { ice: true } : {});
/** Seconds (at cruise) of takeoff positions that land on b from a. */
function simHopWindow(a, b) {
  const end = a.x + a.w;
  const plats = [{ kind: a.kind, x: end - 300, y: a.y, w: 300, ...iceOf(a) }, { kind: b.kind, x: b.x, y: b.y, w: Math.min(b.w, 300), ...iceOf(b) }];
  let n = 0;
  for (let xj = end - 130; xj <= end + 8; xj += 3) if (simTrial(plats, [], xj, (g) => g.mama.ground.id === 1)) n++;
  return (3 * n) / C;
}
/** Seconds of takeoff positions that clear the (non-cycling) spikes h standing on platform a. */
function simSpikeWindow(a, h) {
  const plats = [{ kind: a.kind, x: h.x - 300, y: a.y, w: 300 + h.w + 300, ...iceOf(a) }];
  let n = 0;
  for (let xj = h.x - 110; xj <= h.x + 6; xj += 3) if (simTrial(plats, [{ id: 0, kind: 'spikes', x: h.x, y: a.y, w: h.w }], xj, (g) => g.mama.x > h.x + h.w + 25)) n++;
  return (3 * n) / C;
}

test('(F) takeoff windows MEASURED in the real sim, circuits 1-4 (1-6 under FULL): every hop >= 0.30 s, every spike >= 0.40 s, and the first landscapes are roomier than the last', { timeout: 600000 }, () => {
  for (const circuit of CIRCUITS) for (const journey of FULL ? [JOURNEY, 7, 31337] : [JOURNEY]) {
    const lv = levelOf(circuit, journey);
    const all = main(lv);
    const st = all.filter((p) => !isDyn(p));
    const hops = Array.from({ length: 13 }, () => []), spikes = [];
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i], b = st[i + 1];
      if (b.x - (a.x + a.w) <= 6) continue;                                                       // contiguous ground (or a step): no gap to jump
      if (all.some((p) => isDyn(p) && p.x + p.w > a.x + a.w - 5 && p.x < b.x + 5)) continue;      // a lift or mover sits in this gap
      // (circuit 1 measures every hop; later circuits only the narrow ones and Meadow's: the model's window is within ~0.15 s of the sim's, so a model window
      // of 0.52 s or more cannot be under 0.30 s measured. The generator's model windows are asserted separately for every hop and circuit.)
      const model = jumpWindow({ end: a.x + a.w, top: a.y, kind: kindOf(a.kind) }, { x: b.x, end: b.x + b.w, top: b.y, kind: kindOf(b.kind) }).secs;
      if (circuit > 1 && model >= 0.52 && !FULL && a.ch !== 0) continue;           // (Meadow's hops are always all measured: the later-circuit start is asserted below)
      const w = simHopWindow(a, b);
      hops[a.ch].push(w);
      assert.ok(w >= 0.30, `circuit ${circuit} journey ${journey}: the hop at x=${a.x + a.w} (${NAMES[a.ch]}: ${a.kind} -> ${b.kind}, gap ${b.x - a.x - a.w}) has a measured takeoff window of ${w.toFixed(2)} s (>= 0.30)`);
    }
    for (const h of lv.hazards) {
      if (h.cycle) continue;
      const a = st.find((p) => h.x >= p.x && h.x + h.w <= p.x + p.w);
      assert.ok(a, `spikes at ${h.x} stand on static main-route ground`);
      const w = simSpikeWindow(a, h);
      spikes.push(w);
      assert.ok(w >= 0.40, `circuit ${circuit} journey ${journey}: spikes ${h.w} u wide at x=${h.x} (${NAMES[a.ch]}) have a measured takeoff window of ${w.toFixed(2)} s (>= 0.40)`);
    }
    assert.ok(spikes.length >= 8, 'the world has spikes to measure');
    const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
    const head = avgOf([0, 1, 2].map((i) => med(hops[i]))), tail = avgOf([10, 11, 12].map((i) => med(hops[i])));
    if (circuit === 1 || FULL) assert.ok(head - tail >= 0.04, `circuit ${circuit} journey ${journey}: the median measured hop window shrinks from ${head.toFixed(2)} s (Meadow-Reedwater) to ${tail.toFixed(2)} s (Moonridge-Summit)`);
    // later circuits start as roomy as circuit 2's Meadow (measured 0.49-0.52 s; circuits 3 and 4 used to be 0.45 and 0.42 s)
    if (circuit >= 2) assert.ok(med(hops[0]) >= 0.46, `circuit ${circuit} journey ${journey}: Meadow's median measured hop window ${med(hops[0]).toFixed(2)} s >= 0.46`);
  }
});
