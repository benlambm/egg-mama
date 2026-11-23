/*
 * Egg Mama — structural variants. Every landscape's signature element comes in 3-4 STRUCTURALLY different beats
 * (not just different numbers), so an hour of the same idea never reads as the same stretch:
 *
 *   everywhere    gapHill (a gap onto a raised landing), cliffHop (up a bank, then a gap down), upperRoute (a high
 *                 route of 3-4 ledges with gaps between them: an optional split that rejoins the ground)
 *   Clover        walkerStep (a patrol on a raised plateau), walkerWide (a long, slow patrol)
 *   Reedwater     logsZig (up/down zig-zag logs), logsRaft (a wide raft between small logs), logsLane (a high lane of
 *                 optional logs over the low one)
 *   Orchard       springTall (a very high branch), springChain (spring -> ledge -> ledge), branchSteps (plank stairs)
 *   Amber         crumbleStairs (cracked stairs up), crumbleSkip (cracked stones with a solid plank between)
 *   Fogwood       mothLane (duck under one, hop the next), mothSwarm (three out of step), mothHill (a moth over a
 *                 plateau), mothDip (one that dives from head height to the ground)
 *   Ember Canyon  spikeStep (spikes on a raised plateau)
 *   Glass Coast   liftFerry (a vertical ferry between banks at one height), liftDrop (down a cliff on a lift)
 *   Lantern       liftCrumbleChain (lift -> crumble -> crumble -> ground)
 *   Frostline     iceSteps (ice planks up and down)   [the optional ice sequences are in beats5.mjs]
 *   Moonridge     ferryTwo (mover, island, mover), ferryStep (the far bank is higher)
 *   Dawnbridge    bridgeMissing (a missing span bridged by a cracked stone), bridgeArch (decks that rise and fall),
 *                 bridgePillars (decks on pillars of different heights)
 *
 * Fairness is the same as everywhere: chains are checked with phys.trainFeasible, moving things work at any clock phase,
 * and tests/levels.test.mjs plays every beat with the planner bot at several difficulties.
 */
import { T, clamp } from '../tuning.mjs';
import { P, ease, chainMax } from './params.mjs';
import { C, flightTime, springLanding, trainFeasible } from './phys.mjs';
import { def, BEATS, springLedge, capN, gapW, landW, islW, ledgeW, settle, fixHeights, gold, walkerEncounter, flyerEncounter, spikeW, crW, crG } from './beats.mjs';
import { liftUp } from './beats2.mjs';

const rd = Math.round;
const TAU = Math.PI * 2;
const q2 = (n) => Math.round(n * 100) / 100;
const stat = (p) => ({ x: p.x, end: p.x + p.w, top: p.y, kind: p.kind === 'ground' ? 'ground' : 'ledge' });

/* ───────────────────────── everywhere ───────────────────────── */

/** A gap onto a landing that sits a little higher (14-26 u): a different feel from the flat gap. */
def('gapHill', { needs: 'gap' }, (B, c) => {
  B.tag('gap', B.x);
  const h = rd(c.rand.range(14, 26));
  B.train([{ gap: gapW(c, -2), w: landW(c) + 20, dy: -h }]);
  if (B.bad) return;
  B.run(rd(c.rand.range(60, 140)), 'line');
  B.hop(0, rd(c.rand.range(200, 280)), h);                    // walk back down
  B.runEggs(B.cur.x, B.x, B.y, 'wave');
  settle(B, c);
});

/** Up a low bank (a wall she hops onto), along the top, then a gap DOWN to the lower ground: a longer flight. */
def('cliffHop', { needs: 'gap' }, (B, c) => {
  B.tag('gap', B.x);
  const h = rd(c.rand.range(24, 36));
  B.train([{ gap: 0, w: rd(c.rand.range(210, 280)), dy: -h }, { gap: gapW(c, -4), w: landW(c) + 10, dy: h }]);
  if (B.bad) return;
  settle(B, c);
});

/**
 * An optional HIGH ROUTE: a row of 3-4 thin ledges with small gaps between them, floating above the ground path with
 * eggs in the air between them and a golden egg on the last. The ground below is the main route and stays an unbroken
 * run, so the route splits off and rejoins; nothing on it is required.
 */
def('upperRoute', { needs: 'upper', hz: false }, (B, c) => {
  B.tag('upper', B.x);
  const n = c.k > 0.6 ? 4 : 3;
  B.run(110, 'line');
  const base = B.y;
  const ws = [], gs = [];
  let total = 120;
  for (let i = 0; i < n; i++) { ws.push(rd(c.rand.range(100, 140))); gs.push(i ? rd(c.rand.range(46, 62)) : 0); total += ws[i] + gs[i]; }
  const x0 = B.x;
  B.run(total + 140, 'none');
  const stop = B.x;
  let x = x0 + 70, y = base - rd(c.rand.range(68, 78));
  let prev = null;
  for (let i = 0; i < n; i++) {
    x += gs[i];
    if (i) y = clamp(y + rd(c.rand.range(-9, 9)), base - 84, base - 62);
    const L = B.plat('ledge', x, y, ws[i], { opt: true });
    if (!prev) B.arc(L.x + 30 - C * flightTime(-(base - y)), base, -(base - y), 3);
    else { B.egg(prev.x + prev.w + gs[i] * 0.33, Math.min(prev.y, y) - 38); B.egg(prev.x + prev.w + gs[i] * 0.66, Math.min(prev.y, y) - 38); }
    for (let k = 1; k <= 2; k++) { const ex = L.x + (L.w * k) / 3; if (i === n - 1 && k === 2) gold(B, ex, L.y - 30); else B.egg(ex, L.y - 26); }
    x += ws[i]; prev = L;
  }
  B.runEggs(x0 + 20, stop - 20, base, 'none');
  B.quiet.push([x0, stop]);
  B.run(120, 'line');
});

/* ───────────────────────── Clover Mill ───────────────────────── */

/** A snail patrolling a raised plateau: step up, read the patrol, step down. */
def('walkerStep', { needs: 'walker' }, (B, c) => {
  const patrol = rd(Math.max(96, P.walkerPatrol(c.d) + c.rand.range(-6, 6)));
  const h = rd(c.rand.range(22, 30));
  B.train([{ gap: 0, w: 150 + patrol + 190, dy: -h, eggs: false }]);
  if (B.bad) return;
  const isl = B.cur;
  const w0 = isl.x + 150, w1 = w0 + patrol;
  B.walker(w0, w1, clamp(P.walkerSpeed(c.d) + c.rand.range(-3, 3), 14, 50), c.rand.range(0, 1));
  B.tag('walker', w0);
  B.runEggs(isl.x + 20, w0 - 10, B.y, 'line');
  B.arc((w0 + w1) / 2 - (C * flightTime(0)) / 2, B.y, 0, 5);
  B.hop(0, rd(c.rand.range(220, 300)), h);
  B.runEggs(B.cur.x, B.x, B.y, 'wave');
  settle(B, c);
});

/** A long, slow patrol: more of the path to read, one good hop (or a stomp) to cross it. */
def('walkerWide', { needs: 'walker' }, (B, c) => { walkerEncounter(B, c, { patrolMul: 1.55, speedMul: 0.75, lead: 150, tail: 190 }); });

/* ───────────────────────── Reedwater ───────────────────────── */

function bob(B, c, res) {
  if (c.ch !== 2 || B.bad) return;
  for (const p of res.plats) {
    if (p.kind !== 'ledge') continue;
    p.motion = { axis: 'y', amp: rd(c.rand.range(5, 8)), period: q2(c.rand.range(3.4, 4.6)), phase: q2(c.rand.range(0, TAU)) };
  }
}
const logOpts = (c) => (c.ch === 2 ? { minSecs: 0.27 } : {});

/** Logs that zig-zag: up a little, down a little. */
def('logsZig', { needs: 'logs' }, (B, c) => {
  B.tag('logs', B.x);
  const n = capN(c, Math.min(c.k < 0.5 ? 3 : 4, Math.max(2, chainMax(c.d) - 1)));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c), dy: (i % 2 ? 1 : -1) * rd(c.rand.range(14, 22)), gold: i === 2 && c.rand.chance(0.25) });
  specs.push({ kind: 'ground', gap: gapW(c, -7), w: landW(c), dy: 0 });
  fixHeights(B, specs);
  bob(B, c, B.train(specs, logOpts(c)));
});

/** Two small logs, a wide raft to catch your breath on (a golden egg may ride it), two more logs. */
def('logsRaft', { needs: 'logs' }, (B, c) => {
  B.tag('logs', B.x);
  const specs = [
    { kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c), dy: 0 },
    { kind: 'ledge', gap: gapW(c, -10), w: rd(c.rand.range(190, 240)), dy: 0, gold: c.rand.chance(0.4) },
    { kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c), dy: 0 },
    { kind: 'ground', gap: gapW(c, -7), w: landW(c), dy: 0 },
  ];
  bob(B, c, B.train(specs, logOpts(c)));
});

/** A low lane of logs with a high lane of optional logs above it (eggs, and a golden one at the end). */
def('logsLane', { needs: 'logs' }, (B, c) => {
  B.tag('logs', B.x);
  const n = capN(c, Math.min(c.k < 0.5 ? 3 : 4, Math.max(2, chainMax(c.d) - 1)));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c) + 14, dy: 0 });
  specs.push({ kind: 'ground', gap: gapW(c, -7), w: landW(c), dy: 0 });
  const k0 = B.picks.length;
  const res = B.train(specs, logOpts(c));
  if (B.bad) return;
  bob(B, c, res);
  const top = res.plats.filter((p) => p.kind === 'ledge');
  top.forEach((L, i) => {
    if (i % 2 !== 0 && i !== top.length - 1) return;
    const h = rd(c.rand.range(70, 80));
    const U = B.plat('ledge', L.x + 8, L.y - h, Math.min(L.w - 4, 110), { opt: true });
    B.clearEggs(k0, U.x - 6, U.x + U.w + 6, U.y - 14, U.y + U.h + 14);          // the arcs of the low lane pass through this height
    B.egg(U.x + U.w * 0.3, U.y - 26);
    if (i === top.length - 1 || i === 2) gold(B, U.x + U.w * 0.7, U.y - 30); else B.egg(U.x + U.w * 0.7, U.y - 26);
  });
});

/* ───────────────────────── Orchard Heights ───────────────────────── */

/** A spring to a very high branch: the tallest reward in the orchard (optional). */
def('springTall', { needs: 'spring', springy: true }, (B, c) => springLedge(B, c, { tall: true }));

/** A spring to a ledge in the branches, then a hop to a second ledge (optional): an upper route in two parts. */
def('springChain', { needs: 'spring', springy: true }, (B, c) => {
  if (B.y < 274) { B.fail('springHeight'); return; }
  B.run(220, 'line');
  const sx = B.x + 20;
  B.run(40 + 640, 'none');
  B.spring(sx);
  B.tag('spring', sx);
  const e = ease(c.d);
  const rise = rd(c.rand.range(98, 122));
  const lx = springLanding(sx, rise);
  if (!(lx > 0)) { B.fail('spring'); return; }
  const lw = rd(clamp(150 - 30 * e + c.rand.range(-6, 6), 112, 150));
  const L1 = B.plat('ledge', lx - lw / 2, B.y - rise, lw, { opt: true });
  const L2 = B.plat('ledge', L1.x + lw + rd(c.rand.range(50, 62)), L1.y + rd(c.rand.range(-10, 10)), lw, { opt: true });
  const trig = sx - 21, up = T.springSpeed;
  const tAir = (up + Math.sqrt(up * up - 2 * T.gravity * rise)) / T.gravity;
  for (let i = 1; i <= 4; i++) { const t = tAir * (i / 5.5); B.egg(trig + C * t, B.y - (up * t - 0.5 * T.gravity * t * t) - 20); }
  B.egg(L1.x + lw * 0.5, L1.y - 26);
  B.egg(L1.x + lw + 26, Math.min(L1.y, L2.y) - 40);
  gold(B, L2.x + lw * 0.5, L2.y - 30);
  B.runEggs(sx + 60, B.x - 80, B.y, 'wave');
  B.run(180, 'line');
});

/** Plank stairs: thin branches up and back down (a main-route chain, jump to jump). */
def('branchSteps', { needs: 'logs' }, (B, c) => {
  const m = capN(c, clamp(chainMax(c.d) - 1, 2, 4), 2);              // planks; the last hop lands on the ground
  const u = Math.ceil(m / 2);
  const a = rd(c.rand.range(14, 17));
  const specs = [];
  for (let i = 0; i < m; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c) + 12, dy: i < u ? -a : a });
  specs.push({ kind: 'ground', gap: gapW(c, -8), w: landW(c), dy: (u - (m - u)) * a });
  B.train(specs);
});

/* ───────────────────────── Amber Quarry ───────────────────────── */

/** Cracked ledges that climb like stairs, then solid ground at the top and a walk down. */
def('crumbleStairs', { needs: 'crumble' }, (B, c) => {
  B.tag('crumble', B.x);
  const n = capN(c, clamp(chainMax(c.d) - 1, 2, 3));
  const step = rd(Math.min(c.rand.range(14, 20), 58 / (n + 1)));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'crumble', gap: crG(c), w: crW(c), dy: -step });
  specs.push({ kind: 'ground', gap: crG(c), w: landW(c) + 20, dy: -step });
  B.train(specs);
  if (B.bad) return;
  B.run(rd(c.rand.range(60, 140)), 'line');
  settle(B, c);
});

/** Cracked stones with a solid plank between them: land, hop on, land on the plank, hop again. */
def('crumbleSkip', { needs: 'crumble' }, (B, c) => {
  B.tag('crumble', B.x);
  B.train([
    { kind: 'crumble', gap: crG(c), w: crW(c), dy: 0 },
    { kind: 'ledge', gap: gapW(c, -12), w: ledgeW(c), dy: 0 },
    { kind: 'crumble', gap: crG(c), w: crW(c), dy: 0, gold: c.rand.chance(0.25) },
    { kind: 'ground', gap: crG(c), w: landW(c) + 20, dy: 0 },
  ]);
});

/* ───────────────────────── Fogwood ───────────────────────── */

/** Duck under a high moth, then hop a low one: two lanes, two answers. */
def('mothLane', { needs: 'flyer' }, (B, c) => { flyerEncounter(B, c, { high: true }); if (!B.bad) flyerEncounter(B, c, { high: false }); });

/** Three moths out of step along one run: low, high, low. */
def('mothSwarm', { needs: 'flyer' }, (B, c) => {
  const ax = rd(clamp(P.flyerAx(c.d) * 0.8, 28, 60));
  const ay = rd(P.flyerAy(c.d));
  const lead = 150, spacing = 2 * ax + 170, tail = 180;
  const x0 = B.x;
  B.run(lead + 3 * spacing + tail, 'none');
  B.runEggs(x0 + 20, x0 + lead, B.y, 'line');
  B.runEggs(B.x - tail + 20, B.x, B.y, 'line');
  const per = P.flyerPeriod(c.d);
  for (let k = 0; k < 3; k++) {
    const cx = x0 + lead + ax + 40 + k * spacing;
    const high = k === 1;
    B.flyer(cx, B.y - (high ? 92 : 52), ax, high ? Math.min(ay, 18) : ay, per + c.rand.range(-0.2, 0.4), c.rand.range(0, 1));
    if (high) B.runEggs(cx - ax, cx + ax + 60, B.y, 'line'); else B.arc(cx - (C * flightTime(0)) / 2, B.y, 0, 5);
  }
  B.tag('flyer', x0 + lead);
});

/** A moth over a raised plateau. */
def('mothHill', { needs: 'flyer' }, (B, c) => {
  const ax = rd(P.flyerAx(c.d) + c.rand.range(-4, 4));
  const ay = rd(P.flyerAy(c.d));
  const h = rd(c.rand.range(22, 30));
  B.train([{ gap: 0, w: 380 + 2 * ax + 60, dy: -h, eggs: false }]);
  if (B.bad) return;
  const isl = B.cur;
  const cx = isl.x + 160 + ax + 65;
  const high = c.rand.chance(0.5);
  B.flyer(cx, B.y - (high ? 92 : 52), ax, high ? Math.min(ay, 18) : ay, P.flyerPeriod(c.d) + c.rand.range(-0.2, 0.3), c.rand.range(0, 1));
  B.tag('flyer', cx - ax);
  B.runEggs(isl.x + 20, cx - ax - 20, B.y, 'line');
  B.runEggs(cx + ax + 40, B.x - 20, B.y, 'line');
  if (!high) B.arc(cx - (C * flightTime(0)) / 2, B.y, 0, 5);
  B.hop(0, rd(c.rand.range(220, 300)), h);
  B.runEggs(B.cur.x, B.x, B.y, 'wave');
  settle(B, c);
});

/** One moth that dives: at head height it must be ducked under or hopped, then it climbs away. */
def('mothDip', { needs: 'flyer' }, (B, c) => {
  const ax = rd(P.flyerAx(c.d) * 0.7 + 14);
  const ay = rd(clamp(P.flyerAy(c.d) + 10, 24, 38));
  const lead = 150, tail = 180;
  const x0 = B.x;
  B.run(lead + 2 * ax + 150 + tail, 'none');
  B.runEggs(x0 + 20, x0 + lead, B.y, 'line');
  B.runEggs(B.x - tail + 20, B.x, B.y, 'line');
  const cx = x0 + lead + ax + 75;
  B.flyer(cx, B.y - 66, ax, ay, P.flyerPeriod(c.d) + c.rand.range(0, 0.5), c.rand.range(0, 1));
  B.tag('flyer', cx - ax);
  B.arc(cx - (C * flightTime(0)) / 2, B.y, 0, 5);
});

/* ───────────────────────── Ember Canyon ───────────────────────── */

/** Spikes on a raised plateau: step up, a long run to the thorns, hop, step down. */
def('spikeStep', { needs: 'spikes' }, (B, c) => {
  const h = rd(c.rand.range(22, 30));
  const w = spikeW(c);
  B.train([{ gap: 0, w: 300 + w + 260, dy: -h, eggs: false }]);
  if (B.bad) return;
  const isl = B.cur;
  const hz = B.spikes(isl.x + 300, w);
  B.tag('spikes', hz.x);
  B.runEggs(isl.x + 20, hz.x - 40, B.y, 'line');
  B.spikeArc(hz, { n: 4 });
  B.runEggs(hz.x + w + 120, B.x - 20, B.y, 'line');
  B.hop(0, rd(c.rand.range(220, 300)), h);
  B.runEggs(B.cur.x, B.x, B.y, 'wave');
  settle(B, c);
});

/* ───────────────────────── Glass Coast ───────────────────────── */

/** A vertical ferry: a lift swings over a pit between two banks at the same height. */
def('liftFerry', { needs: 'lift' }, (B, c) => {
  liftUp(B, c, { gold: c.rand.chance(0.4), flat: true });
  settle(B, c);
});

/** Walk up a low bank and ride a lift DOWN the cliff (the same descent Lantern Caverns uses, taught here first). */
def('liftDrop', { needs: 'lift' }, (B, c) => { BEATS.liftDescent.fn(B, c); });

/* ───────────────────────── Lantern Caverns ───────────────────────── */

/** Lift -> crumble -> crumble -> ground: two cracked stones in a row after the ride. */
def('liftCrumbleChain', { needs: 'liftCrumble' }, (B, c) => {
  const { rand } = c;
  liftUp(B, c, { exitKind: 'crumble', exitW: crW(c) });
  if (B.bad) return;
  const A = B.cur;
  const Cr = B.plat('crumble', A.x + A.w + crG(c), A.y - rd(rand.range(-6, 6)), crW(c));
  const G = B.plat('ground', Cr.x + Cr.w + crG(c), Cr.y - rd(rand.range(0, 6)), rd(rand.range(230, 300)));
  const res = trainFeasible([stat(A), stat(Cr), stat(G)], { minSecs: 0.2 });
  if (!res.ok || !res.goodSpan(0, A.x - 6, A.x + 42)) { B.fail('liftCrumbleChain'); return; }
  B.tag('liftCrumble', A.x);
  B.tag('crumble', A.x);
  B.arc(res.takeoffs[0], A.y, Cr.y - A.y, 4);
  B.arc(res.takeoffs[1], Cr.y, G.y - Cr.y, 4, { goldMid: rand.chance(0.3) });
  B.setCursor(G);
  B.runEggs(G.x + 20, B.x, B.y, 'line');
  settle(B, c);
});

/* ───────────────────────── Frostline ───────────────────────── */

/** Ice planks that climb and fall: stepping ledges on the slippery stuff. */
def('iceSteps', { needs: 'ice' }, (B, c) => {
  B.tag('ice', B.x);
  const n = capN(c, clamp(chainMax(c.d) - 1, 2, 3), 2);
  const a = rd(c.rand.range(14, 18));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c) + 16, dy: i < n - 1 ? -a : 0, ice: true });
  for (let i = 0; i < n - 1; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c) + 16, dy: a, ice: true });
  specs.push({ kind: 'ground', gap: gapW(c, -8), w: landW(c), dy: 0, ice: true });
  fixHeights(B, specs);
  B.train(specs);
});

/* ───────────────────────── Moonridge ───────────────────────── */

/** One ferry across a chasm: bank A, a mover that swings in x, bank B (optionally higher). */
export function ferry(B, c, { bankW = null, rise = 0 } = {}) {
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
  const E = B.plat('ground', bx, y - rise, bankW ?? rd(rand.range(260, 340)));
  B.arc(aEnd - 10, y, -10, 3);
  for (let k = 1; k <= 3; k++) B.egg(xc + (Mw * k) / 4, y - 10 - 28);
  B.arc(xc + Mw - 30, y - 10, 10 - rise, 4);
  B.setCursor(E);
  B.runEggs(E.x + 20, B.x, B.y, 'line');
  return M;
}
/** Mover, a little island to stand on, then a second mover. */
def('ferryTwo', { needs: 'mover' }, (B, c) => {
  ferry(B, c, { bankW: rd(c.rand.range(210, 260)) });
  ferry(B, c);
  settle(B, c);
});
/** A ferry whose far bank is higher: land on the mover, then climb the wall to the bank. */
def('ferryStep', { needs: 'mover' }, (B, c) => {
  const rise = rd(c.rand.range(20, 28));
  ferry(B, c, { rise });
  B.run(rd(c.rand.range(100, 180)), 'line');
  B.hop(0, rd(c.rand.range(240, 300)), rise);
  B.runEggs(B.cur.x, B.x, B.y, 'wave');
  settle(B, c);
});

/* ───────────────────────── Dawnbridge ───────────────────────── */

/** A missing span: deck, a cracked stone where the stones fell out, deck. */
def('bridgeMissing', { needs: 'bridge' }, (B, c) => {
  B.tag('bridge', B.x);
  B.train([
    { kind: 'ground', gap: gapW(c, -5), w: rd(c.rand.range(180, 240)), dy: 0, h: 140 },
    { kind: 'crumble', gap: crG(c), w: crW(c) + 8, dy: 0 },
    { kind: 'ground', gap: crG(c), w: islW(c) + 40, dy: 0, h: 140, gold: c.rand.chance(0.3) },
    { kind: 'ground', gap: gapW(c, -3), w: landW(c), dy: 0, h: 140 },
  ]);
});

/** Decks that rise to a crest and fall again. */
def('bridgeArch', { needs: 'bridge' }, (B, c) => {
  B.tag('bridge', B.x);
  const a = rd(c.rand.range(14, 20));
  const specs = [
    { kind: 'ground', gap: gapW(c, -4), w: rd(c.rand.range(170, 230)), dy: -a, h: 140 },
    { kind: 'ground', gap: gapW(c, -4), w: islW(c), dy: -a, h: 140 },
    { kind: 'ground', gap: gapW(c, -4), w: islW(c) + 30, dy: a, h: 140, gold: c.rand.chance(0.3) },
    { kind: 'ground', gap: gapW(c, -3), w: landW(c), dy: a, h: 140 },
  ];
  B.train(specs);
});

/** Decks on pillars of different heights, narrower gaps between them. */
def('bridgePillars', { needs: 'bridge' }, (B, c) => {
  B.tag('bridge', B.x);
  const a = rd(c.rand.range(22, 28));
  const specs = [
    { kind: 'ground', gap: gapW(c, -9), w: rd(c.rand.range(180, 240)), dy: -a, h: 140 },
    { kind: 'ground', gap: gapW(c, -9), w: islW(c) + 10, dy: 0, h: 140 },
    { kind: 'ground', gap: gapW(c, -9), w: islW(c) + 40, dy: a, h: 140 },
    { kind: 'ground', gap: gapW(c, -3), w: landW(c), dy: 0, h: 140 },
  ];
  fixHeights(B, specs);
  B.train(specs);
});

export { BEATS };
