/*
 * Egg Mama — art toolkit shared by every drawing module.
 *
 * The look comes from Egg Runner 2's object art (js/art.js in benlambm/egg-runner-2):
 *   1. ONE warm light from the UPPER LEFT. Things are lightest at their upper left,
 *      true colour in the middle, darker and a little cooler at the lower right,
 *      with a thin strip of bounced light just inside the lower-right edge.
 *   2. Shadows are never grey: a hue-shifted deeper, cooler version of the thing.
 *   3. Outlines are a dark shade of the thing's OWN colour (not one black ink).
 *      INK is only for faces (eyes, beaks' tiny details).
 *   4. Round volume: rounded shapes, gradients, a soft white specular.
 *
 * Pictures are drawn in WORLD UNITS with (0,0) at the point where the thing touches
 * the ground (feet / bottom-centre), x right, y DOWN. They are drawn once into small
 * offscreen canvases at the current screen scale (SpriteCache) and stamped each frame,
 * which keeps phones fast and lets us afford careful shading.
 * The 13 pixel-art BACKGROUNDS are the only pixelated thing in the game: everything
 * here must be smooth (never turn smoothing off for sprites).
 */

export const INK = '#3a2618';
export const TAU = Math.PI * 2;

/* ───────── colour ───────── */
const hexToRgb = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

export function rgba(hex, a = 1) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
/** Blend colour a toward b by t (0..1). */
export function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
/** Lit side: toward warm sunlight. */
export const lit = (hex, t = 0.35) => mix(hex, '#fff1c4', t);
/** Shaded side: deeper and cooler, never grey. */
export const shade = (hex, t = 0.35) => mix(hex, '#2b1b4d', t);
/** Outline: a dark shade of the colour's own hue. */
export const outline = (hex, t = 0.62) => mix(hex, '#1d1230', t);
/** Bounced light for the lower-right rim. */
export const bounce = (hex, t = 0.25) => mix(hex, '#ffd9a0', t);

/* ───────── paths ───────── */
export function rr(c, x, y, w, h, r) { c.beginPath(); rrMore(c, x, y, w, h, r); }
export function rrMore(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}
export function poly(c, pts) {
  c.beginPath(); c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}
export function oval(c, x, y, rx, ry, rot = 0) { c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, TAU); }
/** An egg outline: rounder at the bottom, narrower at the top. (cx, cy) is its centre. */
export function eggPath(c, cx, cy, rx, ry) {
  c.beginPath();
  c.moveTo(cx, cy - ry);
  c.bezierCurveTo(cx + rx * 0.74, cy - ry, cx + rx, cy - ry * 0.08, cx + rx, cy + ry * 0.28);
  c.bezierCurveTo(cx + rx, cy + ry * 0.74, cx + rx * 0.56, cy + ry, cx, cy + ry);
  c.bezierCurveTo(cx - rx * 0.56, cy + ry, cx - rx, cy + ry * 0.74, cx - rx, cy + ry * 0.28);
  c.bezierCurveTo(cx - rx, cy - ry * 0.08, cx - rx * 0.74, cy - ry, cx, cy - ry);
  c.closePath();
}
export function star(c, x, y, r, points = 5, inner = 0.45, rot = -Math.PI / 2) {
  c.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + i * Math.PI / points, rad = i % 2 ? r * inner : r;
    c[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  c.closePath();
}

/* ───────── painting ───────── */
export function paint(c, fill, stroke, lw = 2) {
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(); }
}
export function linear(c, x0, y0, x1, y1, stops) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]);
  return g;
}
export function radial(c, x, y, r0, r1, stops, x1 = x, y1 = y) {
  const g = c.createRadialGradient(x, y, r0, x1, y1, r1);
  for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]);
  return g;
}
/** Soft white specular blob (the "gloss" in the upper left of rounded things). */
export function gloss(c, x, y, w, h, a = 0.6) { rr(c, x, y, w, h, Math.min(w, h) / 2); paint(c, `rgba(255,255,255,${a})`, null); }
/**
 * Fill the current path with the standard "lit from upper left" volume:
 * lit highlight at upper left, base colour in the middle, shade at lower right.
 * Call after building a path; bounds are the shape's box (x0,y0,x1,y1).
 */
export function volumeFill(c, base, x0, y0, x1, y1) {
  c.fillStyle = radial(c, x0 + (x1 - x0) * 0.32, y0 + (y1 - y0) * 0.28, 1, Math.max(x1 - x0, y1 - y0) * 0.95,
    [0, lit(base, 0.5), 0.4, base, 1, shade(base, 0.38)]);
  c.fill();
}

/* ───────── offscreen sprites ───────── */
export function createSurface(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/**
 * Draw-once cache. A sprite is described by its size in world units and an origin inside it.
 *   const s = cache.get('egg|v0', 24, 30, 12, 26, (c) => { …draw with (0,0) = origin… });
 *   cache.stamp(ctx, s, x, y, scaleX=1, scaleY=1, rotation=0, alpha=1);
 * `ctx` must already carry the world→screen transform. Call cache.setScale(pixelsPerUnit)
 * when the screen scale changes (it clears itself).
 */
export class SpriteCache {
  constructor(pad = 3) { this.scale = 1; this.pad = pad; this.map = new Map(); }
  setScale(s) { s = Math.max(0.5, Math.round(s * 100) / 100); if (s !== this.scale) { this.scale = s; this.map.clear(); } }
  clear() { this.map.clear(); }
  get(key, w, h, ox, oy, draw) {
    let s = this.map.get(key);
    if (s) return s;
    const k = this.scale, p = this.pad;
    const canvas = createSurface(Math.ceil((w + p * 2) * k), Math.ceil((h + p * 2) * k));
    const c = canvas.getContext('2d');
    c.scale(k, k); c.translate(p + ox, p + oy);
    draw(c);
    s = { canvas, w: w + p * 2, h: h + p * 2, ox: ox + p, oy: oy + p };
    this.map.set(key, s);
    return s;
  }
  stamp(ctx, s, x, y, sx = 1, sy = sx, rot = 0, alpha = 1) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(s.canvas, -s.ox, -s.oy, s.w, s.h);
    ctx.restore();
  }
}
