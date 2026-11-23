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
 *   density       required events per minute of the WHOLE landscape (flag to flag, breathers and flag stations included:
 *                 what a child experiences per minute of play). liveDensity: the same over only its live acts, minus
 *                 breather acts and minus the flag stations (the 600 u of safe ground around every flag).
 *   chains        clusters of events less than CHAIN_U (3 s) apart: singles -> doubles -> triples ("plan a second landing").
 *   windows       takeoff window (s) of every hop and spike: min / median / p10.
 *   combos        events with a DIFFERENT kind of event within COMBO_U (about 1.8 s): spike + gap, walker + gap, lift + gap...
 *   flag->hardest seconds from a flag to the hardest event of its segment (how much a failure costs to re-earn).
 *   quiet         seconds between consecutive required events (max and p90), and the same counting optional activity
 *                 (upper-route ledges, springs, golden eggs, eggs hung in the air that want a jump).
 *   shares        generator-labelled beat names per landscape: biggest share and distinct count (variety).
 *
 * Used by tests/levels.test.mjs and tools/level-report.mjs.
 */
import { T } from '../docs/js/tuning.mjs';
import { jumpWindow, spikeWindow } from '../docs/js/levels/phys.mjs';

const C = T.cruise;
export const CHAIN_U = 330;          // events closer than this are one chain (3 s)
export const COMBO_U = 220;          // a different FAMILY of event (hop / moving platform / walker / flyer / spike) this close is a simultaneous demand
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

/** All required events on the main route, sorted by x: [{ x, kind, cls, secs, ch }]. secs = takeoff window (NaN: no timing). */
export function requiredEvents(level) {
  const ev = [];
  const plats = level.platforms.filter((p) => !p.o);
  const push = (x, kind, cls, secs = NaN) => ev.push({ x, kind, cls, secs, ch: landscapeAt(level, x) });
  for (let i = 0; i < plats.length; i++) {
    const p = plats[i];
    if (isDyn(p)) {
      if (p.kind === 'lift' || p.kind === 'mover') { push(p.x, p.kind, 'moving'); push(p.x + p.w, p.kind + 'Exit', 'moving'); }
      continue;
    }
    const q = plats[i + 1];
    if (!q || isDyn(q)) continue;
    const gap = q.x - (p.x + p.w), rise = p.y - q.y;
    if (gap <= 0 && rise <= T.stepUp) continue;
    const end = p.x + p.w;
    if (gap > 0 && level.springs.some((s) => s.x >= end - 70 && s.x <= end)) { push(end, 'springhop', 'hop'); continue; }
    const cls = 'hop';                                   // gaps, steps and crumbling landings are one family
    if (gap <= 0) { push(end, 'step', cls); continue; }
    const w = jumpWindow({ end, top: p.y, kind: kindOf(p.kind) }, { x: q.x, end: q.x + q.w, top: q.y, kind: kindOf(q.kind) });
    push(end, q.kind === 'crumble' ? 'crumbleHop' : 'hop', cls, w.secs);
  }
  // ground height under x (the main route), for flyers and eggs
  const groundY = groundLookup(level);
  for (const e of level.enemies) {
    if (e.kind === 'walker') push(e.x0, 'walker', 'walker');
    else {
      const gy = groundY(e.cx);
      push(e.cx - e.ax, gy - e.cy >= 70 ? 'flyerHigh' : 'flyer', 'flyer');
    }
  }
  for (const h of level.hazards) push(h.x, h.cycle ? 'spikeCycle' : 'spike', 'spike', spikeWindow(h.x, h.w).secs);
  ev.sort((a, b) => a.x - b.x);
  return ev;
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
  // events of the live acts that are not inside a flag station
  const liveEv = events.filter((e) => inAct(e.x, live) && !zones.some(([a, b]) => e.x >= a && e.x < b));
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
  const out = [];
  for (const ch of level.chapters) {
    const i = ch.index;
    const myLive = live.filter((a) => a.ch === i);
    const liveLen = myLive.reduce((sum, a) => sum + minusZones(a.x0, a.x1, zones), 0);
    const mine = liveEv.filter((e) => e.ch === i);
    const liveMin = liveLen / C / 60;
    const allMine = events.filter((e) => e.ch === i);
    const landMin = (ch.x1 - ch.x0) / C / 60;
    const secs = mine.filter((e) => Number.isFinite(e.secs)).map((e) => e.secs);
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
    out.push({
      ch: i, n: allMine.length, nLive: mine.length, liveMin, landMin,
      density: allMine.length / landMin, liveDensity: mine.length / liveMin,
      chainMean: mean(sizes), chain2: sizes.filter((v) => v >= 2).length / Math.max(1, sizes.length), chain3: sizes.filter((v) => v >= 3).length / Math.max(1, sizes.length),
      chainMax: Math.max(0, ...sizes),
      winMin: secs.length ? Math.min(...secs) : NaN, winMed: median(secs), winP10: pct(secs, 0.1),
      comboShare: mine.length ? ids.filter((k) => combo[k]).length / mine.length : 0,
      comboPerMin: ids.filter((k) => combo[k]).length / liveMin,
      flagToHardest: mean(f2h),
      gapMax: Math.max(0, ...nb.map((g) => g.s)), gapP90: pct(nb.map((g) => g.s), 0.9), gapBreatherMax: Math.max(0, ...bg.map((g) => g.s)),
      optGapMax: Math.max(0, ...onb.map((g) => g.s)), optGapP90: pct(onb.map((g) => g.s), 0.9), optGapBreatherMax: Math.max(0, ...obg.map((g) => g.s)),
      beats: names.length, distinct: Object.keys(tally).length, topBeat: top[0], topShare: names.length ? top[1] / names.length : 0, tally,
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

export { mean, median, pct };
