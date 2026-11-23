/*
 * Egg Mama — "felt difficulty": what a child would FEEL from a built world, measured from the finished geometry only.
 *
 * demand.mjs (the generator's own yardstick) inverts the same curves levelgen scales with, so "it ramps" is partly
 * circular. THIS module never looks at difficulty(), params.mjs or any generator curve. It reads the platforms,
 * enemies, hazards, springs, pickups and checkpoints of a Level (plus level.acts for act roles and beat names) and
 * counts what the player has to DO:
 *
 *   events        every required thing on the main route: a hop (gap or step between static platforms, a crumbling
 *                 landing), a lift / mover board + exit, a walker, a flyer, a spike, a spring that carries a gap.
 *   threat        how much each event really asks of a Mama who does nothing: `w` in 0..1 on every event. A hop, a wall, a lift or
 *                 mover board / exit, a static spike and a walker (her patrol is crossed whatever she does) are 1. A FLYER is
 *                 the share of game-clock phases at which a Mama who never jumps and just rolls through its zone at cruise is hit
 *                 (a high moth she passes under: about 0; a low swooper about 0.2-0.4); a cycling spike is the share of phases at
 *                 which it is up while she passes; a spring that carries a gap asks nothing (she rolls on, she flies) but she has
 *                 to watch where she lands: SPRING_THREAT 0.25. A moth is an event the child has to READ, but a button-masher
 *                 who never jumps is hit by only a fraction of them, and a calm player jumps only for those: the planner bot makes
 *                 as many jumps in Fogwood as the threat says (tests assert both).
 *   density       required events per minute of the WHOLE landscape (flag to flag, breathers, flag stations, opening and join all
 *                 included: what a child experiences per minute of play). `wDensity` is the same threat-weighted.
 *   liveDensity   the same over only its live acts, minus breather acts and minus the flag stations (the 600 u of safe ground
 *                 around every flag); `wLiveDensity` threat-weighted. `liveInclDensity`: breathers and stations excluded but the
 *                 opening and the join counted (the third way to count; it is the noisiest because the opening is fixed length).
 *   chains        clusters of events less than CHAIN_U (3 s) apart: singles -> doubles -> triples ("plan a second landing").
 *   windows       takeoff window (s) of every hop and spike: min / median / p10.
 *   combos        events with a DIFFERENT kind of event within COMBO_U (about 1.8 s): spike + gap, walker + gap, lift + gap...
 *   flag->hardest seconds from a flag to the hardest event of its segment (how much a failure costs to re-earn).
 *   quiet         seconds between consecutive required events (max and p90), and the same counting optional activity
 *                 (upper-route ledges, springs, golden eggs, eggs hung in the air that want a jump).
 *   shares        generator-labelled beat names per landscape: biggest share and distinct count (variety); and the GEOMETRY
 *                 FINGERPRINT of every required event (see fingerprint()): the biggest share of one fingerprint in a landscape
 *                 and the share of the landscape's events that are plain hops.
 *   steps         zero-gap walls she stops dead against (a swipe is needed before she rolls on again): count per landscape.
 *
 * feltSummary(levels) averages feltOf over many levels (journeys x circuits) and reports the Spearman of the density ramps and the
 * lowest landscape-to-landscape ratio. Families for "simultaneous demands": hop (gap, step, crumbling landing), moving platform,
 * walker, flyer, spike.
 *
 * Used by tests/levels.test.mjs and tools/level-report.mjs.
 */
import { T } from '../docs/js/tuning.mjs';
import { jumpWindow, spikeWindow } from '../docs/js/levels/phys.mjs';
import { enemyPosAt, hazardActive, WALKER, FLYER } from '../docs/js/sim.mjs';

const C = T.cruise;
export const CHAIN_U = 330;          // events closer than this are one chain (3 s)
export const COMBO_U = 330;          // a different FAMILY of event (hop / moving platform / walker / flyer / spike) within this (3 s) is a simultaneous demand
const kindOf = (k) => (k === 'ground' ? 'ground' : 'ledge');
const isDyn = (p) => !!p.motion && !(p.kind === 'ledge' && p.motion.amp <= 10);       // Reedwater's logs only bob a little
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const pct = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((p, r) => p - r); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/** The landscape index owning x. */
export function landscapeAt(level, x) {
  const cs = level.chapters;
  let lo = 0, hi = cs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cs[mid].x0 <= x) lo = mid; else hi = mid - 1; }
  return lo;
}

/** A spring that carries a gap asks nothing of her (she rolls on and flies) but she must watch where she lands. */
export const SPRING_THREAT = 0.25;

/**
 * The share of game-clock phases at which a Mama who NEVER jumps (rolling at cruise) is hurt by something while she crosses
 * x0..x1: `at(clock, x)` says whether she is hurt at that clock with her centre at x. 48 phases over one `period`, 1/60 s apart.
 * The overlap rules are the sim's own (|dx| < mamaHalfW + 0.42 w, her body gy-38..gy against the enemy's box).
 */
function idleHit(x0, x1, period, gy, at) {
  const N = 48, dt = 1 / 60;
  const dur = (x1 - x0) / C;
  let hits = 0;
  for (let k = 0; k < N; k++) {
    const t0 = (k / N) * period;
    for (let t = 0; t <= dur; t += dt) {
      const r = at(t0 + t, x0 + C * t);
      if (r) { hits++; break; }
    }
  }
  return hits / N;
}
const overlapY = (gy, top, bottom) => !(gy < top || gy - T.mamaH > bottom);
/** Idle-roll hit rate of a flyer (0..1), her feet at height gy. */
export function flyerThreat(e, gy) {
  return idleHit(e.cx - e.ax - 45, e.cx + e.ax + 45, e.period, gy, (t, mx) => {
    const p = enemyPosAt(e, t);
    return Math.abs(mx - p.x) <= T.mamaHalfW + FLYER.w * 0.42 && overlapY(gy, p.y - FLYER.h / 2, p.y + FLYER.h / 2);
  });
}
/** Idle-roll hit rate of a walker (a patrol on her path: about 1). */
export function walkerThreat(e) {
  const len = e.x1 - e.x0, per = (2 * len) / Math.max(1, e.speed);
  return idleHit(e.x0 - 45, e.x1 + 45, per, e.y, (t, mx) => {
    const p = enemyPosAt(e, t);
    return Math.abs(mx - p.x) <= T.mamaHalfW + WALKER.w * 0.42 && overlapY(e.y, p.y - WALKER.h, p.y);
  });
}
/** Idle-roll hit rate of spikes (1 for plain ones; the share of phases a cycling set is up while she crosses). */
export function spikeThreat(h) {
  if (!h.cycle) return 1;
  return idleHit(h.x - T.mamaHalfW, h.x + h.w + T.mamaHalfW, h.cycle.period, h.y, (t) => hazardActive(h, t));
}

/** All required events on the main route, sorted by x: [{ x, kind, cls, secs, w, ch, fp }]. secs = takeoff window (NaN: no timing), w = threat 0..1, fp = geometry fingerprint. */
export function requiredEvents(level) {
  const ev = [];
  const plats = level.platforms.filter((p) => !p.o);
  const push = (x, kind, cls, secs = NaN, w = 1, fp = kind) => ev.push({ x, kind, cls, secs, w, ch: landscapeAt(level, x), fp });
  for (let i = 0; i < plats.length; i++) {
    const p = plats[i];
    if (isDyn(p)) {
      if (p.kind === 'lift' || p.kind === 'mover') { push(p.x, p.kind, 'moving', NaN, 1, p.kind); push(p.x + p.w, p.kind + 'Exit', 'moving', NaN, 1, p.kind + 'Exit'); }
      continue;
    }
    const q = plats[i + 1];
    if (!q || isDyn(q)) continue;
    const gap = q.x - (p.x + p.w), rise = p.y - q.y;
    if (gap <= 0 && rise <= T.stepUp) continue;
    const end = p.x + p.w;
    if (gap > 0 && level.springs.some((s) => s.x >= end - 70 && s.x <= end)) { push(end, 'springhop', 'hop', NaN, SPRING_THREAT, 'springhop'); continue; }
    const cls = 'hop';                                   // gaps, steps and crumbling landings are one family
    if (gap <= 0) { push(end, 'step', cls, NaN, 1, `step|${kindOf(p.kind)[0]}>${kindOf(q.kind)[0]}|h${rise > 44 ? 2 : rise > 30 ? 1 : 0}`); continue; }
    const w = jumpWindow({ end, top: p.y, kind: kindOf(p.kind) }, { x: q.x, end: q.x + q.w, top: q.y, kind: kindOf(q.kind) });
    push(end, q.kind === 'crumble' ? 'crumbleHop' : 'hop', cls, w.secs, 1, hopPrint(p, q, gap, rise));
  }
  // ground height under x (the main route), for flyers and eggs
  const groundY = groundLookup(level);
  for (const e of level.enemies) {
    if (e.kind === 'walker') push(e.x0, 'walker', 'walker', NaN, walkerThreat(e), `walker|p${e.x1 - e.x0 < 120 ? 0 : e.x1 - e.x0 < 150 ? 1 : 2}`);
    else {
      const gy = groundY(e.cx);
      const high = gy - e.cy >= 70;
      push(e.cx - e.ax, high ? 'flyerHigh' : 'flyer', 'flyer', NaN, flyerThreat(e, gy), `${high ? 'flyerHigh' : 'flyer'}|a${e.ax < 46 ? 0 : e.ax < 60 ? 1 : 2}`);
    }
  }
  for (const h of level.hazards) push(h.x, h.cycle ? 'spikeCycle' : 'spike', 'spike', spikeWindow(h.x, h.w).secs, spikeThreat(h), `${h.cycle ? 'spikeCycle' : 'spike'}|w${h.w < 15 ? 0 : h.w < 18 ? 1 : 2}`);
  ev.sort((a, b) => a.x - b.x);
  return ev;
}

/**
 * The GEOMETRY FINGERPRINT of a hop: what the jump looks like to the eye, coarsely: the kinds of the two platforms, how wide the
 * gap is (<= 44, <= 50, <= 56, wider) and whether the landing is higher, level or lower (more than 10 u). Two hops with the same
 * fingerprint read as the same thing again; the variety tests cap the share of the biggest fingerprint in a landscape.
 */
function hopPrint(p, q, gap, rise) {
  const g = gap <= 44 ? 'g0' : gap <= 50 ? 'g1' : gap <= 56 ? 'g2' : 'g3';
  const d = rise > 10 ? 'up' : rise < -10 ? 'dn' : 'fl';
  return `hop|${kindOf(p.kind)[0]}>${q.kind === 'crumble' ? 'c' : kindOf(q.kind)[0]}|${g}|${d}`;
}

/** (x) -> top y of the highest main-route platform under x (Infinity if none). */
function groundLookup(level) {
  const plats = level.platforms.filter((p) => !p.o);
  const B = 256, map = new Map();
  plats.forEach((p, i) => { for (let k = Math.floor(p.x / B); k <= Math.floor((p.x + p.w) / B); k++) { if (!map.has(k)) map.set(k, []); map.get(k).push(i); } });
  return (x) => {
    let best = Infinity;
    for (const i of map.get(Math.floor(x / B)) || []) { const p = plats[i]; if (x >= p.x && x <= p.x + p.w && p.y < best) best = p.y; }
    return best;
  };
}

/** Optional things to do (not required): upper-route ledges, springs, golden eggs / shields / magnets, arcs of eggs hung in the air. */
export function optionalActivity(level) {
  const pts = [];
  for (const p of level.platforms) if (p.o) pts.push(p.x);
  for (const s of level.springs) pts.push(s.x);
  const groundY = groundLookup(level);
  let lastAir = -1e9;
  for (const q of level.pickups) {
    if (q.kind !== 'egg') { pts.push(q.x); continue; }
    // an egg she can only get with a jump: out of reach of a rolling Mama (centre 20 above the feet, pickup radius 28)
    const gy = groundY(q.x);
    if (gy < Infinity && q.y < gy - 50 && q.y > gy - 200) { if (q.x - lastAir > 90) pts.push(q.x); lastAir = q.x; }
  }
  pts.sort((a, b) => a - b);
  return pts;
}

/** Flag-station zones: the guaranteed-safe ground around each flag. */
const stations = (level) => level.checkpoints.map((c) => [c.x - 250, c.x + 350]);

/** Length of [a, b) not covered by the (sorted, disjoint) zones. */
function minusZones(a, b, zones) {
  let len = b - a;
  for (const [z0, z1] of zones) { const lo = Math.max(a, z0), hi = Math.min(b, z1); if (hi > lo) len -= hi - lo; }
  return Math.max(0, len);
}

/** Full per-landscape felt report of a level. */
export function feltOf(level) {
  const events = requiredEvents(level);
  const opt = optionalActivity(level);
  const zones = stations(level);
  const live = level.acts.filter((a) => a.role !== 'breather');
  const breathers = level.acts.filter((a) => a.role === 'breather');
  const inAct = (x, acts) => acts.some((a) => x >= a.x0 && x < a.x1);
  const inZone = (x) => zones.some(([a, b]) => x >= a && x < b);
  // events of the live acts that are not inside a flag station
  const liveEv = events.filter((e) => inAct(e.x, live) && !inZone(e.x));
  // chain sizes over ALL events (a chain may not span a breather: those are 400 u+ apart anyway)
  const chainOf = new Array(events.length).fill(1);
  let s = 0;
  for (let i = 1; i <= events.length; i++) {
    if (i === events.length || events[i].x - events[i - 1].x >= CHAIN_U) { for (let k = s; k < i; k++) chainOf[k] = i - s; s = i; }
  }
  const combo = events.map((e, i) => {
    for (let j = i - 1; j >= 0 && e.x - events[j].x <= COMBO_U; j--) if (events[j].cls !== e.cls) return true;
    for (let j = i + 1; j < events.length && events[j].x - e.x <= COMBO_U; j++) if (events[j].cls !== e.cls) return true;
    return false;
  });
  const idx = new Map(events.map((e, i) => [e, i]));
  // gaps between consecutive required events (assigned to the landscape of the later event); optional-aware version too
  const gapsFor = (list) => {
    const out = [];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = typeof list[i] === 'number' ? list[i] : list[i].x, ax = typeof a === 'number' ? a : a.x;
      out.push({ x0: ax, x1: b, s: (b - ax) / C });
    }
    return out;
  };
  const optAndEv = [...events.map((e) => e.x), ...opt].sort((a, b) => a - b);
  const overlapsBreather = (g) => breathers.some((a) => g.x1 > a.x0 && g.x0 < a.x1);
  const wsum = (list) => list.reduce((sum, e) => sum + e.w, 0);
  const out = [];
  for (const ch of level.chapters) {
    const i = ch.index;
    const myLive = live.filter((a) => a.ch === i);
    const liveLen = myLive.reduce((sum, a) => sum + minusZones(a.x0, a.x1, zones), 0);
    const mine = liveEv.filter((e) => e.ch === i);
    const liveMin = liveLen / C / 60;
    const allMine = events.filter((e) => e.ch === i);
    const landMin = (ch.x1 - ch.x0) / C / 60;
    // the third way to count: everything but the breather acts and the flag stations (so the opening and the join are in)
    const myBr = breathers.filter((a) => a.ch === i);
    const inclLen = minusZones(ch.x0, ch.x1, zones) - myBr.reduce((sum, a) => sum + minusZones(a.x0, a.x1, zones), 0);
    const inclEv = allMine.filter((e) => !inZone(e.x) && !inAct(e.x, myBr));
    const secs = mine.filter((e) => Number.isFinite(e.secs)).map((e) => e.secs);
    const spk = allMine.filter((e) => e.kind === 'spike').map((e) => e.secs);
    const ids = mine.map((e) => idx.get(e));
    const sizes = ids.map((k) => chainOf[k]);
    // per-segment (flag to flag): seconds from the flag to the hardest event
    const hardness = (e, k) => (Number.isFinite(e.secs) ? 1 / e.secs : 2.2) + (combo[k] ? 0.6 : 0) + 0.3 * (chainOf[k] - 1);
    const f2h = [];
    const cps = level.checkpoints.filter((c) => c.ch === i);
    for (const c of cps) {
      const next = level.checkpoints[c.id + 1];
      const end = next ? next.x : Infinity;
      let best = null;
      events.forEach((e, k) => { if (e.x > c.x + 350 && e.x < end && (!best || hardness(e, k) > best.h)) best = { h: hardness(e, k), d: e.x - c.x }; });
      if (best) f2h.push(best.d / C);
    }
    const mineGaps = gapsFor(events).filter((g) => landscapeAt(level, g.x1) === i);
    const nb = mineGaps.filter((g) => !overlapsBreather(g));
    const bg = mineGaps.filter(overlapsBreather);
    const optGaps = gapsFor(optAndEv).filter((g) => landscapeAt(level, g.x1) === i);
    const onb = optGaps.filter((g) => !overlapsBreather(g)), obg = optGaps.filter(overlapsBreather);
    // beat variety (generator-labelled)
    const names = level.acts.filter((a) => a.ch === i).flatMap((a) => a.beats || []);
    const tally = {};
    for (const n of names) tally[n] = (tally[n] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || ['', 0];
    // geometry fingerprints of the required events (what reads as "the same thing again")
    const fps = {};
    for (const e of allMine) fps[e.fp] = (fps[e.fp] || 0) + 1;
    const topFp = Object.entries(fps).sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const hopsN = allMine.filter((e) => e.cls === 'hop').length;
    out.push({
      ch: i, n: allMine.length, nLive: mine.length, liveMin, landMin,
      density: allMine.length / landMin, liveDensity: mine.length / liveMin, liveInclDensity: inclEv.length / (inclLen / C / 60),
      wDensity: wsum(allMine) / landMin, wLiveDensity: wsum(mine) / liveMin, wLiveInclDensity: wsum(inclEv) / (inclLen / C / 60),
      chainMean: mean(sizes), chain2: sizes.filter((v) => v >= 2).length / Math.max(1, sizes.length), chain3: sizes.filter((v) => v >= 3).length / Math.max(1, sizes.length),
      chainMax: Math.max(0, ...sizes),
      winMin: secs.length ? Math.min(...secs) : NaN, winMed: median(secs), winP10: pct(secs, 0.1),
      spikeMin: spk.length ? Math.min(...spk) : NaN, spikeMed: median(spk), spikes: allMine.filter((e) => e.cls === 'spike').length,
      comboShare: mine.length ? ids.filter((k) => combo[k]).length / mine.length : 0,
      comboPerMin: ids.filter((k) => combo[k]).length / liveMin,
      flagToHardest: mean(f2h),
      gapMax: Math.max(0, ...nb.map((g) => g.s)), gapP90: pct(nb.map((g) => g.s), 0.9), gapBreatherMax: Math.max(0, ...bg.map((g) => g.s)),
      optGapMax: Math.max(0, ...onb.map((g) => g.s)), optGapP90: pct(onb.map((g) => g.s), 0.9), optGapBreatherMax: Math.max(0, ...obg.map((g) => g.s)),
      beats: names.length, distinct: Object.keys(tally).length, topBeat: top[0], topShare: names.length ? top[1] / names.length : 0, tally,
      fps, topFp: topFp[0], fpShare: allMine.length ? topFp[1] / allMine.length : 0, hopShare: allMine.length ? hopsN / allMine.length : 0,
      steps: allMine.filter((e) => e.kind === 'step').length, wSum: wsum(allMine),
    });
  }
  return out;
}

/** Spearman rank correlation. */
export function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Aggregate feltOf() over several levels (journeys x circuits): per landscape, the mean of every numeric measure, the worst
 * (largest) gapMax / optGapMax / topShare, the smallest `distinct`, the combined beat tally, and the mean density.
 * Returns { lands: [13 rows], density: [13], spearman, minRatio }.
 */
export function feltSummary(levels) {
  const per = Array.from({ length: 13 }, () => []);
  for (const lv of levels) feltOf(lv).forEach((r, i) => per[i].push(r));
  const keys = ['n', 'nLive', 'density', 'liveDensity', 'liveInclDensity', 'wDensity', 'wLiveDensity', 'wLiveInclDensity', 'chainMean', 'chain2', 'chain3', 'winMin', 'winMed', 'winP10', 'comboShare', 'comboPerMin', 'flagToHardest', 'gapMax', 'gapP90', 'gapBreatherMax', 'optGapMax', 'optGapP90', 'optGapBreatherMax', 'beats', 'distinct', 'topShare', 'fpShare', 'hopShare', 'steps', 'spikeMed', 'spikes'];
  const lands = per.map((rows, i) => {
    const out = { ch: i, runs: rows.length };
    for (const k of keys) { const v = rows.map((r) => r[k]).filter(Number.isFinite); out[k] = v.length ? mean(v) : NaN; }
    out.worst = { gapMax: Math.max(...rows.map((r) => r.gapMax)), optGapMax: Math.max(...rows.map((r) => r.optGapMax)), topShare: Math.max(...rows.map((r) => r.topShare)), gapBreatherMax: Math.max(0, ...rows.map((r) => r.gapBreatherMax)), chainMax: Math.max(...rows.map((r) => r.chainMax)), winMin: Math.min(...rows.map((r) => r.winMin)), gapP90: Math.max(...rows.map((r) => r.gapP90).filter(Number.isFinite)), fpShare: Math.max(...rows.map((r) => r.fpShare)), hopShare: Math.max(...rows.map((r) => r.hopShare)), steps: Math.max(...rows.map((r) => r.steps)), spikeMin: Math.min(...rows.map((r) => r.spikeMin).filter(Number.isFinite), Infinity) };
    out.over26 = rows.filter((r) => r.gapMax > 26).length / rows.length;       // share of runs with a wait for a required event over 26 s outside a breather
    out.over30 = rows.filter((r) => r.gapMax > 30).length;                     // number of runs over 30 s
    out.minDistinct = Math.min(...rows.map((r) => r.distinct));
    out.tally = {}; out.fps = {};
    for (const r of rows) { for (const [n, v] of Object.entries(r.tally)) out.tally[n] = (out.tally[n] || 0) + v; for (const [n, v] of Object.entries(r.fps)) out.fps[n] = (out.fps[n] || 0) + v; }
    return out;
  });
  const ramp = (key) => {
    const d = lands.map((l) => l[key]);
    return { values: d, spearman: spearman(d.map((_, i) => i), d), minRatio: Math.min(...d.slice(1).map((v, i) => v / d[i])) };
  };
  const density = lands.map((l) => l.density);
  return {
    lands, density, spearman: spearman(density.map((_, i) => i), density), minRatio: Math.min(...density.slice(1).map((d, i) => d / density[i])),
    ramps: { density: ramp('density'), wDensity: ramp('wDensity'), liveDensity: ramp('liveDensity'), wLiveDensity: ramp('wLiveDensity'), liveInclDensity: ramp('liveInclDensity'), wLiveInclDensity: ramp('wLiveInclDensity') },
  };
}

export { mean, median, pct };
