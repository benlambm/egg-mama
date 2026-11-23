/*
 * Egg Mama — beats with moving or special platforms: lifts, movers, lift -> crumble transfers, ice.
 *
 * Moving things are functions of the GAME CLOCK, and the clock phase when she arrives is arbitrary (pauses do not
 * advance it, but any brake, hit or respawn shifts it). So every one of these is built to work at ANY phase with
 * jump-only play: the whole range of the motion stays inside what one jump can reach, and the tests replay each
 * one at many clock offsets.
 */
import { T, clamp } from '../tuning.mjs';
import { P, chainMax } from './params.mjs';
import { Y0 } from './builder.mjs';
import { C, flightTime, jumpWindow, trainFeasible, MAX_RISE } from './phys.mjs';
import { BEATS, def, gapW, landW, crW as crumbleWidth, settle, capN } from './beats.mjs';

const rd = Math.round;
const TAU = Math.PI * 2;
const stat = (p) => ({ x: p.x, end: p.x + p.w, top: p.y, kind: p.kind === 'ground' ? 'ground' : 'ledge' });
const q2 = (n) => Math.round(n * 100) / 100;

/** Center-of-window takeoff for a hop between two kinds of platform (used to lay egg arcs). */
function windowCentre(fromEnd, fromTop, fromKind, toPlat, toTop) {
  const w = jumpWindow({ end: fromEnd, top: fromTop, kind: fromKind }, { x: toPlat.x, end: toPlat.x + toPlat.w, top: toTop, kind: toPlat.kind === 'ground' ? 'ground' : 'ledge' });
  return w.width > 0 ? fromEnd + (w.lo + w.hi) / 2 : fromEnd - 20;
}

/**
 * One lift from the cursor's ground to an exit platform about 60 u higher. The lift centre is 30 u above the ground,
 * it swings +-amp; the exit sits so that even from the lift's lowest point it is a rise of ~70 (inside one swipe) and
 * from its highest point it is a short drop. Returns { L, E, amp }.
 */
export function liftUp(B, c, { exitKind = 'ground', exitW = null, gold: wantGold = false, flat = false } = {}) {
  const { rand, d } = c;
  const A = B.cur, yA = B.y, aEnd = B.x;
  const amp = rd(clamp(P.liftAmp(d) + rand.range(-3, 3), 26, 54));
  const period = q2(P.liftPeriod(d) + rand.range(-0.3, 0.4));
  const phase = q2(rand.range(0, TAU));
  const Lw = rd(rand.range(160, 190));
  const g1 = rd(rand.range(26, 42));
  const Ly = flat ? yA - 6 : yA - 30;          // flat: a vertical ferry between two banks at the same height
  const L = B.plat('lift', aEnd + g1, Ly, Lw, { motion: { axis: 'y', amp, period, phase } });
  const yE = flat ? yA : Ly + amp - 70 + rd(rand.range(0, 6));
  const g2 = rd(rand.range(26, 40));
  const E = B.plat(exitKind, L.x + Lw + g2, yE, exitW ?? rd(rand.range(240, 320)));
  B.tag('lift', L.x - 10);
  // eggs: up onto the lift, along it, and off to the exit
  B.arc(windowCentre(aEnd, yA, A.kind, L, Ly), yA, Ly - yA, 4);
  for (let k = 1; k <= 3; k++) B.egg(L.x + (Lw * k) / 4, Ly - 28);
  B.arc(L.x + Lw - 36, Ly, yE - Ly, 4);
  if (wantGold) B.gold(L.x + Lw / 2, Ly - amp - 64);       // only reachable when the lift is high: a bonus for good timing
  B.setCursor(E);
  B.runEggs(E.x + 20, B.x, B.y, 'line');
  return { L, E, amp, A };
}

def('liftRide', { needs: 'lift' }, (B, c) => {
  liftUp(B, c, { gold: c.rand.chance(0.4) });
  settle(B, c);
});

/** Two lifts one after another: up a cliff face, then down the steps on the far side. */
def('liftClimb', { needs: 'lift' }, (B, c) => {
  liftUp(B, c, { gold: false });
  B.run(rd(c.rand.range(140, 200)), 'line');
  if (B.y - 60 >= 168) liftUp(B, c, { gold: c.rand.chance(0.6) });
  settle(B, c);
});

/** A horizontal mover that ferries her across a chasm too wide to jump. Its whole sweep stays within one jump of both banks. */
def('moverFerry', { needs: 'mover' }, (B, c) => {
  const { rand, d } = c;
  const amp = rd(clamp(P.moverAmp(d) + rand.range(-2, 2), 12, 29));
  const period = q2(P.moverPeriod(d) + rand.range(-0.3, 0.4));
  const phase = q2(rand.range(0, TAU));
  const Mw = rd(rand.range(160, 190));
  const aEnd = B.x, y = B.y;
  const xc = aEnd + 8 + amp;
  const M = B.plat('mover', xc, y - 10, Mw, { motion: { axis: 'x', amp, period, phase } });
  const bx = xc + Mw + amp + 8;
  B.tag('mover', xc);
  const E = B.plat('ground', bx, y, rd(rand.range(260, 340)));
  B.arc(aEnd - 10, y, -10, 3);
  for (let k = 1; k <= 3; k++) B.egg(xc + (Mw * k) / 4, y - 10 - 28);
  B.arc(xc + Mw - 30, y - 10, 10, 4);
  B.setCursor(E);
  B.runEggs(E.x + 20, B.x, B.y, 'line');
});

/** A lift that leads onto a crumbling ledge: step on, then jump on to solid ground before it gives way. */
def('liftCrumble', { needs: 'liftCrumble' }, (B, c) => {
  const { rand, d } = c;
  liftUp(B, c, { exitKind: 'crumble', exitW: crumbleWidth(c) });
  const Cr = B.cur;
  const gap = rd(clamp(P.crumbleGap(d) + rand.range(-3, 3), 24, 44));
  const G2 = B.plat('ground', Cr.x + Cr.w + gap, Cr.y - rd(rand.range(0, 8)), rd(rand.range(220, 300)));
  const res = trainFeasible([stat(Cr), stat(G2)], { minSecs: 0.2 });
  // from the lift she can land anywhere along the ledge's first ~45 u: every one of those must still be saveable
  if (!res.ok || !res.goodSpan(0, Cr.x - 6, Cr.x + 42)) { B.fail('liftCrumble'); return; }
  B.tag('liftCrumble', Cr.x);
  B.tag('crumble', Cr.x);
  B.arc(res.takeoffs[0], Cr.y, G2.y - Cr.y, 4, { goldMid: rand.chance(0.3) });
  B.setCursor(G2);
  B.runEggs(G2.x + 20, B.x, B.y, 'line');
  settle(B, c);
});

/** A descent: lifts carry her DOWN a cliff (the lift's range sits below the ledge she leaves). Crystal-descent building block. */
def('liftDescent', { needs: 'liftCrumble' }, (B, c) => {
  // first walk up onto a high ledge (steps), then ride lifts down. Built from the top: raise the ground by 2 steps.
  const { rand, d } = c;
  const steps = 2;
  const specs = [];
  for (let i = 0; i < steps; i++) specs.push({ gap: rand.chance(0.5) ? 0 : rd(rand.range(30, 40)), w: rd(rand.range(150, 200)), dy: -rd(rand.range(36, 46)) });
  B.train(specs);
  if (B.bad) return;
  B.run(160, 'line');
  const top = B.y;
  // a lift whose centre is 30 u BELOW the ledge: the exit ground is lower than the lift's highest point by a drop
  const amp = rd(clamp(P.liftAmp(d) + rand.range(-3, 3), 26, 54));
  const period = q2(P.liftPeriod(d) + rand.range(-0.3, 0.4));
  const Lw = rd(rand.range(160, 190));
  const g1 = rd(rand.range(26, 40));
  // she steps OFF the ledge onto the lift: lift range [top + 20 - amp, top + 20 + amp] (never above the ledge, never more than ~70 below)
  const Ly = top + amp - 4;
  const L = B.plat('lift', B.x + g1, Ly, Lw, { motion: { axis: 'y', amp, period, phase: q2(rand.range(0, TAU)) } });
  B.tag('lift', L.x);
  const yE = Ly + amp + 40;             // exit is below the lowest lift position: a drop she walks / hops off
  const g2 = rd(rand.range(20, 34));
  const E = B.plat('ground', L.x + Lw + g2, Math.min(yE, Y0 + 12), rd(rand.range(240, 320)));
  B.arc(B.x - 10, top, Ly - top, 3);
  B.arc(L.x + Lw - 30, Ly, E.y - Ly, 4);
  B.setCursor(E);
  B.runEggs(E.x + 20, B.x, B.y, 'line');
  settle(B, c);
});

/* ───────────────────────── ice ───────────────────────── */

def('iceRun', { needs: 'ice' }, (B, c) => {
  B.tag('ice', B.x);
  const n = capN(c, Math.min(c.k < 0.35 ? 2 : c.k < 0.7 ? 3 : 4, Math.max(2, chainMax(c.d) - 2)));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ gap: gapW(c, -2), w: rd(clamp(P.iceIsland(c.d) + rand01(c) * 30, 120, 260)), dy: 0, ice: true, gold: i === 1 && c.rand.chance(0.25) });
  specs.push({ gap: gapW(c, -2), w: landW(c), dy: 0, ice: true });
  B.train(specs);
});
const rand01 = (c) => c.rand.range(-1, 1);

export { BEATS, MAX_RISE, C, flightTime };
