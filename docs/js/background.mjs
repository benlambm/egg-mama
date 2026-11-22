/*
 * Egg Mama — the painted world behind the action.
 *
 *   Paintings   decodes the 13 pixel-art landscapes on demand (never more than the few that are needed), draws them
 *               cover-fitted (and zoomed a little past the screen, see SLACK) and pixel-crisp, drifting very slowly through
 *               that spare width (never tiled, so no mirror seam), and lets the renderer dissolve one into the next. A decode never blocks a frame: until a painting arrives the
 *               caller draws the previous one, or the landscape's sky colour.
 *   Atmosphere  the drifting weather of each landscape (pollen, mist, petals, dust, embers, spray, fireflies, snow,
 *               clouds). Cheap particle fields that WRAP around the camera, drawn BEHIND platforms and actors, so a
 *               required landing is never veiled. Everything is deterministic (hashed seeds, no Math.random).
 *
 * Both are plain classes with no knowledge of the sim; render.mjs owns the order of the layers.
 */
import { mix, rgba, createSurface, TAU } from './artkit.mjs';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const frac = (v) => v - Math.floor(v);

/* ═══════════════════════════════════════ PAINTINGS ═══════════════════════════════════════ */

/** Decode an image without touching the main thread more than necessary (createImageBitmap), falling back to <img>. */
async function decodeImage(url) {
  if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
    try {
      const res = await fetch(url);
      if (res.ok) return await createImageBitmap(await res.blob());
    } catch { /* fall through to the <img> path (file://, odd service-worker states) */ }
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  if (img.decode) await img.decode();
  else await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; });
  return img;
}

/**
 * Where the horizon sits when a 16:9 painting is cropped to a wider screen: 0 = keep the top, 1 = keep the bottom.
 * The sky is the part of every painting we can most afford to lose; the world's ground line is at 81 % of the screen.
 */
const ANCHOR_Y = 0.55;
/** Spare painting width, as a fraction of the screen's, that the slow drift moves through (zoom = 1 + SLACK on a phone). */
export const SLACK = 0.34;

export class Paintings {
  /** @param chapters the CHAPTERS table (needs .bg: a path relative to docs/index.html) */
  constructor(chapters) {
    this.chapters = chapters;
    this.items = new Map();           // landscape index -> { i, state: 'loading'|'ready'|'failed', img, w, h, tries, retryAt, promise, fit }
    this.loads = 0;                   // diagnostics: how many decodes were started
    this.decoded = 0;                 // how many paintings are held decoded right now
  }

  urlOf(i) { return new URL('../' + this.chapters[i].bg, import.meta.url).href; }

  /** Begin decoding painting `i` (a no-op when it is already known). Resolves true when it is ready, false if it failed. */
  request(i) {
    let it = this.items.get(i);
    if (it) {
      if (it.state === 'failed' && nowMs() >= it.retryAt) { it.state = 'loading'; it.promise = this._load(it); }
      return it.promise;
    }
    it = { i, state: 'loading', img: null, w: 0, h: 0, tries: 0, retryAt: 0, promise: null, fit: null };
    this.items.set(i, it);
    it.promise = this._load(it);
    return it.promise;
  }

  async _load(it) {
    this.loads++;
    try {
      const img = await decodeImage(this.urlOf(it.i));
      if (this.items.get(it.i) !== it) { if (img.close) img.close(); return false; }     // dropped while decoding
      it.img = img; it.w = img.width; it.h = img.height; it.state = 'ready'; this.decoded++;
      return true;
    } catch {
      it.state = 'failed'; it.tries++; it.retryAt = nowMs() + Math.min(30000, 2500 * it.tries);
      return false;
    }
  }

  /** The decoded painting `i`, or null while it is still loading / failed. Never blocks. */
  get(i) { const it = this.items.get(i); return it && it.state === 'ready' ? it : null; }

  /** Free every painting that is not in `keep` (an array of landscape indices). */
  keepOnly(keep) {
    if (this.items.size === keep.length) return;               // the common case: exactly what is needed is held (and no iterator is allocated)
    for (const [i, it] of this.items) {
      if (keep.indexOf(i) >= 0) continue;
      if (it.img && it.img.close) it.img.close();
      if (it.state === 'ready') this.decoded--;
      this.items.delete(i);
    }
  }

  dispose() { this.keepOnly([]); }

  /**
   * How painting `it` is laid over a cw x ch canvas: cover-fitted AND zoomed so it is at least (1 + SLACK) screens wide.
   * That spare width (`slack`, device px) is the room the slow drift moves through, so the painting never runs out and
   * is never tiled. (The first version tiled a screen-wide painting with mirror copies: the seam was on screen for
   * the whole landscape and read as twin windmills / twin mesas. See DESIGN section 2, "mirror-tiled if it ever runs out".)
   */
  fitOf(it, cw, ch) {
    let f = it.fit;
    if (!f || f.cw !== cw || f.ch !== ch) {
      const s = Math.max(cw * (1 + SLACK) / it.w, ch / it.h);
      const dw = Math.round(it.w * s), dh = Math.max(ch, Math.round(it.h * s));
      f = it.fit = { cw, ch, dw, dh, slack: Math.max(0, dw - cw), y: Math.round((ch - dh) * ANCHOR_Y) };
    }
    return f;
  }

  /**
   * Draw painting `it` over the whole canvas (device pixels, identity transform expected), with smoothing OFF so the pixel
   * art stays crisp, scrolled `off` device px to the left (clamped to its slack: it simply stops at its edge).
   * Everything is placed on whole device pixels, so there is no shimmer.
   */
  draw(ctx, it, cw, ch, off, alpha) {
    const f = this.fitOf(it, cw, ch);
    const x = -Math.round(off < 0 ? 0 : off > f.slack ? f.slack : off);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(it.img, x, f.y, f.dw, f.dh);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
  }
}

/** The colour shown until a landscape's painting has arrived: its sky, a touch lighter toward the horizon. */
const SKY = new WeakMap();
export function fillSky(ctx, cw, ch, palette, alpha = 1) {
  let g = SKY.get(palette);
  if (!g || g.ch !== ch) {
    const grad = ctx.createLinearGradient(0, 0, 0, ch);
    grad.addColorStop(0, palette.sky);
    grad.addColorStop(1, mix(palette.sky, palette.light, 0.45));
    g = { ch, grad };
    SKY.set(palette, g);
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g.grad;
  ctx.fillRect(0, 0, cw, ch);
  ctx.globalAlpha = 1;
}

/* ═══════════════════════════════════════ ATMOSPHERE ═══════════════════════════════════════ */
/*
 * Drawn in "view space": the context carries (S,0,0,S,0,ty) so one unit is one world unit, x runs from the LEFT EDGE OF
 * THE SCREEN (not the world) and y is the world's y (negative above the usual sky on tall screens). Every particle has a
 * fixed seed (u, v, a, b, c) in [0,1) and a parallax factor; its x is  wrap(u*P + drift*t - cam*parallax, P)  so the field
 * is endless in both directions and never allocates. `g` carries the frame: { w, top, bottom, cam, t, density }.
 */

const makeSeeds = (n, salt) => {
  const a = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) for (let k = 0; k < 5; k++) a[i * 5 + k] = frac(Math.sin((i + salt * 17) * 127.1 + (k + 1) * 311.7) * 43758.5453123);
  return a;
};
const wrap = (v, P) => v - Math.floor(v / P) * P;

/** A soft round glow, white in the middle, baked once per colour. */
const GLOWS = new Map();
function glowSprite(color) {
  let s = GLOWS.get(color);
  if (s) return s;
  const c = createSurface(64, 64), x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, rgba('#ffffff', 1)); g.addColorStop(0.18, rgba(color, 0.95)); g.addColorStop(0.5, rgba(color, 0.32)); g.addColorStop(1, rgba(color, 0));
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  GLOWS.set(color, c);
  return c;
}

/*
 * Mist banks and clouds are baked at DEVICE resolution (one device pixel per sprite pixel) and blitted at whole device
 * pixels: the canvas then copies them instead of resampling, which is several times cheaper than stretching a small
 * soft sprite (the software rasteriser we test on resamples at ~3 ms per megapixel). They are re-baked when the scale
 * changes; `prepareSteps()` lets the renderer bake them ahead of need.
 */
const MIST_W = 640, MIST_H = 120, CLOUD_W = 420, CLOUD_H = 150;

/** A long soft bank of mist (several blurred blobs squashed flat), every blob well inside the sprite so nothing is clipped. */
function bakeMist(color, variant, S) {
  const c = createSurface(Math.ceil(MIST_W * S), Math.ceil(MIST_H * S)), x = c.getContext('2d');
  x.scale(S, S);
  const blobs = variant
    ? [[0.1, 0.55, 0.12, 0.5], [0.27, 0.46, 0.16, 0.62], [0.5, 0.56, 0.2, 0.55], [0.73, 0.47, 0.17, 0.6], [0.91, 0.56, 0.1, 0.45]]
    : [[0.08, 0.5, 0.1, 0.45], [0.25, 0.56, 0.18, 0.6], [0.48, 0.45, 0.15, 0.55], [0.7, 0.57, 0.2, 0.62], [0.9, 0.5, 0.11, 0.5]];
  const sq = 0.34;
  for (const [bx, by, br, ba] of blobs) {
    const cx = bx * MIST_W, cy = by * MIST_H, r = br * MIST_W;
    x.save(); x.translate(cx, cy); x.scale(1, sq);
    const g = x.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, rgba(color, ba)); g.addColorStop(0.55, rgba(color, ba * 0.45)); g.addColorStop(1, rgba(color, 0));
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, r, 0, TAU); x.fill();
    x.restore();
  }
  return c;
}

/** A cumulus (a cluster of soft puffs, lit on top, cool underneath). Every puff is inside the sprite. */
function bakeCloud(tint, variant, S) {
  const c = createSurface(Math.ceil(CLOUD_W * S), Math.ceil(CLOUD_H * S)), x = c.getContext('2d');
  x.scale(S, S);
  const puffs = [
    [[56, 98, 32], [118, 76, 44], [195, 62, 54], [270, 78, 46], [338, 98, 34], [198, 98, 46]],
    [[70, 100, 30], [130, 84, 38], [190, 70, 44], [250, 60, 50], [320, 86, 38], [250, 100, 42]],
    [[50, 100, 28], [100, 84, 36], [160, 72, 40], [225, 66, 48], [300, 82, 42], [356, 100, 30], [200, 102, 40]],
  ][variant % 3];
  const under = mix(tint, '#8a7fb8', 0.5);
  for (const [px, py, pr] of puffs) {
    const g = x.createRadialGradient(px - pr * 0.22, py - pr * 0.3, 0, px, py, pr);
    g.addColorStop(0, rgba('#ffffff', 0.98)); g.addColorStop(0.45, rgba(tint, 0.9)); g.addColorStop(0.82, rgba(under, 0.7)); g.addColorStop(1, rgba(under, 0));
    x.fillStyle = g; x.beginPath(); x.arc(px, py, pr, 0, TAU); x.fill();
  }
  return c;
}

/** Per-landscape weather settings. `fx` names are chapters[i].fx. */
const FX = {
  pollen: { n: 34, r: [0.9, 2.2], vx: [4, 13], vy: [-9, -3], sway: 7, swayF: 0.8, par: [0.45, 1.0], y: [0.18, 0.88], alpha: 0.62, color: (P) => mix('#fff6c4', P.light, 0.35), shape: 'dot' },
  petals: { n: 30, r: [1.5, 2.6], vx: [6, 18], vy: [13, 26], sway: 14, swayF: 1.1, par: [0.5, 1.0], y: [0, 1], alpha: 0.9, color: (P) => mix('#ffc4d2', P.accent, 0.45), shape: 'petal', front: 7 },
  dust: { n: 30, r: [0.8, 2.0], vx: [10, 28], vy: [-3, 3], sway: 5, swayF: 0.6, par: [0.4, 1.0], y: [0.3, 0.95], alpha: 0.5, color: (P) => mix('#f4dca0', P.light, 0.4), shape: 'dot' },
  snow: { n: 104, r: [0.8, 2.5], vx: [-7, 9], vy: [16, 46], sway: 9, swayF: 0.9, par: [0.25, 1.0], y: [0, 1], alpha: 0.85, color: () => '#ffffff', shape: 'dot', front: 9, layers: 3 },
  embers: { n: 34, r: [4, 8], vx: [-5, 9], vy: [-38, -14], sway: 9, swayF: 1.7, par: [0.5, 1.0], y: [0.2, 1], alpha: 0.9, color: (P) => mix('#ff9a3c', P.accent, 0.15), shape: 'glow', add: true },
  fireflies: { n: 24, r: [5, 11], vx: [-3, 3], vy: [-2, 2], sway: 18, swayF: 0.55, par: [0.45, 1.0], y: [0.22, 0.92], alpha: 0.9, color: (P) => mix(P.light, '#fff0a0', 0.45), color2: (P) => P.accent, shape: 'glow', add: true, pulse: true },
};
const SEEDS = {};
for (const k of Object.keys(FX)) SEEDS[k] = makeSeeds(FX[k].n, k.length * 7 + k.charCodeAt(0));
const SEEDS_MIST = makeSeeds(7, 91), SEEDS_CLOUD = makeSeeds(7, 133), SEEDS_SPRAY = makeSeeds(42, 57);

export class Atmosphere {
  constructor() {
    this.sprites = new Map();         // `${kind}|${colour}|${variant}` -> baked canvas (at this.S)
    this.S = 0;
    this.style = new Map();           // chapter -> resolved weather colours
  }

  /** Baked sprite, rebuilt when the device scale changes. */
  sprite(kind, color, variant, S) {
    if (S !== this.S) { this.S = S; this.sprites.clear(); }
    const key = kind + '|' + color + '|' + variant;
    let s = this.sprites.get(key);
    if (!s) { s = kind === 'mist' ? bakeMist(color, variant, S) : bakeCloud(color, variant, S); this.sprites.set(key, s); }
    return s;
  }
  mistColor(ch) { const P = ch.palette; return ch.dark ? mix(P.sky, P.light, 0.3) : mix(P.sky, '#ffffff', 0.62); }
  cloudTint(ch) { return mix('#ffffff', ch.palette.accent, 0.3); }

  /**
   * The sprites a landscape's weather needs, as small thunks (one sprite each) the renderer runs a few ms per frame, ahead of
   * need. Each forces its raster with a 1-px read-back so the cost lands in the warm-up step, not in the first frame that shows it.
   */
  prepareSteps(ch, S) {
    const steps = [];
    const bake = (kind, color, v) => steps.push(() => {
      const c = this.sprite(kind, color, v, S);
      try { c.getContext('2d').getImageData(0, 0, 1, 1); } catch { /* the sprite is still usable */ }
    });
    if (ch.fx === 'mist') { bake('mist', this.mistColor(ch), 0); bake('mist', this.mistColor(ch), 1); }
    else if (ch.fx === 'clouds') for (let v = 0; v < 3; v++) bake('cloud', this.cloudTint(ch), v);
    const cfg = FX[ch.fx];
    if (cfg && cfg.shape === 'glow') steps.push(() => { const st = this.styleOf(ch, cfg); glowSprite(st.c); if (st.c2) glowSprite(st.c2); });
    return steps;
  }

  /** Haze + weather of landscape `ch`, at `weight` 0..1 (the dissolve). `front` draws only the sparse in-front flakes. */
  draw(ctx, ch, weight, g, front = false) {
    if (weight <= 0.01) return;
    const fx = ch.fx;
    if (!front) {
      if (ch.fog > 0) this.haze(ctx, ch, weight, g);
      if (fx === 'mist') this.mist(ctx, ch, weight, g);
      else if (fx === 'clouds') this.clouds(ctx, ch, weight, g);
      else if (fx === 'spray') this.spray(ctx, ch, weight, g);
    }
    const cfg = FX[fx];
    if (cfg) this.field(ctx, ch, cfg, SEEDS[fx], weight, g, front);
  }

  styleOf(ch, cfg) {
    let s = this.style.get(ch);                                // keyed by the chapter object: no string building per frame
    if (!s) { s = { c: cfg.color(ch.palette), c2: cfg.color2 ? cfg.color2(ch.palette) : null }; this.style.set(ch, s); }
    return s;
  }

  /**
   * Ground haze: a veil strongest low down. Drawn behind every platform, so landings are never veiled. A smooth gradient
   * is surprisingly costly to rasterise on a CPU, so it is built from flat translucent bands on whole device rows
   * (36 steps: finer than the eye can see against the painted texture).
   */
  haze(ctx, ch, weight, g) {
    const col = ch.dark ? mix(ch.palette.sky, ch.palette.light, 0.3) : mix(ch.palette.sky, '#ffffff', 0.6);
    const STEPS = 36, S = g.S, W = Math.ceil((g.w + 2) * S);
    const amax = Math.min(1, ch.fog * 1.25) * weight;
    const y0 = 100, y1 = g.bottom;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = col;
    let prev = Math.round(g.ty + y0 * S);
    for (let i = 0; i < STEPS; i++) {
      const f = (i + 0.5) / STEPS, next = Math.round(g.ty + (y0 + (y1 - y0) * (i + 1) / STEPS) * S);
      const a = (f < 0.55 ? f : 0.55 + (f - 0.55) / 0.45 * 0.3) * amax;
      if (a > 0.004 && next > prev) { ctx.globalAlpha = a; ctx.fillRect(0, prev, W, next - prev); }
      prev = next;
    }
    ctx.restore();
  }

  mist(ctx, ch, weight, g) {
    const col = this.mistColor(ch), S = g.S;
    const a = Math.min(0.85, 0.2 + ch.fog * 1.1) * weight;
    const n = Math.max(3, Math.round(5 * g.density));
    const wDev = Math.ceil(MIST_W * S), P2 = g.w + MIST_W;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < n; i++) {
      const o = i * 5, u = SEEDS_MIST[o], v = SEEDS_MIST[o + 1], s1 = SEEDS_MIST[o + 2], s2 = SEEDS_MIST[o + 3];
      const par = 0.18 + 0.5 * s2;
      const x = wrap(u * P2 + (3 + 8 * s1) * g.t - g.cam * par, P2) - MIST_W;
      const y = 170 + v * (g.bottom - 170 - MIST_H * 0.55) - MIST_H * 0.3;
      ctx.globalAlpha = a * (0.55 + 0.45 * s1);
      ctx.drawImage(this.sprite('mist', col, i & 1, S), Math.round(x * S), Math.round(g.ty + y * S));
    }
    ctx.restore();
    void wDev;
  }

  clouds(ctx, ch, weight, g) {
    const tint = this.cloudTint(ch), S = g.S;
    const n = Math.max(3, Math.round(5 * g.density));
    const P2 = g.w + CLOUD_W;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < n; i++) {
      const o = i * 5, u = SEEDS_CLOUD[o], v = SEEDS_CLOUD[o + 1], s1 = SEEDS_CLOUD[o + 2], s2 = SEEDS_CLOUD[o + 3];
      const par = 0.1 + 0.28 * s2;
      const x = wrap(u * P2 + (2.5 + 7 * s1) * g.t - g.cam * par, P2) - CLOUD_W;
      const y = g.top + 6 + v * Math.min(200, (g.bottom - g.top) * 0.5);
      ctx.globalAlpha = (0.2 + 0.14 * s2) * weight;       // soft puffs over a pixel painting: kept faint so they read as haze, not smudges
      ctx.drawImage(this.sprite('cloud', tint, i % 3, S), Math.round(x * S), Math.round(g.ty + y * S));
    }
    ctx.restore();
  }

  /** Sea spray: droplets arching up from the surf, plus a soft white haze right above the water line. */
  spray(ctx, ch, weight, g) {
    const n = Math.round(42 * g.density);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const P = g.w + 40;
    for (let i = 0; i < n; i++) {
      const o = i * 5, u = SEEDS_SPRAY[o], s1 = SEEDS_SPRAY[o + 2], s2 = SEEDS_SPRAY[o + 3], s3 = SEEDS_SPRAY[o + 4];
      const period = 1.5 + 1.6 * s1, ph = frac(g.t / period + s3);
      const hgt = (26 + 60 * s2) * 4 * ph * (1 - ph);
      const x = wrap(u * P + 8 * (s2 - 0.3) * g.t - g.cam * (0.5 + 0.5 * s1), P) - 20 + ph * 14;
      const y = 332 - hgt;
      const r = 0.8 + 1.1 * s1;
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
    }
    ctx.globalAlpha = 0.55 * weight;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** The generic wrapping field (pollen, petals, dust, snow, embers, fireflies). */
  field(ctx, ch, cfg, seeds, weight, g, front) {
    if (front && !cfg.front) return;
    const st = this.styleOf(ch, cfg);
    const n = Math.max(8, Math.round(cfg.n * g.density));
    const M = 24, P = g.w + 2 * M;
    const top = g.top + (g.bottom - g.top) * cfg.y[0], H = (g.bottom - g.top) * (cfg.y[1] - cfg.y[0]);
    const t = g.t, cam = g.cam;
    const vx0 = cfg.vx[0], vxd = cfg.vx[1] - cfg.vx[0], vy0 = cfg.vy[0], vyd = cfg.vy[1] - cfg.vy[0];
    const p0 = cfg.par[0], pd = cfg.par[1] - cfg.par[0], r0 = cfg.r[0], rd = cfg.r[1] - cfg.r[0];
    if (cfg.shape === 'glow') {
      const sp = glowSprite(st.c), sp2 = st.c2 ? glowSprite(st.c2) : sp;
      const prev = ctx.globalCompositeOperation;
      if (cfg.add) ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const o = i * 5, u = seeds[o], v = seeds[o + 1], s1 = seeds[o + 2], s2 = seeds[o + 3], s3 = seeds[o + 4];
        const x = wrap(u * P + (vx0 + vxd * s1) * t + Math.sin(t * cfg.swayF * (0.6 + s1) + s3 * TAU) * cfg.sway - cam * (p0 + pd * s2), P) - M;
        const y = top + wrap(v * H + (vy0 + vyd * s1) * t + Math.cos(t * cfg.swayF * (0.5 + s2) + s1 * TAU) * cfg.sway * 0.5, H);
        const r = r0 + rd * s2;
        let a = cfg.alpha * weight;
        if (cfg.pulse) a *= 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * (0.9 + 1.4 * s1) + s3 * TAU));
        else a *= 0.55 + 0.45 * Math.sin(t * 5 * (0.4 + s1) + s3 * TAU) * Math.sin(t * 3.1 + s2 * 9);
        if (a <= 0.01) continue;
        ctx.globalAlpha = a;
        ctx.drawImage((i & 1) ? sp2 : sp, x - r, y - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = prev;
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = st.c;
    for (let tier = 0; tier < 2; tier++) {                       // two alpha tiers = two fills, not one per particle
      ctx.beginPath();
      for (let i = tier; i < n; i += 2) {
        const isFront = !!cfg.front && i % cfg.front === 0;
        if (isFront !== front) continue;
        const o = i * 5, u = seeds[o], v = seeds[o + 1], s1 = seeds[o + 2], s2 = seeds[o + 3], s3 = seeds[o + 4];
        const layer = cfg.layers ? Math.floor(s2 * cfg.layers) / (cfg.layers - 1) : s2;       // snow: three discrete depths
        const x = wrap(u * P + (vx0 + vxd * s1) * t * (0.6 + 0.4 * layer) + Math.sin(t * cfg.swayF * (0.6 + s1) + s3 * TAU) * cfg.sway - cam * (p0 + pd * layer), P) - M;
        const y = top + wrap(v * H + (vy0 + vyd * layer) * t * (0.8 + 0.2 * s1), H);
        const r = (r0 + rd * layer) * (front ? 1.25 : 1);
        if (cfg.shape === 'petal') {
          const rot = t * (0.6 + s1) + s3 * TAU, cr = Math.cos(rot), sr = Math.sin(rot);
          ctx.moveTo(x + r * cr, y + r * sr);
          ctx.ellipse(x, y, r, r * 0.55, rot, 0, TAU);
        } else {
          ctx.arc(x, y, r, 0, TAU);
          ctx.closePath();            // (starts the next dot's subpath without a moveTo: the join back to the last start retraces itself, zero area)
        }
      }
      ctx.globalAlpha = cfg.alpha * weight * (tier ? 1 : 0.62) * (front ? 0.55 : 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
