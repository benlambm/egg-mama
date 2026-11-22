/*
 * Egg Mama — a small HAND-MADE multi-landscape world for the renderer demo and tests/e2e/render-smoke.mjs.
 *
 * It follows the sim.mjs level format (one continuous coordinate space, `chapters` with x0/x1/flag, every list sorted by x)
 * and deliberately contains one of everything the renderer must draw: ground islands, ledges, crumbles, a lift, a mover,
 * ice, spikes (plain + cycling), springs, walkers, flyers, eggs, golden eggs, shield and magnet pickups, flags, cues,
 * water (Reedwater) and a beacon. Seven landscapes, 2 800 u each, so every dissolve (+-520 u) fits with room to spare:
 *   Meadow, Clover Mill, Reedwater (water), Fogwood (mist), Lantern Caverns (dark), Frostline (ice), Beacon Summit.
 * It exists so the renderer can be verified without depending on the generator; it is NOT the real game's content.
 */
import { CHAPTERS } from '../docs/js/chapters.mjs';

export const HAND_LANDSCAPES = [0, 1, 2, 5, 8, 9, 12];
export const HAND_SPAN = 2800;

export function buildHandWorld() {
  const platforms = [], pickups = [], enemies = [], hazards = [], springs = [], checkpoints = [], cues = [], chapters = [];
  const plat = (kind, x, y, w, h, ch, extra = {}) => { const p = { id: platforms.length, kind, x, y, w, h, ch, ...extra }; platforms.push(p); return p.id; };
  const egg = (x, y, kind = 'egg') => pickups.push({ id: pickups.length, kind, x, y });
  const flag = (x, y, platform, ch) => checkpoints.push({ id: checkpoints.length, x, y, platform, ch });
  const arc = (x0, x1, yBase, lift, n = 6) => { for (let i = 0; i < n; i++) { const u = i / (n - 1); egg(x0 + (x1 - x0) * u, yBase - lift * 4 * u * (1 - u)); } };
  const line = (x0, x1, y, n) => { for (let i = 0; i < n; i++) egg(x0 + (x1 - x0) * (n === 1 ? 0 : i / (n - 1)), y); };

  HAND_LANDSCAPES.forEach((ci, k) => {
    const x0 = k * HAND_SPAN, ch = CHAPTERS[ci], ice = !!ch.ice;
    chapters.push({ index: ci, x0, x1: x0 + HAND_SPAN, flag: checkpoints.length });
    // A: the opening island with the landscape's first flag
    const a = plat('ground', x0 - (k === 0 ? 300 : 40), 292, 880 + (k === 0 ? 300 : 40), 120, ci, { ice });
    flag(x0 + 300, 292, a, ci);
    line(x0 + 380, x0 + 640, 266, 5);
    if (k === 0) egg(x0 + 520, 252, 'gold');
    // B: an island with a patrolling walker and a golden egg above it
    const b = plat('ground', x0 + 930, 292, 700, 104, ci, { ice });
    enemies.push({ id: enemies.length, kind: 'walker', x0: x0 + 1040, x1: x0 + 1260, y: 292, speed: 26, phase: 0.2 });
    arc(x0 + 1020, x0 + 1300, 262, 54);
    egg(x0 + 1160, 200, 'gold');
    // gap with a lift
    plat('lift', x0 + 1560, 250, 170, 16, ci, { ice, motion: { axis: 'y', amp: 38, period: 5.2, phase: 0 } });
    // C: island with a spring, a ledge route with a crumble chain, spikes
    const c = plat('ground', x0 + 1700, 292, 760, 112, ci, { ice });
    springs.push({ id: springs.length, x: x0 + 1800, y: 292 });
    plat('ledge', x0 + 1820, 196, 150, 16, ci, { ice });
    egg(x0 + 1895, 168, 'gold');
    plat('crumble', x0 + 2000, 214, 110, 16, ci, {});
    plat('crumble', x0 + 2130, 214, 110, 16, ci, {});
    hazards.push({ id: hazards.length, kind: 'spikes', x: x0 + 2000, y: 292, w: 34 });
    hazards.push({ id: hazards.length, kind: 'spikes', x: x0 + 2200, y: 292, w: 44, cycle: { period: 2.6, up: 1.3, phase: 0.1 } });
    pickups.push({ id: pickups.length, kind: k % 2 ? 'magnet' : 'shield', x: x0 + 2320, y: 262 });
    flag(x0 + 2400, 292, c, ci);
    // a flyer over the first island, a mover over the far gap
    enemies.push({ id: enemies.length, kind: 'flyer', cx: x0 + 1380, cy: 176, ax: 90, ay: 22, period: 5.5, phase: 0 });
    plat('mover', x0 + 2480, 262, 160, 16, ci, { ice, motion: { axis: 'x', amp: 46, period: 5, phase: 0 } });
    // D: the closing island that carries into the next landscape (or the beacon)
    const d = plat('ground', x0 + 2560, 292, HAND_SPAN - 2560 - 40 + (k === HAND_LANDSCAPES.length - 1 ? 760 : 0), 118, ci, { ice });
    line(x0 + 2640, x0 + 2760, 266, 4);
    void b; void d;
    cues.push({ x: x0 + 360, text: ch.tip, kind: 'tip' });
    cues.push({ x: x0 + 60, text: ch.story, kind: 'story' });
  });
  const last = (HAND_LANDSCAPES.length - 1) * HAND_SPAN;
  const beacon = { x: last + 2540 + 120, y: 292 };
  chapters[chapters.length - 1].x1 = beacon.x + 140;
  platforms.sort((p, q) => p.x - q.x);
  const remap = new Map(); platforms.forEach((p, i) => { remap.set(p.id, i); p.id = i; });
  for (const c of checkpoints) c.platform = remap.get(c.platform);
  const byX = (list, f) => { list.sort((p, q) => f(p) - f(q)); list.forEach((e, i) => { e.id = i; }); };
  byX(pickups, (p) => p.x); byX(enemies, (e) => (e.kind === 'walker' ? e.x0 : e.cx - e.ax)); byX(hazards, (h) => h.x); byX(springs, (s) => s.x);
  cues.sort((p, q) => p.x - q.x);
  return {
    circuit: 1, seed: 1, start: { x: checkpoints[0].x, y: 292 }, endX: beacon.x + 140,
    chapters, platforms, pickups, enemies, hazards, springs, checkpoints, cues, beacon, water: { y: 330 }, beats: [],
  };
}
