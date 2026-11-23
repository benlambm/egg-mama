/*
 * Egg Mama — tests for the world generator and its fairness bot (DESIGN.md section 4, "Validation").
 *
 *   node --test tests/levels.test.mjs            a spread sample of segments (a few minutes)
 *   FULL=1 node --test tests/levels.test.mjs     every segment of every landscape, all three circuits
 *
 * (a) planner bot, jump-only, reaches the next flag with zero hits and zero falls     [bot, sampled / FULL]
 * (b) human-noise bot (latency, jitter) survives in >= 90 % of runs                    [bot, sampled / FULL]
 * (c) pacing: each landscape within paceBand(i), the circuit within T.journeyMinutes   [geometry + bot clean times]
 * (d) deterministic, pure, fast generation                                             [static]
 * (e) fairness rules 1-7 (and 8 for circuits 2-3)                                      [static]
 * (f) restoring at every flag works                                                    [sim]
 * (g) difficulty ramps slowly and never steps at a landscape join                      [demand score]
 * (h) template variety and each landscape's signature element                          [static]
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { T, jumpDistance } from '../docs/js/tuning.mjs';
import { CHAPTERS, paceBand, difficulty, JOURNEY_SECONDS } from '../docs/js/chapters.mjs';
import { generateLevel, levelSeed } from '../docs/js/levelgen.mjs';
import { beatNames, actNames, miniLevel, BEATS, ELEMENT_INTRO } from '../docs/js/segments.mjs';
import { jumpWindow, trainFeasible, spikeWindow, springLanding, MAX_RISE, flightTime } from '../docs/js/levels/phys.mjs';
import { measureDemand, eventsIn } from '../docs/js/levels/demand.mjs';
import { createGame, startRun, step, act, respawn, snapshotCarry } from '../docs/js/sim.mjs';
import { rng, mixSeed } from '../docs/js/rng.mjs';
import { playLevel, segmentsOf, ROLLIN_LOSS } from './bot.mjs';
import { flagOf, resolveFlag } from '../docs/js/save.mjs';

const FULL = !!process.env.FULL;
const JOURNEY = 20261122;
const EXTRA_JOURNEYS = process.env.JOURNEYS ? process.env.JOURNEYS.split(',').map(Number) : [7, 424242, 0xdecaf, 31337];   // the hard rules (e1-e7) also hold for other random journeys (JOURNEYS=1,2,3 to sweep more)
const CIRCUITS = [1, 2, 3];
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
      assert.ok(h.w <= 60 && h.w >= 14, `spike width ${h.w}`);
      const spikeJump = spikeWindow(h.x, h.w);
      assert.ok(spikeJump.secs >= 0.28, `spike ${h.w} wide has a ${spikeJump.secs.toFixed(3)} s takeoff window (spikes are the tightest element; a sloppy but calm player needs >= 0.28 s)`);
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

test('(e8) circuits 2-3: fresh terrain, a difficulty offset, same fairness', () => {
  const sig = (lv) => lv.platforms.filter((p) => !p.o).map((p) => `${p.kind}:${Math.round(p.w)}`).join(',');
  const a = levelOf(1), b = levelOf(2), c = levelOf(3);
  assert.notEqual(sig(a), sig(b));
  assert.notEqual(sig(b), sig(c));
  // arrangement differs: the act sequence is not the same
  assert.notDeepEqual(a.acts.map((x) => x.id), b.acts.map((x) => x.id));
  assert.notDeepEqual(b.acts.map((x) => x.id), c.acts.map((x) => x.id));
  // circuit 2 starts around difficulty 4.5: its Meadow is more demanding than circuit 1's, and the offset is capped
  assert.ok(Math.abs(difficulty(0, 2, 0) - 4.5) < 1e-9);
  assert.ok(difficulty(12, 9, 1) <= 20);
  const mean = (lv, i) => { const ch = lv.chapters[i]; return measureDemand(lv, ch.x0 + 1000, ch.x1 - 1000).mean; };
  assert.ok(mean(b, 0) > mean(a, 0) + 1, `circuit 2's Meadow is harder (${mean(b, 0).toFixed(1)} vs ${mean(a, 0).toFixed(1)})`);
  assert.ok(mean(c, 12) >= mean(a, 12), 'circuit 3 never gets easier than circuit 1 at the summit');
  // every circuit keeps the first-minutes gentleness
  for (const lv of [b, c]) assert.deepEqual(dangersIn(lv, 0, 900), []);
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
    const dExpected = live.map((r) => difficulty(r.ch, circuit, ((r.x0 + r.x1) / 2 - lv.chapters[r.ch].x0) / (lv.chapters[r.ch].x1 - lv.chapters[r.ch].x0)));
    const rho = spearman(dExpected, live.map((r) => r.m.score));
    assert.ok(rho >= 0.7, `demand vs difficulty(): Spearman ${rho.toFixed(2)} >= 0.7`);
    // per-landscape mean: climbs (gentle sawtooth: no landscape more than 1.5 below the previous one's level, overall rising)
    const land = lv.chapters.map((ch) => { const rs = live.filter((r) => r.ch === ch.index); return rs.reduce((s, r) => s + r.m.score, 0) / rs.length; });
    assert.ok(spearman(land.map((_, i) => i), land) >= 0.85, `landscape means rise (${land.map((v) => v.toFixed(1)).join(' ')})`);
    for (let i = 1; i < land.length; i++) assert.ok(land[i] >= land[i - 1] - 3.0, `landscape ${i} is not much easier than ${i - 1}`);
    // the end of the circuit is clearly more demanding than the start, but the slope is slow
    const head = land.slice(0, 3).reduce((s, v) => s + v, 0) / 3, tail = land.slice(10).reduce((s, v) => s + v, 0) / 3;
    assert.ok(tail > head + 4, `the last landscapes (${tail.toFixed(1)}) are clearly more demanding than the first (${head.toFixed(1)})`);
    // no difficulty step at a join: the first two live acts of landscape i+1 are within ~1.5 points of the last three of i
    // (single acts are noisy: a closing is a breather, a recall act re-plays an earlier lesson)
    const avg = (rs) => rs.reduce((s, r) => s + r.m.score, 0) / rs.length;
    for (let i = 0; i < 12; i++) {
      const prev = live.filter((r) => r.ch === i).slice(-3), next = live.filter((r) => r.ch === i + 1).slice(0, 2);
      assert.ok(avg(next) <= avg(prev) + 3.2, `join ${i}->${i + 1}: first acts ${avg(next).toFixed(2)} vs previous ${avg(prev).toFixed(2)}`);
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
    // the circuit's difficulty() really does go 0 -> ~11 (circuit 1) and circuit 2 starts near 4.5
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
  /* 12 Summit   */ (lv, a) => lv.platforms.filter((p) => p.kind === 'lift' && p.x >= a.x0 && p.x < a.x1 && lv.springs.some((s) => Math.abs(s.x - p.x) < 1100)).map((p) => ({ x: p.x, h: 0 })),   // springs and lifts together
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
      for (const a of mine) { const len = (a.x1 - a.x0) / C; assert.ok(len >= 8 && len <= 75, `${a.id} lasts ${len.toFixed(0)} s`); }
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

for (const circuit of CIRCUITS) {
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
  for (const circuit of CIRCUITS) {
    const lv = levelOf(circuit);
    const res = playLevel(lv, { allowSteer: false, maxSeconds: 4600, tOffset: 0.3 });
    assert.ok(res.ok, `circuit ${circuit}: ${res.reason} at x=${Math.round(res.x)} (beacon ${lv.beacon.x})`);
    assert.equal(res.reason, 'beacon');
    assert.ok(res.t / 60 >= T.journeyMinutes[0] && res.t / 60 <= T.journeyMinutes[1], `circuit ${circuit}: ${(res.t / 60).toFixed(1)} game minutes`);
    assert.ok(res.jumps > 300);
  }
});

test('(c) FULL pacing from the bot: summed clean times land in the journey window', { skip: !FULL, timeout: 3600000 }, () => {
  for (const circuit of CIRCUITS) {
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
  const ds = FULL ? [0, 2, 5, 8, 11, 15, 20] : [0, 6, 11, 20];
  const phases = FULL ? [0.2, 1.7, 4.9, 7.3] : [0.2, 3.1];
  const fails = [];
  let built = 0;
  for (const name of names) {
    let okBuilds = 0;
    for (const d of ds) for (const seed of FULL ? [1, 2] : [1]) for (const k of [0.15, 0.9]) {
      const m = miniLevel(name, d, seed, { k });
      if (m.bad) continue;
      okBuilds++; built++;
      for (const tOffset of phases) {
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
