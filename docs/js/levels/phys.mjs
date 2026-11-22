/*
 * Egg Mama — reach physics for the level generator and its tests.
 *
 * Pure maths (no browser, no sim state) describing what ONE swipe can do at the default cruise.
 * Everything here is derived from tuning.mjs and cross-checked against the real sim in
 * tests/levels.test.mjs ("phys matches sim"), so a retune that breaks reach shows up as a test failure.
 *
 * Two sim facts worth knowing: (1) between SOLID ground islands at the same height she can simply WALK across a gap of up
 * to ~38 u (her body mantles onto the far edge within T.stepUp), so a gap that must be jumped is at least ~42 u; and
 * (2) a solid wall higher than her feet never needs perfect timing: she presses against it and jumps straight up.
 *
 * Conventions: y grows DOWN. `top` is a platform's top (the height her feet stand at). A jump from
 * platform A to platform B has dy = B.top - A.top (positive = landing lower). Positions inside a
 * jump window are measured as the takeoff x of her feet.
 */
import { T } from '../tuning.mjs';

export const C = T.cruise;
const g = T.gravity;
const v0 = T.jumpSpeed;

export const APEX = (v0 * v0) / (2 * g);                       // 104.5 u
export const MAX_RISE = 84;                                      // highest rise we ever ask of a required jump (apex 104)
export const SPRING_APEX = (T.springSpeed * T.springSpeed) / (2 * g);

/** Seconds for the feet to come back DOWN to `dy` below the takeoff height (dy < 0: a higher landing). NaN if out of reach. */
export function flightTime(dy, up = v0) {
  const disc = up * up + 2 * g * dy;
  return disc < 0 ? NaN : (up + Math.sqrt(disc)) / g;
}
/** Seconds to first reach `h` above the takeoff height. */
export function riseTime(h, up = v0) {
  const disc = up * up - 2 * g * h;
  return disc < 0 ? NaN : (up - Math.sqrt(disc)) / g;
}
/** Feet height above the takeoff height `t` seconds into a jump (analytic; the sim is semi-implicit so it sits ~6t u lower). */
export const heightAt = (t, up = v0) => up * t - 0.5 * g * t * t;

/** Horizontal distance of a flat jump (feet at the same height) at speed `s`. */
export const flatJump = (s = C) => s * flightTime(0);

/**
 * Edge forgiveness for a platform kind. Thin slabs (ledge / crumble) use T.edgeForgive; a solid ground slab is
 * more generous because the sim lets her body (half width 13) mantle onto a low slab edge (T.stepUp), so we use
 * a slightly smaller number than the body half width to stay conservative.
 */
export const edgeOf = (kind) => (kind === 'ground' ? T.mamaHalfW - 1 : T.edgeForgive);

/**
 * Takeoff window of one jump between two static platforms, relative to the END of `from` (u).
 * from: { end, top, kind }, to: { x, end, top, kind }. A solid ground wall that is higher than her feet is
 * NOT a problem for timing: if she is late she presses against it and can jump straight up from there (the
 * sim clamps her against the face, then steps onto the top), so only the early / short side limits the window.
 * Returns { lo, hi, width, secs, F, dy }; width <= 0 means impossible. Slightly conservative (1 u margins).
 */
export function jumpWindow(from, to, speed = C) {
  const dy = to.top - from.top;
  const t = flightTime(dy);
  if (!(t > 0) || -dy > MAX_RISE + 10) return { lo: 0, hi: -1, width: -1, secs: -1, F: 0, dy };
  const F = speed * t;
  const gap = to.x - from.end;
  const lo = gap - edgeOf(to.kind) - F + 1;                                   // must land within the far edge's forgiveness
  const hi = Math.min(edgeOf(from.kind) + speed * T.coyote - 1,               // last takeoff after walking off the edge
    gap + (to.end - to.x) + edgeOf(to.kind) - F - 1);                         // ...and not overshoot a short landing
  return { lo, hi, width: hi - lo, secs: (hi - lo) / speed, F, dy };
}

/**
 * Exact feasibility of a chain of static platforms jumped one after another with jump-only play.
 * Dynamic programming over her landing x on each platform (1 u grid): a landing is "good" if from
 * it a takeoff exists whose window (in time) is >= minSecs AND every takeoff in that window leads to
 * a good landing on the next platform. So from any good landing the rest of the chain has slack.
 *
 * plats: [{ x, end, top, kind: 'ground'|'ledge'|'crumble' }] consecutive, sorted by x.
 * Returns { ok, minSecs, secs: [per jump, from the nominal path], takeoffs: [nominal takeoff x per jump], landings }.
 * The nominal path takes off at the centre of each feasible set (what a calm player / the bot does).
 */
export function trainFeasible(plats, { minSecs = T.minWindow, from = null } = {}) {
  const n = plats.length;
  const need = minSecs * C;
  // The landing grid of each platform only needs the stretch she can actually land on (a jump never lands more than
  // ~130 u past a platform's start) and, for the starting platform, the last ~170 u before its end (she has been
  // rolling a while). That keeps the DP tiny on the long ground islands the generator builds.
  const lo = plats.map((p, i) => (i === 0 ? Math.max(p.x, p.end - 170) : p.x) - T.mamaHalfW - 1);
  const base = lo.map((v) => Math.floor(v));
  const size = plats.map((p, i) => Math.ceil(Math.min(p.end + T.mamaHalfW + C * T.coyote + 2, base[i] + (i === 0 ? 260 : 170))) - base[i] + 1);
  const good = plats.map((p, i) => new Uint8Array(size[i]));
  good[n - 1].fill(1);
  const jw = [];
  for (let i = 0; i < n - 1; i++) jw.push(jumpWindow(plats[i], plats[i + 1]));
  // is a landing at absolute x on platform j one the rest of the chain can finish from? (the last platform: always)
  const isGood = (j, x) => { const k = Math.round(x) - base[j]; return k >= 0 && (j === n - 1 || (k < size[j] && good[j][k] === 1)); };
  // the feasible takeoff x-cells for jump i given landing x_l on plats[i] (used for the nominal pass)
  const cells = (i, xl, out) => {
    out.length = 0;
    const w = jw[i], pi = plats[i];
    if (!(w.width > 0)) return out;
    let lo2 = Math.max(pi.end + w.lo, xl), hi = pi.end + w.hi;
    if (pi.kind === 'crumble') hi = Math.min(hi, xl + (T.crumbleDelay - 0.05) * C);
    for (let x = Math.ceil(lo2); x <= hi; x++) if (isGood(i + 1, x + w.F)) out.push(x);
    return out;
  };
  // backward pass with prefix sums: how many good takeoff cells lie in a range, in O(1) per landing cell
  for (let i = n - 2; i >= 0; i--) {
    const w = jw[i], pi = plats[i];
    if (!(w.width > 0)) continue;
    const txLo = Math.ceil(pi.end + w.lo), txHi = Math.floor(pi.end + w.hi);
    if (txHi < txLo) continue;
    const pre = new Int32Array(txHi - txLo + 2);
    for (let x = txLo; x <= txHi; x++) pre[x - txLo + 1] = pre[x - txLo] + (isGood(i + 1, x + w.F) ? 1 : 0);
    const crumble = pi.kind === 'crumble';
    for (let k = 0; k < size[i]; k++) {
      const xl = base[i] + k;
      const a2 = Math.max(txLo, Math.ceil(xl));
      const b2 = crumble ? Math.min(txHi, Math.floor(xl + (T.crumbleDelay - 0.05) * C)) : txHi;
      good[i][k] = b2 >= a2 && pre[b2 - txLo + 1] - pre[a2 - txLo] >= need ? 1 : 0;
    }
  }
  // nominal forward pass: start well before the first platform's end (she has been rolling a while)
  let xl = from == null ? Math.max(plats[0].x, plats[0].end - 160) : from;
  const secs = [], takeoffs = [], landings = [], tmp = [];
  let ok = true, minS = Infinity;
  for (let i = 0; i < n - 1; i++) {
    if (!isGood(i, xl)) { ok = false; secs.push(0); minS = 0; break; }
    const c = cells(i, xl, tmp);
    const s2 = c.length / C;
    secs.push(s2); minS = Math.min(minS, s2);
    const xt = c[(c.length - 1) >> 1];
    takeoffs.push(xt);
    xl = xt + jw[i].F;
    landings.push(xl);
  }
  if (secs.length < n - 1) ok = false;
  // goodSpan(i, x0, x1): is every landing x in [x0, x1] on platform i one the rest of the chain can be completed from?
  const goodSpan = (i, x0, x1) => {
    for (let x = Math.ceil(x0); x <= x1; x++) if (!isGood(i, x)) return false;
    return true;
  };
  return { ok: ok && minS >= minSecs - 1e-9, minSecs: ok ? minS : 0, secs, takeoffs, landings, goodSpan };
}

/** Where Mama's body centre is `t` s after taking off from feet position (x, y): used to trace egg trails along real jumps. */
export function arcPoint(x, y, t, speed = C, up = v0) {
  return { x: x + speed * t, y: y - heightAt(t, up) };
}

/**
 * Spike hop (a static spike of width w at x): takeoff x window [lo, hi] (absolute x) so that her body clears it.
 * Her feet must be >= 13 u up whenever her body overlaps the spike (m.x within [x - 11, x + w + 11]).
 */
export function spikeWindow(x, w, speed = C) {
  const tUp = riseTime(13);                       // feet 13 u clear
  const tDown = flightTime(-13);                  // ...until they drop back below 13 u
  const lo = x + w + 11 - speed * tDown;
  const hi = x - 11 - speed * tUp;
  return { lo, hi, width: hi - lo, secs: (hi - lo) / speed };
}

/** A spring launch (she rolls onto it at cruise): where she lands on a platform `rise` above the spring top. */
export function springLanding(springX, rise, speed = C) {
  const disc = T.springSpeed * T.springSpeed - 2 * g * rise;
  if (disc < 0) return NaN;
  const t = (T.springSpeed + Math.sqrt(disc)) / g;
  return springX - 21 + speed * t;                // she triggers when |dx| <= 21 (SPRING_W/2 + 4)
}
