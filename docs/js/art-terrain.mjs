/*
 * Egg Mama — TERRAIN art: platforms, spikes, springs, the landmark arch, the beacon, water.
 *
 * Everything here is smooth vector art drawn in code on top of the crisp pixel-art backgrounds, in the Egg Runner 2
 * object style: warm light from the upper left, outlines in a dark shade of each thing's own hue, rounded volume,
 * bounced light at the lower right, hue-shifted shadows. Each landscape's palette and `skin` (chapters.mjs) decide
 * the look; platforms keep the skin of the landscape they were generated for (`platform.ch`), so the renderer calls
 *     drawPlatform(ctx, cache, p, CHAPTERS[p.ch], t)
 * even while the painted background is dissolving into the next landscape.
 *
 * All functions take a context that ALREADY carries the world->screen transform (world units, y down) and a shared
 * SpriteCache (artkit.mjs) whose scale the renderer keeps equal to (CSS px per u) * dpr via cache.setScale().
 * Nothing here touches the transform permanently, the global alpha, the smoothing flag or the dash pattern
 * (every draw is inside save()/restore() and forces smoothing ON, so a pixel-crisp background pass can't leak in).
 *
 * ── EXPORTS ──────────────────────────────────────────────────────────────────────────────────────────────────────
 *  drawPlatform(ctx, cache, p, chapter, t, alpha = 1)
 *      p = runtime platform from sim.mjs (or a plain level platform): { id, kind, x, y, w, h, ice?, motion?, cx?, cy?,
 *      pcx?, pcy?, state?, st? }. kind:
 *        'ground'  thick island: cap + body + strata, drawn from p.y DOWN TO T.killY (not just p.h) so pits read as
 *                  drops; the body fades to near-black. Solid sides, lit left end, shaded right end.
 *        'ledge'   thin one-way slab (h 14-18) with a shaped, visible underside.
 *        'crumble' ART-2: cracked, chipped, dusty slab with a dashed (lumpy) lower edge. p.state 'idle' | 'rumble'
 *                  (shakes, cracks widen and glow amber, dust falls; p.st seconds in the state) | 'fall' (splits along its
 *                  cracks into tumbling pieces that fade; a faint dashed ghost shows where it re-forms).
 *        'lift'    deck on two cables with pulleys on a gantry above the top of its travel (cables follow p.cy).
 *        'mover'   deck on wheels running on a rail that shows the whole travel (p.motion.amp), chevrons on the deck.
 *      p.ice = true: glossy pale-blue slippery look (sheen + travelling glint) on any kind.
 *      Position is (p.cx, p.cy) when present (the sim's current position), else (p.x, p.y). Pass `alpha` (0..1) to
 *      interpolate movers/crumbles between (p.pcx, p.pcy) and (p.cx, p.cy) like the actors, so riders don't jitter.
 *      Skins (chapter.skin): ground grass|mud|stone|sand|ice|crystal|brick|cloud,
 *      ledge leaf|plank|log|branch|stone|ice|crystal|brick|cloud (lift/mover decks use plank|stone|ice|crystal|brick|cloud).
 *      Dark landscapes (chapter.dark) get a brighter rim light and a soft glow above every landing surface.
 *  drawSpikes(ctx, cache, h, chapter, t, warn)
 *      h = level hazard { id, x (left), y (ground top), w, h?, cycle? }; skin from chapter.skin.hazard thorn|stone|crystal|urchin.
 *      Plain spikes are always up. Cycling ones (h.cycle) sit on a slotted plate: sunk when inactive, they poke up and
 *      twitch while warn > 0 (default: hazardWarn(h, t)) and snap fully up while hazardActive(h, t). t = game time.
 *  drawSpring(ctx, cache, s, chapter, t)
 *      s = { x (centre), y (ground top), w?, bounceT }; skin mushroom|coil|cloud. Idle breath; squash -> overshoot ->
 *      settle while t - s.bounceT < 0.3 (t and bounceT must share a clock: game.t).
 *  drawGate(ctx, cache, { x, y, chapter, t, progress = 1 })
 *      The landscape-start landmark (no gates between landscapes in the continuous world): pillars + arch in the
 *      landscape's material, a hanging sign with its name, bunting and streamers. progress < 1 strings a ribbon across
 *      the opening, 1 (default) = cut and flying. x = centre, y = ground top. ~132 u wide, ~125 u tall.
 *  drawBeacon(ctx, cache, { x, y, lit, litT, t })
 *      Summit tower (always the chapter flagged `beacon`). Unlit: dark lantern, ember, pulsing "touch me" ring. Lit:
 *      flame, glow, turning rays; litT = seconds since lit drives the flare (flash, rings, sparks, ~2.2 s). ~84 u wide, ~190 tall.
 *  drawWater(ctx, { x0, x1, y, bottom, chapter, t })
 *      Flood / sea band: translucent body with back + front waves, foam line and sparkles, waves anchored to world x.
 *      Draws only the visible part of [x0, x1]; no cache needed. chapter.palette.water (or a sky-derived blue).
 *  platformPadding(p) -> { left, right, top, bottom }
 *      How far the art reaches beyond [x, x+w] x [y, y+h] (leaves, icicles, cables, tumbling lumps, rails...).
 *      The renderer adds mover amplitude itself.
 *  warmTerrainSteps(cache, chapter, ctx?) -> Array<() => void>,  warmTerrain(cache, chapter, ctx?)
 *      Optional: build a landscape's tiles and sprites ahead of time (a few ms per step) so its first on-screen frame
 *      doesn't hitch. terrainCacheStats(cache) -> { chapters, tiles, gradients, decor } for tests / debugging.
 *
 * ── READABILITY RULES (ART-2; keep them when adding art) ───────────────────────────────────────────────────────────
 *  - Hazards own the "danger" hues: red thorns, pale-tipped rock, hot-pink / magenta crystals (also on ice), orange-tipped
 *    purple urchins. Harmless ground decor never uses those hues or a spike silhouette (cave tufts are cool periwinkle/teal,
 *    ice shards are pale blue, starfish are peach), and is never mushroom-shaped where the springs are mushrooms.
 *  - Every landing surface has a bright rim AND a dark own-hue outline; dark landscapes add a thicker rim and a soft glow
 *    whose ends are rounded off (never a hard rectangle).
 *  - A slab's teeth / scallops / arches never poke out past its ends (tests/e2e/terrain-smoke.mjs checks this).
 *
 * ── PERFORMANCE ──────────────────────────────────────────────────────────────────────────────────────────────────
 *  A long island is never one big sprite. Each platform is painted in its own local coordinates (origin snapped to the
 *  device pixel grid, which also keeps far-away worlds numerically exact) from: a cached vertical gradient, ONE
 *  repeating texture tile used as a canvas pattern (a ~176 x 64 u tile for ground, 64 x 26 u for ledges), a clip path
 *  cut to the visible part, and a few small cached decor sprites at seeded slots. Cost is O(visible width), not O(w):
 *  a 1000 u island and a 40 000 u island cost the same. Gradients and patterns are created once and reused; steady
 *  state creates none. Typical busy screen (19 platforms, DPR 3, software raster): ~1 ms/frame, ~17-22 images stamped
 *  (budget 150). Memory: tiles/sprites of the 4 most recently drawn landscapes are kept, older ones are dropped.
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────────────────────────────────────────────
 *  All variation (tufts, pebbles, flowers, crack positions, lump depths, icicle lengths, texture phase) is hashed from
 *  the platform id and a slot index, never from Math.random or the clock; only intended animation uses t.
 *
 * Verification: tools/terrain-sheet.mjs renders every export for every landscape over its real background at iPhone
 * scale (844x390 @ DPR 3) and times it; tests/e2e/terrain-smoke.mjs checks it automatically.
 */
import { T } from './tuning.mjs';
import { hazardActive, hazardWarn, SPIKE_H } from './sim.mjs';
import { CHAPTERS } from './chapters.mjs';
import { TAU, rgba, mix, lit, shade, outline, bounce, rr, oval, star, linear, radial, createSurface } from './artkit.mjs';
import { rng } from './rng.mjs';

/* ═════════════════════════ small utilities ═════════════════════════ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
/** 32-bit integer hash of up to three integers (deterministic per-platform / per-slot variation). */
const hash = (a, b = 0, c = 0) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return (h ^ (h >>> 16)) >>> 0;
};
const unit = (a, b, c) => hash(a, b, c) / 4294967296;
const strSeed = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const wrapX = (P, x, r) => (x - r < 0 ? [x, x + P] : x + r > P ? [x, x - P] : [x]);

/* ═════════════════════ per-cache store (tiles, gradients, decor) ═════════════════════
 * Long platforms are never one big sprite. They are painted from
 *   - a cached vertical GRADIENT (base colour, lit top -> dark bottom),
 *   - a small repeating TEXTURE TILE used as a canvas pattern (strata, bricks, bark…),
 *   - a handful of small cached DECOR sprites (tufts, rocks, crystals…) stamped at seeded slots,
 * all in platform-local coordinates, so a 3000 u island costs the same as a 300 u one.
 * Tiles/gradients/decor are keyed by chapter id and only the most recent few chapters are kept. */
const STORES = new WeakMap();
const KEEP_CHAPTERS = 4;

function storeOf(cache) {
  let s = STORES.get(cache);
  if (!s) { s = { scale: cache.scale, tiles: new Map(), grads: new Map(), decor: new Map(), order: [] }; STORES.set(cache, s); }
  if (s.scale !== cache.scale) { s.scale = cache.scale; s.tiles.clear(); s.decor.clear(); }   // gradients do not depend on the scale
  return s;
}
function touch(s, cache, ch) {
  const o = s.order, id = ch.id;
  if (o[o.length - 1] === id) return;
  const i = o.indexOf(id);
  if (i >= 0) o.splice(i, 1);
  else if (o.length >= KEEP_CHAPTERS) {
    const old = o.shift(), pre = old + '|', cp = 'terr|' + pre;
    for (const m of [s.tiles, s.grads, s.decor]) for (const k of m.keys()) if (k.startsWith(pre)) m.delete(k);
    for (const k of cache.map.keys()) if (k.startsWith(cp)) cache.map.delete(k);
  }
  o.push(id);
}

/** A cached gradient (created once per key, reused every frame, valid for any platform because we draw in local coords). */
function vgrad(ctx, s, key, y0, y1, stops) {
  let g = s.grads.get(key);
  if (!g) { g = ctx.createLinearGradient(0, y0, 0, y1); for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]); s.grads.set(key, g); }
  return g;
}
function hgrad(ctx, s, key, x0, x1, stops) {
  let g = s.grads.get(key);
  if (!g) { g = ctx.createLinearGradient(x0, 0, x1, 0); for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]); s.grads.set(key, g); }
  return g;
}

/** A repeating texture tile. The tile is drawn in world units but rasterised on an INTEGER pixel grid so it wraps seamlessly. */
function tileOf(s, key, P, H, paintFn) {
  let t = s.tiles.get(key);
  if (t) return t;
  const k = s.scale, wp = Math.max(1, Math.round(P * k)), hp = Math.max(1, Math.round(H * k));
  const canvas = createSurface(wp, hp), c = canvas.getContext('2d');
  c.scale(wp / P, hp / H);
  paintFn(c, P, H);
  t = { canvas, P, H, sx: wp / P, sy: hp / H, hp, pat: null };
  s.tiles.set(key, t);
  return t;
}
/** Fill [xa,xb] x [0,H] (local coords) with the tile, phase-shifted by `phase` units. */
function fillTile(ctx, t, xa, xb, phase) {
  if (!t.pat) t.pat = ctx.createPattern(t.canvas, 'repeat');
  phase = Math.round(phase * t.sx) / t.sx;      // a whole number of tile PIXELS, so the texture is never resampled half a pixel off (blur)
  ctx.save();
  ctx.translate(-phase, 0);
  ctx.scale(1 / t.sx, 1 / t.sy);
  ctx.fillStyle = t.pat;
  ctx.fillRect((xa + phase) * t.sx, 0, (xb - xa) * t.sx, t.hp);
  ctx.restore();
}

/** Small cached sprite whose origin is its bottom-centre (or `oy` from the top). */
function sprite(cache, key, w, h, draw, ox = w / 2, oy = h) { return cache.get(key, w, h, ox, oy, draw); }

/* ═════════════════════════ colour kits ═════════════════════════ */

const KITS = new Map();
const ICE = { top: '#f7feff', topLit: '#ffffff', topDk: '#9bd9f4', soil: '#62bdec', rock: '#c4eaf5', deep: '#1a2a62', rim: '#ffffff', outTop: '#23558a' };

function groundKit(ch, skin, ice) {
  const key = ch.id + '|g|' + skin + (ice ? '|ice' : '');
  let K = KITS.get(key);
  if (K) return K;
  const P = ch.palette;
  let top = P.top, topDk = P.fringe, soil = P.soil, rock = P.rock;
  switch (skin) {
    case 'mud': top = mix(P.top, '#2a5a44', 0.45); topDk = mix(P.fringe, '#16352e', 0.5); soil = mix(P.soil, '#2c3730', 0.3); break;
    case 'stone': top = lit(P.rock, 0.3); topDk = mix(P.rock, P.shadow, 0.25); soil = P.soil; break;
    case 'sand': top = mix('#f5e5ae', P.top, 0.18); topDk = mix('#dcc088', P.fringe, 0.2); soil = mix('#caa874', P.soil, 0.3); break;
    case 'ice': top = ICE.top; topDk = ICE.topDk; soil = mix(ICE.soil, P.soil, 0.1); rock = ICE.rock; break;
    case 'crystal': top = mix(P.rock, '#b9a6e0', 0.15); topDk = mix(P.soil, '#2a2250', 0.25); soil = mix(P.soil, '#2c2050', 0.18); break;
    case 'brick': top = lit(P.top, 0.18); topDk = P.fringe; soil = mix(P.fringe, P.soil, 0.35); rock = P.rock; break;
    case 'cloud': top = '#fffaf2'; topDk = '#dcd6ee'; soil = '#c9c3e6'; rock = '#ffffff'; break;
    default: break;                                                          // grass
  }
  if (ice && skin !== 'ice') { top = ICE.top; topDk = ICE.topDk; soil = ICE.soil; rock = ICE.rock; }
  const deep = ice ? ICE.deep : mix(P.shadow, '#120a22', 0.55);
  K = {
    skin, dark: !!ch.dark, ice: !!ice, accent: P.accent, light: P.light,
    top, topLit: lit(top, 0.5), topDk, topDeep: shade(topDk, 0.3),
    soil, soilLit: lit(soil, 0.26), soilDk: shade(soil, 0.34), deep,
    rock, rockLit: lit(rock, 0.4), rockDk: shade(rock, 0.4),
    rim: ice ? ICE.rim : (ch.dark ? mix(P.light, '#ffffff', 0.45) : mix(P.light, '#fffbe6', 0.55)),
    outTop: ice ? ICE.outTop : outline(topDk, 0.7), outBody: outline(soil, 0.72),
    mortar: lit(mix(P.top, P.rock, 0.3), 0.2),
  };
  KITS.set(key, K);
  return K;
}

/* ═════════════════════════ texture painting helpers ═════════════════════════ */

/** Wavy horizontal lines that wrap seamlessly (integer number of waves per tile). */
function strata(c, P, K, ys, amp, a = 0.36, light = 0.16) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  ys.forEach((y, i) => {
    const cyc = 2 + (i % 2), ph = i * 1.7;
    c.beginPath();
    for (let x = 0; x <= P; x += 4) {
      const yy = y + Math.sin(x / P * TAU * cyc + ph) * amp + Math.sin(x / P * TAU * (cyc + 3) + ph * 2) * amp * 0.35;
      if (x) c.lineTo(x, yy); else c.moveTo(x, yy);
    }
    c.strokeStyle = rgba(K.soilDk, a); c.lineWidth = 1.5; c.stroke();
    c.save(); c.translate(0, 1.9); c.strokeStyle = rgba(K.soilLit, light); c.lineWidth = 1.1; c.stroke(); c.restore();
  });
}
/** Embedded pebbles/stones (wrapped across the tile edges). */
function pebbles(c, P, K, R, n, y0, y1, rmin = 2.4, rmax = 5.2) {
  for (let i = 0; i < n; i++) {
    const x = R.range(0, P), y = R.range(y0, y1), rx = R.range(rmin, rmax), ry = rx * R.range(0.62, 0.85), rot = R.range(-0.4, 0.4);
    for (const xx of wrapX(P, x, rx + 1)) {
      c.beginPath(); c.ellipse(xx, y, rx, ry, rot, 0, TAU);
      c.fillStyle = radial(c, xx - rx * 0.35, y - ry * 0.4, 0.5, rx * 1.4, [0, K.rockLit, 0.55, K.rock, 1, K.rockDk]); c.fill();
      c.strokeStyle = rgba(K.soilDk, 0.75); c.lineWidth = 1; c.stroke();
    }
  }
}
/** Fade the lower part of a tile out so the pattern dissolves into the plain dark gradient beneath. */
function fadeMask(c, P, H, from) {
  c.save();
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = linear(c, 0, from, 0, H, [0, '#fff', 1, 'rgba(255,255,255,0)']);
  c.fillRect(-2, -2, P + 4, H + 4);
  c.restore();
}
/** Drooping teeth (blades / icicles / crystals) hanging from y = yTop, valleys at yValley, tips `lens[k]` further down. Wraps. */
function teethShape(c, P, n, yTop, yValley, lens, off = 0, jit = null, round = true) {
  const s = P / n;
  c.beginPath(); c.moveTo(-s * 1.5 + off, yTop); c.lineTo(P + s * 2.5 + off, yTop);
  for (let i = n + 1; i >= -2; i--) {
    const k = ((i % n) + n) % n, L = lens[k], j = jit ? jit[k] : 0;
    const xr = (i + 1) * s + off, xm = (i + 0.5) * s + off + j, xl = i * s + off;
    c.lineTo(xr, yValley);
    if (round) { c.quadraticCurveTo(xr - s * 0.12, yValley + L * 0.55, xm, yValley + L); c.quadraticCurveTo(xl + s * 0.12, yValley + L * 0.55, xl, yValley); }
    else { c.lineTo(xm, yValley + L); c.lineTo(xl, yValley); }
  }
  c.closePath();
}
const rands = (R, n, lo, hi) => Array.from({ length: n }, () => R.range(lo, hi));

/* ═════════════════════════ GROUND tiles (one per skin) ═════════════════════════ */

const GP = 176, GH = 64;     // ground texture tile: period and height (local units)

function tileGrass(c, P, H, K, R) {
  strata(c, P, K, [28, 40, 52], 2.5, 0.62, 0.22);
  pebbles(c, P, K, R, 6, 24, 54);
  // thin roots
  c.lineCap = 'round'; c.strokeStyle = rgba(K.soilDk, 0.5); c.lineWidth = 1.2;
  for (let i = 0; i < 4; i++) { const x = R.range(6, P - 6), y = R.range(20, 30); c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + R.range(-6, 6), y + 8, x + R.range(-9, 9), y + R.range(12, 20)); c.stroke(); }
  const n = 22;
  teethShape(c, P, n, -2, 8, rands(R, n, 8, 17), 0, rands(R, n, -1.5, 1.5));
  c.fillStyle = linear(c, 0, -2, 0, 26, [0, K.topDk, 1, shade(K.topDk, 0.28)]); c.fill();
  c.strokeStyle = rgba(K.outTop, 0.55); c.lineWidth = 1; c.stroke();
  teethShape(c, P, n, -2, 4, rands(R, n, 4, 9), 3.5, rands(R, n, -1, 1));
  c.fillStyle = linear(c, 0, -2, 0, 14, [0, K.topLit, 0.4, K.top, 1, mix(K.top, K.topDk, 0.5)]); c.fill();
  // dew / light flecks on the cap
  c.fillStyle = rgba(K.topLit, 0.7);
  for (let i = 0; i < 9; i++) { const x = R.range(0, P); c.beginPath(); c.ellipse(x, R.range(3, 7), R.range(1.2, 2.4), 0.8, 0, 0, TAU); c.fill(); }
  fadeMask(c, P, H, 36);
}

function tileMud(c, P, H, K, R) {
  strata(c, P, K, [24, 35, 47, 57], 3.2, 0.55, 0.2);
  pebbles(c, P, K, R, 4, 22, 54, 2, 4);
  // bubbles + wet sheen
  c.lineWidth = 1; for (let i = 0; i < 9; i++) { const x = R.range(4, P - 4), y = R.range(20, 56); c.beginPath(); c.arc(x, y, R.range(1.2, 2.8), 0, TAU); c.strokeStyle = rgba(K.soilLit, 0.45); c.stroke(); }
  c.lineCap = 'round'; c.lineWidth = 1.6; c.strokeStyle = 'rgba(255,255,255,0.14)';
  for (let i = 0; i < 5; i++) { const x = R.range(0, P - 22), y = R.range(24, 52); c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 10, y - 2, x + 20, y); c.stroke(); }
  // mossy lumpy cap
  const lump = (off, depth, fill, stroke) => {
    c.beginPath(); c.moveTo(-8, -2); c.lineTo(P + 8, -2);
    for (let x = P + 8; x >= -8; x -= 4) { const y = depth + Math.sin((x + off) / P * TAU * 5) * 2.4 + Math.sin((x + off) / P * TAU * 11) * 1.6; c.lineTo(x, y); }
    c.closePath(); c.fillStyle = fill; c.fill(); if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); }
  };
  lump(0, 12, linear(c, 0, 0, 0, 18, [0, K.topDk, 1, K.topDeep]), rgba(K.outTop, 0.6));
  lump(7, 7, linear(c, 0, 0, 0, 12, [0, K.topLit, 0.5, K.top, 1, mix(K.top, K.topDk, 0.5)]), null);
  c.fillStyle = rgba(K.topLit, 0.55);
  for (let i = 0; i < 14; i++) { const x = R.range(0, P); c.beginPath(); c.arc(x, R.range(3, 7), R.range(0.8, 1.8), 0, TAU); c.fill(); }
  fadeMask(c, P, H, 38);
}

function tileStone(c, P, H, K, R) {
  // masonry-ish layers with staggered joints
  const rows = [[13, 27], [27, 41], [41, 55]];
  rows.forEach(([y0, y1], ri) => {
    const bw = 44 + ri * 6, n = Math.round(P / bw), w = P / n, off = ri % 2 ? w / 2 : 0;
    for (let i = -1; i <= n; i++) {
      const x = i * w + off, tone = R();
      c.fillStyle = tone < 0.33 ? rgba(K.soilLit, 0.16) : tone < 0.66 ? rgba(K.soilDk, 0.14) : rgba(K.rock, 0.1);
      c.fillRect(x, y0, w, y1 - y0);
      c.fillStyle = rgba(K.soilDk, 0.5); c.fillRect(x - 0.7, y0, 1.4, y1 - y0);
      c.fillStyle = rgba(K.soilLit, 0.25); c.fillRect(x + 0.8, y0, 1, y1 - y0);
    }
    c.fillStyle = rgba(K.soilDk, 0.5); c.fillRect(-2, y1 - 0.7, P + 4, 1.4);
    c.fillStyle = rgba(K.soilLit, 0.22); c.fillRect(-2, y1 + 0.8, P + 4, 1);
  });
  pebbles(c, P, K, R, 3, 30, 54, 1.8, 3.2);
  // flat cap slab with chisel joints
  const nb = 4, bw = P / nb;
  c.fillStyle = linear(c, 0, -2, 0, 13, [0, K.topLit, 0.45, K.top, 1, K.topDk]); c.fillRect(-4, -2, P + 8, 15);
  c.strokeStyle = rgba(K.outTop, 0.55); c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(-4, 13); c.lineTo(P + 4, 13); c.stroke();
  for (let i = 0; i <= nb; i++) { const x = i * bw + R.range(-3, 3) * (i % nb ? 1 : 0); c.beginPath(); c.moveTo(x, 1); c.lineTo(x, 13); c.stroke(); c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(x + 0.8, 1, 1, 12); }
  c.fillStyle = rgba(K.topLit, 0.6);
  for (let i = 0; i < 12; i++) { c.fillRect(R.range(0, P), R.range(3, 10), R.range(1.5, 4), 0.9); }
  fadeMask(c, P, H, 40);
}

function tileSand(c, P, H, K, R) {
  // layered sandstone bands
  const bands = [[22, K.soilDk, 0.2], [30, K.soilLit, 0.2], [40, K.soilDk, 0.22], [50, K.soilLit, 0.18], [58, K.soilDk, 0.2]];
  bands.forEach(([y, col, a], i) => {
    c.beginPath(); c.moveTo(0, y);
    for (let x = 0; x <= P; x += 4) c.lineTo(x, y + Math.sin(x / P * TAU * (2 + i % 2) + i) * 2.4);
    c.lineTo(P, y + 8); c.lineTo(0, y + 8); c.closePath(); c.fillStyle = rgba(col, a); c.fill();
  });
  strata(c, P, K, [26, 45], 2.2, 0.3, 0.2);
  pebbles(c, P, K, R, 4, 28, 54, 1.8, 3.6);
  // tiny shells embedded in the face
  c.strokeStyle = rgba(K.soilDk, 0.55); c.lineWidth = 1; c.fillStyle = rgba(K.topLit, 0.7);
  for (let i = 0; i < 3; i++) { const x = R.range(10, P - 10), y = R.range(26, 52); c.beginPath(); c.ellipse(x, y, 3.2, 2.4, R.range(-0.4, 0.4), 0, TAU); c.fill(); c.stroke(); c.beginPath(); c.arc(x, y, 1, 0, TAU); c.stroke(); }
  // sand drifts hanging over the face: soft scallops
  const n = 11, s = P / n;
  const drift = (y0, rad, fill, off) => {
    c.beginPath(); c.moveTo(-s, -2); c.lineTo(P + s * 2, -2);
    for (let i = n + 1; i >= -1; i--) { const xm = (i + 0.5) * s + off; c.lineTo((i + 1) * s + off, y0); c.quadraticCurveTo(xm, y0 + rad * 1.5, i * s + off, y0); }
    c.closePath(); c.fillStyle = fill; c.fill();
  };
  drift(8, 7, linear(c, 0, 0, 0, 17, [0, K.topDk, 1, shade(K.topDk, 0.22)]), 0);
  drift(5, 5, linear(c, 0, 0, 0, 12, [0, K.topLit, 1, K.top]), 3);
  c.strokeStyle = rgba(K.topDk, 0.5); c.lineWidth = 1; c.lineCap = 'round';        // ripples on the cap
  for (let i = 0; i < 7; i++) { const x = R.range(0, P - 20), y = R.range(2.5, 5.5); c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 9, y - 1.6, x + 18, y); c.stroke(); }
  fadeMask(c, P, H, 38);
}

function tileIce(c, P, H, K, R) {
  // trapped streaks, bubbles, hairline cracks
  c.lineCap = 'round';
  for (let i = 0; i < 16; i++) { const x = R.range(0, P), y = R.range(18, 40), L = R.range(8, 24); c.beginPath(); c.moveTo(x, y); c.lineTo(x + R.range(-2, 2), y + L); c.strokeStyle = rgba('#ffffff', R.range(0.18, 0.4)); c.lineWidth = R.range(1, 2.4); c.stroke(); }
  c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1.1;
  for (let i = 0; i < 4; i++) { const x = R.range(6, P - 30), y = R.range(24, 50); c.beginPath(); c.moveTo(x, y); c.lineTo(x + 8, y + 5); c.lineTo(x + 13, y + 3); c.lineTo(x + 22, y + 9); c.stroke(); }
  for (let i = 0; i < 12; i++) { const x = R.range(4, P - 4), y = R.range(22, 56); c.beginPath(); c.arc(x, y, R.range(1, 2.4), 0, TAU); c.fillStyle = 'rgba(255,255,255,0.35)'; c.fill(); }
  // big diagonal glints, long and soft
  for (let i = 0; i < 3; i++) { const x = (i + 0.3 + R() * 0.3) * P / 3; c.beginPath(); c.moveTo(x, 6); c.lineTo(x + 5, 6); c.lineTo(x - 14, 50); c.lineTo(x - 19, 50); c.closePath(); c.fillStyle = 'rgba(255,255,255,0.13)'; c.fill(); }
  // frosting + icicle fringe
  const n = 20;
  teethShape(c, P, n, -2, 7, rands(R, n, 5, 19), 0, rands(R, n, -1.5, 1.5));
  c.fillStyle = linear(c, 0, -2, 0, 26, [0, K.topDk, 1, mix(K.topDk, K.soil, 0.5)]); c.fill();
  c.strokeStyle = rgba(K.outTop, 0.55); c.lineWidth = 1; c.stroke();
  teethShape(c, P, n, -2, 3, rands(R, n, 2, 8), 3.5, rands(R, n, -1, 1));
  c.fillStyle = linear(c, 0, -2, 0, 12, [0, '#ffffff', 1, K.top]); c.fill();
  fadeMask(c, P, H, 36);
}

function tileCrystal(c, P, H, K, R) {
  // faceted body: big translucent triangles
  for (let i = 0; i < 9; i++) { const x = R.range(0, P), y = R.range(14, 50), a = R.range(8, 22); for (const dx of [-P, 0, P]) { c.beginPath(); c.moveTo(x + dx, y); c.lineTo(x + dx + a, y + R.range(-6, 6)); c.lineTo(x + dx + a * 0.4, y + R.range(10, 20)); c.closePath(); c.fillStyle = i % 2 ? 'rgba(255,255,255,0.09)' : rgba(K.soilDk, 0.22); c.fill(); } }
  // glowing veins
  const veins = (n) => {
    for (let i = 0; i < n; i++) {
      let x = R.range(0, P), y = R.range(16, 30); const pts = [[x, y]];
      for (let j = 0; j < 4; j++) { x += R.range(8, 22); y += R.range(-6, 9); pts.push([x, y]); }
      for (const dx of [-P, 0, P]) {
        c.beginPath(); pts.forEach(([px, py], k) => (k ? c.lineTo(px + dx, py) : c.moveTo(px + dx, py)));
        c.strokeStyle = rgba(K.light, 0.16); c.lineWidth = 4.2; c.lineJoin = 'round'; c.stroke();
        c.strokeStyle = rgba(K.light, 0.62); c.lineWidth = 1.2; c.stroke();
      }
    }
  };
  veins(4);
  // embedded crystals
  for (let i = 0; i < 6; i++) {
    const x = R.range(8, P - 8), y = R.range(22, 54), r = R.range(3, 6.2), col = i % 2 ? K.accent : K.light;
    for (const xx of wrapX(P, x, r + 1)) {
      c.beginPath(); c.moveTo(xx, y - r * 1.5); c.lineTo(xx + r * 0.75, y); c.lineTo(xx, y + r * 1.1); c.lineTo(xx - r * 0.75, y); c.closePath();
      c.fillStyle = rgba(col, 0.55); c.fill(); c.strokeStyle = rgba(shade(col, 0.5), 0.8); c.lineWidth = 1; c.stroke();
      c.beginPath(); c.moveTo(xx, y - r * 1.5); c.lineTo(xx - r * 0.75, y); c.lineTo(xx, y + r * 0.2); c.closePath(); c.fillStyle = 'rgba(255,255,255,0.35)'; c.fill();
    }
  }
  pebbles(c, P, K, R, 3, 28, 54, 1.8, 3.4);
  // inverted crystal teeth under the cap lip
  const n = 18;
  teethShape(c, P, n, -2, 6, rands(R, n, 5, 15), 0, rands(R, n, -1.5, 1.5), false);
  c.fillStyle = linear(c, 0, -2, 0, 20, [0, K.top, 1, K.topDk]); c.fill();
  c.strokeStyle = rgba(K.outTop, 0.7); c.lineWidth = 1; c.lineJoin = 'round'; c.stroke();
  c.fillStyle = linear(c, 0, -2, 0, 12, [0, lit(K.top, 0.45), 1, K.top]); c.fillRect(-4, -2, P + 8, 8);
  c.fillStyle = rgba(K.light, 0.75); for (let i = 0; i < 8; i++) c.fillRect(R.range(0, P), R.range(1, 5), R.range(2, 6), 0.9);
  fadeMask(c, P, H, 38);
}

function tileBrick(c, P, H, K, R) {
  const bh = 10, bw = 22, rows = 5;
  for (let r = 0; r < rows; r++) {
    const y = 13 + r * bh, n = Math.round(P / bw), w = P / n, off = r % 2 ? w / 2 : 0;
    for (let i = -1; i <= n; i++) {
      const x = i * w + off;
      const tone = R();
      c.fillStyle = tone < 0.3 ? rgba(K.soilLit, 0.34) : tone < 0.6 ? rgba(K.soilDk, 0.26) : rgba(K.soil, 0.2);
      c.fillRect(x + 1, y + 1, w - 2, bh - 2);
      c.fillStyle = rgba(K.mortar, 0.85); c.fillRect(x - 0.8, y, 1.6, bh);
      c.fillStyle = rgba(K.soilLit, 0.34); c.fillRect(x + 1.4, y + 1.2, w - 3, 1.3);        // lit top of each brick
      c.fillStyle = rgba(K.soilDk, 0.35); c.fillRect(x + 1.4, y + bh - 2.4, w - 3, 1.2);
    }
    c.fillStyle = rgba(K.mortar, 0.85); c.fillRect(-2, y + bh - 0.8, P + 4, 1.6);
  }
  // a few chipped / mossy bricks
  for (let i = 0; i < 5; i++) { c.fillStyle = rgba(K.soilDk, 0.5); c.beginPath(); c.arc(R.range(4, P - 4), R.range(18, 58), R.range(1, 2.2), 0, TAU); c.fill(); }
  // coping stones
  const nb = 4, cw = P / nb;
  c.fillStyle = linear(c, 0, -2, 0, 13, [0, K.topLit, 0.5, K.top, 1, K.topDk]); c.fillRect(-4, -2, P + 8, 15);
  c.strokeStyle = rgba(K.outTop, 0.6); c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(-4, 13); c.lineTo(P + 4, 13); c.stroke();
  for (let i = 0; i <= nb; i++) { const x = i * cw; c.beginPath(); c.moveTo(x, 1); c.lineTo(x, 13); c.stroke(); c.fillStyle = 'rgba(255,255,255,0.28)'; c.fillRect(x + 0.8, 1, 1, 12); }
  fadeMask(c, P, H, 42);
}

function tileCloud(c, P, H, K, R) {
  // layered billows: rows of overlapping circles, lilac in the lower rows
  const rows = [[44, 11, K.soil, 0.55], [34, 12, mix(K.soil, K.topDk, 0.4), 0.5], [24, 12, K.topDk, 0.7]];
  rows.forEach(([y, r0, col, a], ri) => {
    const n = 9, s = P / n;
    for (let i = -1; i <= n; i++) {
      const x = (i + 0.5) * s + R.range(-3, 3) + (ri % 2) * s * 0.4, r = r0 + R.range(-2, 3);
      c.beginPath(); c.arc(x, y + R.range(-2, 2), r, 0, TAU);
      c.fillStyle = radial(c, x - r * 0.3, y - r * 0.5, 1, r * 1.3, [0, rgba(lit(col, 0.5), a), 1, rgba(shade(col, 0.15), a)]); c.fill();
      c.strokeStyle = rgba(shade(col, 0.35), 0.28); c.lineWidth = 1; c.stroke();
    }
  });
  // white billowy cap
  const n = 10, s = P / n;
  c.beginPath(); c.moveTo(-s, -2); c.lineTo(P + s, -2);
  for (let i = n + 1; i >= -1; i--) { const xm = (i + 0.5) * s; c.lineTo((i + 1) * s, 8); c.quadraticCurveTo(xm + R.range(-1, 1), 8 + R.range(7, 11), i * s, 8); }
  c.closePath(); c.fillStyle = linear(c, 0, -2, 0, 18, [0, '#ffffff', 0.5, K.top, 1, K.topDk]); c.fill();
  c.strokeStyle = rgba(K.topDk, 0.7); c.lineWidth = 1; c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.9)'; for (let i = 0; i < 8; i++) c.fillRect(R.range(0, P), R.range(2, 5), R.range(3, 8), 1);
  fadeMask(c, P, H, 40);
}

const GROUND_TILES = { grass: tileGrass, mud: tileMud, stone: tileStone, sand: tileSand, ice: tileIce, crystal: tileCrystal, brick: tileBrick, cloud: tileCloud };


/* ═════════════════════════ GROUND decor (small cached sprites, origin = bottom-centre) ═════════════════════════ */

function blades(c, n, spread, hmin, hmax, R, col, litc, out) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * spread + R.range(-0.8, 0.8), h = R.range(hmin, hmax), lean = x * 0.45 + R.range(-2.5, 2.5);
    c.beginPath(); c.moveTo(x - 1.9, 1); c.quadraticCurveTo(x - 0.8, -h * 0.62, x + lean, -h); c.quadraticCurveTo(x + 1.1, -h * 0.5, x + 1.9, 1); c.closePath();
    c.fillStyle = linear(c, 0, -h, 0, 1, [0, litc, 1, col]); c.fill();
    c.strokeStyle = out; c.lineWidth = 1.1; c.lineJoin = 'round'; c.stroke();
  }
}
function flower(c, h, petal, center, stem, out, R, n = 5, pr = 2.5) {
  c.beginPath(); c.moveTo(0, 1); c.quadraticCurveTo(R.range(-2, 2), -h * 0.5, 0, -h); c.strokeStyle = out; c.lineWidth = 2.6; c.lineCap = 'round'; c.stroke();
  c.strokeStyle = stem; c.lineWidth = 1.3; c.stroke();
  c.beginPath(); c.moveTo(0, -h * 0.35); c.quadraticCurveTo(5, -h * 0.5, 6, -h * 0.28); c.quadraticCurveTo(2, -h * 0.28, 0, -h * 0.35); c.fillStyle = stem; c.fill();
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * TAU;
    c.beginPath(); c.arc(Math.cos(a) * pr * 1.05, -h + Math.sin(a) * pr * 1.05, pr, 0, TAU);
    c.fillStyle = petal; c.fill(); c.strokeStyle = out; c.lineWidth = 0.9; c.stroke();
  }
  c.beginPath(); c.arc(0, -h, pr * 0.7, 0, TAU); c.fillStyle = center; c.fill(); c.strokeStyle = out; c.lineWidth = 0.8; c.stroke();
}
function stone(c, x, y, rx, ry, K, out = K.outBody) {
  c.beginPath(); c.ellipse(x, y - ry * 0.6, rx, ry, 0, 0, TAU);
  c.fillStyle = radial(c, x - rx * 0.35, y - ry * 1.2, 0.5, rx * 1.5, [0, K.rockLit, 0.5, K.rock, 1, K.rockDk]); c.fill();
  c.strokeStyle = out; c.lineWidth = 1.3; c.stroke();
  c.beginPath(); c.ellipse(x - rx * 0.3, y - ry * 1.05, rx * 0.35, ry * 0.2, -0.3, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.45)'; c.fill();
}
function shard(c, x, base, w, h, tilt, col, litc, out) {
  c.beginPath(); c.moveTo(x - w / 2, base); c.lineTo(x - w * 0.36 + tilt, base - h * 0.74); c.lineTo(x + tilt, base - h); c.lineTo(x + w * 0.36 + tilt, base - h * 0.7); c.lineTo(x + w / 2, base); c.closePath();
  c.fillStyle = linear(c, x - w / 2, 0, x + w / 2, 0, [0, litc, 0.5, col, 1, shade(col, 0.4)]); c.fill();
  c.strokeStyle = out; c.lineWidth = 1.3; c.lineJoin = 'round'; c.stroke();
  c.beginPath(); c.moveTo(x - w * 0.3, base - 2); c.lineTo(x - w * 0.26 + tilt, base - h * 0.7); c.lineTo(x + tilt * 0.9, base - h * 0.9); c.lineTo(x - w * 0.02, base - h * 0.45); c.closePath();
  c.fillStyle = 'rgba(255,255,255,0.35)'; c.fill();
}
function mushroom(c, r, capCol, stemCol, out, spots = true) {
  c.beginPath(); c.moveTo(-r * 0.32, 1); c.lineTo(-r * 0.26, -r * 0.9); c.lineTo(r * 0.26, -r * 0.9); c.lineTo(r * 0.32, 1); c.closePath();
  c.fillStyle = stemCol; c.fill(); c.strokeStyle = out; c.lineWidth = 1.1; c.stroke();
  c.beginPath(); c.moveTo(-r, -r * 0.8); c.bezierCurveTo(-r, -r * 2.1, r, -r * 2.1, r, -r * 0.8); c.quadraticCurveTo(0, -r * 0.55, -r, -r * 0.8); c.closePath();
  c.fillStyle = linear(c, -r, -r * 2, r, -r * 0.6, [0, lit(capCol, 0.4), 0.5, capCol, 1, shade(capCol, 0.3)]); c.fill(); c.strokeStyle = out; c.lineWidth = 1.2; c.stroke();
  if (spots) { c.fillStyle = 'rgba(255,255,255,0.85)'; for (const [x, y, q] of [[-r * 0.4, -r * 1.25, 0.2], [r * 0.25, -r * 1.5, 0.17], [r * 0.5, -r * 1.05, 0.13]]) { c.beginPath(); c.arc(x, y, r * q, 0, TAU); c.fill(); } }
}
function puff(c, r, K) {
  const bumps = [[-r * 0.8, -r * 0.5, r * 0.6], [-r * 0.2, -r * 0.85, r * 0.75], [r * 0.5, -r * 0.65, r * 0.65], [r * 0.95, -r * 0.35, r * 0.4]];
  for (const [x, y, rr_] of bumps) {
    c.beginPath(); c.arc(x, y, rr_, 0, TAU);
    c.fillStyle = radial(c, x - rr_ * 0.3, y - rr_ * 0.4, 0.5, rr_ * 1.2, [0, '#ffffff', 0.6, K.top, 1, K.topDk]); c.fill();
    c.strokeStyle = rgba(shade(K.topDk, 0.3), 0.55); c.lineWidth = 1; c.stroke();
  }
}

const tuftCols = (K, skin) => {
  switch (skin) {
    case 'stone': { const col = mix(K.rock, '#b9a55c', 0.55); return [col, lit(col, 0.5), outline(col, 0.62)]; }
    case 'sand': return ['#b7b861', '#e5e08a', '#6d7a3a'];
    case 'ice': return ['#b9e3f3', '#ffffff', '#3d78a6'];
    case 'brick': { const col = mix(K.top, '#6f9a58', 0.55); return [col, lit(col, 0.5), outline(col, 0.62)]; }
    default: return [K.top, K.topLit, K.outTop];
  }
};

/* [w, h, tall?, draw(c, K, R, ch)] — origin (0,0) = bottom-centre; draw upwards (negative y). */
const DECOR = {
  grass: [
    [30, 18, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'grass'); blades(c, 5, 3.4, 7, 13, R, a, b, o); }],
    [26, 20, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'grass'); blades(c, 3, 5, 9, 16, R, a, b, o); }],
    [18, 22, true, (c, K, R) => flower(c, 15, K.accent, '#fff2a8', K.topDk, K.outTop, R)],
    [18, 22, true, (c, K, R) => flower(c, 12, '#ffffff', '#ffd23a', K.topDk, K.outTop, R, 5, 2.2)],
    [22, 14, false, (c, K) => { stone(c, -3, 0, 5.4, 4.2, K); stone(c, 4.5, 0, 3.4, 2.8, K); }],
    [20, 16, false, (c, K, R) => { c.strokeStyle = K.outTop; c.lineWidth = 2.4; c.beginPath(); c.moveTo(0, 1); c.lineTo(0, -6); c.stroke(); c.strokeStyle = K.topDk; c.lineWidth = 1; c.stroke(); for (const [x, y] of [[-4, -8], [4, -8], [0, -12]]) { c.beginPath(); c.arc(x, y, 3.3, 0, TAU); c.fillStyle = linear(c, x, y - 3, x, y + 3, [0, K.topLit, 1, K.top]); c.fill(); c.strokeStyle = K.outTop; c.lineWidth = 1; c.stroke(); } }],
  ],
  mud: [
    [30, 36, true, (c, K, R) => { for (let i = 0; i < 4; i++) { const x = (i - 1.5) * 5 + R.range(-1, 1), h = R.range(20, 31); c.beginPath(); c.moveTo(x, 1); c.quadraticCurveTo(x + R.range(-3, 3), -h * 0.5, x + (i - 1.5) * 1.6, -h); c.strokeStyle = K.outTop; c.lineWidth = 2.6; c.lineCap = 'round'; c.stroke(); c.strokeStyle = i % 2 ? K.top : K.topLit; c.lineWidth = 1.3; c.stroke(); if (i % 2 === 0) { c.beginPath(); c.ellipse(x + (i - 1.5) * 1.6, -h + 1, 2.1, 5, 0, 0, TAU); c.fillStyle = '#8a5a3a'; c.fill(); c.strokeStyle = '#3f2418'; c.lineWidth = 1; c.stroke(); } } }],
    [28, 20, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'mud'); blades(c, 5, 3.6, 7, 13, R, a, b, o); }],
    // a little water lily (NOT a mushroom: the springs in these landscapes are red-capped mushrooms and decor must never look like one)
    [24, 16, false, (c, K) => {
      c.beginPath(); c.ellipse(0, -1.8, 10, 3.3, 0, 0, TAU); c.fillStyle = linear(c, 0, -5, 0, 1, [0, K.topLit, 1, K.topDk]); c.fill(); c.strokeStyle = K.outTop; c.lineWidth = 1.2; c.stroke();
      c.beginPath(); c.moveTo(0, -1.8); c.lineTo(8.6, -3.6); c.strokeStyle = rgba(K.outTop, 0.8); c.lineWidth = 0.9; c.stroke();
      const o = outline(K.accent, 0.6);
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i - 2) * 0.62; c.beginPath(); c.ellipse(-1.5 + Math.cos(a) * 3.2, -5 + Math.sin(a) * 3.2, 1.9, 3.1, a + Math.PI / 2, 0, TAU); c.fillStyle = K.accent; c.fill(); c.strokeStyle = o; c.lineWidth = 0.9; c.stroke(); }
      c.beginPath(); c.arc(-1.5, -5.2, 1.3, 0, TAU); c.fillStyle = '#ffe48a'; c.fill();
    }],
    [22, 14, false, (c, K) => { stone(c, -3, 0, 5.8, 4.2, K); stone(c, 5, 0, 3.4, 2.6, K); }],
    [28, 20, false, (c, K, R) => { c.lineCap = 'round'; for (let i = 0; i < 5; i++) { const a = -2.5 + i * 0.5, L = 12 - Math.abs(i - 2) * 1.6; c.beginPath(); c.moveTo(0, 1); c.quadraticCurveTo(Math.cos(a) * L * 0.6, Math.sin(a) * L * 0.9 - 4, Math.cos(a) * L, Math.sin(a) * L * 0.7 - 5); c.strokeStyle = K.outTop; c.lineWidth = 3; c.stroke(); c.strokeStyle = i % 2 ? K.top : K.topLit; c.lineWidth = 1.6; c.stroke(); } }],
  ],
  stone: [
    [30, 18, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'stone'); blades(c, 5, 3.4, 6, 12, R, a, b, o); }],
    [28, 16, false, (c, K) => { stone(c, -5, 0, 6.2, 4.8, K); stone(c, 4, 0, 5, 4, K); stone(c, -0.5, -5, 3.8, 3, K); }],
    [20, 10, false, (c, K) => { stone(c, -4, 0, 3.4, 2.4, K); stone(c, 3, 0, 2.6, 1.9, K); stone(c, 8, 0, 1.8, 1.4, K); }],
    [14, 22, true, (c, K) => { stone(c, 0, 0, 6.8, 5.2, K); stone(c, 0, -8.2, 5, 4, K); stone(c, 0.5, -15.2, 3, 2.6, K); }],
    [24, 14, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'stone'); blades(c, 3, 4.6, 5, 9, R, a, b, o); stone(c, 8, 0, 3.2, 2.4, K); }],
  ],
  sand: [
    [30, 22, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'sand'); blades(c, 5, 3.6, 8, 16, R, a, b, o); }],
    [18, 14, false, (c, K) => { c.beginPath(); c.moveTo(0, 1); c.bezierCurveTo(-8, 0, -8.5, -10, 0, -12); c.bezierCurveTo(8.5, -10, 8, 0, 0, 1); c.closePath(); c.fillStyle = linear(c, -8, -12, 8, 0, [0, '#fff2e2', 0.5, '#ffc9b0', 1, '#e58f86']); c.fill(); c.strokeStyle = '#8a4a4a'; c.lineWidth = 1.2; c.stroke(); c.lineWidth = 0.9; c.strokeStyle = 'rgba(138,74,74,0.7)'; for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(0, 0); c.lineTo(i * 2.6, -10.4 + Math.abs(i) * 0.9); c.stroke(); } }],
    [20, 12, false, (c, K) => { c.fillStyle = '#ffb9a2'; c.strokeStyle = '#9a4a3c'; c.lineWidth = 1.2; c.lineJoin = 'round'; c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 3.2 : 8; c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, -8 + Math.sin(a) * r * 0.75); } c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#ffe6d6'; c.beginPath(); c.arc(-1, -9, 1.6, 0, TAU); c.fill(); }],
    [22, 14, false, (c, K) => { stone(c, -3, 0, 5.4, 4, K); stone(c, 5, 0, 3.2, 2.5, K); }],
    [16, 24, true, (c, K, R) => { c.strokeStyle = '#6f4a2a'; c.lineWidth = 3.2; c.lineCap = 'round'; c.beginPath(); c.moveTo(-5, 0); c.quadraticCurveTo(0, -7, 6, -16); c.stroke(); c.strokeStyle = '#d2a56a'; c.lineWidth = 1.8; c.stroke(); c.strokeStyle = '#6f4a2a'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(1, -8); c.lineTo(-4, -13); c.stroke(); c.strokeStyle = '#d2a56a'; c.lineWidth = 1.2; c.stroke(); }],
  ],
  ice: [
    [22, 22, true, (c, K) => { shard(c, -5, 0, 7, 14, -1, '#a8e0f4', '#ffffff', K.outTop); shard(c, 2, 0, 8, 21, 1, '#9ad8f0', '#ffffff', K.outTop); shard(c, 8, 0, 5, 10, 1.5, '#b5e6f6', '#ffffff', K.outTop); }],
    [26, 12, false, (c, K) => { c.beginPath(); c.moveTo(-12, 1); c.bezierCurveTo(-11, -9, 11, -9, 12, 1); c.closePath(); c.fillStyle = linear(c, -10, -9, 10, 1, [0, '#ffffff', 0.6, '#eef9ff', 1, '#b6dff0']); c.fill(); c.strokeStyle = K.outTop; c.lineWidth = 1.3; c.stroke(); c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath(); c.ellipse(-4, -6.2, 3.5, 1.3, -0.3, 0, TAU); c.fill(); }],
    [26, 16, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'ice'); blades(c, 5, 3.4, 6, 12, R, a, b, o); }],
    [16, 14, false, (c, K) => { shard(c, 0, 0, 7, 11, 0.5, '#bdeaf8', '#ffffff', K.outTop); shard(c, 6, 0, 4, 7, 1, '#a8e0f4', '#ffffff', K.outTop); }],
    [24, 12, false, (c, K) => { stone(c, -4, 0, 5, 3.6, K); c.beginPath(); c.moveTo(1, 1); c.bezierCurveTo(2, -7, 12, -7, 12, 1); c.closePath(); c.fillStyle = '#f5fdff'; c.fill(); c.strokeStyle = K.outTop; c.lineWidth = 1.2; c.stroke(); }],
  ],
  crystal: [
    [28, 30, true, (c, K) => { shard(c, -7, 0, 8, 13, -1.5, mix(K.light, '#6ad0e0', 0.2), '#e6fffb', outline(K.light, 0.7)); shard(c, 1, 0, 10, 24, 0.8, mix(K.light, '#6ad0e0', 0.2), '#e6fffb', outline(K.light, 0.7)); shard(c, 9, 0, 6, 12, 1.5, mix(K.light, '#6ad0e0', 0.2), '#e6fffb', outline(K.light, 0.7)); }],
    [24, 24, true, (c, K) => { const cool = mix(K.light, '#8fa4ff', 0.55), o = outline(cool, 0.7); shard(c, -3, 0, 8, 16, -1, cool, '#f2f6ff', o); shard(c, 6, 0, 6, 10, 1.2, cool, '#f2f6ff', o); }],   // cool periwinkle: pink/magenta is reserved for the crystal SPIKES
    [22, 22, true, (c, K) => mushroom(c, 6.5, K.light, '#cdeff2', outline(K.light, 0.7))],
    [22, 14, false, (c, K) => { stone(c, -3, 0, 5.4, 4, K); stone(c, 5, 0, 3.2, 2.6, K); }],
    [16, 14, false, (c, K) => { shard(c, 0, 0, 7, 11, 0.5, mix(K.light, '#6ad0e0', 0.2), '#e6fffb', outline(K.light, 0.7)); }],
  ],
  brick: [
    [30, 18, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'brick'); blades(c, 5, 3.4, 6, 13, R, a, b, o); }],
    [18, 22, true, (c, K, R) => flower(c, 14, K.accent, '#fff2a8', '#5f8a4c', outline('#5f8a4c', 0.6), R, 5, 2.3)],
    [26, 12, false, (c, K) => { for (const [x, y, w] of [[-8, 0, 10], [4, 0, 9], [-2, -6, 9]]) { rr(c, x - w / 2, y - 6, w, 6, 1.4); c.fillStyle = linear(c, 0, y - 6, 0, y, [0, K.soilLit, 1, K.soil]); c.fill(); c.strokeStyle = K.outBody; c.lineWidth = 1.2; c.stroke(); } }],
    [28, 16, false, (c, K, R) => { const [a, b, o] = tuftCols(K, 'brick'); blades(c, 3, 5, 8, 14, R, a, b, o); }],
    [22, 14, false, (c, K) => { stone(c, -3, 0, 5.2, 3.8, K); stone(c, 5, 0, 3.4, 2.6, K); }],
  ],
  cloud: [
    [34, 20, false, (c, K) => puff(c, 10, K)],
    [26, 16, false, (c, K) => puff(c, 7.5, K)],
    [16, 26, true, (c, K) => { c.fillStyle = '#ffe27a'; c.strokeStyle = '#b07a12'; c.lineWidth = 1.2; c.lineJoin = 'round'; c.beginPath(); c.moveTo(0, 1); c.lineTo(0, -8); c.stroke(); c.beginPath(); for (let i = 0; i < 8; i++) { const a = -Math.PI / 2 + i * Math.PI / 4, r = i % 2 ? 2.6 : 6.5; c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, -14 + Math.sin(a) * r); } c.closePath(); c.fill(); c.stroke(); }],
    [30, 14, false, (c, K) => puff(c, 6.5, K)],
    [34, 22, false, (c, K) => puff(c, 11, K)],
  ],
};

const DECOR_STEP = 64, DECOR_CHANCE = 0.74;

function decorFor(s, cache, ch, K, skin) {
  const key = ch.id + '|dec|' + skin + (K.ice && skin !== 'ice' ? 'i' : '');
  let set = s.decor.get(key);
  if (set) return set;
  const defs = DECOR[skin] || DECOR.grass;
  set = defs.map(([w, h, tall, draw], i) => ({ tall, sp: cache.get('terr|' + key + '|' + i, w, h, w / 2, h, (c) => draw(c, K, rng(strSeed(key) + i * 977), ch)) }));
  s.decor.set(key, set);
  return set;
}

/** Stamp seeded decor along a surface between xa..xb (local x). `skipEnd` keeps tall things away from edges. */
function stampDecor(ctx, cache, set, id, xa, xb, w, y, density = DECOR_CHANCE) {
  for (let slot = Math.floor((xa - 20) / DECOR_STEP); slot <= Math.floor((xb + 20) / DECOR_STEP); slot++) {
    const h = hash(id, slot, 7);
    if ((h & 1023) / 1023 > density) continue;
    const x = slot * DECOR_STEP + 6 + ((h >>> 10) & 1023) / 1023 * (DECOR_STEP - 12);
    const d = set[(h >>> 20) % set.length];
    const m = d.tall ? 30 : 12;
    if (x < m || x > w - m) continue;
    cache.stamp(ctx, d.sp, x, y + 1, h & 0x40000000 ? -1 : 1, 1);
  }
}

/* ═════════════════════════ GROUND island drawer ═════════════════════════ */

const _o = { x: 0, y: 0, vx0: -1e9, vx1: 1e9 };
/** Snap a platform origin to the device pixel grid (crisp rims, stable pattern phase) and find the visible local x-range. */
function localFrame(ctx, x, y) {
  const m = ctx.getTransform(), a = m.a || 1, d = m.d || 1;
  const sx = Math.round(a * x + m.e), sy = Math.round(d * y + m.f);
  _o.x = (sx - m.e) / a; _o.y = (sy - m.f) / d;
  const cw = (ctx.canvas && ctx.canvas.width) || 4096;
  _o.vx0 = (0 - m.e) / a - _o.x - 20; _o.vx1 = (cw - m.e) / a - _o.x + 20;
  return _o;
}

function groundPath(c, xa, xb, bottom, rl, rrad) {
  c.beginPath();
  c.moveTo(xa, bottom); c.lineTo(xa, rl);
  if (rl) c.quadraticCurveTo(xa, 0, xa + rl, 0); else c.lineTo(xa, 0);
  c.lineTo(xb - rrad, 0);
  if (rrad) c.quadraticCurveTo(xb, 0, xb, rrad); else c.lineTo(xb, 0);
  c.lineTo(xb, bottom); c.closePath();
}

function groundTile(s, ch, skin, iceFlag, K, variant) {
  const id = ch.id + '|g|' + skin + (iceFlag ? 'i' : '');
  return tileOf(s, id + '|t' + variant, GP, GH, (c, P, H) => GROUND_TILES[skin](c, P, H, K, rng(strSeed(id) + variant * 7919)));
}

const GLOW_H = 26, GLOW_INSET = 6;
/** Soft light above a landing surface in dark landscapes. A vertical-gradient band for the middle and a quarter-disc of the same
 *  profile (cached radial gradient) rounding off each end, so the glow never stops in a hard vertical edge. Local coordinates;
 *  xa..xb is the visible part of the island [0, w]. Creates no gradients in steady state. */
function groundGlow(ctx, s, id, K, xa, xb, w) {
  if (w < 2 * GLOW_INSET + 4) return;
  const gid = id + '|glow', c0 = GLOW_INSET, c1 = w - GLOW_INSET;
  const ma = Math.max(xa, c0), mb = Math.min(xb, c1);
  if (mb > ma) {
    ctx.fillStyle = vgrad(ctx, s, gid, -GLOW_H, 0, [0, rgba(K.rim, 0), 0.6, rgba(K.rim, 0.14), 1, rgba(K.rim, 0.46)]);
    ctx.fillRect(ma, -GLOW_H, mb - ma, GLOW_H);
  }
  let cap = null;
  const draw = (cx, a0, a1) => {                                   // a quarter disc centred on the surface at x = cx
    if (!cap) { cap = s.grads.get(gid + 'cap'); if (!cap) { cap = ctx.createRadialGradient(0, 0, 0, 0, 0, GLOW_H); cap.addColorStop(0, rgba(K.rim, 0.46)); cap.addColorStop(0.4, rgba(K.rim, 0.14)); cap.addColorStop(1, rgba(K.rim, 0)); s.grads.set(gid + 'cap', cap); } }
    ctx.save(); ctx.translate(cx, 0); ctx.fillStyle = cap;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, GLOW_H, a0, a1); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  if (xa < c0) draw(c0, Math.PI, Math.PI * 1.5);
  if (xb > c1) draw(c1, Math.PI * 1.5, Math.PI * 2);
}

/* ── ground islands: a pre-painted STRIP for the interior, a clipped window for each end ──────────────────────────────────────────
 * QA-VISUAL (performance). A ground island used to be painted from scratch every frame: a clip path, a full-height gradient, a
 * pattern fill, an ambient-occlusion gradient, rim bars and an outline stroke over ~2500 x 300 device pixels. That was 4-6 ms of the
 * 8-12 ms a frame costs on the software rasteriser (and the biggest cost on a low-end phone). The interior of an island is
 * periodic, so it is now painted ONCE per (landscape, skin, variant) into an opaque strip one texture period (GP u) wide and
 * GSH u deep, and every frame is a handful of 1:1 integer-pixel blits of it plus a flat fill below. Only the two ends of an island
 * (GCAP u each: rounded corners, lit / shaded end faces, side outlines) still go through a clip, and that clip is a few dozen
 * pixels wide. The look is unchanged; the texture simply no longer starts at a per-island phase. Blits sit on the same device-pixel
 * grid as the island's origin (localFrame), so the period grid is seamless and cannot shimmer as the camera moves. */
const GSH = 120;           // strip depth (u): the body gradient ends (a flat K.deep) at 118
const GCAP = 30;           // width (u) of each end window

function opaqueSurface(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return c;
}
/** The interior of a ground island, one period wide: body gradient + strata/pebble tile + ambient occlusion + rim light (opaque). */
function groundStrip(s, ch, skin, iceFlag, K, variant) {
  const id = ch.id + '|g|' + skin + (iceFlag ? 'i' : '');
  const key = id + '|strip' + variant;
  let st = s.tiles.get(key);
  if (st) return st;
  const k = s.scale, wp = Math.max(1, Math.round(GP * k)), hp = Math.max(1, Math.round(GSH * k));
  const canvas = opaqueSurface(wp, hp), c = canvas.getContext('2d', { alpha: false });
  c.setTransform(wp / GP, 0, 0, hp / GSH, 0, 0);
  c.fillStyle = vgrad(c, s, id + '|body', 0, 118, [0, K.soilLit, 0.1, K.soil, 0.5, K.soilDk, 1, K.deep]);
  c.fillRect(0, 0, GP, GSH);
  fillTile(c, groundTile(s, ch, skin, iceFlag, K, variant), 0, GP, 0);
  c.fillStyle = vgrad(c, s, id + '|ao', 6, 30, [0, 'rgba(24,10,48,' + (K.ice || skin === 'cloud' ? 0.1 : 0.3) + ')', 1, 'rgba(24,10,48,0)']);
  c.fillRect(0, 6, GP, 24);
  c.fillStyle = rgba(K.rim, 0.97); c.fillRect(0, 0.9, GP, K.dark ? 2.5 : 1.9);
  c.fillStyle = rgba(K.rim, K.dark ? 0.5 : 0.3); c.fillRect(0, K.dark ? 3.4 : 2.8, GP, 1.8);
  st = { canvas, wp, hp };
  s.tiles.set(key, st);
  return st;
}
/** The soft light above a landing surface in dark landscapes, one period wide (the straight middle of groundGlow). */
function glowStrip(s, ch, skin, K) {
  const id = ch.id + '|g|' + skin, key = id + '|gstrip';
  let st = s.tiles.get(key);
  if (st) return st;
  const k = s.scale, wp = Math.max(1, Math.round(GP * k)), hp = Math.max(1, Math.round(GLOW_H * k));
  const canvas = createSurface(wp, hp), c = canvas.getContext('2d');
  c.setTransform(wp / GP, 0, 0, hp / GLOW_H, 0, hp);                 // local y -GLOW_H..0 (what the shared gradient is authored for) -> strip rows 0..hp
  c.fillStyle = vgrad(c, s, id + '|glow', -GLOW_H, 0, [0, rgba(K.rim, 0), 0.6, rgba(K.rim, 0.14), 1, rgba(K.rim, 0.46)]);
  c.fillRect(0, -GLOW_H, GP, GLOW_H);
  st = { canvas, wp, hp };
  s.tiles.set(key, st);
  return st;
}

/** 1:1 blit of strip pieces onto device pixels [dx0, dx1) with the period grid anchored at device x X0, top row at device y Y0. */
function blitStrip(ctx, st, X0, Y0, dx0, dx1) {
  const wp = st.wp, W = ctx.canvas.width, H = ctx.canvas.height;
  if (dx0 < 0) dx0 = 0;
  if (dx1 > W) dx1 = W;
  if (dx1 <= dx0 || Y0 >= H) return;
  const rows = Math.min(st.hp, H - Y0), yy = Y0 < 0 ? -Y0 : 0;
  if (rows - yy <= 0) return;
  for (let kk = Math.floor((dx0 - X0) / wp); X0 + kk * wp < dx1; kk++) {
    const px0 = X0 + kk * wp, a = px0 > dx0 ? px0 : dx0, b = px0 + wp < dx1 ? px0 + wp : dx1;
    if (b > a) ctx.drawImage(st.canvas, a - px0, yy, b - a, rows - yy, a, Y0 + yy, b - a, rows - yy);
  }
}

function drawGround(ctx, cache, s, p, ch, x, y, t) {
  const ice = !!p.ice, base = (ch.skin && ch.skin.ground) || 'grass';
  const skin = ice ? 'ice' : base;
  const iceFlag = ice && base !== 'ice';
  const K = groundKit(ch, skin, iceFlag);
  const w = p.w, id = ch.id + '|g|' + skin + (ice ? 'i' : '');
  const f = localFrame(ctx, x, y);
  const xa = Math.max(0, f.vx0), xb = Math.min(w, f.vx1);
  if (xb <= xa) return;
  const variant = hash(p.id, 3) & 1;
  const st = groundStrip(s, ch, skin, iceFlag, K, variant);
  const m = ctx.getTransform(), S = m.a;
  const X0 = Math.round(S * f.x + m.e), Y0 = Math.round(m.d * f.y + m.f);        // the island's origin on the device pixel grid
  const G0 = X0 - (hash(p.id, 5) % st.wp);                                       // where this island's texture period starts: a per-island phase, so neighbours do not repeat each other
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const Hb = (H - Y0) / m.d + 6;                                                   // local y of the screen's bottom edge (+ a little)
  const rc = 6;
  const capPx = Math.round(GCAP * S), capU = capPx / S;
  const devL = (u) => X0 + Math.round(u * S);
  const leftEnd = xa <= 0, rightEnd = xb >= w;
  const small = w * S < 2 * capPx + 4;                                           // too short for an interior: one window
  const sheen = !!p.ice;
  const skinGlow = K.dark ? glowStrip(s, ch, skin, K) : null;

  // an end window [a, b] (local units): rounded where it is a real end, lit / shaded end faces, outline on the real edges
  const windowDraw = (a, b) => {
    const rl = a <= 0 ? rc : 0, rrad = b >= w ? rc : 0;
    ctx.save();
    ctx.translate(f.x, f.y);
    if (K.dark) groundGlow(ctx, s, id, K, a, b, w);
    groundPath(ctx, a, b, Hb, rl, rrad); ctx.clip();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d0 = Math.max(0, devL(a)), d1 = Math.min(W, a <= 0 && b >= w ? devL(w) + 1 : devL(b) + 1);
    blitStrip(ctx, st, G0, Y0, d0, d1);
    if (Y0 + st.hp < H) { ctx.fillStyle = K.deep; ctx.fillRect(d0, Y0 + st.hp, d1 - d0, H - Y0 - st.hp); }
    ctx.restore();
    if (sheen) drawSheen(ctx, cache, s, K, id, a, b, w, p.id, t);
    if (a <= 0) { ctx.fillStyle = hgrad(ctx, s, id + '|el', 0, 13, [0, 'rgba(255,244,210,0.3)', 1, 'rgba(255,244,210,0)']); ctx.fillRect(0, 0, 13, Hb); }
    if (b >= w) { ctx.save(); ctx.translate(w, 0); ctx.fillStyle = hgrad(ctx, s, id + '|er', -16, 0, [0, 'rgba(24,10,48,0)', 1, 'rgba(24,10,48,0.4)']); ctx.fillRect(-16, 0, 16, Hb); ctx.restore(); }
    ctx.restore();
  };

  let ia = xa, ib = xb;
  if (small) {
    windowDraw(xa, xb);
  } else {
    // the end windows sit on whole device pixels so the interior blit meets them exactly
    if (leftEnd) { windowDraw(0, capU); ia = capU; }
    let rx = w;
    if (rightEnd) { rx = (Math.floor(S * f.x + m.e + w * S - capPx) - X0) / S; windowDraw(rx, w); ib = rx; }
    if (ib > ia) {
      const d0 = devL(ia), d1 = devL(ib);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (skinGlow) blitStrip(ctx, skinGlow, G0, Y0 - skinGlow.hp, Math.max(d0, devL(GLOW_INSET)), Math.min(d1, devL(w - GLOW_INSET)));
      blitStrip(ctx, st, G0, Y0, d0, d1);
      if (Y0 + st.hp < H && d1 > d0) { ctx.fillStyle = K.deep; ctx.fillRect(Math.max(0, d0), Y0 + st.hp, Math.min(W, d1) - Math.max(0, d0), H - Y0 - st.hp); }
      ctx.restore();
      ctx.save(); ctx.translate(f.x, f.y);
      if (sheen) drawSheen(ctx, cache, s, K, id, ia, ib, w, p.id, t);
      ctx.restore();
    }
  }
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.imageSmoothingEnabled = true;
  // outline: ONE stroke over the whole visible island (dark hue of the cap at the top, dark soil on the sides), so pieces never show a seam
  const rl = leftEnd ? rc : 0, rrad = rightEnd ? rc : 0;
  groundPath(ctx, xa, xb, Hb, rl, rrad);
  ctx.strokeStyle = vgrad(ctx, s, id + '|out', 0, 40, [0, K.outTop, 1, K.outBody]);
  ctx.lineWidth = 2.4; ctx.lineJoin = 'round'; ctx.stroke();
  if (K.dark) { ctx.beginPath(); ctx.moveTo(xa + rl, -0.4); ctx.lineTo(xb - rrad, -0.4); ctx.strokeStyle = rgba(K.rim, 0.55); ctx.lineWidth = 1; ctx.stroke(); }
  stampDecor(ctx, cache, decorFor(s, cache, ch, K, skin), p.id, xa, xb, w, 0);
  ctx.restore();
}

/** Slippery-ice sheen: a glossy band with slanted glints, and a slow travelling shine. */
function drawSheen(ctx, cache, s, K, id, xa, xb, w, pid, t) {
  ctx.fillStyle = vgrad(ctx, s, id + '|sheen', 0, 13, [0, 'rgba(255,255,255,0.7)', 0.4, 'rgba(214,246,255,0.34)', 1, 'rgba(190,238,255,0)']);
  ctx.fillRect(xa, 0, xb - xa, 13);
  const tile = tileOf(s, id + '|slick', 56, 13, (c, P, H) => {
    c.fillStyle = 'rgba(255,255,255,0.62)';
    for (const [x, wd] of [[8, 5], [24, 2.2], [38, 7]]) { c.beginPath(); c.moveTo(x + 4, 3); c.lineTo(x + 4 + wd, 3); c.lineTo(x + wd - 3, 11); c.lineTo(x - 3, 11); c.closePath(); c.fill(); }
  });
  fillTile(ctx, tile, xa, xb, (hash(pid, 9) % 56));
  const sweep = ((t * 46 + hash(pid, 11) % 400) % 420) - 40;
  if (sweep > xa - 20 && sweep < xb + 20) { ctx.fillStyle = hgrad(ctx, s, id + '|shine', -14, 14, [0, 'rgba(255,255,255,0)', 0.5, 'rgba(255,255,255,0.65)', 1, 'rgba(255,255,255,0)']); ctx.save(); ctx.translate(sweep, 0); ctx.fillRect(-14, 0.5, 28, 7); ctx.restore(); }
}


/* ═════════════════════════ LEDGES: thin one-way slabs, nine skins ═════════════════════════
 * Every ledge is: silhouette path (clip) + cached body gradient + repeating texture tile + bright rim
 * + outline + a little seeded decoration. h is ~14-18; the underside is shaped (icicles, arches, beams…). */

const LP = 64, LH = 26;      // ledge texture tile
const REF_H = 16;            // gradients are authored for this thickness

function mkLedgeKit(ch, c, extra = {}) {
  const P = ch.palette;
  return {
    dark: !!ch.dark, accent: P.accent, light: P.light, c, cl: lit(c, 0.42), cd: shade(c, 0.3), cdd: shade(c, 0.55), cb: bounce(shade(c, 0.2), 0.3),
    out: outline(c, 0.7), rim: ch.dark ? mix(P.light, '#ffffff', 0.45) : lit(c, 0.72), ...extra,
  };
}
function ledgeKit(ch, skin, ice) {
  const key = ch.id + '|l|' + skin + (ice ? '|ice' : '');
  let K = KITS.get(key);
  if (K) return K;
  const P = ch.palette;
  switch (skin) {
    case 'leaf': K = mkLedgeKit(ch, mix(P.top, '#58b84e', 0.3), { vein: lit(P.top, 0.6) }); break;
    case 'plank': K = mkLedgeKit(ch, mix('#c98f4e', P.soil, 0.25)); break;
    case 'log': K = mkLedgeKit(ch, mix('#8d6240', P.soil, 0.35), { moss: P.top, mossDk: P.fringe, wood: '#e9c892' }); break;
    case 'branch': K = mkLedgeKit(ch, mix('#82583b', P.soil, 0.3), { leaf: P.top, leafDk: P.fringe, blossom: P.accent }); break;
    case 'stone': K = mkLedgeKit(ch, mix(P.rock, P.soil, 0.3), { cap: lit(P.rock, 0.3) }); break;
    case 'ice': K = mkLedgeKit(ch, '#7fcdf0', { cl: '#effcff', cd: '#4a9fd8', cdd: '#2a64a8', out: ICE.outTop, rim: '#ffffff', ice: true }); break;
    case 'crystal': K = mkLedgeKit(ch, mix(P.rock, P.soil, 0.2), { rim: mix(P.light, '#ffffff', 0.45) }); break;
    case 'brick': K = mkLedgeKit(ch, mix(P.fringe, P.soil, 0.35), { mortar: lit(mix(P.top, P.rock, 0.3), 0.2), cap: lit(P.top, 0.2) }); break;
    case 'cloud': K = mkLedgeKit(ch, '#f1edf9', { cl: '#ffffff', cd: '#cdc6e6', cdd: '#9d95c4', cb: '#e2dcf2', out: '#6c6a9a', rim: '#ffffff' }); break;
    default: K = mkLedgeKit(ch, P.top);
  }
  K.skin = skin;
  KITS.set(key, K);
  return K;
}

/* tile painters: marks only (mostly translucent) over the base gradient. y in [0, LH]. */
function tilePlank(c, P, H, K, R) {
  const pw = 32;
  for (let i = 0; i < 2; i++) {
    const x0 = i * pw;
    c.fillStyle = i ? rgba(K.cd, 0.18) : rgba(K.cl, 0.2); c.fillRect(x0, 0, pw, REF_H);
    c.fillStyle = rgba(K.cdd, 0.85); c.fillRect(x0 - 0.7, 0, 1.4, REF_H + 1);
    c.fillStyle = rgba(K.cl, 0.55); c.fillRect(x0 + 0.8, 0, 0.9, REF_H + 1);
    c.lineWidth = 1; c.lineCap = 'round';
    for (let g = 0; g < 3; g++) { const y = 5 + g * 4 + R.range(-1, 1); c.beginPath(); c.moveTo(x0 + 3, y); c.quadraticCurveTo(x0 + pw / 2, y + R.range(-1.6, 1.6), x0 + pw - 3, y); c.strokeStyle = rgba(K.cdd, 0.3); c.stroke(); }
    for (const nx of [x0 + 5.5, x0 + pw - 5.5]) { c.beginPath(); c.arc(nx, 5.4, 1.35, 0, TAU); c.fillStyle = 'rgba(40,28,40,0.8)'; c.fill(); c.beginPath(); c.arc(nx - 0.4, 5, 0.5, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.6)'; c.fill(); }
  }
}
function tileLog(c, P, H, K, R) {
  c.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const y = 3.8 + i * 2.9; c.beginPath();
    for (let x = 0; x <= P; x += 4) { const yy = y + Math.sin(x / P * TAU * (2 + i % 2) + i) * 0.8; if (x) c.lineTo(x, yy); else c.moveTo(x, yy); }
    c.strokeStyle = rgba(K.cdd, 0.4); c.lineWidth = 1.2; c.stroke();
  }
  c.strokeStyle = rgba(K.cdd, 0.45); c.lineWidth = 1;
  for (let i = 0; i < 9; i++) { const x = R.range(0, P), y = R.range(3, 11); c.beginPath(); c.moveTo(x, y); c.lineTo(x + R.range(-1, 1), y + R.range(2.5, 4.5)); c.stroke(); }
  const kx = R.range(14, P - 14);
  c.beginPath(); c.ellipse(kx, 9, 3.4, 2.4, 0, 0, TAU); c.fillStyle = rgba(K.cdd, 0.65); c.fill(); c.strokeStyle = rgba(K.cl, 0.5); c.lineWidth = 1; c.stroke();
  c.beginPath(); c.ellipse(kx, 9, 1.4, 0.9, 0, 0, TAU); c.fillStyle = rgba(K.cdd, 0.9); c.fill();
}
function tileLeaf(c, P, H, K) {
  c.lineCap = 'round';
  for (let x = 4; x < P; x += 11) {
    c.beginPath(); c.moveTo(x, 6.6); c.quadraticCurveTo(x + 3, 9, x + 8, 13.4); c.strokeStyle = rgba(K.cdd, 0.3); c.lineWidth = 1.2; c.stroke();
    c.beginPath(); c.moveTo(x + 1.2, 6.6); c.quadraticCurveTo(x + 4, 8.6, x + 9, 12.8); c.strokeStyle = rgba(K.vein, 0.28); c.lineWidth = 0.9; c.stroke();
  }
}
function tileBranch(c, P, H, K, R) {
  c.lineCap = 'round';
  for (let i = 0; i < 16; i++) { const x = R.range(0, P), y = R.range(3, 12), L = R.range(2.5, 5); c.beginPath(); c.moveTo(x, y); c.lineTo(x + R.range(-1, 1.5), y + L); c.strokeStyle = rgba(K.cdd, 0.42); c.lineWidth = 1.1; c.stroke(); }
  for (let i = 0; i < 6; i++) { const x = R.range(0, P), y = R.range(3, 12); c.beginPath(); c.moveTo(x, y); c.lineTo(x + R.range(3, 8), y + R.range(-0.6, 0.6)); c.strokeStyle = rgba(K.cl, 0.4); c.lineWidth = 1; c.stroke(); }
  c.fillStyle = rgba(K.leaf, 0.55); for (let i = 0; i < 4; i++) { c.beginPath(); c.ellipse(R.range(0, P), R.range(4, 12), R.range(1.2, 2.6), 1, 0, 0, TAU); c.fill(); }
  const kx = R.range(12, P - 12); c.beginPath(); c.ellipse(kx, 9, 3, 2.2, 0.2, 0, TAU); c.fillStyle = rgba(K.cdd, 0.6); c.fill(); c.strokeStyle = rgba(K.cl, 0.4); c.stroke();
}
function tileStoneLedge(c, P, H, K, R) {
  c.lineCap = 'round';
  [[7.5, 0.35], [11.5, 0.3]].forEach(([y, a], i) => { c.beginPath(); for (let x = 0; x <= P; x += 4) { const yy = y + Math.sin(x / P * TAU * (2 + i) + i) * 0.9; if (x) c.lineTo(x, yy); else c.moveTo(x, yy); } c.strokeStyle = rgba(K.cdd, a); c.lineWidth = 1.2; c.stroke(); });
  for (let i = 0; i < 20; i++) { const x = R.range(0, P), y = R.range(5, 14); c.fillStyle = i % 3 ? rgba(K.cdd, 0.4) : rgba(K.cl, 0.5); c.fillRect(x, y, R.range(1, 2.4), 1); }
  c.fillStyle = rgba(K.cdd, 0.55); for (const x of [10, 40]) c.fillRect(x, 0, 1.2, 4.2);
}
function tileIceLedge(c, P, H, K, R) {
  for (let i = 0; i < 3; i++) { const x = (i + 0.35) * P / 3 + R.range(-4, 4); c.beginPath(); c.moveTo(x, 2); c.lineTo(x + 4.5, 2); c.lineTo(x - 3.5, 14); c.lineTo(x - 8, 14); c.closePath(); c.fillStyle = 'rgba(255,255,255,0.5)'; c.fill(); }
  c.fillStyle = 'rgba(255,255,255,0.55)'; for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(R.range(0, P), R.range(4, 14), R.range(0.5, 1.2), 0, TAU); c.fill(); }
  c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1; c.beginPath(); const x = R.range(8, P - 26); c.moveTo(x, 8); c.lineTo(x + 6, 11); c.lineTo(x + 11, 9); c.lineTo(x + 18, 13); c.stroke();
}
function tileCrystalLedge(c, P, H, K, R) {
  for (let i = 0; i < 5; i++) { const x = R.range(0, P), y = R.range(2, 10); c.beginPath(); c.moveTo(x, y); c.lineTo(x + R.range(5, 12), y + R.range(3, 7)); c.lineTo(x + R.range(-3, 5), y + R.range(7, 12)); c.closePath(); c.fillStyle = i % 2 ? rgba(K.light, 0.16) : rgba('#ffffff', 0.12); c.fill(); }
  c.beginPath(); let x = R.range(0, 8), y = 8; c.moveTo(x, y); for (let i = 0; i < 6; i++) { x += R.range(8, 14); y = 5 + R.range(0, 8); c.lineTo(x, y); }
  c.strokeStyle = rgba(K.light, 0.2); c.lineWidth = 3.4; c.lineJoin = 'round'; c.stroke(); c.strokeStyle = rgba(K.light, 0.7); c.lineWidth = 1; c.stroke();
}
function tileBrickLedge(c, P, H, K, R) {
  for (let r = 0; r < 2; r++) {
    const y = r * 8 + 4, bw = 16, off = r ? 8 : 0;
    for (let i = -1; i <= P / bw; i++) {
      const x = i * bw + off, tone = R();
      c.fillStyle = tone < 0.35 ? rgba(K.cl, 0.3) : tone < 0.65 ? rgba(K.cd, 0.28) : rgba(K.c, 0.12); c.fillRect(x + 1, y + 0.5, bw - 2, 7);
      c.fillStyle = rgba(K.mortar, 0.85); c.fillRect(x - 0.7, y, 1.4, 8);
    }
    c.fillStyle = rgba(K.mortar, 0.85); c.fillRect(-2, y + 7.3, P + 4, 1.4);
  }
}
function tileCloudLedge(c, P, H, K, R) {
  c.lineCap = 'round';
  for (let i = 0; i < 4; i++) { const x = (i + 0.5) * P / 4 + R.range(-4, 4), y = R.range(6, 12), r = R.range(3, 5.5); c.beginPath(); c.arc(x, y, r, Math.PI * 1.05, Math.PI * 1.95); c.strokeStyle = rgba(K.cdd, 0.28); c.lineWidth = 1.3; c.stroke(); }
  c.fillStyle = 'rgba(255,255,255,0.8)'; for (let i = 0; i < 6; i++) c.fillRect(R.range(0, P), R.range(1.5, 4), R.range(3, 7), 1);
}

/* silhouettes: `edge` emits the bottom edge right->left; the top is flat unless a skin overrides the whole path */
function edgeFlat(c, xa, xb, w, h) { c.lineTo(xa, h); }
function edgeTeeth(step, lo, hi, round) {
  return (c, xa, xb, w, h, id) => {
    for (let i = Math.floor(xb / step); i >= Math.floor(xa / step); i--) {
      const xr = Math.min(xb, (i + 1) * step), xl = Math.max(xa, i * step);
      if (xr < xl + 0.5) continue;
      // a tooth cut by the slab's end keeps its tip INSIDE the slab (otherwise a barb pokes out past the end, e.g. ice / crystal ledges)
      const part = (xr - xl) / step, xm = part < 1 ? (xl + xr) / 2 : (i + 0.5) * step, L = (lo + (hi - lo) * unit(id, i, 17)) * (part < 1 ? 0.35 + 0.65 * part : 1);
      c.lineTo(xr, h);
      if (round) { c.quadraticCurveTo(xr - step * 0.1, h + L * 0.55, xm, h + L); c.quadraticCurveTo(xl + step * 0.1, h + L * 0.55, xl, h); } else { c.lineTo(xm, h + L); c.lineTo(xl, h); }
    }
    c.lineTo(xa, h);
  };
}
function edgeScallop(r) {
  return (c, xa, xb, w, h, id) => {
    const step = r * 2;
    for (let i = Math.floor(xb / step); i >= Math.floor(xa / step); i--) {
      const xr = Math.min(xb, (i + 1) * step), xl = Math.max(xa, i * step), d = r * 0.5 + unit(id, i, 5) * 2;
      if (xr < xl + 0.5) continue;
      const part = (xr - xl) / step, xm = part < 1 ? (xl + xr) / 2 : (i + 0.5) * step;          // a scallop cut by the slab's end stays inside it
      c.lineTo(xr, h - 2);
      if (part < 0.3) c.lineTo(xl, h - 2); else c.quadraticCurveTo(xm, h - 2 + d * 2 * (part < 1 ? part * part : 1), xl, h - 2);     // ...and a sliver is left flat rather than a thin drip
    }
    c.lineTo(xa, h - 2);
  };
}
function edgeArches(span, depth) {
  return (c, xa, xb, w, h) => {
    for (let i = Math.floor(xb / span); i >= Math.floor(xa / span); i--) {
      const xr = Math.min(xb, (i + 1) * span), xl = Math.max(xa, i * span);
      if (xr < xl + 0.5) continue;
      const full = xr - xl >= span - 0.01;
      c.lineTo(xr, h);
      if (full) { c.lineTo(xr - 3, h); c.quadraticCurveTo((xr + xl) / 2, h - depth * 2.1, xl + 3, h); c.lineTo(xl, h); } else c.lineTo(xl, h);
    }
    c.lineTo(xa, h);
  };
}
/** Generic slab: flat top with rounded end corners, bottom shaped by `edge`. */
function slabPath(edge, rEnd = 3) {
  return (c, xa, xb, w, h, id) => {
    const rl = xa <= 0 ? rEnd : 0, rrr = xb >= w ? rEnd : 0;
    c.beginPath(); c.moveTo(xa, rl);
    if (rl) c.quadraticCurveTo(xa, 0, xa + rl, 0);
    c.lineTo(xb - rrr, 0);
    if (rrr) c.quadraticCurveTo(xb, 0, xb, rrr);
    c.lineTo(xb, h - 1);
    edge(c, xa, xb, w, h, id);
    c.closePath();
  };
}
function pathLog(c, xa, xb, w, h) {
  const r = h / 2, atL = xa <= 0, atR = xb >= w;
  c.beginPath();
  if (atL) { c.moveTo(r, 0); } else c.moveTo(xa, 0);
  c.lineTo(atR ? w - r : xb, 0);
  if (atR) c.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2); else c.lineTo(xb, h);
  c.lineTo(atL ? r : xa, h);
  if (atL) c.arc(r, r, r, Math.PI / 2, Math.PI * 1.5); else c.lineTo(xa, 0);
  c.closePath();
}
function pathLeaf(c, xa, xb, w, h) {
  c.beginPath(); c.moveTo(-5, -2.5);
  c.bezierCurveTo(1, 3.2, 8, 0, 16, 0); c.lineTo(w - 16, 0); c.bezierCurveTo(w - 8, 0, w - 1, 3.2, w + 5, -2.5);
  c.bezierCurveTo(w + 1, h * 0.7, w * 0.78, h + 1.6, w * 0.5, h + 1.6);
  c.bezierCurveTo(w * 0.22, h + 1.6, -1, h * 0.7, -5, -2.5);
  c.closePath();
}
function pathBranch(c, xa, xb, w, h, id) {
  const r = Math.min(7, h * 0.45), atL = xa <= 0, atR = xb >= w, th = (x) => h * (1 - 0.22 * (x / w));
  c.beginPath(); c.moveTo(xa, atL ? r : 0);
  if (atL) c.quadraticCurveTo(xa, 0, xa + r, 0);
  for (let x = xa + (atL ? r : 0); x <= xb - (atR ? 4 : 0); x += 6) c.lineTo(x, Math.sin(x * 0.21 + id) * 0.8);
  if (atR) { c.lineTo(xb, 1); c.quadraticCurveTo(xb + 3, th(xb) * 0.5, xb - 1, th(xb)); } else c.lineTo(xb, 0);
  for (let x = xb - (atR ? 2 : 0); x >= xa + (atL ? r : 0); x -= 6) c.lineTo(x, th(x) + Math.sin(x * 0.17 + id * 2) * 1.2);
  if (atL) c.quadraticCurveTo(xa, th(xa) + 1, xa, th(xa) - r * 0.5);
  c.closePath();
}

/* rims (bright landing edge) */
const rimFlat = (c, w, h, xa, xb, K, inset = 3) => {
  const a = xa + (xa <= 0 ? inset : 0), b = xb - (xb >= w ? inset : 0);
  c.fillStyle = rgba(K.rim, 0.97); c.fillRect(a, 0.7, b - a, K.dark ? 2.5 : 1.9);
  c.fillStyle = rgba(K.rim, K.dark ? 0.5 : 0.26); c.fillRect(a, K.dark ? 3.2 : 2.5, b - a, 1.5);
};
function rimCurve(c, w, h, xa, xb, K) {
  c.beginPath(); c.moveTo(Math.max(xa, 7), 1.9); c.lineTo(Math.min(xb, w - 7), 1.9);
  c.strokeStyle = rgba(K.rim, 0.95); c.lineWidth = 1.9; c.lineCap = 'round'; c.stroke();
}

/* specs. `behind`/`front` receive (ctx, cache, s, K, p, w, h, xa, xb, id, t) in platform-local space. */
const LEDGES = {
  plank: {
    path: slabPath(edgeFlat, 3), tile: tilePlank, rim: rimFlat,
    behind(ctx, cache, s, K, p, w, h, xa, xb) {
      const a = Math.max(xa, 9), b = Math.min(xb, w - 9); if (b <= a) return;
      rr(ctx, a, h - 4, b - a, 9, 3);
      ctx.fillStyle = vgrad(ctx, s, 'beam|' + K.skin + K.c, h - 4, h + 5, [0, K.cd, 1, K.cdd]); ctx.fill(); ctx.strokeStyle = K.out; ctx.lineWidth = 1.8; ctx.stroke();
    },
    front(ctx, cache, s, K, p, w, h, xa, xb) {
      for (const bx of [9, w - 9]) if (bx > xa - 6 && bx < xb + 6) { ctx.fillStyle = 'rgba(40,30,44,0.8)'; ctx.beginPath(); ctx.arc(bx, h + 0.5, 1.5, 0, TAU); ctx.fill(); }
    },
  },
  log: {
    path: pathLog, tile: tileLog,
    rim(c, w, h, xa, xb, K) { const a = Math.max(xa, h * 0.55), b = Math.min(xb, w - h * 0.55); if (b <= a) return; c.fillStyle = rgba(K.rim, 0.85); c.fillRect(a, 1.1, b - a, 2); c.fillStyle = rgba(K.rim, 0.22); c.fillRect(a, 3.1, b - a, 1.4); },
    front(ctx, cache, s, K, p, w, h, xa, xb) {
      const ring = (cx, dark) => {
        ctx.beginPath(); ctx.ellipse(cx, h / 2, 3.4, h / 2 - 1.3, 0, 0, TAU); ctx.fillStyle = dark ? shade(K.wood, 0.25) : K.wood; ctx.fill(); ctx.strokeStyle = K.out; ctx.lineWidth = 1.3; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx, h / 2, 1.5, h / 2 - 4.6, 0, 0, TAU); ctx.strokeStyle = rgba(K.cdd, 0.6); ctx.lineWidth = 0.9; ctx.stroke();
      };
      if (xa <= 0) ring(4.2, false);
      if (xb >= w) ring(w - 4.2, true);
      // a tuft of moss on top
      for (let i = 0; i < 2; i++) { const mx = w * (0.25 + 0.45 * i) + (unit(p.id, i, 61) - 0.5) * 16; if (mx < xa - 8 || mx > xb + 8 || mx < 14 || mx > w - 14) continue; ctx.beginPath(); ctx.ellipse(mx, 0, 7, 2.8, 0, Math.PI, 0); ctx.fillStyle = K.moss; ctx.fill(); ctx.strokeStyle = outline(K.mossDk, 0.6); ctx.lineWidth = 1.2; ctx.stroke(); }
    },
  },
  leaf: {
    path: pathLeaf, tile: tileLeaf, rim: rimCurve,
    behind(ctx, cache, s, K, p, w, h) {
      const cx = w * 0.5 + (unit(p.id, 2) - 0.5) * w * 0.3;               // a curly stem under the leaf
      ctx.beginPath(); ctx.moveTo(cx, h + 0.5); ctx.bezierCurveTo(cx + 3, h + 6, cx - 6, h + 8, cx - 3, h + 13); ctx.strokeStyle = K.out; ctx.lineWidth = 3.4; ctx.lineCap = 'round'; ctx.stroke();
      ctx.strokeStyle = K.cd; ctx.lineWidth = 1.6; ctx.stroke();
    },
    front(ctx, cache, s, K, p, w, h) {
      ctx.beginPath(); ctx.moveTo(8, h * 0.42); ctx.quadraticCurveTo(w / 2, h * 0.34, w - 8, h * 0.42);       // midrib
      ctx.strokeStyle = rgba(K.vein, 0.85); ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(10, h * 0.5); ctx.quadraticCurveTo(w / 2, h * 0.42, w - 10, h * 0.5); ctx.strokeStyle = rgba(K.cdd, 0.4); ctx.lineWidth = 1; ctx.stroke();
    },
  },
  branch: {
    path: pathBranch, tile: tileBranch, rim: rimFlat,
    behind(ctx, cache, s, K, p, w, h) {
      ctx.lineCap = 'round';
      for (let i = 0; i < 2; i++) {                                   // two twigs hanging under, with a leaf each
        const x = w * (0.28 + i * 0.4) + (unit(p.id, i, 4) - 0.5) * 12;
        ctx.beginPath(); ctx.moveTo(x, h - 2); ctx.quadraticCurveTo(x + 3, h + 6, x + 8, h + 9); ctx.strokeStyle = K.out; ctx.lineWidth = 3; ctx.stroke(); ctx.strokeStyle = K.c; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(x + 11, h + 9.5, 4.2, 2.3, 0.4, 0, TAU); ctx.fillStyle = K.leaf; ctx.fill(); ctx.strokeStyle = K.leafDk; ctx.lineWidth = 1; ctx.stroke();
      }
    },
    front(ctx, cache, s, K, p, w, h, xa, xb) {
      for (const [fx, tall] of [[0.1, 1], [0.34, 0], [0.62, 0], [0.9, 1]]) {
        const x = w * fx + (unit(p.id, (fx * 100) | 0, 3) - 0.5) * 10; if (x < xa - 8 || x > xb + 8) continue;
        const bl = tall ? 5.5 : 4;
        ctx.beginPath(); ctx.ellipse(x, -0.5, bl, 2.4, tall ? -0.5 : 0.4, 0, TAU); ctx.fillStyle = K.leaf; ctx.fill(); ctx.strokeStyle = K.leafDk; ctx.lineWidth = 1; ctx.stroke();
        if (tall) { ctx.fillStyle = K.blossom; ctx.beginPath(); ctx.arc(x + 4, -3.5, 2.4, 0, TAU); ctx.fill(); ctx.strokeStyle = outline(K.blossom, 0.55); ctx.stroke(); ctx.fillStyle = '#ffe48a'; ctx.beginPath(); ctx.arc(x + 4, -3.5, 0.9, 0, TAU); ctx.fill(); }
      }
    },
  },
  stone: {
    path: slabPath(edgeTeeth(15, 0.5, 3.8, false), 3), tile: tileStoneLedge,
    rim(c, w, h, xa, xb, K) { c.fillStyle = K.cap; c.fillRect(xa, 0, xb - xa, 4.2); rimFlat(c, w, h, xa, xb, K); c.fillStyle = rgba(K.cdd, 0.5); c.fillRect(xa, 4.2, xb - xa, 1); },
  },
  ice: { path: slabPath(edgeTeeth(13, 3, 11, false), 5), tile: tileIceLedge, rim: rimFlat },
  crystal: {
    path: slabPath(edgeTeeth(15, 4, 12, false), 4), tile: tileCrystalLedge, rim: rimFlat,
    front(ctx, cache, s, K, p, w, h, xa, xb, id) {
      // a couple of small crystals sprouting from the top at the ends (cached sprites: no gradients per frame)
      [[9, 8], [w - 11, 6.5]].forEach(([x, hh], i) => {
        if (x < xa - 6 || x > xb + 6) return;
        const sp = cache.get('terr|' + id + '|tip' + i, 14, 16, 7, 15, (c) => shard(c, 0, 0, 5.5, hh, 0.5, mix(K.light, '#6ad0e0', 0.2), '#e6fffb', outline(K.light, 0.7)));
        cache.stamp(ctx, sp, x, 0.5);
      });
    },
  },
  brick: {
    path: slabPath(edgeArches(36, 5.5), 2), tile: tileBrickLedge,
    rim(c, w, h, xa, xb, K) { c.fillStyle = K.cap; c.fillRect(xa, 0, xb - xa, 4.4); rimFlat(c, w, h, xa, xb, K); c.fillStyle = rgba(K.cdd, 0.55); c.fillRect(xa, 4.4, xb - xa, 1.1); c.fillStyle = rgba(K.cdd, 0.5); for (let x = Math.ceil(xa / 28) * 28; x < xb; x += 28) c.fillRect(x, 0, 1.2, 4.4); },
  },
  cloud: {
    path: slabPath(edgeScallop(8), 6), tile: tileCloudLedge, rim: rimFlat,
    front(ctx, cache, s, K, p, w, h, xa, xb) {
      for (let x = Math.max(14, Math.ceil(xa / 36) * 36 - 8); x < Math.min(w - 12, xb); x += 36) {
        if (unit(p.id, x | 0, 8) > 0.55) continue;
        ctx.beginPath(); ctx.arc(x, -0.5, 4.2 + unit(p.id, x | 0, 9) * 2, Math.PI, 0); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = K.out; ctx.lineWidth = 1.1; ctx.stroke();
      }
    },
  },
};

/** Soft elliptical drop shadow under a slab and soft glow above it (dark landscapes): cached stretched sprites, never rectangles. */
function softShadow(ctx, cache, ch, K, w, h) {
  const sp = cache.get('terr|' + ch.id + '|shd' + (K.dark ? 'd' : 'l'), 64, 20, 32, 2, (c) => {
    c.save(); c.scale(1, 0.3); c.beginPath(); c.arc(0, 0, 31, 0, TAU);
    c.fillStyle = radial(c, 0, 0, 1, 31, [0, K.dark ? 'rgba(0,0,12,0.46)' : 'rgba(30,14,60,0.32)', 0.6, K.dark ? 'rgba(0,0,12,0.2)' : 'rgba(30,14,60,0.14)', 1, 'rgba(30,14,60,0)']); c.fill(); c.restore();
  });
  cache.stamp(ctx, sp, w / 2, h + 2, (w + 10) / 62, 1);
}
function softGlow(ctx, cache, ch, K, w) {
  const col = K.rim;
  const sp = cache.get('terr|' + ch.id + '|glw', 64, 34, 32, 34, (c) => {
    c.save(); c.scale(1, 0.55); c.beginPath(); c.arc(0, 0, 31, Math.PI, TAU);
    c.fillStyle = radial(c, 0, 0, 1, 31, [0, rgba(col, 0.66), 0.5, rgba(col, 0.28), 1, rgba(col, 0)]); c.fill(); c.restore();
  });
  cache.stamp(ctx, sp, w / 2, 3, (w + 44) / 62, 1);
}

const ledgeTile = (s, id, spec, K) => tileOf(s, id + '|t', LP, LH, (c, P, H) => spec.tile(c, P, H, K, rng(strSeed(id))));

/** Draw one thin slab (ledge-like): used directly for ledges and as the deck of lifts and movers. */
function drawSlab(ctx, cache, s, skin, p, ch, x, y, t) {
  const ice = !!p.ice;
  const spec = LEDGES[skin] || LEDGES.plank;
  const K = ledgeKit(ch, skin, ice);
  const w = p.w, h = p.h || REF_H;
  const id = ch.id + '|l|' + skin + (ice ? 'i' : '');
  const f = localFrame(ctx, x, y);
  const xa = Math.max(0, f.vx0), xb = Math.min(w, f.vx1);
  if (xb <= xa) return;
  const tile = ledgeTile(s, id, spec, K);
  ctx.save(); ctx.translate(f.x, f.y); ctx.imageSmoothingEnabled = true;
  if (K.dark) softGlow(ctx, cache, ch, K, w);
  softShadow(ctx, cache, ch, K, w, h);                 // lifts the slab off any background
  if (spec.behind) spec.behind(ctx, cache, s, K, p, w, h, xa, xb, id, t);
  ctx.save();
  spec.path(ctx, xa, xb, w, h, p.id); ctx.clip();
  ctx.fillStyle = vgrad(ctx, s, id + '|body', 0, REF_H, [0, K.cl, 0.28, K.c, 0.8, K.cd, 1, K.cb]);
  ctx.fillRect(xa - 8, -8, xb - xa + 16, h + 30);
  fillTile(ctx, tile, xa, xb, hash(p.id, 6) % LP);
  spec.rim(ctx, w, h, xa, xb, K);
  if (ice) drawSheen(ctx, cache, s, K, id, xa, xb, w, p.id, t);
  if (xa <= 0) { ctx.fillStyle = hgrad(ctx, s, id + '|el', 0, 8, [0, 'rgba(255,244,210,0.28)', 1, 'rgba(255,244,210,0)']); ctx.fillRect(0, 0, 8, h + 14); }
  if (xb >= w) { ctx.save(); ctx.translate(w, 0); ctx.fillStyle = hgrad(ctx, s, id + '|er', -10, 0, [0, 'rgba(24,10,48,0)', 1, 'rgba(24,10,48,0.34)']); ctx.fillRect(-10, 0, 10, h + 14); ctx.restore(); }
  ctx.restore();
  spec.path(ctx, xa, xb, w, h, p.id);
  // QA-VISUAL: in the dark landscapes the slab's dark own-hue outline is the same value as the cave behind it (2.9:1 in Lantern Caverns), so a
  // pale key-line sits just outside it: the dark outline stays, and the edge is now light-on-dark as well (edge contrast >= 3.7:1).
  if (K.dark) { ctx.strokeStyle = rgba(K.rim, 0.45); ctx.lineWidth = 4.6; ctx.lineJoin = 'round'; ctx.stroke(); }
  ctx.strokeStyle = K.out; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
  if (K.dark) { ctx.beginPath(); ctx.moveTo(xa + (xa <= 0 ? 4 : 0), -0.4); ctx.lineTo(xb - (xb >= w ? 4 : 0), -0.4); ctx.strokeStyle = rgba(K.rim, 0.55); ctx.lineWidth = 1; ctx.stroke(); }
  if (spec.front) spec.front(ctx, cache, s, K, p, w, h, xa, xb, id, t);
  ctx.restore();
}

/* ═════════════════════════ CRUMBLING LEDGES ═════════════════════════
 * ART-2: unmistakable by SHAPE and MARKING, never just a colour. A crumbling ledge is a dusty, pale slab with
 *   - zig-zag FRACTURES running right through it (dark crack + lit lip),
 *   - CHIPPED corners and a notch bitten out of the top edge,
 *   - a DASHED lower edge: the underside is a string of separate rounded lumps with slits between them,
 *   - a few crumbs already hanging below.
 * rumble: it shakes, the cracks widen and glow amber, dust drifts down.
 * fall: it splits along its own cracks into tumbling pieces that fade; for the last ~0.8 s before it re-forms a faint
 * dashed ghost marks the spot (so the player can see where it will be). */

const crumbleKit = (ch, ice) => {
  const base = (ch.skin && ch.skin.ledge) || 'plank';
  const key = ch.id + '|c|' + (ice ? 'ice' : base);
  let K = KITS.get(key);
  if (K) return K;
  const L = ledgeKit(ch, ice ? 'ice' : base, ice);
  const dust = ice ? '#d5eef8' : '#d9c7a6';
  const c = mix(L.c, dust, ice ? 0.4 : 0.55);
  K = { dark: L.dark, c, cl: lit(c, 0.5), cd: shade(c, 0.26), cdd: shade(c, 0.55), cb: bounce(shade(c, 0.12), 0.3), out: outline(c, 0.74), rim: L.rim, accent: ice ? '#9fe4ff' : '#ffb347', light: L.light };
  KITS.set(key, K);
  return K;
};

const crumbleCount = (w) => Math.max(2, Math.round(w / 38));
/** The i-th fracture (1..n-1) as a zig-zag polyline from above the slab to below it (shared by drawing and by the fall split). */
function crack(id, i, n, w, h, out) {
  const bx = w * i / n + (unit(id, i, 31) - 0.5) * (w / n) * 0.5, slant = (unit(id, i, 32) - 0.5) * 8;
  for (let k = 0; k < 5; k++) {
    const v = k / 4;
    out[k * 2] = bx + slant * (v - 0.5) + (k === 0 || k === 4 ? 0 : (unit(id, i * 7 + k, 33) - 0.5) * 5.5);
    out[k * 2 + 1] = -7 + v * (h + 16);
  }
  return out;
}
const _ca = new Array(10), _cb = new Array(10);

/** Silhouette of the whole slab: chipped corners, a bite out of the top, lumpy "dashed" underside. */
function crumblePath(c, w, h, id) {
  const r = 5, notch = w * (0.3 + 0.4 * unit(id, 1, 61));
  c.beginPath(); c.moveTo(0, r + 1);
  c.lineTo(r - 1, 0); c.lineTo(notch - 4, 0); c.lineTo(notch - 1.4, 3.4); c.lineTo(notch + 1.6, 2.4); c.lineTo(notch + 4.6, 0); c.lineTo(w - r, 0);
  c.lineTo(w, r + 0.5);
  const n = Math.max(2, Math.round(w / 14)), lw = w / n;
  c.lineTo(w, h * 0.62);
  for (let j = n - 1; j >= 0; j--) {
    const xr = (j + 1) * lw, xl = j * lw, d = 0.5 + unit(id, j, 71) * 3.4;
    c.quadraticCurveTo(xr - 0.4, h + d, xr - 4.2, h + d);
    c.lineTo(xl + 4.2, h + d);
    c.quadraticCurveTo(xl + 0.4, h + d, xl + 0.4, h * 0.62);
    if (j) c.lineTo(xl - 0.4, h * 0.62);                          // the slit between two lumps
  }
  c.closePath();
}

function crumbleTile(s, K, id) {
  return tileOf(s, id + '|ct', 48, 22, (c, P, H) => {
    const R = rng(strSeed(id));
    c.lineCap = 'round';
    for (const [y, a] of [[7, 0.3], [12.5, 0.26]]) { c.setLineDash([7, 4, 3, 5]); c.beginPath(); c.moveTo(-4, y); c.lineTo(P + 4, y + 0.8); c.strokeStyle = rgba(K.cdd, a); c.lineWidth = 1.2; c.stroke(); }
    c.setLineDash([]);
    for (let i = 0; i < 22; i++) { c.fillStyle = i % 3 ? rgba(K.cdd, 0.4) : rgba(K.cl, 0.55); c.fillRect(R.range(0, P), R.range(4, 17), R.range(0.8, 2), R.range(0.8, 1.6)); }
    for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(R.range(2, P - 2), R.range(6, 15), R.range(1, 1.8), 0, TAU); c.fillStyle = rgba(K.cdd, 0.35); c.fill(); }
  });
}

/** The whole slab body, drawn at the current origin (platform-local). Pieces re-use it under a clip. */
function crumbleSlab(ctx, s, K, id, p, w, h, tile, prog) {
  crumblePath(ctx, w, h, p.id);
  ctx.fillStyle = vgrad(ctx, s, id + '|body', 0, REF_H, [0, K.cl, 0.3, K.c, 0.78, K.cd, 1, K.cb]); ctx.fill();
  ctx.save(); ctx.clip();
  fillTile(ctx, tile, 0, w, hash(p.id, 8) % 48);
  ctx.fillStyle = rgba(K.rim, 0.95); ctx.fillRect(2, 0.8, w - 4, 1.9);
  ctx.fillStyle = rgba(K.rim, K.dark ? 0.4 : 0.24); ctx.fillRect(2, 2.7, w - 4, 1.3);
  ctx.restore();
  crumblePath(ctx, w, h, p.id);
  if (K.dark) { ctx.strokeStyle = rgba(K.rim, 0.45); ctx.lineWidth = 4.5; ctx.lineJoin = 'round'; ctx.stroke(); }          // pale key-line (see drawSlab)
  ctx.strokeStyle = K.out; ctx.lineWidth = 2.1; ctx.lineJoin = 'round'; ctx.stroke();
}

function drawCrumble(ctx, cache, s, p, ch, x, y, t) {
  const base = (ch.skin && ch.skin.ledge) || 'plank', ice = !!p.ice || base === 'ice';
  const K = crumbleKit(ch, ice), id = ch.id + '|c|' + (ice ? 'ice' : base);
  const w = p.w, h = p.h || REF_H;
  const fr = localFrame(ctx, x, y);
  const f = { x: fr.x, y: fr.y, vx0: fr.vx0, vx1: fr.vx1 };                 // copy: the ghost below calls localFrame() again
  if (f.vx1 < -8 || f.vx0 > w + 8) return;
  const state = p.state || 'idle', st = p.st || 0, fall = state === 'fall';
  const prog = state === 'rumble' ? clamp01(st / T.crumbleDelay) : 0;
  const n = crumbleCount(w), tile = crumbleTile(s, K, id);
  ctx.save(); ctx.imageSmoothingEnabled = true;
  if (fall) {
    const g = clamp01((st - (T.crumbleRespawn - 0.8)) / 0.8);                 // ghost of where it will re-form
    if (g > 0) {
      const gf = localFrame(ctx, x, p.y); ctx.save(); ctx.translate(gf.x, gf.y);
      rr(ctx, 0, 0, w, h, 3); ctx.fillStyle = rgba(K.rim, 0.1 + 0.18 * g * (0.55 + 0.45 * Math.sin(t * 14))); ctx.fill();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = rgba(K.rim, 0.4 + 0.5 * g); ctx.lineWidth = 1.7; ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
    }
    const fade = 1 - smooth01((st - 0.3) / 0.55);
    if (fade <= 0) { ctx.restore(); return; }
    ctx.globalAlpha = fade;
    ctx.translate(f.x, f.y);
    for (let i = 0; i < n; i++) {                                              // tumbling pieces cut along the cracks
      const a = i ? crack(p.id, i, n, w, h, _ca) : null, b = i < n - 1 ? crack(p.id, i + 1, n, w, h, _cb) : null;
      const r = unit(p.id, i, 51) - 0.5, cx = w * (i + 0.5) / n;
      ctx.save();
      ctx.translate(cx + r * 80 * st, h / 2 + r * 40 * st + st * st * 120 * (0.4 + 0.6 * unit(p.id, i, 53)));
      ctx.rotate(r * 5 * st); ctx.translate(-cx, -h / 2);
      ctx.beginPath();
      if (a) { ctx.moveTo(a[0], a[1]); for (let k = 1; k < 5; k++) ctx.lineTo(a[k * 2], a[k * 2 + 1]); } else { ctx.moveTo(-8, -8); ctx.lineTo(-8, h + 10); }
      if (b) { for (let k = 4; k >= 0; k--) ctx.lineTo(b[k * 2], b[k * 2 + 1]); } else { ctx.lineTo(w + 8, h + 10); ctx.lineTo(w + 8, -8); }
      ctx.closePath();
      ctx.save(); ctx.clip();
      crumbleSlab(ctx, s, K, id, p, w, h, tile, 0);
      ctx.restore();
      ctx.strokeStyle = K.out; ctx.lineWidth = 2; ctx.lineJoin = 'round';                    // cut faces
      for (const q of [a, b]) if (q) { ctx.beginPath(); ctx.moveTo(q[0], q[1]); for (let k = 1; k < 5; k++) ctx.lineTo(q[k * 2], q[k * 2 + 1]); ctx.stroke(); }
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  const amp = prog ? 0.5 + 1.5 * prog : 0;
  ctx.translate(f.x + (amp ? Math.sin(st * 95) * amp : 0), f.y + (amp ? Math.sin(st * 71 + 1) * amp * 0.55 : 0));
  if (K.dark) softGlow(ctx, cache, ch, K, w);
  softShadow(ctx, cache, ch, K, w, h);
  // crumbs already hanging below
  ctx.strokeStyle = K.out; ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const k = (st * 40 + i * 9) % 16;
    const px = w * (0.18 + 0.3 * i) + (unit(p.id, i, 41) - 0.5) * 14, py = h + 8 + unit(p.id, i, 43) * 6 + (prog ? k : 0);
    ctx.globalAlpha = prog ? 1 - k / 18 : 0.9; ctx.fillStyle = K.cd;
    ctx.beginPath(); ctx.ellipse(px, py, 2.1, 1.7, 0.4, 0, TAU); ctx.fill(); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  crumbleSlab(ctx, s, K, id, p, w, h, tile, prog);
  // fractures (widen and glow while rumbling)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.save(); crumblePath(ctx, w, h, p.id); ctx.clip();
  for (let i = 1; i < n; i++) {
    const q = crack(p.id, i, n, w, h, _ca);
    const line = () => { ctx.beginPath(); ctx.moveTo(q[0], q[1]); for (let k = 1; k < 5; k++) ctx.lineTo(q[k * 2], q[k * 2 + 1]); };
    line(); ctx.strokeStyle = rgba(K.cdd, 0.95); ctx.lineWidth = 1.7 + 1.9 * prog; ctx.stroke();
    ctx.save(); ctx.translate(1.5, 0.5); line(); ctx.strokeStyle = rgba(K.cl, 0.6); ctx.lineWidth = 0.9; ctx.stroke(); ctx.restore();
    if (prog > 0) { line(); ctx.strokeStyle = rgba(K.accent, 0.5 + 0.4 * prog); ctx.lineWidth = 0.9 + 0.7 * prog; ctx.stroke(); }
  }
  ctx.restore();
  if (prog > 0) {
    ctx.fillStyle = 'rgba(235,220,190,0.8)';
    for (let i = 0; i < 6; i++) { const k = (st * 55 + i * 13) % 22; ctx.globalAlpha = 0.8 * (1 - k / 22); ctx.beginPath(); ctx.arc(w * (0.1 + 0.16 * i), h + 3 + k, 1.2 + (i % 2) * 0.6, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/* ═════════════════════════ LIFTS (cables + pulleys) and MOVERS (cart on a rail) ═════════════════════════ */

const deckSkin = (ch, ice) => {
  if (ice) return 'ice';
  const l = (ch.skin && ch.skin.ledge) || 'plank';
  return l === 'leaf' || l === 'log' || l === 'branch' ? 'plank' : l;
};
const STEEL = { c: '#9fb0c8', cl: '#e6eef8', cd: '#6b7c9c', out: '#34415f' };

function drawLift(ctx, cache, s, p, ch, x, y, t) {
  const skin = deckSkin(ch, !!p.ice), w = p.w;
  const amp = p.motion ? p.motion.amp : 0;
  const rest = p.y, top = rest - amp - 52;                       // pulleys hang above the highest the deck ever gets
  const f = localFrame(ctx, x, y);
  if (f.vx1 < -10 || f.vx0 > w + 10) return;
  const id = ch.id + '|lift';
  const L = y - top;                                              // from the pulley beam down to the deck top
  ctx.save(); ctx.translate(f.x, f.y); ctx.imageSmoothingEnabled = true;
  // gantry: beam, two pulleys (turn with the deck), ropes fading up into the sky
  ctx.save(); ctx.translate(0, -L);
  for (const px of [11, w - 11]) {
    ctx.fillStyle = vgrad(ctx, s, id + '|rope', -46, 0, [0, 'rgba(60,40,30,0)', 1, 'rgba(60,40,30,0.9)']);
    ctx.fillRect(px - 1.1, -46, 2.2, 46);
  }
  steelBar(ctx, s, id, 2, -9, w - 4, 8);
  for (const px of [11, w - 11]) {
    ctx.beginPath(); ctx.arc(px, 6, 7.2, 0, TAU); ctx.fillStyle = vgrad(ctx, s, id + '|wheel', -2, 14, [0, STEEL.cl, 0.5, STEEL.c, 1, STEEL.cd]); ctx.fill(); ctx.strokeStyle = STEEL.out; ctx.lineWidth = 2; ctx.stroke();
    const a = y / 7; ctx.strokeStyle = STEEL.out; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let k = 0; k < 3; k++) { ctx.moveTo(px - Math.cos(a + k * 1.047) * 6, 6 - Math.sin(a + k * 1.047) * 6); ctx.lineTo(px + Math.cos(a + k * 1.047) * 6, 6 + Math.sin(a + k * 1.047) * 6); }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(px, 6, 1.8, 0, TAU); ctx.fillStyle = STEEL.out; ctx.fill();
  }
  ctx.restore();
  for (const cx of [11, w - 11]) { ctx.fillStyle = 'rgba(52,34,26,0.95)'; ctx.fillRect(cx - 1.7, -L + 6, 3.4, L - 6); ctx.fillStyle = 'rgba(214,176,120,0.95)'; ctx.fillRect(cx - 0.7, -L + 6, 1.4, L - 6); }
  ctx.restore();
  drawSlab(ctx, cache, s, skin, p, ch, x, y, t);
  ctx.save(); ctx.translate(f.x, f.y);                           // iron brackets where the cables are fixed
  for (const cx of [11, w - 11]) { rr(ctx, cx - 5, -4, 10, 10, 2.5); ctx.fillStyle = vgrad(ctx, s, id + '|brk', -4, 6, [0, STEEL.cl, 1, STEEL.cd]); ctx.fill(); ctx.strokeStyle = STEEL.out; ctx.lineWidth = 1.6; ctx.stroke(); ctx.beginPath(); ctx.arc(cx, 1, 1.1, 0, TAU); ctx.fillStyle = STEEL.out; ctx.fill(); }
  ctx.restore();
}
// QA-VISUAL: the pulley beam hangs ~50 u above the highest the deck gets, right where the generator puts egg trails, and its bright rim-lit top
// read as a second platform (the golden egg sat "on" it). It is now a thin DARK iron bar with no light edge: every landing surface in the game
// has a bright rim, so this one must not.
function steelBar(ctx, s, id, x, y, w, h) {
  rr(ctx, x, y + 1, w, h - 2, 2); ctx.fillStyle = vgrad(ctx, s, id + '|beam2', y + 1, y + h - 1, [0, '#66728f', 1, '#3b4560']); ctx.fill(); ctx.strokeStyle = 'rgba(40,46,70,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
}

function drawMover(ctx, cache, s, p, ch, x, y, t) {
  const skin = deckSkin(ch, !!p.ice), w = p.w, h = p.h || REF_H;
  const amp = p.motion ? p.motion.amp : 0, bx = p.x;
  const f = localFrame(ctx, x, y);
  const shift = bx - x;                                           // rail is fixed in the world: shift into its own frame
  const ra = Math.max(-amp - 14, f.vx0 - shift - 14), rb = Math.min(w + amp + 14, f.vx1 - shift + 14);
  if (f.vx1 + x < bx - amp - 30 || f.vx0 + x > bx + w + amp + 30) return;
  const id = ch.id + '|mover';
  ctx.save(); ctx.translate(f.x, f.y); ctx.imageSmoothingEnabled = true;
  ctx.save(); ctx.translate(shift, h + 9);
  ctx.fillStyle = 'rgba(40,30,50,0.7)';
  for (let sx = Math.ceil(ra / 14) * 14; sx < rb; sx += 14) ctx.fillRect(sx - 1.2, 1.5, 2.4, 4.5);
  if (rb > ra) { ctx.fillStyle = vgrad(ctx, s, id + '|rail', -2, 3, [0, STEEL.cl, 1, STEEL.cd]); ctx.fillRect(ra, -1.8, rb - ra, 3.6); ctx.strokeStyle = STEEL.out; ctx.lineWidth = 1.2; ctx.strokeRect(ra, -1.8, rb - ra, 3.6); }
  for (const ex of [-amp - 14, w + amp + 14]) { if (ex < ra - 6 || ex > rb + 6) continue; rr(ctx, ex - 2.5, -6, 5, 12, 2); ctx.fillStyle = '#e0524a'; ctx.fill(); ctx.strokeStyle = '#6a1c24'; ctx.lineWidth = 1.2; ctx.stroke(); }
  ctx.restore();
  for (const wx of [16, w - 16]) {                                 // wheels turn with the cart
    ctx.beginPath(); ctx.arc(wx, h + 6.5, 5, 0, TAU); ctx.fillStyle = vgrad(ctx, s, id + '|wh', h + 1.5, h + 11.5, [0, STEEL.cl, 1, STEEL.cd]); ctx.fill(); ctx.strokeStyle = STEEL.out; ctx.lineWidth = 1.6; ctx.stroke();
    const a = x / 5; ctx.beginPath(); ctx.moveTo(wx + Math.cos(a) * 3.8, h + 6.5 + Math.sin(a) * 3.8); ctx.lineTo(wx - Math.cos(a) * 3.8, h + 6.5 - Math.sin(a) * 3.8); ctx.strokeStyle = STEEL.out; ctx.lineWidth = 1.1; ctx.stroke();
  }
  ctx.restore();
  drawSlab(ctx, cache, s, skin, p, ch, x, y, t);
  ctx.save(); ctx.translate(f.x + w / 2, f.y + h * 0.54);         // direction chevrons on the front of the deck
  for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(d * 4, -5.2); ctx.lineTo(d * 12, 0); ctx.lineTo(d * 4, 5.2); ctx.lineTo(d * 6.4, 0); ctx.closePath(); ctx.fillStyle = '#ffe9a6'; ctx.fill(); ctx.strokeStyle = outline('#9a6a20', 0.5); ctx.lineWidth = 1.1; ctx.lineJoin = 'round'; ctx.stroke(); }
  ctx.restore();
}

/* ═════════════════════════ SPIKES (4 skins, plain or cycling) ═════════════════════════
 * A hazard is a row of modules (one thorn / rock spike / crystal / urchin each, ~14-19 u wide) standing on the ground at
 * h.y. Plain spikes are always up. Cycling spikes (h.cycle) sit on a slotted plate: while inactive they are sunk
 * out of sight (the slots glint), during the warning they poke up and twitch, then they snap fully up while active.
 * Spikes are drawn clearly bigger than their hitbox (about 1.4x taller, and much wider than the 7-8 u hurt width) and in the "danger" hues (red thorns, pale-tipped rock, hot crystal,
 * orange-tipped urchin), so they read against every ground. */

const SPIKE_MOD = { thorn: 14, stone: 16, crystal: 15, urchin: 19 };
// QA-VISUAL: the hitbox is now only 7-8 u wide (the level generator made spikes narrower so the takeoff window is >= 0.4 s), but a 19 u cone is a speck on a phone and the first thing a child must read in a busy painting. The art is
// drawn SPIKE_K times bigger than the module was authored (baked at that size, so it stays crisp), with a pale key-line around it so it pops
// off dark paintings as well as bright ones, and a soft hot halo on the ground (see drawSpikes). Mama's hurtbox is far narrower than her art
// (|dx| < 20 u hurts, her art overlaps the spike from ~29 u) so the bigger art only ever errs on the forgiving side.
const SPIKE_K = 1.42;
const SPIKE_KEY_R = 1.15;           // key-line width (u)
const SPIKE_HALO = { thorn: '#ff4a58', stone: '#ff7e3a', crystal: null, urchin: '#ffa23a' };

function spikeColors(ch, skin) {
  const P = ch.palette;
  switch (skin) {
    case 'thorn': return { body: mix('#b02f4e', P.shadow, 0.12), tip: '#ff7a55', dark: '#3f1129', litc: '#ffb08a', base: mix(P.fringe, '#2e2a36', 0.55) };
    // a deep plum-grey rock with a bone-white tip: darker than the red/orange/pink paintings it stands in front of, and nothing
    // like the warm-brown ground cairns that sit around it
    case 'stone': { const body = mix(shade(P.rock, 0.5), '#3a2c4c', 0.5); return { body, tip: '#fff6dc', dark: outline(body, 0.7), litc: lit(mix(P.rock, '#c9b0d8', 0.4), 0.45), base: shade(P.soil, 0.4) }; }
    case 'crystal': {
      // one danger hue for every crystal landscape (hot pink / magenta), never icy blue or lilac: Frostline's harmless ice shards and
      // the cave's harmless crystal tufts are cool blues, and a child must be able to tell them from the thing that hurts
      const col = ch.dark ? mix(P.accent, '#d03ad8', 0.55) : '#ff8fb8';
      return { body: col, tip: '#ffffff', dark: outline(col, 0.74), litc: lit(col, 0.7), base: shade(P.soil, 0.25), glow: col };
    }
    default: return { body: '#6a3a86', tip: '#ff9a3c', dark: '#2a1238', litc: '#b88ad8', base: '#4a2a60' };    // urchin
  }
}

function drawSpikeModule(c, skin, C, v) {
  const R = rng(777 + v * 31);
  c.lineJoin = 'round'; c.lineCap = 'round';
  if (skin === 'thorn') {
    // little tangle mound + one curved thorn leaning a bit
    oval(c, 0, 0.5, 8.5, 4); c.fillStyle = C.base; c.fill(); c.strokeStyle = C.dark; c.lineWidth = 1.6; c.stroke();
    const lean = (v - 1) * 2.4;
    c.beginPath(); c.moveTo(-6.4, 1); c.bezierCurveTo(-5.4, -8, -1 + lean, -13.5, 3 + lean * 1.6, -19.5); c.bezierCurveTo(4.6 + lean, -12, 6.6, -6, 6.4, 1); c.closePath();
    c.fillStyle = linear(c, 0, 1, 0, -19, [0, C.body, 0.55, mix(C.body, C.tip, 0.5), 1, C.tip]); c.fill(); c.strokeStyle = C.dark; c.lineWidth = 1.9; c.stroke();
    c.beginPath(); c.moveTo(-4.4, -1); c.bezierCurveTo(-4, -7, -1.4 + lean, -12, 1.4 + lean * 1.4, -16); c.strokeStyle = rgba(C.litc, 0.75); c.lineWidth = 1.3; c.stroke();
  } else if (skin === 'stone') {
    const lean = (v - 1) * 2;
    oval(c, 0, 0.8, 8.8, 3.2); c.fillStyle = C.base; c.fill(); c.strokeStyle = C.dark; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.moveTo(-7.6, 1); c.lineTo(-4.2, -9.5); c.lineTo(-1 + lean, -15); c.lineTo(1.4 + lean * 1.5, -19.5); c.lineTo(3.8, -12); c.lineTo(7.6, 1); c.closePath();
    c.fillStyle = linear(c, 0, 1, 0, -19.5, [0, shade(C.body, 0.15), 0.42, C.body, 0.78, mix(C.body, C.tip, 0.5), 1, C.tip]); c.fill(); c.strokeStyle = C.dark; c.lineWidth = 1.9; c.stroke();
    c.beginPath(); c.moveTo(-6.6, 0); c.lineTo(-3.8, -9); c.lineTo(0.4 + lean, -15); c.lineTo(1.4 + lean, -6); c.closePath(); c.fillStyle = rgba(C.litc, 0.4); c.fill();
    c.beginPath(); c.moveTo(-1.5, -12); c.lineTo(2.2, -9.5); c.moveTo(0.5, -5); c.lineTo(4, -3.8); c.strokeStyle = rgba(C.dark, 0.5); c.lineWidth = 1; c.stroke();
  } else if (skin === 'crystal') {
    oval(c, 0, 0.8, 8.2, 3); c.fillStyle = C.base; c.fill(); c.strokeStyle = C.dark; c.lineWidth = 1.4; c.stroke();
    const tilt = (v - 1) * 1.6;
    shard(c, -2.2, 1, 7.5, 13, -1.2 + tilt, C.body, C.litc, C.dark);
    shard(c, 2.4, 1, 8.5, 19.5, 0.9 + tilt, C.body, C.litc, C.dark);
    c.beginPath(); c.moveTo(1.6 + tilt, -18); c.lineTo(3.4 + tilt, -14.6); c.lineTo(5, -17); c.closePath(); c.fillStyle = C.tip; c.fill();
  } else {
    // sea urchin: dark round core, radiating spines with hot tips
    const cy = -9.2, n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + v * 0.2, L = 9.3 + (i % 2) * 1.4, ca = Math.cos(a), sa = Math.sin(a);
      if (cy + sa * L > 2.5) continue;
      c.beginPath(); c.moveTo(ca * 4.5, cy + sa * 4.5); c.lineTo(ca * L, cy + sa * L);
      c.strokeStyle = C.dark; c.lineWidth = 3.1; c.stroke();
      c.strokeStyle = i % 2 ? C.body : C.litc; c.lineWidth = 1.6; c.stroke();
      c.beginPath(); c.arc(ca * (L + 0.2), cy + sa * (L + 0.2), 1.35, 0, TAU); c.fillStyle = C.tip; c.fill(); c.strokeStyle = C.dark; c.lineWidth = 0.8; c.stroke();
    }
    c.beginPath(); c.arc(0, cy, 6.4, 0, TAU); c.fillStyle = radial(c, -2.2, cy - 2.6, 0.6, 8, [0, C.litc, 0.5, C.body, 1, shade(C.body, 0.45)]); c.fill(); c.strokeStyle = C.dark; c.lineWidth = 1.8; c.stroke();
    c.beginPath(); c.ellipse(-2.3, cy - 3, 1.9, 1.1, -0.5, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.7)'; c.fill();
    c.beginPath(); c.arc(1.6, cy + 0.2, 1.7, 0, TAU); c.fillStyle = C.tip; c.fill(); c.strokeStyle = C.dark; c.lineWidth = 0.9; c.stroke();     // a single bright eye-spot
  }
}

/** Draw `draw` into the sprite `c` with a thin pale key-line (the silhouette, dilated) behind it. `c` is the cache.get() context. */
function keyed(c, cache, w, h, ox, oy, draw, col, r) {
  const k = cache.scale, p = cache.pad, W = Math.ceil((w + p * 2) * k), H = Math.ceil((h + p * 2) * k);
  const art = createSurface(W, H), ac = art.getContext('2d');
  ac.scale(k, k); ac.translate(p + ox, p + oy); draw(ac);
  const sil = createSurface(W, H), sc = sil.getContext('2d');
  sc.drawImage(art, 0, 0); sc.globalCompositeOperation = 'source-in'; sc.fillStyle = col; sc.fillRect(0, 0, W, H);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
  const R = r * k;
  for (let i = 0; i < 12; i++) { const a = i * TAU / 12; c.drawImage(sil, Math.cos(a) * R, Math.sin(a) * R); }
  c.drawImage(art, 0, 0);
  c.restore();
}

function spikeSprites(s, cache, ch, skin) {
  const key = ch.id + '|spk2|' + skin;
  let set = s.decor.get(key);
  if (set) return set;
  const C = spikeColors(ch, skin), K = SPIKE_K, w = (SPIKE_MOD[skin] + 8) * K, h = 28 * K, oy = h - 3 * K;
  const keyCol = ch.dark ? 'rgba(255,255,255,0.95)' : 'rgba(255,250,236,0.92)';
  set = [0, 1, 2].map((v) => cache.get('terr|' + key + '|' + v, w, h, w / 2, oy,
    (c) => keyed(c, cache, w, h, w / 2, oy, (cc) => { cc.scale(K, K); drawSpikeModule(cc, skin, C, v); }, keyCol, SPIKE_KEY_R)));
  set.C = C;
  s.decor.set(key, set);
  return set;
}

const PLATE = { top: '#5a4f6c', bot: '#2d2640', slot: '#171220', hot: '#ff6a3c' };

export function drawSpikes(ctx, cache, h, chapter, t = 0, warn) {
  const ch = chapter || CHAPTERS[0];
  const s = storeOf(cache); touch(s, cache, ch);
  const skin = (ch.skin && ch.skin.hazard) || 'thorn';
  const set = spikeSprites(s, cache, ch, skin), C = set.C;
  const w = h.w, hs = ((h.h || SPIKE_H) + 2) / 19;                 // art is a little taller than the hitbox
  const cyc = h.cycle;
  let ext = 1, wig = 0, active = true;
  if (cyc) {
    active = hazardActive(h, t);
    if (warn === undefined) warn = hazardWarn(h, t);
    if (active) {
      ext = 1;
    } else {
      const into = ((((t / cyc.period + (cyc.phase || 0)) % 1) + 1) % 1) * cyc.period;      // seconds since the cycle began
      const since = into - cyc.up;                                                      // seconds since it sank (inactive part)
      const sink = 1 - clamp01(since / 0.14);                                           // quick retract
      ext = Math.max(sink, warn > 0 ? 0.16 + 0.64 * warn * warn : 0);
      wig = warn > 0 ? warn : 0;
    }
  }
  ctx.save();
  ctx.translate(h.x, h.y); ctx.imageSmoothingEnabled = true;
  if (cyc) {                                                          // slotted plate flush with the ground
    const hot = active ? 1 : wig;
    rr(ctx, -1, -0.5, w + 2, 5.5, 2.2); ctx.fillStyle = vgrad(ctx, s, 'plate', -0.5, 5, [0, PLATE.top, 1, PLATE.bot]); ctx.fill(); ctx.strokeStyle = outline(PLATE.bot, 0.5); ctx.lineWidth = 1.5; ctx.stroke();
    const n = Math.max(1, Math.round(w / SPIKE_MOD[skin]));
    for (let i = 0; i < n; i++) { const cx = (i + 0.5) * w / n; ctx.fillStyle = hot > 0 ? rgba(PLATE.hot, 0.5 + 0.5 * hot) : PLATE.slot; ctx.fillRect(cx - 3.4, 1.1, 6.8, 1.9); }
  }
  if (ext > 0.02) {
    // danger halo: a soft hot glow standing on the ground around the spikes (it breathes slowly), so "this one hurts" survives
    // a busy painting. Upper half-ellipse only, so it never stains the soil. Fades with the spikes while a cycling hazard sinks.
    const halo = SPIKE_HALO[skin] || C.glow;
    if (halo) {
      let g = s.grads.get(ch.id + '|spkhalo');
      if (!g) { g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, rgba(halo, 0.5)); g.addColorStop(0.45, rgba(halo, 0.2)); g.addColorStop(1, rgba(halo, 0)); s.grads.set(ch.id + '|spkhalo', g); }
      const breathe = 0.82 + 0.18 * Math.sin(t * 3.2 + (h.id | 0));
      ctx.save();
      ctx.translate(w / 2, 1); ctx.scale(w / 2 + 22, 30);
      ctx.globalAlpha = Math.min(1, ext) * breathe * (ch.dark ? 1 : 0.85);
      ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 1);
      ctx.restore();
    }
    ctx.save();
    if (ext < 1) { ctx.beginPath(); ctx.rect(-14, -56, w + 28, 56.5); ctx.clip(); }         // sinks INTO the ground
    const n = Math.max(1, Math.round(w / SPIKE_MOD[skin])), step = w / n;
    for (let i = 0; i < n; i++) {
      const hh = hash(h.id | 0, i, 91), v = hh % 3, scl = (0.9 + ((hh >>> 4) & 7) / 7 * 0.22) * hs;
      const rot = wig ? Math.sin(t * 40 + i * 1.9) * 0.17 * wig : 0;
      const sink = (1 - ext) * 22 * SPIKE_K * scl;
      cache.stamp(ctx, set[v], (i + 0.5) * step, 0.5 + sink, (hh & 0x100) ? -1 : 1, scl, rot, 1);
    }
    ctx.restore();
  }
  if (C.glow && ext > 0.5) {                                          // crystal glow
    ctx.fillStyle = vgrad(ctx, s, ch.id + '|spkglow', -26, 0, [0, rgba(C.glow, 0), 1, rgba(C.glow, ch.dark ? 0.26 : 0.12)]);
    ctx.fillRect(-4, -26, w + 8, 26);
  }
  ctx.restore();
}

/* ═════════════════════════ SPRINGS (mushroom | coil | cloud) ═════════════════════════
 * Idle: a slow breath. After a bounce (t - s.bounceT < 0.3 s): squashed flat at launch, overshoots tall, settles. */

const SPRING_COLORS = {
  mushroom: (P) => ({ cap: mix('#e5483f', P.accent, 0.12), stem: '#f6ebd2', dot: '#ffffff' }),
  coil: () => ({ pad: '#ffcf3a', coil: '#c6d2e4', base: '#7a86a4' }),
  cloud: () => ({ puff: '#ffffff', shade: '#c9c2ea', spark: '#ffe27a' }),
};

function springSprites(s, cache, ch, skin) {
  const key = ch.id + '|spr|' + skin;
  let set = s.decor.get(key);
  if (set) return set;
  const P = ch.palette, C = SPRING_COLORS[skin](P), k = (n, w, h, ox, oy, fn) => cache.get('terr|' + key + '|' + n, w, h, ox, oy, fn);
  set = { C };
  if (skin === 'mushroom') {
    set.stem = k('stem', 16, 11, 8, 11, (c) => {
      c.beginPath(); c.moveTo(-5.6, 1); c.bezierCurveTo(-4.4, -3, -4.6, -6, -4.2, -9); c.lineTo(4.2, -9); c.bezierCurveTo(4.6, -6, 4.4, -3, 5.6, 1); c.closePath();
      c.fillStyle = linear(c, -6, 0, 6, 0, [0, '#fff9e8', 0.5, C.stem, 1, '#cdb994']); c.fill(); c.strokeStyle = '#7a5a3c'; c.lineWidth = 1.8; c.lineJoin = 'round'; c.stroke();
      c.strokeStyle = 'rgba(122,90,60,0.4)'; c.lineWidth = 1; c.beginPath(); c.moveTo(-1, -2); c.lineTo(-1.2, -7); c.moveTo(2, -2); c.lineTo(2.2, -6.5); c.stroke();
    });
    set.cap = k('cap', 40, 16, 20, 16, (c) => {
      const body = () => { c.beginPath(); c.moveTo(-17.5, -1); c.bezierCurveTo(-19.5, -12, -8.5, -15.5, 0, -15.5); c.bezierCurveTo(8.5, -15.5, 19.5, -12, 17.5, -1); c.quadraticCurveTo(0, 2.2, -17.5, -1); c.closePath(); };
      body(); c.fillStyle = radial(c, -7, -12, 1, 26, [0, lit(C.cap, 0.55), 0.45, C.cap, 1, shade(C.cap, 0.4)]); c.fill();
      c.save(); body(); c.clip(); c.strokeStyle = rgba(bounce(C.cap), 0.8); c.lineWidth = 4; body(); c.stroke(); c.restore();
      body(); c.strokeStyle = outline(C.cap, 0.7); c.lineWidth = 2.2; c.lineJoin = 'round'; c.stroke();
      c.fillStyle = C.dot; c.strokeStyle = 'rgba(120,30,40,0.35)'; c.lineWidth = 0.9;
      for (const [x, y, r] of [[-9.5, -7, 3.3], [2, -11, 2.7], [10.5, -6, 2.9], [-2, -4, 1.8], [-14, -3, 1.6]]) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.stroke(); }
      c.beginPath(); c.ellipse(-11, -10.8, 3.6, 1.4, -0.7, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.55)'; c.fill();
    });
  } else if (skin === 'coil') {
    set.base = k('base', 40, 8, 20, 8, (c) => { rr(c, -18, -4, 36, 5, 2.5); c.fillStyle = linear(c, 0, -6, 0, 1, [0, '#b8c4dc', 1, C.base]); c.fill(); c.strokeStyle = '#2f3a58'; c.lineWidth = 1.7; c.stroke(); c.fillStyle = '#2f3a58'; for (const x of [-13, 13]) { c.beginPath(); c.arc(x, -1.6, 0.9, 0, TAU); c.fill(); } });
    set.coil = k('coil', 30, 14, 15, 13, (c) => {
      c.lineCap = 'round'; c.lineJoin = 'round';
      const zig = () => { c.beginPath(); c.moveTo(-8.5, 0); for (let i = 0; i < 3; i++) { const y0 = -i * 4.2, y1 = -(i + 1) * 4.2; c.lineTo(8.5, y0 - 2.1); c.lineTo(-8.5, y1); } c.lineTo(0, -12.6); };
      zig(); c.strokeStyle = '#2f3a58'; c.lineWidth = 5; c.stroke();
      zig(); c.strokeStyle = C.coil; c.lineWidth = 2.9; c.stroke();
      zig(); c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1; c.save(); c.translate(-0.4, -0.7); c.stroke(); c.restore();
    });
    set.pad = k('pad', 42, 11, 21, 10, (c) => {
      rr(c, -19, -8, 38, 8, 4); c.fillStyle = linear(c, 0, -8, 0, 0, [0, '#fff0a0', 0.4, C.pad, 1, '#e08a14']); c.fill(); c.strokeStyle = '#8a4a08'; c.lineWidth = 2; c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.7)'; c.fillRect(-14, -6.4, 14, 1.4);
      c.fillStyle = '#8a4a08'; c.beginPath(); c.moveTo(0, -6.2); c.lineTo(4.4, -2.6); c.lineTo(-4.4, -2.6); c.closePath(); c.fill();         // up arrow
    });
  } else {
    set.puff = k('puff', 42, 22, 21, 20, (c) => {
      const bumps = [[-11, -6, 6.5], [-4, -10.5, 7.8], [5, -10, 7.4], [12, -5.5, 5.8], [0, -5.5, 7.6]];
      for (const [x, y, r] of bumps) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fillStyle = C.shade; c.fill(); c.strokeStyle = '#6c6a9a'; c.lineWidth = 2; c.stroke(); }
      for (const [x, y, r] of bumps) { c.beginPath(); c.arc(x - 0.8, y - 1, r - 1.1, 0, TAU); c.fillStyle = radial(c, x - 2, y - 4, 0.5, r, [0, '#ffffff', 0.7, '#f6f3ff', 1, '#d8d2f2']); c.fill(); }
      c.fillStyle = '#6c6a9a'; c.beginPath(); c.moveTo(0, -14.5); c.lineTo(4.4, -10); c.lineTo(-4.4, -10); c.closePath(); c.fill();                // up arrow
      c.fillStyle = C.spark; c.strokeStyle = '#b07a12'; c.lineWidth = 1; star(c, 13, -14.5, 3.2, 4, 0.45); c.fill(); c.stroke();
    });
  }
  s.decor.set(key, set);
  return set;
}

export function drawSpring(ctx, cache, sp, chapter, t = 0) {
  const ch = chapter || CHAPTERS[0];
  const s = storeOf(cache); touch(s, cache, ch);
  const skin = (ch.skin && ch.skin.spring) || 'mushroom';
  const set = springSprites(s, cache, ch, skin);
  const since = t - (sp.bounceT === undefined ? -9 : sp.bounceT);
  let v = 0;                                                       // >0 squashed, <0 stretched
  if (since >= 0 && since < 0.3) { const k = since / 0.3; v = Math.exp(-3.2 * k) * Math.cos(7.2 * k); }
  else v = 0.025 * Math.sin(t * 3.1 + sp.x * 0.05);               // idle breath
  const sx = 1 + 0.3 * v, sy = 1 - 0.5 * v;
  ctx.save(); ctx.translate(sp.x, sp.y); ctx.imageSmoothingEnabled = true;
  if (ch.dark) { ctx.fillStyle = vgrad(ctx, s, ch.id + '|sprglow', -30, 0, [0, rgba(ch.palette.accent, 0), 1, rgba(ch.palette.accent, 0.3)]); ctx.fillRect(-26, -30, 52, 30); }
  ctx.fillStyle = 'rgba(20,10,40,0.22)'; ctx.beginPath(); ctx.ellipse(0, 1, 15 * sx, 2.4, 0, 0, TAU); ctx.fill();   // contact shadow
  if (skin === 'mushroom') {
    const sh = 8.5 * sy;
    cache.stamp(ctx, set.stem, 0, 0.5, sx * 0.9, sy);
    cache.stamp(ctx, set.cap, 0, -sh + 2, sx * 1.02, 1 - 0.3 * v);
  } else if (skin === 'coil') {
    const ch2 = 12.6 * sy;
    cache.stamp(ctx, set.base, 0, 1.2);
    cache.stamp(ctx, set.coil, 0, -2.6, 1, sy);
    cache.stamp(ctx, set.pad, 0, -2.6 - ch2 + 0.6, 1 + 0.06 * v);
  } else {
    cache.stamp(ctx, set.puff, 0, 2, sx, sy);
  }
  ctx.restore();
}

/* ═════════════════════════ THE LANDMARK ARCH (landscape-start signpost) ═════════════════════════
 * Two pillars and an arch in the landscape's own material (log posts, stone columns, bricks, crystal spires, ice
 * columns, cloud stacks), a hanging sign with the landscape's name, streamers fluttering from the pillar tops.
 * progress < 1 strings a ribbon across the opening; progress = 1 (the usual case here) leaves it cut and flying.
 * Origin (x, y) = the middle of its footing on the ground. About 132 u wide, 125 u tall; Mama rolls straight through. */

const GATE_HALF = 54, GATE_TOP = -100;
const GATE_MAT = { grass: 'plank', mud: 'plank', sand: 'plank', stone: 'stone', brick: 'brick', crystal: 'crystal', ice: 'ice', cloud: 'cloud' };

function drawGateFrame(c, ch, skin) {
  const mat = GATE_MAT[skin] || 'plank', K = ledgeKit(ch, mat, mat === 'ice');
  c.lineJoin = 'round'; c.lineCap = 'round';
  const pillar = (px) => {
    c.save(); c.translate(px, 0);
    const body = linear(c, -9, 0, 9, 0, [0, K.cl, 0.4, K.c, 1, K.cd]);
    if (mat === 'crystal') {
      c.beginPath(); c.moveTo(-9, 1); c.lineTo(-7.5, -82); c.lineTo(0, -106); c.lineTo(8, -84); c.lineTo(10, 1); c.closePath();
      c.fillStyle = body; c.fill(); c.strokeStyle = K.out; c.lineWidth = 2.2; c.stroke();
      c.beginPath(); c.moveTo(-7, -4); c.lineTo(-6, -80); c.lineTo(-0.5, -100); c.lineTo(-1.5, -30); c.closePath(); c.fillStyle = 'rgba(255,255,255,0.2)'; c.fill();
      c.beginPath(); c.moveTo(1, -10); c.lineTo(2.4, -40); c.lineTo(0.2, -60); c.lineTo(3, -86); c.strokeStyle = rgba(K.light, 0.8); c.lineWidth = 1.3; c.stroke();
      for (const [x, hh] of [[-13, 18], [14, 13]]) { c.save(); c.translate(x, 1); shard(c, 0, 0, 7, hh, x > 0 ? 1 : -1, mix(K.light, '#6ad0e0', 0.2), '#e6fffb', outline(K.light, 0.7)); c.restore(); }
    } else if (mat === 'cloud') {
      for (let i = 0; i < 6; i++) { const y = -9 - i * 16, r = 11 - i * 0.3; c.beginPath(); c.arc((i % 2 ? 1.4 : -1.4), y, r, 0, TAU); c.fillStyle = radial(c, -3, y - 4, 1, r * 1.3, [0, '#ffffff', 0.7, K.c, 1, K.cd]); c.fill(); c.strokeStyle = K.out; c.lineWidth = 2; c.stroke(); }
      rr(c, -10, -104, 20, 7, 3); c.fillStyle = linear(c, 0, -104, 0, -97, [0, '#fff0a0', 1, '#e8a81c']); c.fill(); c.strokeStyle = '#8a5a08'; c.lineWidth = 1.8; c.stroke();
    } else {
      rr(c, -8, -100, 16, 100, mat === 'plank' ? 6 : 2.5); c.fillStyle = body; c.fill(); c.strokeStyle = K.out; c.lineWidth = 2.2; c.stroke();
      c.save(); rr(c, -8, -100, 16, 100, mat === 'plank' ? 6 : 2.5); c.clip();
      if (mat === 'plank') {                                                         // bark + rope bands
        c.strokeStyle = rgba(K.cdd, 0.4); c.lineWidth = 1.2; for (let i = 0; i < 9; i++) { const x = -6 + (i % 4) * 4.2, y = -92 + i * 10; c.beginPath(); c.moveTo(x, y); c.lineTo(x + 0.8, y + 7); c.stroke(); }
        for (const y of [-24, -52, -80]) { c.fillStyle = '#e4cf98'; c.fillRect(-9, y, 18, 5); c.fillStyle = 'rgba(80,50,20,0.55)'; c.fillRect(-9, y + 4, 18, 1.2); c.fillRect(-9, y, 18, 1); }
      } else if (mat === 'brick') {
        c.fillStyle = rgba(K.mortar, 0.85); for (let i = 0; i < 12; i++) { c.fillRect(-9, -i * 8.4 - 8.4, 18, 1.3); c.fillRect(-1 + (i % 2) * 5, -i * 8.4 - 8.4, 1.3, 8.4); }
      } else if (mat === 'stone') {
        c.fillStyle = rgba(K.cdd, 0.4); c.fillRect(-3.5, -96, 1.4, 88); c.fillRect(2.5, -96, 1.4, 88); c.fillStyle = rgba(K.cl, 0.45); c.fillRect(-1.8, -96, 1, 88);
      } else if (mat === 'ice') {
        c.fillStyle = 'rgba(255,255,255,0.5)'; for (const x of [-5, 1]) { c.beginPath(); c.moveTo(x, -98); c.lineTo(x + 3, -98); c.lineTo(x - 2, -10); c.lineTo(x - 5, -10); c.closePath(); c.fill(); }
      }
      c.restore();
      if (mat !== 'plank') for (const [y, hh] of [[-110, 10], [-8, 9]]) { rr(c, -12, y, 24, hh, 2.5); c.fillStyle = linear(c, 0, y, 0, y + hh, [0, K.cl, 1, K.cd]); c.fill(); c.strokeStyle = K.out; c.lineWidth = 2; c.stroke(); }
      else { c.beginPath(); c.arc(0, -103, 5.2, 0, TAU); c.fillStyle = radial(c, -1.6, -105, 0.5, 6.5, [0, K.cl, 1, K.cd]); c.fill(); c.strokeStyle = K.out; c.lineWidth = 1.8; c.stroke(); for (const sx of [-8, 3, 9]) { c.beginPath(); c.ellipse(sx, 0, 5.2, 3.2, 0, Math.PI, 0); c.fillStyle = K.cd; c.fill(); c.strokeStyle = K.out; c.lineWidth = 1.5; c.stroke(); } }
    }
    c.restore();
  };
  // arch beam
  const beam = (w, col, dash) => { c.beginPath(); c.moveTo(-GATE_HALF, GATE_TOP + 4); c.quadraticCurveTo(0, -124, GATE_HALF, GATE_TOP + 4); c.lineWidth = w; c.strokeStyle = col; c.setLineDash(dash || []); c.stroke(); c.setLineDash([]); };
  pillar(-GATE_HALF); pillar(GATE_HALF);
  beam(15, K.out); beam(11.6, K.c);
  if (mat === 'stone' || mat === 'brick') { beam(11.6, rgba(K.cdd, 0.55), [1.2, 11.5]); }
  beam(5, rgba(K.cl, 0.7)); c.save(); c.translate(0, 2.8); beam(2.4, rgba(K.cd, 0.5)); c.restore();
  if (mat === 'crystal' || mat === 'ice') { c.save(); c.translate(0, -1.3); beam(1.6, rgba(K.rim, 0.9)); c.restore(); }
  // crest medallion
  c.beginPath(); c.arc(0, -112, 8.5, 0, TAU); c.fillStyle = radial(c, -2, -114, 0.5, 11, [0, '#fff3b0', 0.6, '#ffd23a', 1, '#e08a14']); c.fill(); c.strokeStyle = '#8a4a00'; c.lineWidth = 2; c.stroke();
  c.fillStyle = ch.palette.accent; c.strokeStyle = '#8a4a00'; c.lineWidth = 1; star(c, 0, -112, 5.2, 5, 0.45); c.fill(); c.stroke();
}

function gateSprites(s, cache, ch) {
  const key = ch.id + '|gate';
  let set = s.decor.get(key);
  if (set) return set;
  const skin = (ch.skin && ch.skin.ground) || 'grass';
  const font = '800 9.5px ui-rounded, "Arial Rounded MT Bold", Nunito, system-ui, sans-serif';
  const m = createSurface(8, 8).getContext('2d'); m.font = font;
  const tw = Math.ceil(m.measureText(ch.name).width), sw = Math.max(56, tw + 20);
  set = {
    frame: cache.get('terr|' + key + '|f', 140, 128, 70, 126, (c) => drawGateFrame(c, ch, skin)),
    sign: cache.get('terr|' + key + '|s', sw, 30, sw / 2, 0, (c) => {
      c.lineCap = 'round';
      for (const x of [-sw / 2 + 8, sw / 2 - 8]) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 7); c.strokeStyle = '#4a3020'; c.lineWidth = 3; c.stroke(); c.strokeStyle = '#d9bf8a'; c.lineWidth = 1.4; c.stroke(); }
      rr(c, -sw / 2, 6, sw, 20, 5); c.fillStyle = linear(c, 0, 6, 0, 26, [0, '#fff6dc', 1, '#ecd5a0']); c.fill(); c.strokeStyle = '#6b4424'; c.lineWidth = 2.2; c.stroke();
      rr(c, -sw / 2 + 2.4, 8.4, sw - 4.8, 15.2, 3.5); c.strokeStyle = 'rgba(107,68,36,0.35)'; c.lineWidth = 1; c.stroke();
      c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#4a2c18'; c.fillText(ch.name, 0, 16.6);
    }),
    sw,
  };
  s.decor.set(key, set);
  return set;
}

function streamer(ctx, x, y, dir, t, col, dark, len = 40) {
  const N = 9;
  ctx.beginPath(); ctx.moveTo(x, y);
  for (let i = 1; i <= N; i++) { const u = i / N; ctx.lineTo(x + dir * u * len, y + 2 + u * 7 + Math.sin(t * 4.2 - i * 0.8 + x) * 3.6 * u); }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = dark; ctx.lineWidth = 6.4; ctx.stroke();
  ctx.strokeStyle = col; ctx.lineWidth = 3.8; ctx.stroke();
  const ex = x + dir * len, ey = y + 9 + Math.sin(t * 4.2 - N * 0.8 + x) * 3.6;        // swallow-tail
  ctx.beginPath(); ctx.moveTo(ex, ey - 3.4); ctx.lineTo(ex + dir * 7, ey - 5); ctx.lineTo(ex + dir * 4.4, ey); ctx.lineTo(ex + dir * 7, ey + 5); ctx.lineTo(ex, ey + 3.4); ctx.closePath();
  ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = dark; ctx.lineWidth = 1.6; ctx.stroke();
}

export function drawGate(ctx, cache, g) {
  const ch = g.chapter || CHAPTERS[0], t = g.t || 0, prog = g.progress === undefined ? 1 : g.progress;
  const s = storeOf(cache); touch(s, cache, ch);
  const set = gateSprites(s, cache, ch);
  const P = ch.palette, rib = mix('#e0524a', P.accent, 0.25), ribDk = outline(rib, 0.65);
  ctx.save(); ctx.translate(g.x, g.y); ctx.imageSmoothingEnabled = true;
  if (ch.dark) { ctx.fillStyle = vgrad(ctx, s, ch.id + '|gateglow', -130, 0, [0, rgba(P.light, 0), 1, rgba(P.light, 0.16)]); ctx.fillRect(-70, -130, 140, 130); }
  ctx.fillStyle = 'rgba(20,10,40,0.2)'; ctx.beginPath(); ctx.ellipse(0, 1, 70, 3.4, 0, 0, TAU); ctx.fill();
  cache.stamp(ctx, set.frame, 0, 2);
  // bunting under the arch: little flags on a sagging string
  const cols = [rib, P.accent, lit(P.top, 0.3), '#ffffff'];
  ctx.beginPath(); ctx.moveTo(-GATE_HALF + 6, GATE_TOP + 7); ctx.quadraticCurveTo(0, GATE_TOP + 28, GATE_HALF - 6, GATE_TOP + 7); ctx.strokeStyle = 'rgba(60,40,30,0.8)'; ctx.lineWidth = 1.2; ctx.stroke();
  for (let i = 0; i < 9; i++) {
    const u = (i + 0.5) / 9, bx = -GATE_HALF + 6 + u * (GATE_HALF * 2 - 12), by = GATE_TOP + 7 + 4 * (u * (1 - u)) * 5.2, sw = Math.sin(t * 3 + i * 1.3) * 1.2;
    ctx.beginPath(); ctx.moveTo(bx - 3.6, by); ctx.lineTo(bx + 3.6, by); ctx.lineTo(bx + sw, by + 8); ctx.closePath(); ctx.fillStyle = cols[i % 4]; ctx.fill(); ctx.strokeStyle = outline(cols[i % 4], 0.62); ctx.lineWidth = 1; ctx.stroke();
  }
  cache.stamp(ctx, set.sign, 0, GATE_TOP - 10);                                  // hangs from the crown of the arch
  // ribbon: strung across the opening until it is cut, then streaming from the pillar tops
  if (prog < 1) {
    ctx.beginPath(); ctx.moveTo(-GATE_HALF + 8, -40); ctx.quadraticCurveTo(0, -34 + Math.sin(t * 2) * 1.5, GATE_HALF - 8, -40);
    ctx.lineCap = 'round'; ctx.strokeStyle = ribDk; ctx.lineWidth = 7; ctx.stroke(); ctx.strokeStyle = rib; ctx.lineWidth = 4.4; ctx.stroke();
  }
  streamer(ctx, -GATE_HALF - 3, GATE_TOP - 4, -1, t, rib, ribDk);
  streamer(ctx, GATE_HALF + 3, GATE_TOP - 4, 1, t, rib, ribDk);
  ctx.restore();
}

/* ═════════════════════════ THE BEACON ═════════════════════════
 * A stone tower on the summit: arched door, lit slit windows, gallery, a glass lantern room and a red roof with a gold
 * finial. Unlit: dark lantern with a faint ember and a gently pulsing gold ring ("touch me"). Lit: a bright flickering
 * flame, soft glow and slowly turning rays. litT (seconds since it was lit) drives the flare: white flash, two
 * shock rings, sparks and a big flame that settles over ~2.2 s. Origin (x, y) = middle of the tower's foot. */

const BEACON_FLAME_Y = -128;

function drawBeaconTower(c, P) {
  const stone = '#a79db6', stoneL = '#d4cbe0', stoneD = '#6f6890', out = '#2b2848', gold = '#ffd35a', goldD = '#a8700e';
  c.lineJoin = 'round'; c.lineCap = 'round';
  const blocks = (x0, x1, yTop, yBot, rowH) => {            // masonry lines inside the current clip
    c.strokeStyle = rgba(out, 0.28); c.lineWidth = 1;
    for (let y = yBot - rowH, r = 0; y > yTop; y -= rowH, r++) { c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); for (let x = x0 + (r % 2 ? 7 : 14); x < x1; x += 14) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + rowH); c.stroke(); } }
  };
  // plinth
  c.beginPath(); c.moveTo(-38, 1); c.lineTo(38, 1); c.lineTo(32, -15); c.lineTo(-32, -15); c.closePath();
  c.fillStyle = linear(c, -38, 0, 38, 0, [0, stoneL, 0.5, stone, 1, stoneD]); c.fill(); c.strokeStyle = out; c.lineWidth = 2.4; c.stroke();
  c.save(); c.clip(); blocks(-38, 38, -15, 1, 8); c.restore();
  // shaft (tapering)
  const shaft = () => { c.beginPath(); c.moveTo(-28, -15); c.lineTo(28, -15); c.lineTo(23, -98); c.lineTo(-23, -98); c.closePath(); };
  shaft(); c.fillStyle = linear(c, -28, 0, 28, 0, [0, stoneL, 0.35, stone, 1, stoneD]); c.fill();
  c.save(); shaft(); c.clip(); blocks(-28, 28, -98, -15, 9); c.fillStyle = 'rgba(255,240,200,0.18)'; c.fillRect(-28, -98, 9, 84); c.fillStyle = 'rgba(24,12,56,0.2)'; c.fillRect(14, -98, 14, 84); c.restore();
  shaft(); c.strokeStyle = out; c.lineWidth = 2.4; c.stroke();
  // door with warm light inside
  c.beginPath(); c.moveTo(-9, -15); c.lineTo(-9, -29); c.quadraticCurveTo(-9, -39, 0, -39); c.quadraticCurveTo(9, -39, 9, -29); c.lineTo(9, -15); c.closePath();
  c.fillStyle = linear(c, 0, -39, 0, -15, [0, '#5a3a2a', 1, '#ffb55a']); c.fill(); c.strokeStyle = out; c.lineWidth = 2; c.stroke();
  c.beginPath(); c.moveTo(-11, -15); c.lineTo(-11, -29); c.quadraticCurveTo(-11, -41, 0, -41); c.quadraticCurveTo(11, -41, 11, -29); c.lineTo(11, -15); c.strokeStyle = stoneL; c.lineWidth = 2; c.stroke();
  // slit windows
  for (const y of [-58, -80]) { rr(c, -2.8, y, 5.6, 14, 2.8); c.fillStyle = linear(c, 0, y, 0, y + 14, [0, '#ffe79a', 1, '#ff9a3c']); c.fill(); c.strokeStyle = out; c.lineWidth = 1.8; c.stroke(); }
  // gallery with railing
  rr(c, -33, -108, 66, 11, 3); c.fillStyle = linear(c, 0, -108, 0, -97, [0, stoneL, 1, stoneD]); c.fill(); c.strokeStyle = out; c.lineWidth = 2.2; c.stroke();
  c.fillStyle = gold; c.fillRect(-33, -104, 66, 2.2);
  for (let x = -27; x <= 27; x += 9) { c.beginPath(); c.moveTo(x, -108); c.lineTo(x, -118); c.strokeStyle = out; c.lineWidth = 3.4; c.stroke(); c.strokeStyle = stoneL; c.lineWidth = 1.5; c.stroke(); }
  rr(c, -31, -121, 62, 5, 2); c.fillStyle = linear(c, 0, -121, 0, -116, [0, stoneL, 1, stone]); c.fill(); c.strokeStyle = out; c.lineWidth = 2; c.stroke();
  // lantern room: dark interior (the flame is drawn into it), glass posts, gold ring
  rr(c, -19, -150, 38, 29, 4); c.fillStyle = linear(c, 0, -150, 0, -121, [0, '#241a3e', 1, '#4a2a4a']); c.fill();
  c.save(); rr(c, -19, -150, 38, 29, 4); c.clip(); c.fillStyle = 'rgba(255,255,255,0.1)'; c.beginPath(); c.moveTo(-19, -150); c.lineTo(-6, -150); c.lineTo(-19, -128); c.closePath(); c.fill(); c.restore();
  for (const x of [-20, 20]) { rr(c, x - 3, -152, 6, 32, 2); c.fillStyle = linear(c, x - 3, 0, x + 3, 0, [0, stoneL, 1, stoneD]); c.fill(); c.strokeStyle = out; c.lineWidth = 1.8; c.stroke(); }
  rr(c, -19, -150, 38, 29, 4); c.strokeStyle = out; c.lineWidth = 1.8; c.stroke();
  rr(c, -25, -158, 50, 8, 3); c.fillStyle = linear(c, 0, -158, 0, -150, [0, '#fff0a0', 1, gold]); c.fill(); c.strokeStyle = goldD; c.lineWidth = 2; c.stroke();
  // roof + finial
  c.beginPath(); c.moveTo(-26, -158); c.quadraticCurveTo(-18, -168, 0, -190); c.quadraticCurveTo(18, -168, 26, -158); c.closePath();
  c.fillStyle = linear(c, -26, 0, 26, 0, [0, '#ff8a80', 0.45, '#d04a5c', 1, '#8a2a4a']); c.fill(); c.strokeStyle = '#4a1230'; c.lineWidth = 2.4; c.stroke();
  c.beginPath(); c.moveTo(-14, -164); c.quadraticCurveTo(-8, -174, -2, -184); c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 2; c.stroke();
  c.beginPath(); c.arc(0, -192, 3.6, 0, TAU); c.fillStyle = radial(c, -1, -193, 0.4, 5, [0, '#fff6c0', 1, gold]); c.fill(); c.strokeStyle = goldD; c.lineWidth = 1.5; c.stroke();
}

function flameShape(c, k) {
  const sway = [0, 2.2, -1.6, 1][k], tall = [0, 3, -2, 1.5][k];
  const f = (w, h, col, out) => {
    c.beginPath(); c.moveTo(0, 0);
    c.bezierCurveTo(-w, -h * 0.15, -w * 0.9, -h * 0.55, -w * 0.25 + sway * 0.4, -h * 0.75 - tall * 0.3);
    c.bezierCurveTo(-w * 0.1, -h * 0.9, sway * 0.5, -h * 0.95 - tall, sway, -h - tall);
    c.bezierCurveTo(sway * 0.6 + w * 0.3, -h * 0.85, w * 1.0, -h * 0.5, w * 0.9, -h * 0.18);
    c.bezierCurveTo(w * 0.8, h * 0.02, w * 0.2, 0, 0, 0); c.closePath();
    c.fillStyle = col; c.fill(); if (out) { c.strokeStyle = out; c.lineWidth = 1.6; c.stroke(); }
  };
  f(11, 30, linear(c, 0, 0, 0, -32, [0, '#ff7a1a', 1, '#ff4a1a']), '#b83a0e');
  f(8, 24, linear(c, 0, 0, 0, -26, [0, '#ffb42e', 1, '#ffd84a']), null);
  f(4.6, 15, linear(c, 0, 0, 0, -16, [0, '#fff4b8', 1, '#ffffff']), null);
}

function beaconSprites(s, cache, ch) {
  const key = ch.id + '|beacon';
  let set = s.decor.get(key);
  if (set) return set;
  set = {
    tower: cache.get('terr|' + key + '|tower', 84, 198, 42, 196, (c) => drawBeaconTower(c, ch.palette)),
    flames: [0, 1, 2, 3].map((k) => cache.get('terr|' + key + '|fl' + k, 34, 46, 17, 44, (c) => flameShape(c, k))),
    glow: cache.get('terr|' + key + '|glow', 220, 220, 110, 110, (c) => { c.beginPath(); c.arc(0, 0, 108, 0, TAU); c.fillStyle = radial(c, 0, 0, 2, 108, [0, 'rgba(255,236,160,0.9)', 0.25, 'rgba(255,210,110,0.5)', 0.6, 'rgba(255,190,90,0.16)', 1, 'rgba(255,190,90,0)']); c.fill(); }),
    rays: cache.get('terr|' + key + '|rays', 260, 260, 130, 130, (c) => {
      c.beginPath();
      for (let i = 0; i < 12; i++) { const a = i / 12 * TAU, w = 0.075; c.moveTo(Math.cos(a - w) * 16, Math.sin(a - w) * 16); c.lineTo(Math.cos(a) * 128, Math.sin(a) * 128); c.lineTo(Math.cos(a + w) * 16, Math.sin(a + w) * 16); c.closePath(); }
      c.fillStyle = radial(c, 0, 0, 10, 128, [0, 'rgba(255,244,190,0.8)', 1, 'rgba(255,244,190,0)']); c.fill();
    }),
  };
  s.decor.set(key, set);
  return set;
}

export function drawBeacon(ctx, cache, b) {
  const ch = CHAPTERS.find((c) => c.beacon) || CHAPTERS[CHAPTERS.length - 1];
  const s = storeOf(cache); touch(s, cache, ch);
  const set = beaconSprites(s, cache, ch);
  const t = b.t || 0, lt = b.litT === undefined ? (b.lit ? 9 : 0) : b.litT;
  const fy = BEACON_FLAME_Y;
  ctx.save(); ctx.translate(b.x, b.y); ctx.imageSmoothingEnabled = true;
  const p = clamp01(lt / 2.2);
  if (b.lit) {
    // QA-VISUAL (performance): the rays and the halo used to be 260 u / 220 u bitmaps stamped at 1.3-2.4x, rotating: 1500-2700 device px
    // squares of bilinear alpha blending each frame, ~12-24 ms on the software rasteriser (the whole frame budget, in the one scene where
    // the child is watching hardest). The rays are now twelve thin wedges filled with one cached radial gradient (the same picture, but
    // only the ~15 % of the area that is not empty is touched) and the halo is a gradient disc.
    const k = 1.3 + 0.5 * (1 - p);
    let g = s.grads.get('beacon|rays');
    if (!g) { g = ctx.createRadialGradient(0, 0, 10, 0, 0, 128); g.addColorStop(0, 'rgba(255,244,190,0.8)'); g.addColorStop(1, 'rgba(255,244,190,0)'); s.grads.set('beacon|rays', g); }
    ctx.save(); ctx.translate(0, fy); ctx.rotate(t * 0.12); ctx.scale(k, k); ctx.globalAlpha = 0.5 + 0.4 * (1 - p);
    ctx.beginPath();
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU, w = 0.075; ctx.moveTo(Math.cos(a - w) * 16, Math.sin(a - w) * 16); ctx.lineTo(Math.cos(a) * 128, Math.sin(a) * 128); ctx.lineTo(Math.cos(a + w) * 16, Math.sin(a + w) * 16); ctx.closePath(); }
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
    const gs = 1.5 + 0.12 * Math.sin(t * 8) + 0.9 * (1 - p) * (1 - p);
    let hg = s.grads.get('beacon|halo');
    if (!hg) { hg = ctx.createRadialGradient(0, 0, 2, 0, 0, 108); hg.addColorStop(0, 'rgba(255,236,160,0.9)'); hg.addColorStop(0.25, 'rgba(255,210,110,0.5)'); hg.addColorStop(0.6, 'rgba(255,190,90,0.16)'); hg.addColorStop(1, 'rgba(255,190,90,0)'); s.grads.set('beacon|halo', hg); }
    ctx.save(); ctx.translate(0, fy); ctx.scale(gs, gs); ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(0, 0, 108, 0, TAU); ctx.fillStyle = hg; ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(20,10,40,0.22)'; ctx.beginPath(); ctx.ellipse(0, 1, 44, 3.6, 0, 0, TAU); ctx.fill();
  cache.stamp(ctx, set.tower, 0, 2);
  if (b.lit) {
    const k = Math.floor(t * 11) & 3, sc = 1.22 * (1 + 0.05 * Math.sin(t * 17)) * (1 + 1.3 * (1 - p) * (1 - p) * (1 - p));
    cache.stamp(ctx, set.flames[k], 0, fy + 19, sc * 0.95, sc, 0, 1);
    cache.stamp(ctx, set.glow, 0, fy, 0.5, 0.5, 0, 0.55);
    if (lt < 2.4) {                                                           // the flare
      const e = lt / 2.4, ease = 1 - (1 - e) * (1 - e);
      for (const [d, col] of [[0, '#fff1a8'], [0.22, '#ffb347']]) { const q = clamp01((lt - d) / 1.8); if (q <= 0 || q >= 1) continue; ctx.beginPath(); ctx.arc(0, fy, 12 + 200 * (1 - (1 - q) * (1 - q)), 0, TAU); ctx.strokeStyle = rgba(col, 0.9 * (1 - q)); ctx.lineWidth = 1 + 7 * (1 - q); ctx.stroke(); }
      if (lt < 0.2) { ctx.beginPath(); ctx.arc(0, fy, 70, 0, TAU); ctx.fillStyle = `rgba(255,252,230,${0.85 * (1 - lt / 0.2)})`; ctx.fill(); }
      for (let i = 0; i < 18; i++) {                                           // sparks
        const a = i * 2.399 + 0.4, sp = 80 + (i % 5) * 34, d = sp * ease, x = Math.cos(a) * d, y = fy + Math.sin(a) * d * 0.8 - 20 * ease + 150 * e * e * (0.4 + (i % 3) * 0.3);
        ctx.fillStyle = i % 3 ? `rgba(255,214,90,${1 - e})` : `rgba(255,255,255,${1 - e})`; ctx.beginPath(); ctx.arc(x, y, 2.6 * (1 - e) + 0.6, 0, TAU); ctx.fill();
      }
    }
  } else {
    // unlit: a dim ember in the dark lantern + a pulsing gold ring that says "touch me"
    const em = 0.5 + 0.5 * Math.sin(t * 2.6);
    ctx.fillStyle = `rgba(255,${110 + 60 * em | 0},40,${0.55 + 0.35 * em})`; ctx.beginPath(); ctx.ellipse(0, fy + 15, 6 + em, 2.8 + em * 0.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgba(255,214,120,${0.22 + 0.14 * em})`; ctx.beginPath(); ctx.arc(0, fy + 13, 11 + 2 * em, 0, TAU); ctx.fill();
    // "touch me": a dashed ring that must read against ANY sky (the summit's is golden), so it is a dark dashed ring under a bright one
    const r = 26 + 5 * Math.sin(t * 3), pulse = 0.5 + 0.5 * Math.sin(t * 3);
    ctx.setLineDash([6, 6]); ctx.lineDashOffset = -t * 14;
    ctx.beginPath(); ctx.arc(0, fy, r, 0, TAU); ctx.strokeStyle = `rgba(70,28,96,${0.55 + 0.25 * pulse})`; ctx.lineWidth = 5.4; ctx.stroke();
    ctx.strokeStyle = `rgba(255,250,214,${0.78 + 0.22 * pulse})`; ctx.lineWidth = 2.6; ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/* ═════════════════════════ WATER (flood / sea band, decor, no cache) ═════════════════════════
 * Semi-transparent body (so the painted lake shows through) with a darker back wave, a lighter front wave,
 * a foam line and sparkles. Waves are anchored to WORLD x so they do not slide with the camera. */

const WATER_GRADS = new Map();
function waterGrad(ctx, key, y0, y1, stops) {
  let g = WATER_GRADS.get(key);
  if (!g) {
    if (WATER_GRADS.size > 24) WATER_GRADS.clear();
    g = ctx.createLinearGradient(0, y0, 0, y1); for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]); WATER_GRADS.set(key, g);
  }
  return g;
}

export function drawWater(ctx, w) {
  const ch = w.chapter || CHAPTERS[2], t = w.t || 0, P = ch.palette;
  const base = P.water || mix(P.sky, '#2a7fb0', 0.5);
  const m = ctx.getTransform(), a = m.a || 1, cw = (ctx.canvas && ctx.canvas.width) || 4096;
  const vx0 = (0 - m.e) / a - 16, vx1 = (cw - m.e) / a + 16;
  const x0 = Math.max(w.x0, vx0), x1 = Math.min(w.x1, vx1);
  if (x1 <= x0) return;
  const y = w.y, bottom = w.bottom === undefined ? y + 140 : w.bottom;
  const gk = ch.id + '|' + y + '|' + bottom;
  ctx.save();
  const wave = (x, amp, len, speed, ph) => Math.sin(x / len * TAU + t * speed + ph) * amp + Math.sin(x / (len * 0.47) * TAU - t * speed * 1.3 + ph * 2) * amp * 0.35;
  const step = 8;
  const crest = (yOff, amp, len, speed, ph, close) => {
    ctx.beginPath();
    let x = Math.floor(x0 / step) * step;
    ctx.moveTo(x, y + yOff + wave(x, amp, len, speed, ph));
    for (x += step; x <= x1 + step; x += step) ctx.lineTo(x, y + yOff + wave(x, amp, len, speed, ph));
    if (close) { ctx.lineTo(x - step, bottom); ctx.lineTo(Math.floor(x0 / step) * step, bottom); ctx.closePath(); }
  };
  // back wave (darker, slower), then the body, then the lighter front wave and foam
  crest(-3.5, 2.6, 74, 0.8, 1.3, true);
  ctx.fillStyle = waterGrad(ctx, 'b' + gk, y - 8, bottom, [0, rgba(shade(base, 0.25), 0.55), 0.35, rgba(shade(base, 0.35), 0.74), 1, rgba(shade(base, 0.55), 0.9)]); ctx.fill();
  crest(0, 2, 46, -1.2, 0, true);
  ctx.fillStyle = waterGrad(ctx, 'f' + gk, y - 4, bottom, [0, rgba(lit(base, 0.3), 0.7), 0.12, rgba(base, 0.66), 0.6, rgba(shade(base, 0.3), 0.8), 1, rgba(shade(base, 0.55), 0.92)]); ctx.fill();
  // soft light streaks under the surface
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let x = Math.floor(x0 / 64) * 64; x < x1; x += 64) { const k = hash(x | 0, 3, 5), xx = x + (k & 31) + Math.sin(t * 0.7 + x) * 4; ctx.fillRect(xx, y + 8 + ((k >>> 5) & 15), 26 + ((k >>> 9) & 15), 2); }
  // foam line + sparkles on the crest
  crest(0, 2, 46, -1.2, 0, false); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.7; ctx.lineJoin = 'round'; ctx.stroke();
  crest(2.6, 2, 46, -1.2, 0.3, false); ctx.strokeStyle = rgba(lit(base, 0.5), 0.45); ctx.lineWidth = 1; ctx.stroke();
  for (let x = Math.floor(x0 / 52) * 52; x < x1; x += 52) {
    const k = hash(x | 0, 9, 1), tw = 0.5 + 0.5 * Math.sin(t * 2.3 + (k & 255)), xx = x + (k & 31);
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.5 * tw})`; ctx.fillRect(xx, y + wave(xx, 2, 46, -1.2, 0) - 3.2, 5 + tw * 4, 1.3);
  }
  ctx.restore();
}

/* ═════════════════════════ art overhang for culling ═════════════════════════ */

/** How far the art reaches beyond the platform's own box [x, x+w] x [y, y+h]. The renderer adds mover amplitude itself. */
export function platformPadding(p) {
  switch (p.kind) {
    case 'ground': return { left: 8, right: 8, top: 34, bottom: Math.max(0, T.killY - (p.y + (p.h || 0))) + 8 };
    case 'crumble': return { left: 44, right: 44, top: 20, bottom: 460 };                                  // tumbling lumps drift up to ~35 u sideways before they fade (~1 s)
    case 'lift': { const amp = (p.motion && p.motion.amp) || 0; return { left: 14, right: 14, top: 2 * amp + 112, bottom: 24 }; }
    case 'mover': return { left: 24, right: 24, top: 20, bottom: 26 };                                     // rail ends overhang by 14 beyond the travel
    default: return { left: 10, right: 10, top: 20, bottom: 24 };                                          // leaves, twigs, icicles, stems
  }
}
/* ═════════════════════════ public API: drawPlatform ═════════════════════════ */

export function drawPlatform(ctx, cache, p, chapter, t = 0, alpha = 1) {
  if (!(p.w > 0)) return;
  const ch = chapter || CHAPTERS[0];
  const s = storeOf(cache);
  touch(s, cache, ch);
  const a = alpha < 1 && p.pcx !== undefined;
  const x = p.cx === undefined ? p.x : (a ? p.pcx + (p.cx - p.pcx) * alpha : p.cx);
  const y = p.cy === undefined ? p.y : (a ? p.pcy + (p.cy - p.pcy) * alpha : p.cy);
  switch (p.kind) {
    case 'ground': drawGround(ctx, cache, s, p, ch, x, y, t); break;
    case 'crumble': drawCrumble(ctx, cache, s, p, ch, x, y, t); break;
    case 'lift': drawLift(ctx, cache, s, p, ch, x, y, t); break;
    case 'mover': drawMover(ctx, cache, s, p, ch, x, y, t); break;
    default: drawSlab(ctx, cache, s, p.ice ? 'ice' : ((ch.skin && ch.skin.ledge) || 'plank'), p, ch, x, y, t);
  }
}

/* ═════════════════════════ warm-up (optional) ═════════════════════════
 * The first time a landscape's terrain is drawn, its texture tiles and sprites are built (about 40-60 ms on a phone-class
 * machine). The renderer can pay that earlier, a few ms per frame, while Mama is still a few thousand units away:
 *   const steps = warmTerrainSteps(cache, CHAPTERS[next]);   // array of small thunks (each ~2-12 ms)
 *   ...each frame: steps.shift()?.();
 * or warmTerrain(cache, chapter) to do it all at once (e.g. behind the title screen). Pass the main ctx as a third argument
 * to pre-create the canvas patterns too. Purely an optimisation: drawing
 * works without it. Call again after cache.setScale() changes (the tiles are rebuilt for the new scale). */
export function warmTerrainSteps(cache, chapter, ctx = null) {
  const ch = chapter || CHAPTERS[0], s = storeOf(cache);
  const pat = (t) => { if (ctx && t && !t.pat) t.pat = ctx.createPattern(t.canvas, 'repeat'); return t; };       // optional: also pre-create the canvas patterns
  const gBase = (ch.skin && ch.skin.ground) || 'grass', lBase = (ch.skin && ch.skin.ledge) || 'plank';
  const gK = groundKit(ch, gBase, false), lK = ledgeKit(ch, lBase, false), lSpec = LEDGES[lBase] || LEDGES.plank;
  const steps = [
    () => touch(s, cache, ch),
    () => groundStrip(s, ch, gBase, false, gK, 0),
    () => groundStrip(s, ch, gBase, false, gK, 1),
    () => { if (gK.dark) glowStrip(s, ch, gBase, gK); },
    () => decorFor(s, cache, ch, gK, gBase),
    () => pat(ledgeTile(s, ch.id + '|l|' + lBase, lSpec, lK)),
    () => { const ice = lBase === 'ice'; pat(crumbleTile(s, crumbleKit(ch, ice), ch.id + '|c|' + (ice ? 'ice' : lBase))); },
    () => spikeSprites(s, cache, ch, (ch.skin && ch.skin.hazard) || 'thorn'),
    () => springSprites(s, cache, ch, (ch.skin && ch.skin.spring) || 'mushroom'),
    () => gateSprites(s, cache, ch),
  ];
  if (ch.ice || gBase === 'ice') {
    const iK = groundKit(ch, 'ice', false);
    steps.push(() => groundStrip(s, ch, 'ice', false, iK, 0), () => groundStrip(s, ch, 'ice', false, iK, 1), () => decorFor(s, cache, ch, iK, 'ice'));
  }
  if (ch.beacon) steps.push(() => beaconSprites(s, cache, ch));
  return steps;
}
export function warmTerrain(cache, chapter, ctx = null) { for (const f of warmTerrainSteps(cache, chapter, ctx)) f(); }

/** Cache diagnostics (tests, debugging). */
export function terrainCacheStats(cache) {
  const s = STORES.get(cache);
  return s ? { chapters: s.order.slice(), tiles: s.tiles.size, gradients: s.grads.size, decor: s.decor.size } : { chapters: [], tiles: 0, gradients: 0, decor: 0 };
}
