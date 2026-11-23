/*
 * Egg Mama — how demanding is a stretch of level? Measured from GEOMETRY ONLY (platforms, enemies, hazards,
 * springs), never from the generator's intentions, so the tests and the report can check that the difficulty
 * ramp really is a slow ramp with a gentle sawtooth.
 *
 * Every event on the main route gets a hardness on the same 0..20 scale as chapters.difficulty():
 *   jump      the takeoff window of the jump in seconds (wide window = easy)
 *   walker    its speed and how short its patrol is
 *   flyer     reach, bob and period
 *   spikes    width (and cycling)
 *   crumble   how narrow the ledge is
 *   lift / mover   how large and fast the swing is
 * A stretch's score blends the average and the peak event with a bonus for events packed close together
 * (chains: less recovery room), so more demanding = harder events AND less rest between them.
 */
import { T, clamp } from '../tuning.mjs';
import { unease } from './params.mjs';
import { jumpWindow } from './phys.mjs';

/** A thin ledge that only bobs a few units (Reedwater's logs) is analysed like a static one; lifts and movers are not. */
const moving = (p) => !!p.motion && !(p.kind === 'ledge' && p.motion.amp <= 10);
const WIN_EASY = 0.69, WIN_SPAN = 0.24;        // a flat gap of 42 u has a 0.68 s window, a gap of 68 u 0.45 s
const hWindow = (secs) => clamp((20 * (WIN_EASY - secs)) / WIN_SPAN, 0, 20);

/** All events on the main route between x0 and x1: [{ x, h, kind }]. */
export function eventsIn(level, x0, x1) {
  const ev = [];
  const plats = level.platforms.filter((p) => !p.o && p.x + p.w >= x0 - 400 && p.x <= x1 + 400);
  for (let i = 0; i < plats.length; i++) {
    const p = plats[i];
    if (p.kind === 'crumble' && p.x >= x0 && p.x < x1) ev.push({ x: p.x, h: unease(clamp((104 - p.w) / 34, 0, 1)), kind: 'crumble' });
    if (p.kind === 'lift' && p.x >= x0 && p.x < x1) {
      const m = p.motion;
      const h = unease(0.5 * clamp((m.amp - 30) / 22, 0, 1) + 0.5 * clamp((6.4 - m.period) / 2.6, 0, 1));
      ev.push({ x: p.x, h, kind: 'lift' }, { x: p.x + p.w, h, kind: 'liftexit' });      // a jump on, a jump off
    }
    if (p.kind === 'mover' && p.x >= x0 && p.x < x1) {
      const m = p.motion;
      const h = unease(0.5 * clamp((m.amp - 14) / 16, 0, 1) + 0.5 * clamp((6.2 - m.period) / 2.4, 0, 1));
      ev.push({ x: p.x, h, kind: 'mover' }, { x: p.x + p.w, h, kind: 'moverexit' });
    }
    const q = plats[i + 1];
    if (!q) continue;
    if (moving(p) || moving(q)) continue;                            // lifts / movers have their own event above
    const gap = q.x - (p.x + p.w), rise = p.y - q.y;
    if (gap <= 0 && rise <= T.stepUp) continue;                      // simply continues (or a drop)
    if (p.x + p.w < x0 || p.x + p.w >= x1) continue;
    // a spring at the end of the island does the jumping for her: no timing at all
    if (gap > 0 && level.springs.some((s) => s.x >= p.x + p.w - 70 && s.x <= p.x + p.w)) { ev.push({ x: p.x + p.w, h: 2, kind: 'spring' }); continue; }
    const kind = (k) => (k === 'ground' ? 'ground' : 'ledge');
    const w = jumpWindow({ end: p.x + p.w, top: p.y, kind: kind(p.kind) }, { x: q.x, end: q.x + q.w, top: q.y, kind: kind(q.kind) });
    if (!(w.secs > 0)) continue;
    let h = hWindow(w.secs);
    if (gap <= 0) h = Math.min(h, 0.15 * rise / 6);                  // a wall step is a forgiving hop
    ev.push({ x: p.x + p.w, h, kind: gap <= 0 ? 'step' : 'gap' });
  }
  for (const e of level.enemies) {
    if (e.kind === 'walker') {
      if (e.x0 < x0 || e.x0 >= x1) continue;
      const len = e.x1 - e.x0;
      ev.push({ x: e.x0, h: unease(0.55 * clamp((e.speed - 22) / 28, 0, 1) + 0.45 * clamp((170 - len) / 66, 0, 1)), kind: 'walker' });
    } else {
      if (e.cx < x0 || e.cx >= x1) continue;
      ev.push({ x: e.cx, h: unease(0.4 * clamp((e.ax - 34) / 42, 0, 1) + 0.4 * clamp((e.ay - 14) / 20, 0, 1) + 0.2 * clamp((4.9 - e.period) / 1.6, 0, 1)), kind: 'flyer' });
    }
  }
  for (const s of level.springs) {
    if (s.x < x0 || s.x >= x1) continue;
    const ledge = level.platforms.find((p) => p.o && p.x > s.x && p.x < s.x + 200);
    if (!ledge) continue;                                                              // a spring with no ledge to reach is a plain bounce
    // how high and how small the ledge in the branches is
    ev.push({ x: s.x, h: unease(0.5 * clamp((s.y - ledge.y - 96) / 54, 0, 1) + 0.5 * clamp((180 - ledge.w) / 68, 0, 1)), kind: 'spring' });
  }
  for (const h of level.hazards) {
    if (h.x < x0 || h.x >= x1) continue;
    ev.push({ x: h.x, h: unease(clamp((h.w - 6) / 3.4, 0, 1)) + (h.cycle ? 0.8 : 0), kind: 'spikes' });      // width 6 u (easiest) .. 9.4 u (params.spikeW)
  }
  ev.sort((a, b) => a.x - b.x);
  return ev;
}

/** Recovery-room bonus: the largest cluster of events within 450 u of each other. */
export function maxChain(ev) {
  let best = ev.length ? 1 : 0, s = 0;
  for (let e = 0; e < ev.length; e++) {
    while (ev[e].x - ev[s].x > 450) s++;
    best = Math.max(best, e - s + 1);
  }
  return best;
}

/** The demand score of [x0, x1): events, peak, mean, chain and the blended score (0 for a quiet stretch). */
export function measureDemand(level, x0, x1) {
  const ev = eventsIn(level, x0, x1);
  if (!ev.length) return { score: 0, n: 0, mean: 0, peak: 0, chain: 0, density: 0, events: ev };
  const hs = ev.map((e) => e.h).sort((a, b) => a - b);
  const mean = hs.reduce((s, v) => s + v, 0) / hs.length;
  const peak = hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.9))];
  const chain = maxChain(ev);
  const density = (ev.length * 1000) / (x1 - x0);
  const score = 0.5 * mean + 0.4 * peak + Math.min(2.2, 0.55 * (chain - 1)) + Math.min(1.2, 0.5 * density);
  return { score, n: ev.length, mean, peak, chain, density, events: ev };
}
