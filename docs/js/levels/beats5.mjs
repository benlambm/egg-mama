/*
 * Egg Mama — more structural variants, and the ICE SEQUENCES.
 *
 * Ice in this game (sim.mjs): on ice she changes speed slowly (T.iceAccel 70 u/s^2 against 620 on plain ground), in the air
 * she steers as usual (260). So a swipe on ice is a long, gentle thing: a push builds speed over most of a second and she
 * keeps it after landing; a brake takes room, it slows her to about half but never stops her at once. The REQUIRED route
 * never asks for either (jump-only at default cruise is the generator's hard guarantee), so ice is where steering PAYS:
 *
 *   iceLeap    an optional high ledge, then a gap of ~112 u (the most one swipe up reaches at cruise is ~105 u) to a second
 *              ledge with a golden egg. A push in the last second before the edge carries her across; without it she
 *              drops back to the path below. (tests/levels.test.mjs finds the push + jump in the real sim, and checks that
 *              no jump-only play ever collects the golden egg.)
 *   iceSpring / springBrake / springPush   a spring FIXES where she takes off, so only a swipe in the air changes where she
 *              lands: an optional ledge ~45 u short of the plain landing needs a brake, one ~30 u beyond it a push.
 *
 * (A row of tiny ice floes was tried for the brake and dropped: braking shortens her reach, it does not widen any window.)
 * All of them sit ABOVE an unbroken run of the main route: falling never costs anything, nothing here is ever required.
 * Also here: variants for Reedwater (logsStairs), Orchard (springHops), Glass Coast (liftHop, liftValley), Moonridge (ferryWalker)
 * and Dawnbridge (bridgeWalker).
 */
import { T, clamp } from '../tuning.mjs';
import { P, chainMax } from './params.mjs';
import { C, flightTime, heightAt, springLanding, MAX_RISE } from './phys.mjs';
import { BEATS, def, gapW, landW, ledgeW, settle, fixHeights, gold, capN } from './beats.mjs';
import { liftUp } from './beats2.mjs';
import { ferry } from './beats4.mjs';

const rd = Math.round;
const q2 = (n) => Math.round(n * 100) / 100;

/** How far a push in the last half second before a ledge's edge flies on ice (measured in the real sim: 107-123 u). */
export const PUSH_REACH = 112;

/* ───────────────────────── ice sequences (optional) ───────────────────────── */

def('iceLeap', { needs: 'ice', hz: false }, (B, c) => {
  B.tag('iceLeap', B.x);
  B.run(120, 'line');
  const base = B.y;
  const rise = rd(c.rand.range(58, 68));
  const w1 = rd(c.rand.range(220, 250));
  const gap = rd(c.rand.range(110, 114));
  const w2 = rd(c.rand.range(150, 180));
  const x0 = B.x;
  B.run(70 + w1 + gap + w2 + 100, 'none');
  const stop = B.x;
  const L1 = B.plat('ledge', x0 + 70, base - rise, w1, { opt: true, ice: true });
  const L2 = B.plat('ledge', L1.x + w1 + gap, base - rise, w2, { opt: true, ice: true });
  B.arc(L1.x + 34 - C * flightTime(-rise), base, -rise, 3);                       // up onto the first ledge: an ordinary jump
  for (let k = 1; k <= 2; k++) B.egg(L1.x + 40 + (k * (w1 - 150)) / 3, L1.y - 26);
  // the leap: eggs along the real parabola of a pushed jump (a flat jump of ~PUSH_REACH u)
  const T0 = flightTime(0);
  const tx = L1.x + w1 + 2;
  for (let i = 1; i <= 4; i++) B.egg(tx + (PUSH_REACH * i) / 5, L1.y - heightAt((T0 * i) / 5) - 20);
  gold(B, L2.x + w2 * 0.45, L2.y - 30);
  B.egg(L2.x + w2 * 0.2, L2.y - 26); B.egg(L2.x + w2 * 0.75, L2.y - 26); B.egg(L2.x + w2 * 0.9, L2.y - 26);
  B.runEggs(x0 + 20, stop - 20, base, 'none');
  B.quiet.push([x0, stop]);
  B.run(120, 'line');
});

/**
 * A spring fixes WHERE she takes off, so only steering in the air can change where she lands (in the air she steers at
 * T.airAccel whatever the ground is like): a swipe left drops her short, a swipe right carries her on. Integrates the
 * real air control (approach to the steer target at airAccel, steer gesture of steerSeconds) for a flight launched by a
 * spring at cruise and returns the path as [{ dx, h }] (dx from the spring, h above the spring top) until she is back
 * down at `rise`.
 */
export function steeredFlight(kind, tau, rise, dt = 1 / 120) {
  const out = [];
  let vx = C, vy = T.springSpeed, h = 0, dx = -21, t = 0;                  // she triggers 21 u before the spring's centre
  while (t < 3) {
    const target = kind && t >= tau && t < tau + T.steerSeconds ? (kind === 'push' ? T.push : -T.back) : C;
    const d = T.airAccel * dt;
    vx = vx < target ? Math.min(target, vx + d) : Math.max(target, vx - d);
    dx += vx * dt;
    vy -= T.gravity * dt;
    h += vy * dt;
    t += dt;
    out.push({ t, dx, h });
    if (vy < 0 && h <= rise) break;
  }
  return out;
}

/**
 * A spring on the path and an optional ledge in the branches that the NOMINAL flight overshoots (brake: it sits ~45 u short
 * of where a flight with no steering lands) or undershoots (push: ~30 u beyond). The golden egg is on the ledge; the eggs
 * trace the steered flight (a brake swipe ~0.4 s after launching, or a push). Ice (Frostline) makes the ledge slippery.
 * Nothing is required: without the swipe she flies on and lands on the path.
 */
function springSteer(B, c, kind, ice) {
  if (B.y < 274) { B.fail('springHeight'); return; }
  B.run(160, 'line');
  const sx = B.x + 20;
  B.run(40 + 300, 'none');
  B.spring(sx);
  B.tag('spring', sx);
  const rise = rd(c.rand.range(96, 110));          // higher than this and the golden egg could be picked up on the way UP, without landing
  const D0 = springLanding(sx, rise) - sx;                                // where a flight with no steering lands (relative)
  if (!(D0 > 0)) { B.fail('spring'); return; }
  const lw = 52;
  const lc = kind === 'brake' ? D0 - 46 : D0 + 48;
  const L = B.plat('ledge', sx + lc - lw / 2, B.y - rise, lw, { opt: true, ice });
  const path = steeredFlight(kind, kind === 'brake' ? 0.4 : 0.25, rise);
  const n = 5;
  for (let i = 1; i <= n; i++) { const q = path[Math.min(path.length - 1, Math.floor((path.length * i) / (n + 1)))]; B.egg(sx + q.dx, B.y - q.h - 20); }
  gold(B, L.x + lw / 2, L.y - 30);
  B.runEggs(sx + 60, B.x - 80, B.y, 'wave');
  B.run(120, 'line');
}
def('springBrake', { needs: 'spring', springy: true }, (B, c) => springSteer(B, c, 'brake', false));
def('springPush', { needs: 'spring', springy: true }, (B, c) => springSteer(B, c, 'push', false));
/** Frostline: the same, with the ledge on ice (the swipe is the same; a pushed landing keeps sliding, a braked one glides slowly). */
def('iceSpring', { needs: 'ice', springy: true }, (B, c) => springSteer(B, c, c.rand.chance(0.5) ? 'brake' : 'push', true));

/* ───────────────────────── Reedwater ───────────────────────── */

/** Logs that climb like a staircase (12 u a step), then a drop back to the path. */
def('logsStairs', { needs: 'logs' }, (B, c) => {
  B.tag('logs', B.x);
  const n = capN(c, Math.min(3, Math.max(2, chainMax(c.d) - 1)));
  const a = rd(c.rand.range(11, 13));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c) + 8, dy: -a, gold: i === 1 && c.rand.chance(0.25) });
  specs.push({ kind: 'ground', gap: gapW(c, -7), w: landW(c), dy: n * a });
  const bob = c.ch === 2;
  const res = B.train(specs, bob ? { minSecs: 0.27 } : {});
  if (bob && !B.bad) {
    for (const p of res.plats) {
      if (p.kind !== 'ledge') continue;
      p.motion = { axis: 'y', amp: rd(c.rand.range(5, 8)), period: q2(c.rand.range(3.4, 4.6)), phase: q2(c.rand.range(0, 2 * Math.PI)) };
    }
  }
});

/* ───────────────────────── Orchard ───────────────────────── */

/** Two or three springs in a row, each carrying her over a gap to a small island: roll on, fly, roll on again. */
def('springHops', { needs: 'spring', springy: true }, (B, c) => {
  const n = capN(c, c.k < 0.5 ? 2 : 3, 2, 0);
  for (let i = 0; i < n; i++) {
    if (i) B.run(rd(c.rand.range(70, 110)), 'line');
    BEATS.springGap.fn(B, c);
    if (B.bad) return;
  }
});

/* ───────────────────────── Glass Coast ───────────────────────── */

/** Ride a lift, hop across a small island, ride a second lift: two ferries with a rest in the middle. */
def('liftHop', { needs: 'lift' }, (B, c) => {
  liftUp(B, c, { flat: true, gold: c.rand.chance(0.3) });
  if (B.bad) return;
  B.run(rd(c.rand.range(70, 110)), 'line');
  liftUp(B, c, { flat: true });
  settle(B, c);
});

/** Down a cliff on one lift, across the valley floor, up the far side on another: the lift ride in both directions. */
def('liftValley', { needs: 'lift' }, (B, c) => {
  BEATS.liftDescent.fn(B, c);
  if (B.bad) return;
  B.run(rd(c.rand.range(60, 110)), 'line');
  liftUp(B, c, { gold: c.rand.chance(0.4) });
  settle(B, c);
});

/* ───────────────────────── Moonridge ───────────────────────── */

/** A ferry whose far bank is a patrol: the snail walks the bank she lands on, so the landing has to be read as well. */
def('ferryWalker', { needs: 'mover' }, (B, c) => {
  const patrol = rd(Math.max(96, P.walkerPatrol(c.d) + c.rand.range(-6, 6)));
  ferry(B, c, { bankW: 140 + patrol + 150 });
  if (B.bad) return;
  const E = B.cur;
  const w0 = E.x + 140;
  B.walker(w0, w0 + patrol, clamp(P.walkerSpeed(c.d) * 0.8 + c.rand.range(-3, 3), 14, 44), c.rand.range(0, 1));
  B.tag('walker', w0);
  settle(B, c);
});

/* ───────────────────────── Dawnbridge ───────────────────────── */

/** A walker patrolling a stretch of deck between two missing spans. */
def('bridgeWalker', { needs: 'bridge' }, (B, c) => {
  B.tag('bridge', B.x);
  const patrol = rd(Math.max(96, P.walkerPatrol(c.d) + c.rand.range(-6, 6)));
  const g1 = gapW(c, -4), g2 = gapW(c, -3);
  const res = B.train([{ kind: 'ground', gap: g1, w: 150 + patrol + 170, dy: 0, h: 140 }, { kind: 'ground', gap: g2, w: landW(c) - 10, dy: 0, h: 140 }]);
  if (B.bad) return;
  const isl = res.plats[0];
  B.walker(isl.x + 150, isl.x + 150 + patrol, clamp(P.walkerSpeed(c.d) + c.rand.range(-3, 3), 14, 50), c.rand.range(0, 1), isl.y);
  B.tag('walker', isl.x + 150);
});

export { BEATS, MAX_RISE, T, fixHeights };
