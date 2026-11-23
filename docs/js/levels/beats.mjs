/*
 * Egg Mama — beats: the small building blocks (200-900 u, 2-8 s) that acts are made of.
 *
 * Every beat starts with the cursor on a long flat ground island (the connector before it guarantees
 * the run-up) and ends with the cursor on ground again, with tail room, at about the same height.
 * A beat reads the context `c` = { d (difficulty here), k (0..1 progress through the act), rand, ch, circuit, evLeft } and
 * builds with the Builder. Chains shorten when the act's event quota is nearly used (capN). Fairness is by construction
 * (phys.mjs windows, trainFeasible) AND verified in tests by the planner bot at many difficulties and game-clock phases.
 * rest() is the recovery ground between beats: its length is set by the pacing controller (acts.mjs), a long one may carry a
 * ledge to climb (upperOverlay: no extra length), and the last 280 u before whatever comes next is always plain and level.
 * Spikes: width 7-8 u (a takeoff window of 0.43-0.44 s in the sim, against 0.45-0.57 s for the median gap hop; the art is drawn much bigger than the hitbox on purpose), >= 190 u of room after a landing (>= 250 u in the first two spike landscapes).
 */
import { T, clamp } from '../tuning.mjs';
import { P, ease, chainMax } from './params.mjs';
import { Y0 } from './builder.mjs';
import { C, flightTime, jumpWindow, spikeWindow, springLanding, APEX, MAX_RISE } from './phys.mjs';

const rd = Math.round;
export const BEATS = Object.create(null);
export const def = (name, meta, fn) => { BEATS[name] = { name, hz: true, ...meta, fn }; };

/* ───────────────────────── helpers ───────────────────────── */

export const gapW = (c, extra = 0) => {
  // The first minutes vary a little, later ones more; and now and then a span that is clearly different from its neighbours, so
  // a landscape does not read as the same hop again: early on LONGER (+3.5 .. +9 u, less and less as the gaps grow), later SHORTER
  // (-3.5 .. -8 u): the widest gap of a given difficulty never grows (every required hop keeps its measured window of >= 0.30 s).
  const d = c.d;
  const odd = c.rand.chance(0.4) ? (d < 7 ? c.rand.range(3.5, 9 - 5 * clamp(d / 7, 0, 1)) : -c.rand.range(3.5, 8)) : 0;
  return rd(clamp(P.gap(d) + extra + odd + c.rand.range(-3, 3) * clamp(d / 4, 0.25, 1), 22, T.maxGapHard - 2));
};
export const landW = (c) => rd(clamp(P.landing(c.d) + c.rand.range(-24, 24), T.minLanding + 14, 300));
export const islW = (c) => rd(clamp(P.island(c.d) + c.rand.range(-12, 14), T.minLanding + 6, 230));
export const ledgeW = (c) => rd(clamp(P.ledge(c.d) + c.rand.range(-10, 12), T.minLanding, 220));
/** A chain of `n` hops, shortened when the act's event quota is nearly used (c.evLeft: set by the pacing controller). `extra` = hops beyond the n platforms (the final landing). */
export const capN = (c, n, lo = 1, extra = 1) => (Number.isFinite(c.evLeft) ? Math.max(lo, Math.min(n, Math.round(c.evLeft) - extra)) : n);
export const dyJit = (c, m) => rd(c.rand.range(-m, m));
/**
 * The gap in front of a landing that is HIGHER than the ground she rolls on. A zero-gap WALL makes her stop dead against it and wait
 * for a swipe, which a small child may read as "it is broken" in a game whose premise is that Mama always rolls (and which a masher of
 * the jump button sails through, a real hop she has to time). So it is a small hop most of the time (a gap of 30-37 u in the first
 * three landscapes, 34-44 u later) and a wall only now and then (`wallP`: about 1 in 3 in Meadow to Orchard, 3 in 20 after); the first
 * wall of a journey gets a caption (cues.mjs: `wall`). Tiny steps (up to T.stepUp) are bumps she rolls over: those are not events.
 */
export const riseGap = (c, wallP = c.ch <= 1 ? 0.35 : c.ch <= 3 ? 0.3 : 0.15) => (c.rand.chance(wallP) ? 0 : rd(c.ch <= 2 ? c.rand.range(30, 37) : c.rand.range(34, 44)));

/**
 * Flat ground with the right amount of recovery room, plus the occasional pickup. Used between beats. The run is
 * lightly alive: arcs of eggs to jump for, and (sometimes) tiny hills, but the last 280 u before whatever comes next
 * is plain, level ground so nothing misleads the approach.
 */
export function rest(B, c, factor = 1, min = 220) {
  // the pacing controller (acts.mjs) may set the length of the first rest of a spec so the landscape lands on its event rate
  const len = c.restLen != null && factor === 1 ? rd(c.restLen) : rd(Math.max(min, P.rest(c.d) * factor * c.rand.range(0.85, 1.2)));
  const x0 = B.x;
  const plain = Math.min(len, 280);
  const free = len - plain;
  if (free >= 160) {
    // a long rest may carry a ledge above the path with eggs (and now and then a golden one): something to climb for, and no extra length
    if (free >= 330 && c.rand.chance(c.overlayP ?? 0.3)) upperOverlay(B, c, free);
    else if (c.rand.chance(0.4)) bumps(B, c, free);
    else B.run(free, 'auto');
  }
  B.run(plain, 'line');
  dropPickups(B, c, x0, B.x);
}

/** An optional ledge hung above `len` u of flat path (a rest): an easy jump up, eggs along it, sometimes a golden egg. Adds no length. */
function upperOverlay(B, c, len) {
  const base = B.y;
  const w = rd(clamp(P.ledge(c.d) + c.rand.range(10, 40), 100, 160));
  const h = rd(c.rand.range(66, 80));
  const pre = rd(c.rand.range(90, Math.max(100, len - w - 130)));
  const x0 = B.x;
  B.run(len, 'none');
  const L = B.plat('ledge', x0 + pre, base - h, w, { opt: true });
  B.arc(L.x + Math.min(34, w * 0.3) - C * flightTime(-h), base, -h, 3);
  for (let k = 1; k <= 3; k++) { const ex = L.x + (w * k) / 4; if (k === 2 && c.rand.chance(0.3) && B.x - B.lastGold > 2600) { B.gold(ex, L.y - 30); } else B.egg(ex, L.y - 26); }
  B.runEggs(x0 + 20, x0 + pre - 40, base, 'line');
  B.quiet.push([x0, x0 + pre]);
}

/** A few tiny rolling hills (steps up of at most 6 u, any drop): the ground stops looking like a ruler. */
function bumps(B, c, len) {
  let left = len;
  while (left > 0) {
    const w = Math.min(left, rd(c.rand.range(150, 300)));
    const dy = rd(c.rand.range(-6, 9));
    if (Math.abs(B.y + dy - Y0) <= 14 && left > w + 100) { B.hop(0, w, dy); B.runEggs(B.cur.x + 20, B.x, B.y, 'auto'); if (w >= 280) B.quiet.push([B.cur.x, B.x]); }
    else B.run(w, 'auto');
    left -= w;
  }
}

/** Golden / shield / magnet pickups on SAFE flat ground, spaced by main-route distance (about 45 s, 90 s, 3 min). */
export function dropPickups(B, c, x0, x1) {
  if (x1 - x0 < 150) return;
  const mid = (x0 + x1) / 2 + c.rand.range(-30, 30);
  // each kind keeps its own clock; when several are due on the same stretch they sit side by side
  if (B.x - B.lastGold > 3600 + c.rand.range(0, 600)) { B.gold(mid, B.y - 28); B.lastGold = B.x; }
  if (x1 - x0 < 260) return;                           // a shield / magnet sits beside the gold egg: only on a rest long enough for both
  if (c.ch >= 2 && B.x - B.lastShield > 9600 + c.rand.range(0, 1500)) { B.pickup('shield', mid + 90, B.y - 30); B.lastShield = B.x; B.tag('shield', mid); }
  if (c.ch >= 1 && B.x - B.lastMagnet > 16000 + c.rand.range(0, 3000)) { B.pickup('magnet', mid - 90, B.y - 30); B.lastMagnet = B.x; B.tag('magnet', mid); }
}

/** Bring the cursor's ground back to the usual height with small, safe steps (up <= stepUp, down any). */
export function settle(B, c) {
  let guard = 0;
  while (Math.abs(B.y - Y0) > 1 && guard++ < 12) {
    const dy = clamp(Y0 - B.y, -8, 40);
    B.hop(0, rd(c.rand.range(160, 240)), dy);
    B.runEggs(B.cur.x, B.x, B.y, 'auto');
  }
}

/** Keep a chain's heights inside [lo, hi] and end it back at the usual ground height. */
export function fixHeights(B, specs, lo = Y0 - 36, hi = Y0 + 14) {
  let y = B.y;
  for (const s of specs) { let dy = s.dy; if (y + dy < lo) dy = lo - y; if (y + dy > hi) dy = hi - y; s.dy = dy; y += dy; }
  specs[specs.length - 1].dy += Y0 - y;
}

/** An optional / risky golden egg (upper route): does not count toward the main-route cadence. */
export const gold = (B, x, y) => { B.gold(x, y); };
/** A golden egg reachable on the main route with at most one easy jump: resets the cadence clock. */
export const goldMain = (B, x, y) => { B.gold(x, y); B.lastGold = Math.max(B.lastGold, B.x); };

/* ───────────────────────── plain ground and gaps ───────────────────────── */

/** Rolling over flat ground with eggs. The very first stretch of the world. */
def('runEggs', { needs: 'gap', hz: false }, (B, c) => {
  const x0 = B.x;
  B.run(rd(c.rand.range(500, 800)), c.rand.pick(['line', 'wave', 'dash']));
  dropPickups(B, c, x0, B.x);
});

/** A golden egg sitting on flat, safe ground with a line of eggs leading to it. */
def('goldenPatch', { needs: 'gap', hz: false }, (B, c) => {
  const len = rd(c.rand.range(560, 760));
  const x0 = B.x;
  B.run(len, 'line');
  const gx = x0 + len / 2;
  gold(B, gx, B.y - 28);
  B.lastGold = B.x;
});

def('gap1', { needs: 'gap' }, (B, c) => {
  B.tag('gap', B.x);
  // the very first gap of a journey: forgiving (44 u, a real jump since she can only walk across ~38 u) with a wide landing
  const first = !B.sawGap;
  B.sawGap = true;
  B.train([{ gap: first ? 44 : gapW(c), w: first ? 240 : landW(c), dy: 0, gold: c.rand.chance(c.goldP ?? 0.1) }]);
});

def('gapPair', { needs: 'gap' }, (B, c) => {
  B.tag('gap', B.x);
  B.train([{ gap: gapW(c), w: islW(c) + 30, dy: 0 }, { gap: gapW(c, 2), w: landW(c) - 20, dy: dyJit(c, 6) }]);
});

def('gapChain', { needs: 'gap' }, (B, c) => {
  B.tag('gap', B.x);
  const n = capN(c, Math.min(c.k < 0.3 ? 3 : c.k < 0.7 ? 4 : 5, Math.max(3, chainMax(c.d))), 2, 0);        // chains lengthen over the hour: 3 at first, 5 at the summit
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ gap: gapW(c, i % 2 ? 2 : -1), w: i === n - 1 ? landW(c) : islW(c), dy: i === n - 1 ? 0 : dyJit(c, 8), gold: i === 1 && c.rand.chance(0.3) });
  fixHeights(B, specs, Y0 - 24, Y0 + 12);
  B.train(specs);
});

/** A step up (a short wall she hops onto), a stretch on the higher ground, then steps back down. Walls forgive: a late jump just stalls. */
def('stepUp', { needs: 'step' }, (B, c) => {
  B.tag('step', B.x);
  const h = rd(clamp(24 + 26 * ease(c.d) + c.rand.range(-4, 12), 22, 64));
  const gap = riseGap(c);                              // a small hop onto the higher ground (almost never a wall: she would stop dead)
  B.train([{ gap, w: rd(c.rand.range(200, 300)), dy: -h }]);
  if (B.bad) return;
  B.runEggs(B.cur.x + 30, B.x, B.y, 'line');
  B.hop(0, rd(c.rand.range(220, 320)), h);            // drop back down (walk off the edge)
  B.runEggs(B.cur.x, B.x, B.y, 'wave');
  settle(B, c);
});

/** Two or three steps up and down: little islands to hop between. */
def('stairs', { needs: 'step' }, (B, c) => {
  B.tag('step', B.x);
  const n = c.k < 0.5 ? 2 : 3;
  const specs = [];
  const h = [];
  for (let i = 0; i < n; i++) { const s = rd(clamp(22 + 14 * ease(c.d) + c.rand.range(0, 16), 22, Math.floor(110 / n))); h.push(s); specs.push({ gap: riseGap(c), w: rd(c.rand.range(150, 210)), dy: -s, gold: i === n - 1 && c.rand.chance(0.3) }); }
  B.train(specs);
  if (B.bad) return;
  for (let i = n - 1; i >= 0; i--) B.hop(0, rd(c.rand.range(150, 210)), h[i]);
  settle(B, c);
});

/** Rolling hills: adjacent small islands, tiny steps up (<= stepUp) and drops. No jumping needed. */
def('hills', { needs: 'hill', hz: false }, (B, c) => {
  const n = rd(c.rand.range(4, 7));
  for (let i = 0; i < n; i++) {
    let dy = rd(c.rand.range(-8, 14));
    const ny = B.y + dy;
    if (ny < Y0 - 18) dy = Y0 - 18 - B.y; else if (ny > Y0 + 14) dy = Y0 + 14 - B.y;
    B.hop(0, rd(c.rand.range(140, 260)), dy);
    B.runEggs(B.cur.x, B.x, B.y, 'wave');
  }
  settle(B, c);
});

/**
 * An OPTIONAL upper route: thin ledges above the ground path with eggs and a golden egg. The ground below is the
 * main route; hopping up is the harder, rewarding choice. Heights stay below MAX_RISE so one swipe reaches them.
 */
def('upper', { needs: 'upper', hz: false }, (B, c) => {
  B.tag('upper', B.x);
  const n = 1 + (c.k > 0.45 ? 1 : 0) + (c.k > 0.8 && c.rand.chance(0.5) ? 1 : 0);
  B.run(110, 'line');
  const base = B.y;
  let x = B.x + 60;
  const total = n * 270 + 90;
  B.run(total, 'none');
  const stop = B.x;
  for (let i = 0; i < n; i++) {
    const h = rd(c.rand.range(66, 82));
    const w = rd(clamp(P.ledge(c.d) + c.rand.range(0, 26), 96, 170));
    const L = B.plat('ledge', x, base - h, w, { opt: true });
    // eggs: a real arc from the middle of the takeoff window up onto the ledge, then eggs along the top
    const F = C * flightTime(-h);
    const xt = L.x + Math.min(34, w * 0.3) - F;          // land near the ledge's left end: the climb stays clear of the slab
    B.arc(xt, base, -h, 3);
    const gi = i === n - 1;
    for (let k = 1; k <= 3; k++) { const ex = L.x + (w * k) / 4; if (gi && k === 2) gold(B, ex, L.y - 30); else B.egg(ex, L.y - 26); }
    x = L.x + w + rd(c.rand.range(70, 120));
  }
  B.runEggs(x - 40, stop, base, 'none');
  B.quiet.push([B.cur.x, stop]);
  B.run(Math.max(0, x + 90 - stop), 'line');
});

/* ───────────────────────── walkers ───────────────────────── */

export function walkerEncounter(B, c, { lead = 130, tail = 170, patrolMul = 1, speedMul = 1 } = {}) {
  // now and then a short patrol (~100-140 u) instead of the long one: the snails do not all read the same
  const shorter = patrolMul >= 1 && c.role !== 'teach' && c.rand.chance(0.35) ? c.rand.range(0.62, 0.86) : 1;       // (never in the teaching act: shorter is harder)
  const patrol = rd(Math.max(96, P.walkerPatrol(c.d) * patrolMul * shorter + c.rand.range(-8, 8)));
  const speed = clamp(P.walkerSpeed(c.d) * speedMul + c.rand.range(-3, 3), 14, 52);
  const x0 = B.x;
  B.run(lead + patrol + tail, 'none');
  B.runEggs(x0 + 20, x0 + lead - 10, B.y, 'line');
  B.runEggs(x0 + lead + patrol + 20, B.x, B.y, 'line');
  const w0 = x0 + lead, w1 = w0 + patrol;
  B.walker(w0, w1, speed, c.rand.range(0, 1));
  B.tag('walker', w0);
  // an egg arc over the patrol: the real parabola of a hop centred on the patrol
  const F = C * flightTime(0);
  B.arc((w0 + w1) / 2 - F / 2, B.y, 0, 5);
  return { w0, w1 };
}

def('walker1', { needs: 'walker' }, (B, c) => { walkerEncounter(B, c); });

/** A walker on its own island between two gaps: read the snail, hop it or stomp it, then jump on. */
def('walkerIsland', { needs: 'walker' }, (B, c) => {
  const patrol = rd(Math.max(96, P.walkerPatrol(c.d) + c.rand.range(-6, 6)));
  const wIsl = 150 + patrol + 170;
  const g1 = gapW(c, -2), g2 = gapW(c, -2);
  const res = B.train([{ gap: g1, w: wIsl, dy: 0 }, { gap: g2, w: landW(c) - 10, dy: 0 }]);
  if (B.bad) return;
  const isl = res.plats[0];
  const saved = B.cur, sx = B.x, sy = B.y;
  B.cur = isl; B.x = isl.x + isl.w; B.y = isl.y;
  B.walker(isl.x + 150, isl.x + 150 + patrol, clamp(P.walkerSpeed(c.d) + c.rand.range(-3, 3), 14, 50), c.rand.range(0, 1));
  B.tag('walker', isl.x + 150);
  B.cur = saved; B.x = sx; B.y = sy;
});

def('walkerPair', { needs: 'walker' }, (B, c) => {
  walkerEncounter(B, c, { tail: 260 });
  if (B.bad) return;
  walkerEncounter(B, c, { lead: 120, patrolMul: 0.95, speedMul: 1.1 });
});

/* ───────────────────────── flyers ───────────────────────── */

export function flyerEncounter(B, c, { high = false } = {}) {
  const ax = rd(P.flyerAx(c.d) + c.rand.range(-4, 6));
  const ay = rd(P.flyerAy(c.d) + c.rand.range(-2, 3));
  const lead = 130, tail = 160;
  const x0 = B.x;
  B.run(lead + 2 * ax + 130 + tail, 'none');
  B.runEggs(x0 + 20, x0 + lead, B.y, 'line');
  B.runEggs(B.x - tail + 20, B.x, B.y, 'line');
  const cx = x0 + lead + ax + 65;
  // she can pass UNDER a high flyer; a low one dips to head height and must be hopped or stomped
  const cy = high ? B.y - 92 : B.y - 52;
  B.flyer(cx, cy, ax, high ? Math.min(ay, 18) : ay, P.flyerPeriod(c.d) + c.rand.range(-0.2, 0.3), c.rand.range(0, 1));
  B.tag('flyer', x0 + lead);
  if (high) {
    // a high moth is passed UNDER: the eggs run along the ground beneath it (an arc would invite a jump into it)
    B.runEggs(x0 + lead + 10, x0 + lead + 2 * ax + 130, B.y, 'line');
  } else {
    const F = C * flightTime(0);
    B.arc(cx - F / 2, B.y, 0, 5);          // a low swooper can be hopped or stomped: the arc shows the way over
  }
}
def('flyer1', { needs: 'flyer' }, (B, c) => flyerEncounter(B, c, { high: false }));
def('flyerHigh', { needs: 'flyer' }, (B, c) => flyerEncounter(B, c, { high: true }));
def('flyerPair', { needs: 'flyer' }, (B, c) => { flyerEncounter(B, c, { high: c.rand.chance(0.5) }); if (!B.bad) flyerEncounter(B, c, { high: false }); });

/* ───────────────────────── spikes ───────────────────────── */

export function spikeHop(B, c, w, cycle = null) {
  const sx = B.x + 20;
  B.run(w + 40, 'none');
  const h = B.spikes(sx, w, cycle);
  B.tag('spikes', sx);
  B.spikeArc(h, { n: 4 });
  return h;
}
export const spikeW = (c) => rd(clamp(P.spikeW(c.d), 5, 10));   // 7 u at the first spikes, 8-9 u later: a takeoff window of 0.43-0.46 s at any difficulty (no jitter: one unit is a visible step of difficulty)

def('spike1', { needs: 'spikes' }, (B, c) => {
  B.run(30, 'none');
  spikeHop(B, c, spikeW(c));
  B.run(200, 'line');
});

def('spikeRow', { needs: 'spikes' }, (B, c) => {
  const n = c.d > 10 ? 3 : 2;                       // two thorns with room between; three only late in the journey (a late jump over the first leaves less room for the next)
  for (let i = 0; i < n; i++) {
    B.run(i ? rd(c.rand.range(150, 190)) : 20, 'line');
    spikeHop(B, c, spikeW(c));
  }
  B.run(200, 'line');
});

def('spikeCycle', { needs: 'spikes' }, (B, c) => {
  const period = c.rand.range(2.2, 3.4), up = period * c.rand.range(0.4, 0.55);
  B.run(30, 'none');
  spikeHop(B, c, spikeW(c), { period, up, phase: c.rand.range(0, 1) });
  B.run(rd(c.rand.range(150, 190)), 'line');
  spikeHop(B, c, spikeW(c), { period: period * 1.15, up: up * 1.1, phase: c.rand.range(0, 1) });
  B.run(200, 'line');
});

/** A gap, then spikes on the landing island with room to recover (Ember Canyon's signature chain). */
def('gapSpike', { needs: 'spikes' }, (B, c) => {
  B.tag('gap', B.x);
  const g = gapW(c);
  const lead = rd((c.ch <= 7 ? 250 : 190) + c.rand.range(0, 30));       // recovery room after the landing: the first spike landscapes get the most
  const w = spikeW(c);
  const isl = lead + 40 + w + 190;
  B.train([{ gap: g, w: isl, dy: 0 }]);
  if (B.bad) return;
  const p = B.cur;
  const h = B.spikes(p.x + lead + 20, w);
  B.tag('spikes', p.x + lead);
  B.spikeArc(h, { n: 4 });
});

/** Spikes first, then a gap: the recovery room between them is what the tests check. */
def('spikeGap', { needs: 'spikes' }, (B, c) => {
  B.run(30, 'none');
  const w = spikeW(c);
  const h = spikeHop(B, c, w);
  B.run(150, 'line');
  B.tag('gap', B.x);
  B.train([{ gap: gapW(c, -2), w: landW(c) }]);
});

/* ───────────────────────── springs ───────────────────────── */

/**
 * A spring on the ground path launches her to a ledge in the branches (an optional upper route with a golden egg);
 * the lower path continues underneath to land back on. Rolling onto the spring is automatic, so nothing is timed.
 */
export function springLedge(B, c, { two = false, tall = false } = {}) {
  if (B.y < 274) { B.fail('springHeight'); return; }
  const lead = 160;
  B.run(lead, 'line');
  const sx = B.x + 20;                 // spring centre
  B.run(40 + 300 + (two ? 240 : 0), 'none');
  B.spring(sx);
  B.tag('spring', sx);
  const e = ease(c.d);
  const rise = tall ? rd(clamp(150 + 22 * e + c.rand.range(-6, 6), 148, 178)) : rd(clamp(96 + 54 * e + c.rand.range(-8, 8), 92, 156));
  const lx = springLanding(sx, rise);
  if (!(lx > 0)) { B.fail('spring'); return; }
  const lw = rd(clamp(180 - 68 * e + c.rand.range(-8, 8), 108, 188));
  const L = B.plat('ledge', lx - lw / 2, B.y - rise, lw, { opt: true });
  // eggs up the launch arc, a golden egg on the ledge
  const trig = sx - 21;
  const up = T.springSpeed;
  const tAir = (up + Math.sqrt(up * up - 2 * T.gravity * rise)) / T.gravity;
  for (let i = 1; i <= 4; i++) {
    const t = tAir * (i / 5.5);
    B.egg(trig + C * t, B.y - (up * t - 0.5 * T.gravity * t * t) - 20);
  }
  gold(B, L.x + lw * 0.55, L.y - 30);
  B.egg(L.x + lw * 0.25, L.y - 26); B.egg(L.x + lw * 0.85, L.y - 26);
  B.runEggs(sx + 60, B.x - 80, B.y, 'wave');
  if (two) {
    const sx2 = B.x - 200;
    B.spring(sx2);
    const rise2 = rd(clamp(96 + 54 * e + c.rand.range(-8, 8), 92, 156));
    const lx2 = springLanding(sx2, rise2);
    const L2 = B.plat('ledge', lx2 - lw / 2, B.y - rise2, lw, { opt: true });
    B.egg(L2.x + lw * 0.3, L2.y - 26); gold(B, L2.x + lw * 0.6, L2.y - 30);
  }
  B.run(120, 'line');
}
def('springLedge', { needs: 'spring', springy: true }, (B, c) => springLedge(B, c));
def('springTwo', { needs: 'spring', springy: true }, (B, c) => springLedge(B, c, { two: true }));

/** A spring at the end of the island carries her over a gap without any timing: she only has to roll onto it. */
def('springGap', { needs: 'spring', springy: true }, (B, c) => {
  if (B.y < 274) { B.fail('springHeight'); return; }
  B.run(40, 'none');
  const sx = B.x - 18;                          // the spring sits at the very end of the island
  B.spring(sx);
  B.tag('spring', sx);
  const gap = rd(c.rand.range(58, 68));         // a flat spring launch lands ~82 u past the island's end
  const lw = rd(clamp(P.springLandW(c.d) + 60, 200, 300));
  const p = B.hop(gap, lw, 0);
  const trig = sx - 21;
  const tAir = (2 * T.springSpeed) / T.gravity;
  for (let i = 1; i <= 4; i++) {
    const t = tAir * (i / 5.5);
    B.egg(trig + C * t, p.y - (T.springSpeed * t - 0.5 * T.gravity * t * t) - 20);
  }
  B.runEggs(p.x + 20, B.x, B.y, 'line');
});

/* ───────────────────────── crumbling ledges ───────────────────────── */

export const crW = (c) => rd(clamp(P.crumbleW(c.d) + c.rand.range(-4, 6), T.minLanding, 96));
export const crG = (c) => rd(clamp(P.crumbleGap(c.d) + c.rand.range(-3, 3), 24, 50));

/** Crumbling ledges ABOVE solid ground: the safe first lesson (an optional route with eggs; falling just drops her to the path). */
def('crumbleUpper', { needs: 'crumble', hz: false }, (B, c) => {
  B.tag('crumble', B.x);
  B.run(200, 'line');
  const base = B.y;
  const n = 2 + (c.k > 0.5 ? 1 : 0);
  const x0 = B.x;
  B.run(n * 230 + 180, 'none');
  let x = x0 + 60;
  for (let i = 0; i < n; i++) {
    const h = rd(c.rand.range(66, 80));
    const w = crW(c) + 18;
    const L = B.plat('crumble', x, base - h, w, { opt: true });
    B.arc(L.x + Math.min(30, w * 0.3) - C * flightTime(-h), base, -h, 3);
    if (i === n - 1) gold(B, L.x + w / 2, L.y - 30); else B.egg(L.x + w / 2, L.y - 26);
    x = L.x + w + crG(c) + 40;
  }
  B.runEggs(x0, B.x, base, 'none');
  B.quiet.push([x0, B.x]);
  B.run(150, 'line');
});

/** Crumbling ledges across a pit: land, and jump on before it gives way. */
def('crumbleChain', { needs: 'crumble' }, (B, c) => {
  B.tag('crumble', B.x);
  const n = capN(c, Math.min(c.k < 0.3 ? 2 : c.k < 0.6 ? 3 : c.k < 0.85 ? 4 : 5, Math.max(2, chainMax(c.d) - 1)));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'crumble', gap: crG(c), w: crW(c), dy: dyJit(c, 12), gold: i === 1 && c.rand.chance(0.35) });
  specs.push({ kind: 'ground', gap: crG(c), w: landW(c) + 20, dy: 0 });
  fixHeights(B, specs);
  B.train(specs);
});

/** One crumbling stepping stone between two solid islands (a gap with a cracked middle). */
def('crumbleBridge', { needs: 'crumble' }, (B, c) => {
  B.tag('crumble', B.x);
  B.train([{ kind: 'crumble', gap: crG(c), w: crW(c) + 14, dy: 0, gold: c.rand.chance(0.2) }, { gap: crG(c), w: landW(c), dy: 0 }]);
});

/* ───────────────────────── stepping ledges over a pit (logs, planks, bridges) ───────────────────────── */

/**
 * Stepping logs over the flood. In Reedwater (the water landscape) the logs BOB a little (a swing of 5-8 u, period
 * ~4 s: "the logs bob up and down"): small enough that every window of the static chain still holds, and the chain is
 * validated with extra slack (0.27 s instead of 0.2 s) to cover the +-8 u of height.
 */
def('logs', { needs: 'logs' }, (B, c) => {
  B.tag('logs', B.x);
  // how many logs: not always the same three (2, 3, 4 or 5 by how far into the act, with a coin toss either way)
  const n = capN(c, clamp(Math.min(c.k < 0.35 ? 3 : c.k < 0.7 ? 4 : 6, Math.max(2, chainMax(c.d) - 1)) + c.rand.int(-1, 1), 2, 5));
  const specs = [];
  for (let i = 0; i < n; i++) specs.push({ kind: 'ledge', gap: gapW(c, -10), w: ledgeW(c) + (c.rand.chance(0.3) ? c.rand.int(14, 40) : 0), dy: dyJit(c, 16), gold: i === 2 && c.rand.chance(0.25) });
  specs.push({ kind: 'ground', gap: gapW(c, -7), w: landW(c), dy: 0 });
  fixHeights(B, specs);
  const bob = c.ch === 2;
  const res = B.train(specs, bob ? { minSecs: 0.27 } : {});
  if (bob && !B.bad) {
    for (const p of res.plats) {
      if (p.kind !== 'ledge') continue;
      p.motion = { axis: 'y', amp: rd(c.rand.range(5, 8)), period: Math.round(c.rand.range(3.4, 4.6) * 100) / 100, phase: Math.round(c.rand.range(0, 2 * Math.PI) * 100) / 100 };
    }
  }
});

/** Broken spans: a deck of big and small pieces; the small ones need a second landing planned. */
def('bridge', { needs: 'bridge' }, (B, c) => {
  B.tag('bridge', B.x);
  const n = capN(c, Math.max(2, Math.min(c.k < 0.35 ? 3 : c.k < 0.7 ? 4 : 5, Math.max(2, chainMax(c.d) - 1)) - c.rand.int(0, 1)));
  const specs = [];
  let big = true;
  for (let i = 0; i < n; i++) {
    specs.push({ kind: 'ground', gap: gapW(c, big ? -5 : -3), w: big ? rd(c.rand.range(180, 260)) : islW(c), dy: 0, h: 140, gold: !big && i === 1 && c.rand.chance(0.3) });
    big = !big || c.rand.chance(0.35);
  }
  specs.push({ kind: 'ground', gap: gapW(c), w: landW(c), dy: 0 });
  B.train(specs);
});

/* ───────────────────────── scenic breathers ───────────────────────── */

/** An egg field: big arcs of eggs over flat, safe ground and a golden egg. No hazards. */
def('eggField', { needs: 'gap', hz: false }, (B, c) => {
  const len = rd(c.rand.range(780, 1000));
  const x0 = B.x;
  B.run(len, 'none');
  const top = B.y;
  const arches = rd(c.rand.range(2, 4));
  for (let a = 0; a < arches; a++) {
    const ax = x0 + 90 + (a * (len - 180)) / arches;
    const span = rd(c.rand.range(110, 170));
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      const x = ax + span * u, y = top - 26 - 64 * Math.sin(Math.PI * u);
      if (a === arches - 1 && i === 3) goldMain(B, x, y); else B.egg(x, y);
    }
  }
  B.runEggs(x0 + 20, B.x - 20, B.y, 'line');
  B.quiet.push([x0, B.x]);
});

/** A little cluster of pickups on a raised ledge (optional): a golden egg, eggs, maybe a shield or magnet. */
def('treasure', { needs: 'upper', hz: false }, (B, c) => {
  B.run(220, 'line');
  const base = B.y;
  B.run(480, 'none');
  const x = B.x - 400;
  const h = rd(c.rand.range(70, 82));
  const w = 150;
  const L = B.plat('ledge', x, base - h, w, { opt: true });
  B.arc(L.x + 30 - C * flightTime(-h), base, -h, 3);
  gold(B, L.x + w * 0.5, L.y - 30);
  B.egg(L.x + w * 0.2, L.y - 26); B.egg(L.x + w * 0.8, L.y - 26);
  if (c.ch >= 2 && c.rand.chance(0.5) && B.x - B.lastShield > 5000) { B.pickup('shield', L.x + w * 0.5, L.y - 34); B.lastShield = B.x; B.tag('shield', L.x); }
  B.runEggs(x - 40, B.x, base, 'line');
  B.quiet.push([x - 80, B.x]);
  B.run(120, 'none');
});

export const beatNames = () => Object.keys(BEATS);
export { APEX, MAX_RISE, jumpWindow, spikeWindow };
