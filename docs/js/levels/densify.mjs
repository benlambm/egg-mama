/*
 * Egg Mama — the dead-stretch guard.
 *
 * The pacing controller (acts.mjs) lands every landscape on its event rate, but the wait between two required events is still
 * a distribution with a tail: a flag station (600 u of guaranteed safe ground), a breather's neighbours, a long optional beat and
 * a rest can add up to 25 s with nothing to do but roll. This pass runs once, after the whole circuit is built, and walks the
 * required events of the main route (the same events tests/felt.mjs counts): wherever two of them are more than LIMIT_U apart
 * (about 18 s, breathers excepted) it CARVES one small hop into the flat ground between them (a wait that has a breather act in it is allowed 31 s: the hop goes beside the breather), a gap taken out of a long island
 * (nothing else moves: every platform, flag, egg and enemy keeps its x), with an egg arc over it, so the wait is cut in two.
 *
 * It only ever carves where that is certainly fair: inside one long static ground platform with >= 260 u of ground on each
 * side (so it is a normal, easy hop with the window of any gap of that difficulty, checked with trainFeasible), >= 330 u (3 s) from
 * every other event, clear of every flag's safe zone, optional ledge, spring, golden egg and pickup, not in the first 800 u of a landscape
 * (its quiet opening is 860 u), not in the last 400 u (the join; 740 u before Clover Mill) and not before Meadow's first real gap. The gap is the landscape's own
 * difficulty of the moment (P.gap) and each carve is logged as a 'gapCarve' beat of the act it falls in.
 */
import { T, clamp } from '../tuning.mjs';
import { rng, mixSeed } from '../rng.mjs';
import { P, levelDifficulty } from './params.mjs';
import { trainFeasible } from './phys.mjs';

export const LIMIT_U = 2000;            // a wait longer than this (18.2 s) gets a hop carved into it
export const LIMIT_BREATHER_U = 3400;   // ...and 31 s where a breather act (15-20 s of egg fields, no hazards) sits in the wait; the hop then goes beside the breather, never in it
export const LIMIT_EARLY_U = 2200;      // ...20 s in the first two landscapes: Meadow and Clover Mill stay the gentlest (fewest hops added)
const MARGIN = 330;                     // a carved hop keeps this far (3 s) from every other event
const rd = Math.round;
const dyn = (p) => !!p.motion && !(p.kind === 'ledge' && p.motion.amp <= 10);

/** The required events of the main route: [{ x (where the felt count puts it), a, b (the stretch of ground it occupies) }], sorted by x. */
export function eventSpans(B) {
  const ev = [];
  const plats = B.plats.filter((p) => !p.o).sort((p, q) => p.x - q.x || p.id - q.id);
  for (let i = 0; i < plats.length; i++) {
    const p = plats[i];
    if (dyn(p)) {
      if (p.kind === 'lift' || p.kind === 'mover') { ev.push({ x: p.x, a: p.x, b: p.x + p.w }); ev.push({ x: p.x + p.w, a: p.x + p.w, b: p.x + p.w }); }
      continue;
    }
    const q = plats[i + 1];
    if (!q || dyn(q)) continue;
    const end = p.x + p.w, gap = q.x - end;
    if (gap > 0 || p.y - q.y > T.stepUp) ev.push({ x: end, a: end, b: end });
  }
  for (const e of B.enemies) {
    if (e.kind === 'walker') ev.push({ x: e.x0, a: e.x0, b: e.x1 });
    else ev.push({ x: e.cx - e.ax, a: e.cx - e.ax, b: e.cx + e.ax });
  }
  for (const h of B.hazards) ev.push({ x: h.x, a: h.x, b: h.x + h.w });
  ev.sort((p, q) => p.x - q.x);
  return ev;
}

/**
 * Carve hops into every long wait. `ctx` = { acts (the landscapes' acts: x0, x1, role, d0, d1, beats, beatX), chapters (x0, x1 per
 * landscape), seed, circuit, endX (the beacon's x) }. Returns the number of hops carved.
 */
export function densify(B, ctx) {
  const rand = rng(mixSeed(ctx.seed >>> 0, 0xDE45E));
  const { acts, chapters } = ctx;
  const breathers = acts.filter((a) => a.role === 'breather');
  const inBreather = (x0, x1) => breathers.some((a) => x1 > a.x0 && x0 < a.x1);
  const firstGap = B.firsts.find((f) => f.ch === 0 && f.kind === 'gap');
  const noBefore = firstGap ? firstGap.x + 900 : 3000;
  // the events are listed once and kept sorted as hops are carved (a carve adds exactly one: the end of the left half); pickups are indexed
  // once by x (the carve checks run for every candidate position, and there are ~8 000 pickups)
  const ev = eventSpans(B);
  const ix = {
    solid: B.picks.filter((q) => q.kind !== 'egg').map((q) => q.x).sort((p, q) => p - q),                       // golden eggs, shields, magnets
    air: B.picks.filter((q) => q.kind === 'egg' && q.y < 262).sort((p, q) => p.x - q.x),                         // eggs that can hang above head height
  };
  let carved = 0;
  const tried = new Set();
  for (let guard = 0; guard < 400; guard++) {
    // the longest wait that has not been given up on (a breather's neighbourhood has a longer allowance)
    let worst = null;
    for (let i = 1; i < ev.length; i++) {
      const g = ev[i].x - ev[i - 1].x;
      const limit = inBreather(ev[i - 1].x, ev[i].x) ? LIMIT_BREATHER_U : chapterAt(chapters, ev[i].x) <= 1 ? LIMIT_EARLY_U : LIMIT_U;
      if (g <= limit || tried.has(ev[i - 1].x + ':' + ev[i].x)) continue;
      if (!worst || g > worst.g) worst = { g, prev: ev[i - 1], next: ev[i] };
    }
    if (!worst) break;
    const x = carveOne(B, ctx, rand, worst, noBefore, chapters, acts, breathers, ix);
    if (x === null) tried.add(worst.prev.x + ':' + worst.next.x);
    else {
      carved++;
      let k = ev.findIndex((e) => e.x > x);
      if (k < 0) k = ev.length;
      ev.splice(k, 0, { x, a: x, b: x });
    }
  }
  B.stats.carved = carved;
  return carved;
}

/** First index of the sorted numbers `arr` that is >= x. */
function lowerBound(arr, x, key = (v) => v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function carveOne(B, ctx, rand, { prev, next }, noBefore, chapters, acts, breathers, ix) {
  const lo = prev.b + MARGIN, hi = next.a - MARGIN;             // the hop (its hole and landing) fits between these
  if (hi - lo < 700) return null;
  const mid = (prev.x + next.x) / 2;
  const grounds = B.plats.filter((p) => !p.o && p.kind === 'ground' && !p.motion && p.solid !== false && p.x + p.w > lo && p.x < hi && p.w >= 560);
  if (!grounds.length) return null;
  const optional = B.plats.filter((p) => p.o && p.x < hi + 200 && p.x + p.w > lo - 200);
  const nearPick = (x0, x1) => { const k = lowerBound(ix.solid, x0); return k < ix.solid.length && ix.solid[k] <= x1; };
  const nearSpring = (x0, x1) => B.springs.some((s) => s.x >= x0 && s.x <= x1);
  const arcEggs = (x0, x1, top) => {      // eggs hung in the air above head height: an arc someone is meant to jump through
    for (let k = lowerBound(ix.air, x0, (q) => q.x); k < ix.air.length && ix.air[k].x <= x1; k++) if (ix.air[k].y < top - 62) return true;
    return false;
  };
  // try centres outward from the middle of the wait
  const span = hi - lo;
  for (let off = 0; off <= span / 2; off += 24) {
    for (const sign of off === 0 ? [1] : [1, -1]) {
      const p0 = mid + sign * off;
      const host = grounds.find((g) => p0 - 260 >= g.x && p0 + 120 + 260 <= g.x + g.w);
      if (!host) continue;
      const ch = chapters[chapterAt(chapters, p0)];
      const within = clamp((p0 - ch.x0) / (ch.x1 - ch.x0), 0, 1);
      const d = levelDifficulty(ch.index, ctx.circuit, within);
      const g = rd(clamp(P.gap(d) + rand.range(-2, 4), 40, 62));
      const p = rd(p0);
      const e0 = p, e1 = p + g;
      if (e0 < lo || e1 > hi) continue;
      if (e0 - host.x < 260 || host.x + host.w - e1 < 260) continue;
      if (breathers.some((br) => e1 > br.x0 - 150 && e0 < br.x1 + 150)) continue;
      if (e0 < ch.x0 + 800 || e1 > ch.x1 - (ch.index === 0 ? 740 : 400) || e0 < noBefore || e1 > ctx.endX - 1500) continue;
      if (B.cps.some((c) => c.x > e0 - 480 && c.x < e1 + 330)) continue;                 // clear of every flag's safe zone (and the flag stays on a >= 250 u run)
      if (optional.some((o) => o.x < e1 + 100 && o.x + o.w > e0 - 100)) continue;
      if (nearSpring(e0 - 120, e1 + 120) || nearPick(e0 - 30, e1 + 30)) continue;
      if (arcEggs(e0 - 70, e1 + 70, host.y)) continue;                                   // nor under an arc of eggs (a set piece's golden crown)
      const L = { x: host.x, end: e0, top: host.y, kind: 'ground' }, R = { x: e1, end: host.x + host.w, top: host.y, kind: 'ground' };
      const res = trainFeasible([L, R], { minSecs: 0.42 });
      if (!res.ok) continue;
      // ── carve: the island is cut in two, the left half keeps the id (flags before the cut stay on it), the right half is new
      const right = { ...host, id: B.plats.length, x: e1, w: host.x + host.w - e1 };
      host.w = e0 - host.x;
      B.plats.push(right);
      for (const c of B.cps) if (c.platform === host.id && c.x >= e1) c.platform = right.id;
      // eggs that sat on the carved ground go; an arc of eggs over the hop takes their place
      const y = host.y;
      for (let k = B.picks.length - 1; k >= 0; k--) { const q = B.picks[k]; if (q.kind === 'egg' && q.x >= e0 - 20 && q.x <= e1 + 20 && q.y >= y - 60) B.picks.splice(k, 1); }
      B.picks.forEach((q, k) => { q.id = k; });
      B.arc(res.takeoffs[0], y, 0, 4);
      // the quiet-ground list (captions go there) must not cross the hole
      const quiet = [];
      for (const [a, b] of B.quiet) {
        if (b < e0 - 140 || a > e1 + 140) { quiet.push([a, b]); continue; }
        if (e0 - 140 - a >= 380) quiet.push([a, e0 - 140]);
        if (b - (e1 + 140) >= 380) quiet.push([e1 + 140, b]);
      }
      B.quiet = quiet;
      // log it as a beat of its act
      const act = acts.find((a) => p >= a.x0 && p < a.x1);
      if (act) {
        let k = act.beatX.findIndex((bx) => bx > p);
        if (k < 0) k = act.beatX.length;
        if (act.beats[k - 1] !== 'crown' && !(act.finaleLast && k === act.beats.length)) { act.beats.splice(k, 0, 'gapCarve'); act.beatX.splice(k, 0, p); }       // (a set piece's last beat stays its crown)
      }
      return e0;
    }
  }
  return null;
}

function chapterAt(chapters, x) {
  let lo = 0, hi = chapters.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (chapters[mid].x0 <= x) lo = mid; else hi = mid - 1; }
  return lo;
}
