/*
 * Egg Mama — ACTORS: the smooth, digital-render art for everything that lives or glints in the world.
 *
 *   Mama · ducklings · eggs (plain + golden) · hatch burst · 5 walker species · 6 flyer species ·
 *   shield / magnet pickups · shield bubble · checkpoint flag
 *
 * LOOK (ported from Egg Runner 2's object art to a SIDE view): one warm light from the UPPER LEFT, rounded volume,
 * hue-shifted shadows (never grey), a thin strip of bounced light inside the lower-right edge, a soft white gloss, an
 * outline that is a dark shade of the thing's OWN colour, and INK only for faces. The light never mirrors: art that
 * faces left is re-shaded, not flipped (tools/art-sheet + tests/e2e/art-smoke.mjs prove it).
 *
 * CONVENTIONS
 *   Every call is  drawX(ctx, cache, params)  with `ctx` already carrying the world->screen transform (device px per
 *   world unit = cache.scale, i.e. 3.25 on an iPhone 13 in landscape) and `cache` a SpriteCache (artkit.mjs). Y is DOWN.
 *   ORIGIN: Mama, ducklings, walkers, flag = feet / base on the ground (x centre, y ground top).
 *           eggs, flyers, pickups = their CENTRE.  Bubble = Mama's feet (same x,y you give drawMama).
 *   `t` = seconds (any clock; ambient loops only). Missing / NaN params are tolerated (0 / defaults); unknown species
 *   fall back (walker->beetle, flyer->bee) and incomplete palettes are filled in from Meadow: nothing here throws.
 *   Calls leave ctx's transform and alpha as they found them and switch image smoothing ON (the painted backgrounds are
 *   drawn with smoothing off; sprites are smooth art).
 *   Performance: everything is drawn once at the current scale into the SpriteCache and stamped every frame. Mama and
 *   the ducklings are a few cached PARTS (shell, face, wing, tuft, feet) placed with continuous transforms, so rock,
 *   squash, waddle and wing flap are smooth with no frame sprites. Enemies/flag pennants are baked as 12 frames per cycle
 *   per facing. Cache keys come from a small fixed set of variants; palette-dependent sprites live in per-palette groups
 *   and only the 3 most recently used groups are kept, so an hour of travel never grows the cache (see art-bounds test).
 *
 * EXPORTS
 *   drawMama(ctx, cache, { x, y, face, vx, vy, phase, onGround, squash, hurt, invulnFlash, shield, happy, t, rock, dark?, alpha? })
 *       x,y feet. face ±1 (the egg turns to face; the beak/eyes/wing flip). vx/vy u/s (tuft lag, stretch, step rate).
 *       phase = sim's m.phase (distance travelled): drives the waddle (feet alternate) and, unless `rock` is given, the
 *       rock angle sin(phase*0.09)*0.10*speed. `rock` radians: pass it (reduced-motion: x0.25) and it is used as is;
 *       leave it undefined and Mama rocks herself. onGround false = airborne pose (stretch, wings up, feet tucked).
 *       squash 0..1 = landing squash (sim m.squash). hurt 0..1 = wince (eyes > <, pink flush, wings out, jolt).
 *       invulnFlash true = the renderer's blink phase: drawn at 42 % alpha (still visible to a child). shield true =
 *       a cool blue rim on the shell (the bubble itself is drawShieldBubble: drawMama never draws one). happy = the
 *       beacon hop (^ ^ eyes, fast wing flaps, bounce). alpha 0..1 = optional fade. Blinks every ~3.7 s by itself.
 *   drawDuckling(ctx, cache, { x, y, face, air, t, i, alpha, dark? })
 *       i = phase offset (the flock index) so five chicks don't waddle in unison. air = hopping with Mama. alpha = fade.
 *   drawEgg(ctx, cache, { x, y, kind: 'egg'|'gold', t, i, dark? })
 *       'egg' = small cream speckled oval, gentle bob. 'gold' = bigger, golden, POINTED top, jewelled belt, glow halo,
 *       pulsing 4-point twinkles, bouncier: a different silhouette, not just a different colour.
 *   drawHatchBurst(ctx, cache, { x, y, progress 0..1, dark? })   x,y = the golden egg's centre. 0..0.3 it shakes and
 *       cracks; then the cap flies off, a flash + star burst, a duckling pops out of the cup, hops and fades (the real
 *       follower takes over). Designed for the 0.9 s hatch.
 *   drawWalker(ctx, cache, { species: 'snail'|'caterpillar'|'beetle'|'crab'|'mite', palette, x, y, face, t, squash, i?, dark? })
 *   drawFlyer (ctx, cache, { species: 'bee'|'moth'|'gull'|'bat'|'owl'|'hawk',        palette, x, y, face, t, i?, dark? })
 *       palette = chapters[i].palette. Each species has a few natural colour ways; we pick the one that contrasts best with
 *       the landscape (ground for walkers, sky for flyers) and tint it toward the palette's accent, so enemies sit in their
 *       landscape yet keep a bold silhouette. Every enemy glares (angled brows, big eyes) and keeps its stinger / pincers /
 *       fangs / hooked beak to the FRONT or underside, with a smooth rounded top: "hurts" from the sides, "stomp me" from
 *       above. squash 0..1 flattens a stomped walker (the renderer fades it). i = optional phase offset (e.g. enemy id).
 *   drawShieldPickup / drawMagnetPickup(ctx, cache, { x, y, t, dark? })
 *       shield = round scalloped BLUE medal with a white shield; magnet = RED horseshoe with silver tips and sparks. No
 *       faces, never yellow: they cannot be mistaken for a duckling.
 *   drawShieldBubble(ctx, cache, { x, y, t, pop 0..1, dark? })   x,y = Mama's feet. pop>0 = bursting (expands, fades, shards).
 *   drawFlag(ctx, cache, { x, y, active, t, palette, dark? })     active=false: limp grey pennant with a hollow egg;
 *       active=true: a proud, waving, glowing pennant in a palette-contrasting colour with a golden egg and sparkles.
 *   ACTOR_SIZES = { mama, duckling, egg, gold, walker, flyer, pickup, bubble, flag }  art extents (w,h, plus shadowW for the
 *       things that stand on ground) so the renderer can place contact shadows. Measured in tests/e2e/art-smoke.mjs.
 *   prewarmActors(cache, { palette, species: [...], dark, cast, flags, budgetMs }) -> boolean   optional but recommended: bake every
 *       frame of the given walker/flyer species (both facings), the flag and/or the whole cast ahead of time, e.g. while the next
 *       landscape's painting decodes. budgetMs makes it incremental (call once per frame until it returns true).
 *
 * DARK CHAPTERS (`dark: true` = chapter.dark): every sprite gets a soft warm glow and a thin bright rim light baked around
 * its silhouette, so creatures and the cast pop against Lantern Caverns / Moonridge. Pass chapter.dark to every call. (Calls
 * that carry a palette - walkers, flyers, flags - work it out from the palette if `dark` is omitted; Mama, ducklings, eggs,
 * pickups and the bubble have no palette, so they only go dark when told.)
 * (Moths always carry a gentle lantern glow; they are the "moth lanterns" of Fogwood.)
 *
 * Dev tooling: tools/art-sheet.mjs renders contact sheets at real phone scale; tests/e2e/art-*.mjs check extents,
 * lighting direction, robustness, cache bounds and speed.
 */
import { INK, TAU, rgba, mix, lit, shade, outline, bounce, rr, eggPath, linear, radial, createSurface } from './artkit.mjs';

const PI = Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d);
const frac = (v) => v - Math.floor(v);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/* ───────────────────────── colour families ───────────────────────── */
// l = lit side, m = true colour, d = shade side (hue-shifted, never grey), b = bounced light, k = own-hue outline.
function fam(m, o = {}) {
  return { m, l: o.l || lit(m, 0.5), d: o.d || shade(m, 0.34), b: o.b || bounce(m, 0.32), k: o.k || outline(m, 0.62) };
}

/* ───────────────────────── sprite helpers ───────────────────────── */
// All art is authored in a local space whose origin is the feet (or the centre, for eggs/flyers).
// A sprite is cached for a bounding box [x0,x1]×[y0,y1] of that space and stamped with its origin on (0,0).
function sprite(cache, key, x0, y0, x1, y1, draw) {
  return cache.get(key, x1 - x0, y1 - y0, -x0, -y0, draw);
}
/** Draw a sprite with its origin at the current transform's (0,0). */
function blit(ctx, s) { ctx.drawImage(s.canvas, -s.ox, -s.oy, s.w, s.h); }
function blitAt(ctx, s, x, y, rot = 0, sx = 1, sy = sx, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
  if (alpha < 1) ctx.globalAlpha *= alpha;
  ctx.drawImage(s.canvas, -s.ox, -s.oy, s.w, s.h);
  ctx.restore();
}
/** Sprites are smooth art: make sure the (possibly pixel-art-configured) context smooths them. */
function smoothOn(ctx) {
  if (ctx.imageSmoothingEnabled === false) ctx.imageSmoothingEnabled = true;
  // QA-VISUAL (performance): 'low' (bilinear), not 'high' (bicubic / mipmaps). Every sprite is baked at the screen's own scale, so a stamp is
  // ~1:1 plus a sub-pixel bob; 'high' cost ~1 ms per frame on the software rasteriser for a typical egg trail and showed no visible gain.
  if (ctx.imageSmoothingQuality !== 'low') ctx.imageSmoothingQuality = 'low';
}

/**
 * Cache a sprite for a box [x0,x1]×[y0,y1] of local space, optionally facing (f = ±1; 0/undefined = no facing),
 * with an optional dark-chapter treatment: a soft glow plus a thin bright rim light around its silhouette.
 * `glow` = null | { rim, glow, blur, w } (colours; blur radius and rim width in world units).
 * draw(c, f) paints facing RIGHT (the canvas is mirrored for f < 0; use `f` only to keep the light on the upper left).
 */
function bake(cache, key, f, x0, y0, x1, y1, draw, glow, K = 1) {
  const flip = f < 0;
  const R = glow ? Math.ceil(glow.blur * 1.4 + glow.w + 1) : 0;
  // box in FINAL world units: the design-space box times the art scale K (art is drawn at K, so it stays crisp)
  const a = (flip ? -x1 : x0) * K - R, b = (flip ? -x0 : x1) * K + R, ya = y0 * K - R, yb = y1 * K + R;
  return cache.get(key + (flip ? '|L' : '|R'), b - a, yb - ya, -a, -ya, (c) => {
    if (!glow) { c.scale(K, K); if (flip) c.scale(-1, 1); draw(c, flip ? -1 : 1); return; }
    const k = cache.scale, p = cache.pad;
    const W = Math.ceil((b - a + 2 * p) * k), H = Math.ceil((yb - ya + 2 * p) * k);
    const art = createSurface(W, H), ac = art.getContext('2d');
    ac.scale(k, k); ac.translate(p - a, p - ya); ac.scale(K, K); if (flip) ac.scale(-1, 1); draw(ac, flip ? -1 : 1);
    const sil = createSurface(W, H), sc = sil.getContext('2d');
    sc.drawImage(art, 0, 0); sc.globalCompositeOperation = 'source-in'; sc.fillStyle = glow.rim; sc.fillRect(0, 0, W, H);
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
    c.shadowColor = glow.glow; c.shadowBlur = glow.blur * k;
    c.drawImage(sil, 0, 0);
    c.shadowBlur = 0; c.shadowColor = 'rgba(0,0,0,0)';
    const r = glow.w * k;
    for (let i = 0; i < 12; i++) { const an = i * TAU / 12; c.drawImage(sil, Math.cos(an) * r, Math.sin(an) * r); }
    c.drawImage(art, 0, 0);
    c.restore();
  });
}

/* ───────────────────────── drawing helpers ───────────────────────── */
function ell(c, x, y, rx, ry, rot = 0) { c.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot)); c.ellipse(x, y, rx, ry, rot, 0, TAU); }
function ellPath(c, x, y, rx, ry, rot = 0) { c.beginPath(); ell(c, x, y, rx, ry, rot); }
function stroke(c, col, w) { c.strokeStyle = col; c.lineWidth = w; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(); }
function fill(c, col) { c.fillStyle = col; c.fill(); }
/** Fill + outline the current path. */
function ink(c, f, k, w) { fill(c, f); stroke(c, k, w); }
/** Outline a union of sub-paths (they may overlap): stroke wide first, then fill, so inner seams vanish. */
function blob(c, build, fillStyle, k, w) {
  c.beginPath(); build(c);
  stroke(c, k, w * 2); fill(c, fillStyle);
}
function dot(c, x, y, r, col) { c.beginPath(); c.arc(x, y, r, 0, TAU); fill(c, col); }

/** Radial "lit from the upper left" fill for a roundish thing centred (cx,cy). `f` = facing sign (see fsprite). */
function ballGrad(c, cx, cy, rx, ry, p, f = 1) {
  const g = c.createRadialGradient(cx - 0.4 * f * rx, cy - 0.44 * ry, Math.min(rx, ry) * 0.08, cx + 0.02 * f * rx, cy + 0.08 * ry, Math.max(rx, ry) * 1.2);
  g.addColorStop(0, p.l); g.addColorStop(0.42, p.m); g.addColorStop(0.86, p.d); g.addColorStop(1, p.d);
  return g;
}
/** The thin strip of bounced light just inside the lower-right edge. */
function rimStrip(c, path, x0, y0, x1, y1, col, w) {
  c.save(); path(); c.clip(); path();
  c.strokeStyle = linear(c, x0, y0, x1, y1, [0, rgba(col, 0), 0.5, rgba(col, 0), 1, rgba(col, 0.95)]);
  c.lineWidth = w; c.lineJoin = 'round'; c.stroke();
  c.restore();
}
/** A soft white gleam blob. */
function gleam(c, x, y, rx, ry, rot, a = 0.85) { ellPath(c, x, y, rx, ry, rot); fill(c, `rgba(255,255,255,${a})`); }
/** Volume + bounced light + outline + gloss for a round shape. */
function solid(c, path, cx, cy, rx, ry, p, lw, f, o = {}) {
  path(); fill(c, ballGrad(c, cx, cy, rx, ry, p, f));
  rimStrip(c, path, cx - f * rx * 0.2, cy - ry * 0.1, cx + f * rx * 0.8, cy + ry * 0.9, p.b, Math.max(rx, ry) * (o.rimW || 0.36));
  path(); stroke(c, p.k, lw);
  if (o.gloss !== false) gleam(c, cx - f * rx * 0.42, cy - ry * 0.46, rx * 0.2, ry * 0.26, 0.5 * f, o.gloss || 0.9);
}
/** A leaf / feather / petal: from (0,0) up to (0,-len), `wid` half-width at the belly, then rotated and added to the path. */
function leaf(c, len, wid, rot, ox = 0, oy = 0) {
  const s = Math.sin(rot), co = Math.cos(rot);
  const P = (x, y) => [ox + x * co - y * s, oy + x * s + y * co];
  const a = P(0, 0), b1 = P(-wid, -len * 0.3), b2 = P(-wid * 0.9, -len * 0.8), t = P(0, -len), b3 = P(wid * 0.9, -len * 0.8), b4 = P(wid, -len * 0.3);
  c.moveTo(a[0], a[1]);
  c.bezierCurveTo(b1[0], b1[1], b2[0], b2[1], t[0], t[1]);
  c.bezierCurveTo(b3[0], b3[1], b4[0], b4[1], a[0], a[1]);
  c.closePath();
}
/** A 4-point twinkle star (concave sides). */
function twinkle(c, x, y, r, rot = 0, pinch = 0.16) {
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const a0 = rot + i * PI / 2, a1 = a0 + PI / 4, a2 = a0 + PI / 2;
    const px = x + Math.cos(a0) * r, py = y + Math.sin(a0) * r;
    if (i === 0) c.moveTo(px, py);
    c.quadraticCurveTo(x + Math.cos(a1) * r * pinch * 1.5, y + Math.sin(a1) * r * pinch * 1.5, x + Math.cos(a2) * r, y + Math.sin(a2) * r);
  }
  c.closePath();
}

/* ───────────────────────── dark-chapter lighting ───────────────────────── */
const WARM_GLOW = { rim: '#fff0b8', glow: 'rgba(255,214,120,0.62)', blur: 5.5, w: 1.0 };
const glowFor = (dark, g = WARM_GLOW) => (dark ? g : null);
const dk = (dark) => (dark ? '|d' : '');

/* ═════════════════════════════════ MAMA ═════════════════════════════════ */
const MAMA = fam('#ffedc6', { l: '#fffcee', d: '#e9b3a2', b: '#ffdba8', k: '#8a5230' });
const WING = fam('#ffe4b4', { l: '#fff6dc', d: '#eab096', b: '#ffdcb0', k: '#9a6038' });
const BEAK = fam('#ff9d2e', { l: '#ffc766', d: '#e0701a', k: '#98430f' });
const FOOT = fam('#ffa13a', { l: '#ffcf80', d: '#e06d1c', k: '#98430f' });
const BOW = fam('#ff86b0', { l: '#ffc4d8', d: '#e0508a', k: '#8f2457' });
const TUFT = fam('#ffc85a', { l: '#ffeaa4', d: '#e8902a', k: '#97581a' });
const CHEEK = 'rgba(255,100,126,0.55)';

const M_BODY = { cx: 0, cy: -22.4, rx: 16.8, ry: 19.8 };

function mamaBody(c, f) {
  const { cx, cy, rx, ry } = M_BODY;
  const path = () => eggPath(c, cx, cy, rx, ry);
  solid(c, path, cx, cy, rx, ry, MAMA, 1.9, f, { gloss: false, rimW: 7 });
  // a few speckles on the lower shell: she is an egg, after all
  c.save(); path(); c.clip();
  c.fillStyle = 'rgba(190,130,92,0.6)';
  for (const [x, y, rx2, ry2, r] of [[-8.5, -9, 1.3, 0.9, 0.4], [4, -5.5, 1.1, 0.8, -0.3], [-2, -4.6, 0.9, 0.7, 0.2], [9.5, -12, 1, 0.75, 0.5], [-12.5, -17, 1, 0.8, -0.4], [-5, -14, 0.8, 0.6, 0.1]]) {
    ellPath(c, x * 1, y, rx2, ry2, r); c.fill();
  }
  c.restore();
  gleam(c, cx - f * 8.2, cy - 10.5, 3.3, 5.6, 0.5 * f, 0.88);
  gleam(c, cx - f * 5.2, cy - 15.6, 1.3, 1.5, 0, 0.8);
}

function mamaWing(c, f) {
  // a small tucked wing: hangs from its root (0,0) down and back (toward -x); three soft feather lobes
  c.save(); c.rotate(0.3);
  const path = () => {
    c.beginPath();
    c.moveTo(-1.2, -1.2);
    c.bezierCurveTo(-4.2, 1.4, -4.6, 6.6, -3.6, 9.4);
    c.quadraticCurveTo(-3.2, 11.8, -1.4, 11.4);         // outer lobe
    c.quadraticCurveTo(-0.3, 13.4, 1.3, 11.6);          // middle lobe
    c.quadraticCurveTo(3.4, 12, 3.8, 9.2);              // inner lobe
    c.bezierCurveTo(4.8, 5.4, 3.8, 1, 1.4, -1.2);
    c.closePath();
  };
  solid(c, path, 0, 5, 4.4, 6.6, WING, 1.3, f, { gloss: 0.6 });
  c.beginPath(); c.moveTo(-1.2, 3.4); c.lineTo(-1.5, 9); c.moveTo(1.2, 3.4); c.lineTo(1.5, 9.2);
  stroke(c, rgba(WING.k, 0.25), 0.6);
  c.restore();
}

function mamaFoot(c, f) {
  // orange webbed foot, toes forward (+x), origin = ground contact under the foot's centre
  blob(c, (cc) => { ell(cc, -0.4, -2.0, 4.2, 2.1); ell(cc, 3.6, -1.2, 1.6, 1.2); ell(cc, 3.0, -2.9, 1.5, 1.1); ell(cc, 4.3, -2.0, 1.4, 1.1); },
    linear(c, 0, -4.2, 0, 0.4, [0, FOOT.l, 0.5, FOOT.m, 1, FOOT.d]), FOOT.k, 0.85);
}

function mamaFace(c, f, mood) {
  const eyeY = -27.4;
  // cheeks first (under the eyes)
  ellPath(c, 2.4, -21.4, 3.5, 2.3, 0); fill(c, CHEEK);
  ellPath(c, 13.6, -22.1, 2.0, 1.6, 0); fill(c, 'rgba(255,100,126,0.38)');
  const eye = (x, y, rx, ry, big) => {
    if (mood === 'open') {
      ellPath(c, x, y, rx, ry); fill(c, INK);
      gleam(c, x - rx * 0.3, y - ry * 0.36, rx * 0.44, rx * 0.44, 0, 0.98);
      gleam(c, x + rx * 0.4, y + ry * 0.45, rx * 0.2, rx * 0.2, 0, 0.7);
    } else if (mood === 'blink') {
      c.beginPath(); c.moveTo(x - rx, y + 0.3); c.quadraticCurveTo(x, y + ry * 0.75, x + rx, y + 0.3); stroke(c, INK, 1.2);
    } else if (mood === 'happy') {
      c.beginPath(); c.moveTo(x - rx * 1.05, y + ry * 0.45); c.quadraticCurveTo(x, y - ry * 1.15, x + rx * 1.05, y + ry * 0.45); stroke(c, INK, 1.4);
    } else { // wince: > <
      c.beginPath();
      if (big) { c.moveTo(x - rx, y - ry * 0.7); c.lineTo(x + rx * 0.9, y); c.lineTo(x - rx, y + ry * 0.7); }
      else { c.moveTo(x + rx, y - ry * 0.7); c.lineTo(x - rx * 0.9, y); c.lineTo(x + rx, y + ry * 0.7); }
      stroke(c, INK, 1.4);
    }
  };
  eye(4.6, eyeY, 2.9, 3.7, true);
  eye(12.3, eyeY - 0.1, 2.2, 3.2, false);
  // soft brows, very light: a hint of expression (worried when wincing)
  c.beginPath();
  if (mood === 'wince') { c.moveTo(1.8, -32.9); c.lineTo(7.2, -34.4); c.moveTo(10.6, -34.2); c.lineTo(14.4, -32.8); }
  else if (mood !== 'happy') { c.moveTo(2.6, -33.4); c.quadraticCurveTo(5, -35.2, 7.6, -34.4); c.moveTo(10.2, -34.2); c.quadraticCurveTo(12.4, -35, 14, -33.8); }
  stroke(c, rgba(MAMA.k, 0.5), 0.8);
  // the tiny beak, on the front edge of the shell
  const open = mood === 'happy' || mood === 'wince';
  c.beginPath();
  c.moveTo(14.6, -25.6); c.bezierCurveTo(17.4, -26.8, 21.6, -25.2, 23.4, -23); c.bezierCurveTo(21.2, -22, 17.4, -21.8, 14.6, -22.4); c.closePath();
  ink(c, linear(c, 0, -26.5, 0, -22, [0, BEAK.l, 0.5, BEAK.m, 1, BEAK.d]), BEAK.k, 1.05);
  c.beginPath();
  c.moveTo(14.8, -22.2); c.bezierCurveTo(17.4, -22, 20.2, -21.8, 21.6, -21 + (open ? 1.4 : 0)); c.bezierCurveTo(19.8, -19.2 + (open ? 1.2 : 0), 16.6, -19.4, 14.8, -20.4); c.closePath();
  ink(c, linear(c, 0, -22.4, 0, -19, [0, BEAK.m, 1, BEAK.d]), BEAK.k, 1.05);
  gleam(c, 17.8, -24.8, 1.8, 0.6, 0.15, 0.7);
  if (mood === 'wince') { ellPath(c, 18.6, -36.4, 0.95, 1.5, 0.2); fill(c, '#8fd3ff'); } // a sweat bead
}

function mamaTuft(c, f) {
  c.scale(0.82, 0.82);
  // origin = where the tuft grows out of the shell. A tuft of three feathers and a little pink bow behind it.
  blob(c, (cc) => { leaf(cc, 8.2, 2.5, -0.62); leaf(cc, 10.8, 2.9, 0.02); leaf(cc, 8.8, 2.5, 0.64); },
    linear(c, 0, -11, 0, 0, [0, TUFT.l, 0.55, TUFT.m, 1, TUFT.d]), TUFT.k, 0.95);
  // bow
  const bx = -f * 4.6, by = 0.8;
  c.save(); c.translate(bx, by);
  for (const s of [-1, 1]) {
    c.save(); c.rotate(s * 0.42);
    ellPath(c, s * 3.3, 0, 3.6, 2.4, 0); ink(c, linear(c, 0, -2.4, 0, 2.4, [0, BOW.l, 0.5, BOW.m, 1, BOW.d]), BOW.k, 1.0);
    c.restore();
  }
  ellPath(c, 0, 0, 1.7, 1.7, 0); ink(c, BOW.m, BOW.k, 0.9);
  gleam(c, -0.5, -0.5, 0.6, 0.5, 0, 0.8);
  c.restore();
}

function mamaTint(c, f) {
  const { cx, cy, rx, ry } = M_BODY;
  eggPath(c, cx, cy, rx, ry); fill(c, 'rgba(255,92,100,0.5)');
}

/** Mama is authored at 1:1 (42 u shell) and drawn at this scale: shell 38 u = her hurtbox, art ≈ 46 u with tuft. */
const MAMA_K = 0.9;
const SHIELD_GLOW = { rim: '#d6f0ff', glow: 'rgba(80,160,255,0.75)', blur: 4.5, w: 0.8 };

/**
 * drawMama — composed from a handful of cached parts placed with continuous transforms, so her rocking, squash,
 * waddle and wing flap are smooth without frame sprites. Origin = feet.
 */
export function drawMama(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const f = p.face < 0 ? -1 : 1;
  const t = num(p.t), vx = num(p.vx), vy = num(p.vy);
  const air = p.onGround === false;
  const dark = !!p.dark;
  const hurt = clamp(num(p.hurt), 0, 1);
  const happy = !!p.happy;
  const speed = clamp(Math.abs(vx) / 110, 0, 1.5);
  const sp1 = Math.min(speed, 1);
  const ph = num(p.phase) * 0.09;
  const sph = Math.sin(ph);
  let rock = p.rock === undefined ? (air ? 0 : sph * 0.10 * speed) : num(p.rock);

  // squash & stretch (about her feet)
  const land = clamp(num(p.squash), 0, 1);
  let sy = 1 - 0.2 * land, sx = 1 + 0.15 * land;
  if (air) { const st = clamp(Math.abs(vy) / 650, 0, 1) * 0.1 * (vy < 0 ? 1 : 0.7); sy += st; sx -= st * 0.6; }
  if (!air && !land && speed < 0.05) { const br = Math.sin(t * 2.2) * 0.012; sy += br; sx -= br * 0.5; } // breathing
  sy -= 0.1 * hurt; sx += 0.08 * hurt;
  let hop = 0;
  if (happy) { const h = Math.abs(Math.sin(t * 6.4)); hop = -h * 9; if (h < 0.18) { sy -= 0.07 * (1 - h / 0.18); sx += 0.05 * (1 - h / 0.18); } }
  const bob = air || happy ? 0 : -Math.abs(Math.cos(ph)) * 1.1 * sp1;
  rock += -0.13 * hurt * f;

  // face
  const bl = frac(t / 3.7 + 0.31);
  const mood = hurt > 0.12 ? 'wince' : happy ? 'happy' : (bl < 0.034 || (bl > 0.5 && bl < 0.53)) ? 'blink' : 'open';

  // wings & tuft
  let wing;
  if (happy) wing = 1.0 + Math.sin(t * 17) * 0.34;
  else if (hurt > 0.12) wing = 0.7 + Math.sin(t * 40) * 0.1;
  else if (air) wing = vy < 0 ? 0.85 + Math.sin(t * 26) * 0.16 : 0.7 + Math.sin(t * 22) * 0.34;
  else wing = 0.04 + speed * (0.14 + 0.16 * (0.5 + 0.5 * Math.sin(ph * 2 + 1)));
  const tuftRot = clamp(-vx / 110, -1.5, 1.5) * 0.2 + rock * 0.8 + Math.sin(t * 8.5) * 0.04 * (0.4 + speed);
  const tuftSy = air ? (vy < 0 ? 0.88 : 1.12) : 1;

  const glow = p.shield ? SHIELD_GLOW : dark ? WARM_GLOW : null;
  const gk = p.shield ? '|s' : dark ? '|d' : '';
  const K = MAMA_K;
  const sBody = bake(cache, 'mama|body' + gk, f, -19, -46, 19, 3, mamaBody, glow, K);
  const sWing = bake(cache, 'mama|wing', f, -12, -6, 10, 18, mamaWing, null, K);
  const sFoot = bake(cache, 'mama|foot', f, -7, -6, 8, 1, mamaFoot, null, K);
  const sFace = bake(cache, 'mama|face|' + mood, f, -2, -40, 26, -12, (c, ff) => mamaFace(c, ff, mood), null, K);
  const sTuft = bake(cache, 'mama|tuft', f, -12, -14, 12, 4, mamaTuft, null, K);

  ctx.save();
  ctx.translate(num(p.x) + (hurt ? Math.sin(t * 70) * 0.9 * hurt : 0), num(p.y) + hop * K);
  if (p.invulnFlash) ctx.globalAlpha *= 0.42;
  if (p.alpha !== undefined) ctx.globalAlpha *= clamp(num(p.alpha, 1), 0, 1);
  ctx.scale(sx, sy);
  // feet: planted on the ground, they lift alternately as she waddles
  const l1 = air ? 1.6 : Math.max(0, sph) * 3.1 * sp1, l2 = air ? 1.6 : Math.max(0, -sph) * 3.1 * sp1;
  const fx1 = air ? -5.5 : -5.8 + Math.cos(ph) * 1.4 * sp1, fx2 = air ? 5.2 : 5.6 + Math.cos(ph) * 1.4 * sp1;
  blitAt(ctx, sFoot, fx1 * K, -l1 * K);
  blitAt(ctx, sFoot, fx2 * K, -l2 * K);
  // the shell rocks about her feet
  ctx.rotate(rock);
  ctx.translate(0, bob * K);
  blit(ctx, sBody);
  if (hurt > 0.05) { blitAt(ctx, bake(cache, 'mama|tint', f, -19, -46, 19, 3, mamaTint, null, K), 0, 0, 0, 1, 1, hurt * 0.4); }
  blitAt(ctx, sWing, -f * 2.6 * K, -25.4 * K, wing * f);
  blit(ctx, sFace);
  blitAt(ctx, sTuft, f * 1.1 * K, -40.4 * K, tuftRot, 1, tuftSy);
  ctx.restore();
}

/* ═══════════════════════════════ DUCKLINGS ═══════════════════════════════ */
const CHICK = fam('#ffd83d', { l: '#fff6a8', d: '#f0a21f', b: '#ffe887', k: '#9a5a06' });
/** Chicks are authored 1:1 and drawn at this scale (≈ 22 u, half of Mama). */
const DUCK_K = 0.88;
const BILL = fam('#ff8f24', { l: '#ffc069', d: '#e0601a', k: '#9a3c0a' });

function chickBody(c, f, blink) {
  const build = (cc) => { ell(cc, -1.2, -8.2, 8.4, 6.9); ell(cc, 4.6, -14.4, 6.4, 6.2); ell(cc, -9.4, -9.4, 2.6, 1.9, -0.5); };
  blob(c, build, ballGradU(c, f), CHICK.k, 1.25);
  // bounced light along the belly, then a soft gloss on the head
  c.save(); c.beginPath(); build(c); c.clip();
  ellPath(c, 0.5, -3.4, 8.5, 2.4); fill(c, rgba(CHICK.b, 0.65));
  c.restore();
  gleam(c, 3.0, -17.4, 2.3, 1.7, 0.5 * f, 0.9);
  // cheek, eye, bill
  ellPath(c, 3.4, -11.8, 1.9, 1.3); fill(c, 'rgba(255,110,120,0.55)');
  if (blink) { c.beginPath(); c.moveTo(5.2, -15.2); c.quadraticCurveTo(6.7, -14.2, 8.2, -15.2); stroke(c, INK, 1.0); }
  else { ellPath(c, 6.8, -15.4, 1.6, 2.0); fill(c, INK); gleam(c, 6.3, -16.2, 0.62, 0.62, 0, 1); }
  blob(c, (cc) => { cc.moveTo(10.3, -15.3); cc.quadraticCurveTo(14.6, -15.2, 15.2, -13.4); cc.quadraticCurveTo(13.4, -11.6, 10.4, -12.1); cc.closePath(); },
    linear(c, 0, -15.5, 0, -11.5, [0, BILL.l, 0.5, BILL.m, 1, BILL.d]), BILL.k, 0.7);
  c.beginPath(); c.moveTo(10.8, -13.6); c.lineTo(14.2, -13.5); stroke(c, rgba(BILL.k, 0.8), 0.6);
  // two downy head hairs
  c.beginPath(); c.moveTo(3.6, -20.2); c.quadraticCurveTo(2.2, -23, 3.8, -24.2); c.moveTo(5.6, -20.5); c.quadraticCurveTo(6.2, -23.4, 8, -23.8);
  stroke(c, CHICK.k, 1.0);
  c.beginPath(); c.moveTo(3.6, -20.2); c.quadraticCurveTo(2.2, -23, 3.8, -24.2); c.moveTo(5.6, -20.5); c.quadraticCurveTo(6.2, -23.4, 8, -23.8);
  stroke(c, CHICK.m, 0.45);
}
function ballGradU(c, f) { return ballGrad(c, 0.5, -12, 11, 10.5, CHICK, f); }

function chickWing(c, f) {
  c.save(); c.rotate(0.4);
  blob(c, (cc) => { cc.moveTo(0.6, -0.6); cc.bezierCurveTo(-4.4, 0.5, -5.4, 4.6, -3.6, 6.6); cc.bezierCurveTo(-1.8, 8.2, 2.4, 5.8, 2.2, 0.6); cc.closePath(); },
    linear(c, 0, 0, 0, 7, [0, CHICK.m, 1, CHICK.d]), CHICK.k, 0.85);
  c.beginPath(); c.moveTo(-1.8, 2.2); c.lineTo(-1.5, 5); stroke(c, rgba(CHICK.k, 0.4), 0.5);
  c.restore();
}
function chickFoot(c) {
  c.beginPath(); c.moveTo(0, -3.4); c.lineTo(0, -1.2); stroke(c, BILL.k, 1.5); c.beginPath(); c.moveTo(0, -3.4); c.lineTo(0, -1.2); stroke(c, BILL.m, 0.7);
  blob(c, (cc) => { ell(cc, 0.7, -0.8, 2.8, 1.0); ell(cc, 2.6, -0.8, 1.0, 0.8); }, BILL.m, BILL.k, 0.55);
}

/** Little yellow chick follower. `i` = phase offset, `air` = hopping, `alpha` = fade (0..1). Origin = feet. */
export function drawDuckling(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const f = p.face < 0 ? -1 : 1;
  const t = num(p.t), i = num(p.i);
  const air = !!p.air, dark = !!p.dark;
  const a = p.alpha === undefined ? 1 : clamp(num(p.alpha, 1), 0, 1);
  if (a <= 0) return;
  const w = t * 9.5 + i * 1.7, sw = Math.sin(w);
  const bl = frac(t / 2.9 + i * 0.37);
  const blink = bl < 0.045;
  const K = DUCK_K;
  const sBody = bake(cache, 'duck|body' + (blink ? 'b' : 'o') + dk(dark), f, -13, -26, 18, 3, (c, ff) => chickBody(c, ff, blink), glowFor(dark), K);
  const sWing = bake(cache, 'duck|wing', f, -9, -3, 6, 12, chickWing, null, K);
  const sFoot = bake(cache, 'duck|foot', f, -4, -5, 6, 1, chickFoot, null, K);

  ctx.save();
  ctx.translate(num(p.x), num(p.y));
  if (a < 1) ctx.globalAlpha *= a;
  let sy = 1, sx = 1, bob = 0, rock = 0, wing, l1 = 0, l2 = 0;
  if (air) {
    sy = 1.1; sx = 0.93; wing = 1.1 + Math.sin(t * 24 + i) * 0.45; l1 = 2.4; l2 = 1.6; rock = -0.1 * f;
  } else {
    bob = -Math.abs(sw) * 1.5; rock = sw * 0.09; wing = 0.12 + (0.5 + 0.5 * Math.sin(w * 2)) * 0.12;
    l1 = Math.max(0, sw) * 2.2; l2 = Math.max(0, -sw) * 2.2;
  }
  ctx.scale(sx, sy);
  blitAt(ctx, sFoot, -2.6 * K, -l1 * K);
  blitAt(ctx, sFoot, 2.4 * K, -l2 * K);
  ctx.rotate(rock);
  ctx.translate(0, bob * K);
  blit(ctx, sBody);
  blitAt(ctx, sWing, -f * 1.6 * K, -9.4 * K, wing * f);
  ctx.restore();
}

/* ═════════════════════════════════ EGGS ═════════════════════════════════ */
const SHELL = fam('#fff3d6', { l: '#fffdf2', d: '#e2b9a4', b: '#ffe6c4', k: '#8a5a38' });
const GOLD = fam('#ffd23a', { l: '#fffbd6', d: '#ea8a00', b: '#ffe58a', k: '#8a4a00' });

function plainEgg(c, f) {
  const cx = 0, cy = 0, rx = 7.2, ry = 8.7;
  const path = () => eggPath(c, cx, cy, rx, ry);
  solid(c, path, cx, cy, rx, ry, SHELL, 1.4, f, { gloss: 0.95, rimW: 3 });
  c.save(); path(); c.clip();
  c.fillStyle = 'rgba(176,110,70,0.7)';
  for (const [x, y, a, b, r] of [[-2.8, 3.4, 0.95, 0.7, 0.4], [2.4, 5.6, 0.8, 0.6, -0.3], [3.6, -1.6, 0.75, 0.55, 0.5], [-0.8, 0.8, 0.6, 0.5, 0], [-4.2, -1.4, 0.55, 0.45, 0.3], [0.2, 6.6, 0.55, 0.45, 0.2]]) { ellPath(c, x, y, a, b, r); c.fill(); }
  c.restore();
}
function goldPath(c, cx, cy, rx, ry) {
  // an egg with a little crown-point at the top: unmistakably not the plain oval
  c.beginPath();
  c.moveTo(cx, cy - ry - 1.9);
  c.bezierCurveTo(cx + rx * 0.16, cy - ry * 0.92, cx + rx * 0.5, cy - ry * 0.82, cx + rx * 0.76, cy - ry * 0.42);
  c.bezierCurveTo(cx + rx * 1.02, cy - ry * 0.02, cx + rx, cy + ry * 0.4, cx + rx * 0.74, cy + ry * 0.7);
  c.bezierCurveTo(cx + rx * 0.5, cy + ry * 1.0, cx + rx * 0.18, cy + ry, cx, cy + ry);
  c.bezierCurveTo(cx - rx * 0.18, cy + ry, cx - rx * 0.5, cy + ry * 1.0, cx - rx * 0.74, cy + ry * 0.7);
  c.bezierCurveTo(cx - rx, cy + ry * 0.4, cx - rx * 1.02, cy - ry * 0.02, cx - rx * 0.76, cy - ry * 0.42);
  c.bezierCurveTo(cx - rx * 0.5, cy - ry * 0.82, cx - rx * 0.16, cy - ry * 0.92, cx, cy - ry - 1.9);
  c.closePath();
}
function goldEgg(c, f) {
  const cx = 0, cy = 0, rx = 10.2, ry = 12.4;
  const path = () => goldPath(c, cx, cy, rx, ry);
  solid(c, path, cx, cy, rx, ry, GOLD, 1.6, f, { gloss: 0.95, rimW: 4.2 });
  // a smooth jewelled belt around the belly (never a zig-zag: that would read as a crack)
  c.save(); path(); c.clip();
  const belt = () => { c.beginPath(); c.moveTo(-rx - 1, -1.8); c.quadraticCurveTo(0, 3.4, rx + 1, -1.8); c.lineTo(rx + 1, 2.4); c.quadraticCurveTo(0, 7.6, -rx - 1, 2.4); c.closePath(); };
  belt(); fill(c, linear(c, 0, -2, 0, 7, [0, '#fff3b0', 0.5, '#ffe15a', 1, '#f2a41c']));
  stroke(c, rgba(GOLD.k, 0.6), 0.9);
  for (const [x, y] of [[-5.8, 2.1], [0, 3.0], [5.8, 2.1]]) {
    c.beginPath(); c.moveTo(x, y - 1.5); c.lineTo(x + 1.2, y); c.lineTo(x, y + 1.5); c.lineTo(x - 1.2, y); c.closePath(); fill(c, '#ffffff'); stroke(c, rgba(GOLD.k, 0.7), 0.5);
  }
  c.restore();
  path(); stroke(c, GOLD.k, 1.6);
  gleam(c, cx - f * 4.5, cy - 6.2, 2.0, 3.0, 0.5 * f, 0.95);
}
function glowBlob(c, r, col, a0 = 0.8) {
  c.beginPath(); c.arc(0, 0, r, 0, TAU);
  fill(c, radial(c, 0, 0, r * 0.1, r, [0, rgba(col, a0), 0.5, rgba(col, a0 * 0.4), 1, rgba(col, 0)]));
}
function sparkleArt(c) {
  twinkle(c, 0, 0, 8, 0, 0.2); c.fillStyle = '#ffffff'; c.fill(); stroke(c, '#f2a30a', 0.9);
  twinkle(c, 0, 0, 3.2, PI / 4, 0.3); fill(c, '#fff8d0');
}

const GOLD_GLOW = { rim: '#fff4b0', glow: 'rgba(255,214,90,0.7)', blur: 4, w: 0.8 };
const EGG_GLOW = { rim: '#fff6d8', glow: 'rgba(255,236,190,0.5)', blur: 3, w: 0.7 };
const glowLight = (c) => glowBlob(c, 21, '#ffd54a', 0.8), glowDark = (c) => glowBlob(c, 21, '#ffd54a', 0.95);
/** The soft halo behind a golden egg (stronger in dark chapters). Keyed by darkness: the two differ. */
function goldGlow(cache, dark) { return sprite(cache, 'egg|goldglow' + dk(dark), -22, -22, 22, 22, dark ? glowDark : glowLight); }

/** Ordinary (small cream, speckled) or golden (big, crowned, glowing, twinkling) egg. x,y = centre. */
export function drawEgg(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const x = num(p.x), y = num(p.y);
  const t = num(p.t), dark = !!p.dark;
  const i = p.i === undefined ? x * 0.05 : num(p.i);              // no index given: bob by position so a trail ripples instead of marching in step
  if (p.kind === 'gold') {
    const ph = t * 3.2 + i * 1.9, b = Math.sin(ph);
    const sGlow = goldGlow(cache, dark);
    const sEgg = bake(cache, 'egg|gold' + dk(dark), 1, -12, -16, 12, 14, goldEgg, dark ? GOLD_GLOW : null);
    const sSpark = sprite(cache, 'egg|spark', -9, -9, 9, 9, sparkleArt);
    const pulse = 0.5 + 0.5 * Math.sin(t * 4.1 + i);
    const by = y - Math.abs(b) * 3.4 + 1.4;                       // bouncier than the plain egg
    blitAt(ctx, sGlow, x, by, 0, 0.92 + 0.12 * pulse, 0.92 + 0.12 * pulse, 0.7 + 0.3 * pulse);
    blitAt(ctx, sEgg, x, by, Math.sin(ph * 0.5) * 0.07, 1 - Math.abs(b) * 0.03 + 0.02, 1 + Math.abs(b) * 0.05);
    const s1 = 0.4 + 0.75 * pulse, s2 = 0.4 + 0.75 * (1 - pulse);
    blitAt(ctx, sSpark, x + 9.5, by - 11, 0, s1, s1, 0.5 + 0.5 * pulse);
    blitAt(ctx, sSpark, x - 10.5, by + 4.5, 0, s2 * 0.7, s2 * 0.7, 0.5 + 0.5 * (1 - pulse));
  } else {
    const sEgg = bake(cache, 'egg|plain' + dk(dark), 1, -9, -11, 9, 11, plainEgg, dark ? EGG_GLOW : null);
    blitAt(ctx, sEgg, x, y + Math.sin(t * 2.6 + i * 1.7) * 1.7, Math.sin(t * 1.9 + i * 2.3) * 0.05);
  }
}

/* ───────────────────────────── HATCH BURST ───────────────────────────── */
function goldHalf(c, f, top) {
  // the golden egg cut along a jagged crack; `top` = the cap, else the cup
  const zig = (cc) => { for (let i = 0; i <= 6; i++) cc.lineTo(16 - i * 32 / 6, -1.5 + (i % 2 ? 2.6 : -2.6)); };
  c.save(); c.beginPath();
  if (top) { c.moveTo(-18, -26); c.lineTo(18, -26); zig(c); c.closePath(); }
  else { c.moveTo(-18, 26); c.lineTo(18, 26); zig(c); c.closePath(); }
  c.clip();
  goldEgg(c, f);
  c.beginPath(); c.moveTo(16, -1.5 - 2.6); zig(c); stroke(c, GOLD.k, 1.5);
  c.beginPath(); c.moveTo(16, -1.5 - 2.6); zig(c); stroke(c, '#fff6c8', 0.5);
  c.restore();
}
function crackArt(c) {
  c.beginPath(); c.moveTo(-1, -14); c.lineTo(1.6, -9); c.lineTo(-1.8, -5.5); c.lineTo(1.2, -1.5); c.lineTo(-2, 2); c.moveTo(1.6, -9); c.lineTo(5.4, -7.2); c.moveTo(-1.8, -5.5); c.lineTo(-5.6, -4.4);
  stroke(c, '#6a3a00', 1.5); stroke(c, '#fff1a8', 0.5);
}

/**
 * The golden egg cracks and a duckling pops out (0.9 s, progress 0..1). x,y = the egg's centre (as drawEgg).
 * The real follower takes over as this fades; the renderer adds the shell-burst / star particles.
 */
export function drawHatchBurst(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const pr = clamp(num(p.progress), 0, 1), dark = !!p.dark;
  const x = num(p.x), y = num(p.y);
  const sGlow = goldGlow(cache, dark);
  const sSpark = sprite(cache, 'egg|spark', -9, -9, 9, 9, sparkleArt);
  const SPLIT = 0.3;
  const glowA = pr < SPLIT ? 0.6 + pr : Math.max(0, 1.5 - (pr - SPLIT) * 2.2);
  blitAt(ctx, sGlow, x, y, 0, 1 + pr * 0.9, 1 + pr * 0.9, clamp(glowA, 0, 1));
  const box = dark ? GOLD_GLOW : null;
  if (pr < SPLIT) {
    const k = pr / SPLIT;
    const shake = Math.sin(pr * 110) * 0.2 * k;
    const sEgg = bake(cache, 'egg|gold' + dk(dark), 1, -12, -16, 12, 14, goldEgg, box);
    blitAt(ctx, sEgg, x, y - k * 1.5, shake, 1 + 0.08 * k, 1 + 0.08 * k);
    const sCrack = sprite(cache, 'egg|crack', -8, -16, 8, 4, crackArt);
    blitAt(ctx, sCrack, x, y, shake, 1, 1, clamp(k * 1.6, 0, 1));
    return;
  }
  const k = (pr - SPLIT) / (1 - SPLIT);                         // 0..1 after the split
  const sTop = bake(cache, 'egg|goldtop' + dk(dark), 1, -14, -18, 14, 14, (c, f) => goldHalf(c, f, true), box);
  const sBot = bake(cache, 'egg|goldbot' + dk(dark), 1, -14, -18, 14, 14, (c, f) => goldHalf(c, f, false), box);
  // flash + star burst
  const fl = Math.max(0, 1 - k * 3);
  if (fl > 0) blitAt(ctx, sGlow, x, y - 4, 0, 1.3 + k * 1.6, 1.3 + k * 1.6, fl * 0.75);
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6 + 0.4, d = 6 + k * 26, s = (0.5 + 0.4 * Math.sin(i * 2.1)) * (1 - k * 0.7);
    blitAt(ctx, sSpark, x + Math.cos(a) * d, y - 6 + Math.sin(a) * d * 0.8, k * 3 * (i % 2 ? 1 : -1), s, s, clamp(1.4 - k * 1.4, 0, 1));
  }
  // the cap flies up and away, the cup stays
  const kk = Math.min(1, k * 1.6);
  blitAt(ctx, sTop, x - kk * 10, y - 2 - 20 * Math.sin(kk * PI * 0.8) - kk * 4 + kk * kk * 16, -kk * 2.2, 1, 1, clamp(1.6 - kk * 1.2, 0, 1));
  // the duckling rises out of the cup, hops, then fades as the real follower takes over
  const r = smooth(k / 0.45), over = Math.sin(clamp(k / 0.45, 0, 1) * PI) * 4;
  let dy = 8 - r * 20 - over;
  const hopK = clamp((k - 0.5) / 0.5, 0, 1);
  dy -= Math.abs(Math.sin(hopK * PI * 2)) * 5 * (1 - hopK);
  const da = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
  ctx.save(); ctx.translate(x, y + dy); ctx.scale(0.55 + 0.45 * r, 0.55 + 0.45 * r);
  drawDuckling(ctx, cache, { x: 0, y: 0, face: 1, air: k > 0.45 && k < 0.8, t: pr * 0.9, i: 0, alpha: da, dark });
  ctx.restore();
  blitAt(ctx, sBot, x, y, 0, 1, 1, clamp(1.7 - k * 1.2, 0, 1));
}

/* ═════════════════════════════ PICKUPS & BUBBLE ═════════════════════════════ */
const BLUE = fam('#2f86f0', { l: '#9ccfff', d: '#1f4fc0', b: '#78b4ff', k: '#143a8a' });
const SILVER = fam('#d4deea', { l: '#ffffff', d: '#8c9cb8', b: '#e6eef8', k: '#3c4868' });
const RED = fam('#e8434c', { l: '#ff9a8e', d: '#a8203e', b: '#f0808e', k: '#6e1230' });

function shieldBadge(c, f) {
  // a scalloped, medal-like round badge: silver rim, blue dome, white shield emblem. No face, no yellow: never a duckling.
  const R = 12;
  const scal = () => { c.beginPath(); for (let i = 0; i < 40; i++) { const a = i * TAU / 40, r = R + (i % 4 < 2 ? 0 : -1.0); c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } c.closePath(); };
  scal(); fill(c, linear(c, -8, -10, 9, 11, [0, SILVER.l, 0.45, SILVER.m, 1, SILVER.d])); stroke(c, SILVER.k, 1.5);
  c.beginPath(); c.arc(0, 0, 8.6, 0, TAU); fill(c, ballGrad(c, 0, 0, 8.6, 8.6, BLUE, f)); stroke(c, BLUE.k, 1.1);
  // bounced light inside the lower-right of the dome
  rimStrip(c, () => { c.beginPath(); c.arc(0, 0, 8.6, 0, TAU); }, -2, -2, 6, 7, BLUE.b, 3.2);
  // emblem: a white kite shield
  const em = () => { c.beginPath(); c.moveTo(-4.7, -4.9); c.quadraticCurveTo(0, -6.8, 4.7, -4.9); c.lineTo(4.7, 0.4); c.quadraticCurveTo(4.2, 4.6, 0, 6.6); c.quadraticCurveTo(-4.2, 4.6, -4.7, 0.4); c.closePath(); };
  em(); fill(c, linear(c, -4, -6, 4, 6, [0, '#ffffff', 0.6, '#eaf3ff', 1, '#b8d2f4'])); stroke(c, BLUE.k, 1.0);
  c.beginPath(); c.moveTo(0, -4.8); c.lineTo(0, 5.2); c.moveTo(-3.6, -0.6); c.lineTo(3.6, -0.6); stroke(c, rgba(BLUE.m, 0.8), 1.3);
  gleam(c, -4.6, -5.6, 3.2, 1.5, -0.7, 0.8);
}
function magnetArt(c, f) {
  const body = () => {
    c.beginPath(); c.moveTo(-10.5, -13.5); c.lineTo(-10.5, -2); c.arc(0, -2, 10.5, PI, 0, true); c.lineTo(10.5, -13.5); c.lineTo(5, -13.5); c.lineTo(5, -2); c.arc(0, -2, 5, 0, PI, false); c.lineTo(-5, -13.5); c.closePath();
  };
  body(); fill(c, linear(c, -10, -6, 10, 10, [0, RED.l, 0.4, RED.m, 1, RED.d]));
  rimStrip(c, body, -2, -4, 8, 8, RED.b, 4);
  // silver tips on both legs
  c.save(); c.beginPath(); c.rect(-12, -14, 24, 5.8); c.clip(); body(); fill(c, linear(c, -10, 0, 10, 0, [0, SILVER.l, 0.5, SILVER.m, 1, SILVER.d]));
  c.beginPath(); c.moveTo(-12, -8.9); c.lineTo(12, -8.9); stroke(c, rgba(SILVER.k, 0.7), 0.8);
  c.restore();
  body(); stroke(c, RED.k, 1.6);
  c.beginPath(); c.moveTo(-10, -10); c.lineTo(-5.4, -10); c.moveTo(5.4, -10); c.lineTo(10, -10); stroke(c, rgba(SILVER.k, 0.8), 1.2);
  gleam(c, -7.6, -1.6, 1.4, 5.2, 0.2, 0.75);
  gleam(c, -7.6, -12.2, 1.2, 1.2, 0, 0.9);
}
function boltArt(c, v) {
  c.beginPath();
  if (v === 0) { c.moveTo(-6, -2); c.lineTo(-2.4, 1); c.lineTo(0.6, -2.2); c.lineTo(3.6, 0.8); c.lineTo(6, -1.6); }
  else if (v === 1) { c.moveTo(-6, 0); c.lineTo(-2.8, -2.6); c.lineTo(0.2, 1); c.lineTo(3.2, -1.8); c.lineTo(6, 0.4); }
  else { c.moveTo(-6, -1); c.lineTo(-3.2, 1.4); c.lineTo(-0.2, -1.6); c.lineTo(2.8, 1.2); c.lineTo(6, -1); }
  stroke(c, '#ff5a6a', 2.4); stroke(c, '#ffffff', 0.9);
}
const pickupGlow = (col) => (c) => glowBlob(c, 22, col, 0.7);
const SHIELD_HALO = pickupGlow('#5ab0ff'), MAGNET_HALO = pickupGlow('#ff6a7a');
const SHIELD_PICK_GLOW = { rim: '#d6f0ff', glow: 'rgba(110,190,255,0.7)', blur: 3.5, w: 0.8 };
const MAGNET_PICK_GLOW = { rim: '#ffe0e4', glow: 'rgba(255,110,130,0.7)', blur: 3.5, w: 0.8 };
const BOLTS = [0, 1, 2].map((v) => (c) => boltArt(c, v));

/** Shield pickup: round, scalloped blue medal with a white shield. x,y = centre. */
export function drawShieldPickup(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const t = num(p.t), x = num(p.x), y = num(p.y), dark = !!p.dark;
  const g = sprite(cache, 'pick|sglow', -23, -23, 23, 23, SHIELD_HALO);
  const s = bake(cache, 'pick|shield' + dk(dark), 1, -14, -14, 14, 14, shieldBadge, dark ? SHIELD_PICK_GLOW : null);
  const sp = sprite(cache, 'egg|spark', -9, -9, 9, 9, sparkleArt);
  const bob = Math.sin(t * 2.7) * 2.4, pu = 0.5 + 0.5 * Math.sin(t * 3.3);
  blitAt(ctx, g, x, y + bob, 0, 0.95 + 0.1 * pu, 0.95 + 0.1 * pu, 0.55 + 0.35 * pu);
  blitAt(ctx, s, x, y + bob, Math.sin(t * 1.8) * 0.06, 1 + 0.025 * pu, 1 + 0.025 * pu);
  const tw = frac(t * 0.7);
  if (tw < 0.4) { const k = Math.sin(tw / 0.4 * PI); blitAt(ctx, sp, x + 6.5, y + bob - 8.5, 0, 0.7 * k, 0.7 * k, k); }
}
/** Magnet pickup: red horseshoe with silver tips and crackling bolts. x,y = centre. */
export function drawMagnetPickup(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const t = num(p.t), x = num(p.x), y = num(p.y), dark = !!p.dark;
  const g = sprite(cache, 'pick|mglow', -23, -23, 23, 23, MAGNET_HALO);
  const s = bake(cache, 'pick|magnet' + dk(dark), 1, -13, -17, 13, 13, magnetArt, dark ? MAGNET_PICK_GLOW : null);
  const bob = Math.sin(t * 2.5 + 1) * 2.4, pu = 0.5 + 0.5 * Math.sin(t * 3.7);
  blitAt(ctx, g, x, y + bob, 0, 0.95 + 0.1 * pu, 0.95 + 0.1 * pu, 0.5 + 0.35 * pu);
  blitAt(ctx, s, x, y + bob + 1.5, Math.sin(t * 1.9) * 0.1, 1 + 0.025 * pu, 1 + 0.025 * pu);
  const bv = ((Math.floor(t * 11) % 3) + 3) % 3;                  // which crackle of the three
  blitAt(ctx, sprite(cache, 'pick|bolt' + bv, -8, -6, 8, 6, BOLTS[bv]), x, y + bob - 12.5, 0, 1, 1, 0.55 + 0.45 * pu);
}

// the bubble hugs Mama: a hair over her 46 u art, resting on the ground line (so it never sinks into the platform)
const BUBBLE = Object.freeze({ rx: 24, ry: 27.2, cy: -25.2 });
function bubbleArt(c, dark) {
  const rx = BUBBLE.rx, ry = BUBBLE.ry, cy = BUBBLE.cy;
  const path = () => { c.beginPath(); c.ellipse(0, cy, rx, ry, 0, 0, TAU); };
  path(); fill(c, radial(c, -rx * 0.25, cy - ry * 0.3, 2, ry * 1.05, [0, 'rgba(190,230,255,0.05)', 0.7, 'rgba(120,190,255,0.16)', 1, 'rgba(70,150,255,0.42)']));
  rimStrip(c, path, -rx * 0.2, cy - ry * 0.2, rx * 0.8, cy + ry * 0.9, '#bfe4ff', 5);
  if (dark) {
    // Dark chapters: a glow that hugs the RIM only. (The generic silhouette glow of bake() fills the whole shape 13 times;
    // the bubble's faint interior would stack into a milky veil and Mama would vanish behind it.)
    const k = c.getTransform ? c.getTransform().a : 3;           // device px per world unit: shadowBlur is in device px
    c.save(); c.shadowColor = 'rgba(120,200,255,0.95)'; c.shadowBlur = 4.5 * k;
    path(); stroke(c, 'rgba(225,244,255,0.9)', 1.6);
    c.restore();
  }
  path(); stroke(c, 'rgba(240,250,255,0.95)', 2.0);
  c.beginPath(); c.ellipse(0, cy, rx + 1.0, ry + 1.0, 0, 0, TAU); stroke(c, 'rgba(40,110,220,0.55)', 0.9);
  // specular streaks upper left and a small one lower right
  c.beginPath(); c.ellipse(0, cy, rx - 5, ry - 5, 0, PI * 1.08, PI * 1.45); stroke(c, 'rgba(255,255,255,0.95)', 2.6);
  c.beginPath(); c.ellipse(0, cy, rx - 4.5, ry - 4.5, 0, PI * 0.06, PI * 0.2); stroke(c, 'rgba(255,255,255,0.7)', 1.8);
  gleam(c, -rx * 0.45, cy - ry * 0.52, 1.4, 1.4, 0, 0.95);
}
const bubbleLight = (c) => bubbleArt(c, false), bubbleDark = (c) => bubbleArt(c, true);
/** Bubble around Mama while shielded. x,y = Mama's feet (same as drawMama). pop 0..1 = bursting (expands, fades, shards). */
export function drawShieldBubble(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const t = num(p.t), x = num(p.x), y = num(p.y), pop = clamp(num(p.pop), 0, 1), dark = !!p.dark;
  const s = bake(cache, 'bubble' + dk(dark), 1, -28, -56, 28, 6, dark ? bubbleDark : bubbleLight, null);
  const w = Math.sin(t * 3.1) * 0.02;
  if (pop <= 0) { blitAt(ctx, s, x, y, 0, 1 + w, 1 - w, 0.95); return; }
  const e = 1 + pop * 0.5;
  ctx.save(); ctx.translate(x, y + BUBBLE.cy); ctx.scale(e, e); ctx.translate(0, -BUBBLE.cy);
  blitAt(ctx, s, 0, 0, 0, 1, 1, clamp(1 - pop * 1.25, 0, 1));
  ctx.restore();
  // shards flying outward
  ctx.save(); ctx.translate(x, y + BUBBLE.cy); ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(225,244,255,${clamp(1.2 - pop * 1.2, 0, 1)})`; ctx.lineWidth = 2.2 * (1 - pop * 0.6);
  for (let i = 0; i < 10; i++) {
    const a = i * TAU / 10 + 0.2, r0 = 24 + pop * 18, r1 = r0 + 5 * (1 - pop);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 1.12); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * 1.12); ctx.stroke();
  }
  ctx.restore();
}

/* ═══════════════════ PALETTE-AWARE CREATURE COLOURS & CACHE GROUPS ═══════════════════ */
// Enemies take the landscape's palette so they sit in it, yet must stay bold: each species has a few natural colour
// ways, and we pick the one that contrasts best with the ground (walkers) or sky (flyers) of the landscape, then tint
// it a touch toward the palette's accent so it belongs.
function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hslOf(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const DEFAULT_PALETTE = Object.freeze({ sky: '#249ae4', light: '#c2e677', top: '#7fc54b', fringe: '#469942', soil: '#895035', rock: '#ac6844', shadow: '#54343b', outline: '#253749', accent: '#ffd67d', water: null });
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const darkOfPalette = new WeakMap();
/**
 * Is this a night / cave landscape? DESIGN §5's signatures carry no `dark` flag, so when a call that has a palette (walkers,
 * flyers, flags) is not told, we read it off the sky: Lantern Caverns (#353071) and Moonridge (#4542a2) are far below every
 * daytime sky. An explicit `dark: true/false` from the caller always wins.
 */
function paletteIsDark(P) {
  let d = darkOfPalette.get(P);
  if (d === undefined) { const [r, g, b] = rgb(P.sky); d = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.12; darkOfPalette.set(P, d); }
  return d;
}
const PAL_FIELDS = ['sky', 'light', 'top', 'fringe', 'soil', 'rock', 'shadow', 'outline', 'accent'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const palFixed = new WeakMap();
/** A usable palette: the given one if complete, else it filled in from Meadow (bad input never throws). */
function okPalette(P) {
  if (!P || typeof P !== 'object') return DEFAULT_PALETTE;
  let q = palFixed.get(P);
  if (q) return q;
  q = PAL_FIELDS.every((k) => typeof P[k] === 'string' && HEX6.test(P[k])) ? P : Object.assign({}, DEFAULT_PALETTE, ...PAL_FIELDS.filter((k) => typeof P[k] === 'string' && HEX6.test(P[k])).map((k) => ({ [k]: P[k] })));
  palFixed.set(P, q);
  return q;
}

// [hue, saturation, lightness] natural colour ways, in order of preference
const WAYS = {
  snail: [[22, 0.8, 0.55], [335, 0.62, 0.6], [268, 0.5, 0.58], [192, 0.62, 0.46]],
  caterpillar: [[96, 0.62, 0.52], [338, 0.7, 0.62], [24, 0.85, 0.58], [196, 0.65, 0.5]],
  beetle: [[218, 0.62, 0.5], [6, 0.72, 0.5], [168, 0.6, 0.4], [282, 0.5, 0.52], [38, 0.8, 0.5]],
  crab: [[6, 0.78, 0.55], [26, 0.85, 0.56], [340, 0.7, 0.6]],
  mite: [[352, 0.72, 0.55], [268, 0.55, 0.55], [28, 0.85, 0.55]],
  // QA-VISUAL: the pale cream / pink moths vanished into Fogwood's pale mist and Dawnbridge's pink sky. Violet first (a bold, "do not touch"
  // silhouette on both), then a lantern amber and magenta; pickWay still chooses whichever contrasts best with the landscape's sky.
  moth: [[268, 0.5, 0.48], [26, 0.85, 0.56], [318, 0.55, 0.5]],
  bat: [[288, 0.45, 0.4], [330, 0.5, 0.46], [212, 0.5, 0.44]],
  owl: [[30, 0.5, 0.44], [44, 0.5, 0.62], [268, 0.36, 0.52]],
  hawk: [[22, 0.62, 0.42], [34, 0.5, 0.36], [208, 0.38, 0.44]],
  flag: [[352, 0.8, 0.55], [212, 0.72, 0.52], [46, 0.9, 0.55], [290, 0.55, 0.55]],
};
function pickWay(species, P, ref, dark) {
  const ways = WAYS[species] || WAYS.beetle;
  const [rh, rs, rl] = hslOf(P[ref] || P.top);
  const weight = 0.35 + clamp(rs * 1.6, 0, 0.9);
  let best = ways[0], bestScore = -1;
  ways.forEach((w, idx) => {
    const l = dark ? Math.min(0.78, w[2] + 0.12) : w[2];
    // hue contrast saturates at 60 deg (beyond that a colour is already clearly different), lightness contrast adds,
    // and the species' natural first choices get a small head start so a snail stays a warm snail.
    const score = Math.min(1, hueDist(w[0], rh) / 60) * weight + Math.abs(l - rl) * 1.1 + (ways.length - idx) * 0.12;
    if (score > bestScore) { bestScore = score; best = w; }
  });
  return [best[0], best[1], dark ? Math.min(0.78, best[2] + 0.12) : best[2]];
}
/** Main body colour for a species in a palette, tinted 14 % toward the palette accent. */
function creatureMain(species, P, ref, dark) {
  const [h, s, l] = pickWay(species, P, ref, dark);
  return mix(hsl(h, s, l), P.accent, 0.14);
}
/** An own-hue outline, nudged toward the landscape's outline colour so the creature sits in the picture. */
function creatureFam(main, P, o = {}) {
  const k = mix(outline(main, 0.6), P.outline, 0.28);
  return fam(main, Object.assign({ k }, o));
}

// Palette-dependent sprites live in a "group" (one per palette). Only the few most recently used groups stay cached,
// so an hour of travel through 13 landscapes never grows the cache without bound.
const MAX_GROUPS = 3;   // the landscape you are in, the one dissolving in, and the one just left
const palKeys = new WeakMap(), groupOrder = new WeakMap();
function palKey(P) {
  let k = palKeys.get(P);
  if (!k) { k = [P.top, P.accent, P.rock, P.soil, P.light, P.sky, P.outline].map((v) => String(v).replace('#', '')).join(''); palKeys.set(P, k); }
  return k;
}
function useGroup(cache, g) {
  let order = groupOrder.get(cache);
  if (!order) { order = []; groupOrder.set(cache, order); }
  if (order[0] === g) return;
  const i = order.indexOf(g);
  if (i >= 0) order.splice(i, 1);
  order.unshift(g);
  while (order.length > MAX_GROUPS) {
    const old = '@' + order.pop() + '|';
    for (const key of cache.map.keys()) if (key.startsWith(old)) cache.map.delete(key);
  }
}

/* ═══════════════════════════════════ WALKERS ═══════════════════════════════════ */
const FRAMES = 12;
// art scale per species, so every creature lands near its 34×26 (walker) / 30×24 (flyer) footprint
// QA-VISUAL: the sim's walker hurtbox is 34 x 26 and reaches 26 u up; the beetle (21 u tall) and caterpillar (23 u) left a 3-5 u band above
// their backs where a jump that visibly cleared them still hurt. Both are scaled up so the art fills the box (beetle 23 u, caterpillar 26 u).
const WALK_K = { snail: 0.88, caterpillar: 1.02, beetle: 0.95, crab: 0.94, mite: 1 };
const FLY_K = { bee: 1, moth: 0.82, gull: 0.88, bat: 0.9, owl: 0.86, hawk: 0.9 };
const WALK_RATE = { snail: 0.9, caterpillar: 1.3, beetle: 2.0, crab: 2.4, mite: 3.2 };

/** A glaring cartoon eye. `ang` 0..1 = how cross the brow is (slopes down toward the front). */
function eyeball(c, x, y, r, o = {}) {
  const look = o.look === undefined ? r * 0.32 : o.look;
  ellPath(c, x, y, r, r * 1.1); fill(c, '#fffef6'); stroke(c, o.k || '#4a2a20', Math.max(0.7, r * 0.32));
  ellPath(c, x + look, y + r * 0.1, r * 0.58, r * 0.72); fill(c, INK);
  gleam(c, x + look - r * 0.22, y - r * 0.26, r * 0.26, r * 0.26, 0, 1);
  if (o.ang) {
    const a = o.ang;
    c.beginPath(); c.moveTo(x - r * 1.25, y - r * (1.5 + 0.55 * a)); c.lineTo(x + r * 1.2, y - r * (1.45 - 0.75 * a));
    stroke(c, o.brow || '#2b1810', Math.max(1.0, r * 0.52));
  }
}

function snailArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, s = Math.sin(ph), cs = Math.cos(ph);
  const SK = C.skin, SH = C.main;
  // soft body: a long foot, a raised neck and head, a tapering tail
  const foot = (cc) => { ell(cc, -3 + s * 0.5, -3.7, 15 + cs * 0.8, 3.7); ell(cc, 12.2, -7.6 + cs * 0.5, 5.4, 6.3, 0.15); ell(cc, -16.4, -2.4, 3.4, 2.3); };
  blob(c, foot, linear(c, 0, -13, 0, 0, [0, SK.l, 0.55, SK.m, 1, SK.d]), SK.k, 1.2);
  c.save(); c.beginPath(); foot(c); c.clip(); ellPath(c, -2, 0.4, 18, 2.2); fill(c, rgba(SK.d, 0.75)); c.restore();     // darker sole
  // eye stalks
  for (const [bx, tx, ty, ph2] of [[11, 9.6, -21.4, 0], [14.6, 16.6, -21, 1.6]]) {
    const sx = tx + Math.sin(ph + ph2) * 1.1, sy = ty + Math.cos(ph + ph2) * 0.5;
    c.beginPath(); c.moveTo(bx, -11); c.quadraticCurveTo(bx + (sx - bx) * 0.2, -16, sx, sy);
    stroke(c, SK.k, 3.6); stroke(c, SK.m, 2.0);
    eyeball(c, sx, sy - 1.2, 2.7, { ang: 0.85 });
  }
  // grumpy little mouth
  c.beginPath(); c.moveTo(14, -5.2); c.quadraticCurveTo(16.4, -6.6, 17.8, -4.4); stroke(c, '#4a2a20', 1.0);
  ellPath(c, 12.2, -3.8, 1.8, 1.2); fill(c, 'rgba(255,110,120,0.5)');
  // the shell: a glossy spiral dome that bobs a little with each step
  c.save(); c.translate(-4.2, -14.2); c.rotate(Math.sin(ph) * 0.035);
  const path = () => { c.beginPath(); c.ellipse(0, 0, 12.6, 12.2, 0, 0, TAU); };
  solid(c, path, 0, 0, 12.6, 12.2, SH, 1.6, f, { gloss: false, rimW: 5 });
  c.save(); path(); c.clip();
  c.beginPath(); for (let i = 0; i <= 60; i++) { const a = i / 60 * TAU * 2.1, r = 1 + i / 60 * 9.8; c[i ? 'lineTo' : 'moveTo'](0.6 + Math.cos(a + 0.5) * r, 0.2 + Math.sin(a + 0.5) * r * 0.96); }
  stroke(c, rgba(SH.k, 0.7), 1.5);
  c.beginPath(); for (let i = 0; i <= 60; i++) { const a = i / 60 * TAU * 2.1, r = 1 + i / 60 * 9.8; c[i ? 'lineTo' : 'moveTo'](0.6 + Math.cos(a + 0.5) * r + 0.5, 0.2 + Math.sin(a + 0.5) * r * 0.96 - 0.6); }
  stroke(c, rgba(C.accent, 0.8), 0.8);
  c.restore();
  gleam(c, -5.2, -6.4, 2.6, 4.2, 0.55 * f, 0.75);
  c.restore();
}

function caterpillarArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, SK = C.skin;
  const xs = [-13.4, -7.2, -1.0, 5.2], rs = [4.5, 5.3, 5.8, 5.8];
  const lifts = xs.map((_, i) => Math.max(0, Math.sin(ph - i * 0.85)) * 3.4);
  const hx = 12.2, hr = 6.9, hl = Math.max(0, Math.sin(ph - 4 * 0.85)) * 2;
  // stubby legs under every segment (they plant on the ground while the body arches)
  const leg = (x, top, bob) => {
    c.beginPath(); c.moveTo(x, top); c.lineTo(x + bob, -0.6); stroke(c, SK.k, 2.7);
    c.beginPath(); c.moveTo(x, top); c.lineTo(x + bob, -0.6); stroke(c, SK.m, 1.4);
    ellPath(c, x + bob + 0.4, -0.7, 1.7, 0.9); ink(c, SK.m, SK.k, 0.7);
  };
  xs.forEach((x, i) => { const y = -rs[i] - 0.4 - lifts[i]; leg(x - 1.8, y + rs[i] * 0.7, Math.sin(ph + i) * 0.8); leg(x + 1.8, y + rs[i] * 0.7, Math.sin(ph + i + 2) * 0.8); });
  leg(hx - 2, -hr - lifts[0] * 0 - hl + hr * 0.7, 0); leg(hx + 2.4, -hr - hl + hr * 0.7, 0.6);
  // segments, tail first so each one tucks under the next
  xs.forEach((x, i) => {
    const y = -rs[i] - 0.4 - lifts[i], r = rs[i];
    const p = () => { c.beginPath(); c.arc(x, y, r, 0, TAU); };
    solid(c, p, x, y, r, r, i % 2 ? C.alt : B, 1.3, f, { gloss: i === 3 ? 0.7 : false, rimW: 2.4 });
    for (const dx of [-1.6, 1.8]) { ellPath(c, x + dx, y - r * 0.5, 0.95, 0.8); fill(c, C.accent); }
  });
  // head
  const hy = -hr - 0.4 - hl;
  // antennae
  for (const [ax, tilt] of [[hx - 2.4, -1], [hx + 2.6, 1]]) {
    const sw = Math.sin(ph * 1 + tilt) * 1.3;
    c.beginPath(); c.moveTo(ax, hy - hr * 0.85); c.quadraticCurveTo(ax + tilt * 1.2 + sw * 0.5, hy - hr - 3, ax + tilt * 2.8 + sw, hy - hr - 6.6);
    stroke(c, B.k, 1.7); stroke(c, B.m, 0.7);
    dot(c, ax + tilt * 2.8 + sw, hy - hr - 6.8, 1.5, C.accent); c.beginPath(); c.arc(ax + tilt * 2.8 + sw, hy - hr - 6.8, 1.5, 0, TAU); stroke(c, B.k, 0.7);
  }
  const hp = () => { c.beginPath(); c.arc(hx, hy, hr, 0, TAU); };
  solid(c, hp, hx, hy, hr, hr, B, 1.4, f, { gloss: 0.8, rimW: 3 });
  ellPath(c, hx + 1.5, hy + 3.1, 1.9, 1.3); fill(c, 'rgba(255,110,120,0.5)');
  eyeball(c, hx + 1.2, hy - 1.4, 2.7, { ang: 0.8 });
  eyeball(c, hx + 5.5, hy - 1.2, 2.0, { ang: 0.8 });
  c.beginPath(); c.moveTo(hx + 1.2, hy + 3.7); c.quadraticCurveTo(hx + 3.8, hy + 2.8, hx + 5.4, hy + 3.9); stroke(c, '#4a2a20', 0.95);
}

function beetleArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, DK = C.dark;
  c.translate(-3.2, 0);                                       // keep it centred on its feet
  // six stubby legs, scuttling (we see three), behind the shell
  [-9, -2.2, 5.2].forEach((lx, i) => {
    const a = ph + i * 2.1, fx = lx + Math.sin(a) * 2.4, lift = Math.max(0, Math.cos(a)) * 2.2;
    c.beginPath(); c.moveTo(lx, -7); c.quadraticCurveTo(lx + (fx - lx) * 0.3 + 2.6, -4.6, fx + 0.6, -0.8 - lift); stroke(c, DK.k, 3.4); stroke(c, DK.m, 1.9);
    ellPath(c, fx + 1, -0.7 - lift, 2.0, 1.0); ink(c, DK.m, DK.k, 0.8);
  });
  // head, glaring eye and stag-beetle pincers (the "it bites" cue, kept low and forward, never on top)
  const hb = Math.sin(ph * 2) * 0.45;
  c.save(); c.translate(0, hb);
  const HORN = fam('#fff1cf', { l: '#ffffff', d: '#e8c9a0', k: B.k });
  // two tapered mandibles that curve toward each other but leave a gap (so they read as pincers, never a ring)
  for (const [x0, y0, cx, cy, x1, y1] of [[19.2, -13.6, 24.6, -16.0, 25.2, -12.6], [19.8, -6.4, 24.8, -4.6, 25.4, -7.6]]) {
    const L = [], R = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, u = 1 - t, px = u * u * x0 + 2 * u * t * cx + t * t * x1, py = u * u * y0 + 2 * u * t * cy + t * t * y1;
      const tx = 2 * u * (cx - x0) + 2 * t * (x1 - cx), ty = 2 * u * (cy - y0) + 2 * t * (y1 - cy), n = Math.hypot(tx, ty) || 1, w = (1 - t) * 1.9 + 0.25;
      L.push([px - ty / n * w, py + tx / n * w]); R.push([px + ty / n * w, py - tx / n * w]);
    }
    c.beginPath(); c.moveTo(L[0][0], L[0][1]); for (const q of L) c.lineTo(q[0], q[1]); for (let i = R.length - 1; i >= 0; i--) c.lineTo(R[i][0], R[i][1]); c.closePath();
    fill(c, linear(c, 0, -17, 0, -4, [0, HORN.l, 0.5, HORN.m, 1, HORN.d])); stroke(c, B.k, 1.1);
  }
  const hp = () => { c.beginPath(); c.ellipse(16.4, -10.2, 6.0, 5.8, 0, 0, TAU); };
  solid(c, hp, 16.4, -10.2, 6.0, 5.8, mixFam(B, C.alt, 0.15), 1.5, f, { gloss: 0.7, rimW: 2.6 });
  eyeball(c, 17.9, -11.7, 2.9, { ang: 0.95 });
  c.restore();
  // shell dome
  const body = () => { c.beginPath(); c.moveTo(-15.8, -7.2); c.bezierCurveTo(-17.2, -17.6, -8.6, -23, 0, -23); c.bezierCurveTo(8.6, -23, 13.6, -17.4, 13.8, -7.4); c.quadraticCurveTo(-0.8, -4.4, -15.8, -7.2); c.closePath(); };
  body(); fill(c, radial(c, -6.4, -18, 1, 26, [0, B.l, 0.35, B.m, 0.9, B.d, 1, B.d]));
  rimStrip(c, body, -4, -14, 11, -3, B.b, 6);
  c.save(); body(); c.clip();
  c.beginPath(); c.moveTo(0.4, -23.4); c.quadraticCurveTo(-1.8, -14, -1.2, -4); stroke(c, rgba(B.k, 0.85), 1.3);          // wing-case seam
  for (const [x, y, r] of [[-8.4, -13.4, 2.4], [-8, -9, 1.8], [6.4, -14, 2.3], [7.6, -9.4, 1.7]]) { dot(c, x, y, r, C.accent); c.beginPath(); c.arc(x, y, r, 0, TAU); stroke(c, rgba(B.k, 0.6), 0.7); }
  c.restore();
  body(); stroke(c, B.k, 1.7);
  gleam(c, -7.6, -18.6, 3.6, 1.8, -0.6 * f, 0.85);
  gleam(c, -2.8, -21.0, 1.0, 0.8, 0, 0.8);
}

function crabArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, DK = C.dark;
  // legs: three a side, scuttling
  for (const side of [-1, 1]) [0, 1, 2].forEach((i) => {
    const a = ph * (side > 0 ? 1 : -1) + i * 2.1, bx = side * (5.4 + i * 2.4), fx = side * (10.5 + i * 2.8) + Math.sin(a) * 1.8, lift = Math.max(0, Math.cos(a)) * 1.8;
    c.beginPath(); c.moveTo(bx, -5.6); c.quadraticCurveTo(side * (9.5 + i * 2.2), -8.4 + i * 0.4, fx, -0.8 - lift); stroke(c, DK.k, 2.8); stroke(c, DK.m, 1.4);
  });
  // claws (snapping): near claw (front, +x) a little bigger
  const snap = (Math.sin(ph * 2) * 0.5 + 0.5);
  for (const [side, sc] of [[-1, 0.85], [1, 1]]) {
    const cx = side * 13.2, cy = -15.2 - (side > 0 ? 0 : 0.8);
    c.beginPath(); c.moveTo(side * 8, -11); c.quadraticCurveTo(side * 11, -13, cx, cy + 3); stroke(c, DK.k, 4.0); stroke(c, DK.m, 2.4);
    c.save(); c.translate(cx, cy); c.scale(sc, sc);
    const open = 0.18 + snap * 0.5;
    const claw = (dir) => {                                            // a pincer lobe, dir = -1 upper, +1 lower
      c.save(); c.rotate(-0.5 + dir * open * 0.6);
      blob(c, (cc) => { cc.moveTo(0, 0); cc.bezierCurveTo(-4.4, -dir * 0.4, -4.8, -dir * 5.4, -0.6, -dir * 6.2); cc.bezierCurveTo(1.6, -dir * 6.6, 2.2, -dir * 2.4, 0, 0); cc.closePath(); }, linear(c, 0, -6, 0, 6, [0, B.l, 0.5, B.m, 1, B.d]), B.k, 1.0);
      c.restore();
    };
    claw(1); claw(-1);
    c.restore();
  }
  // eyes on stalks
  for (const [ex, tilt] of [[-3.6, -0.5], [4.2, 0.5]]) {
    c.beginPath(); c.moveTo(ex, -14); c.lineTo(ex + tilt, -19.2); stroke(c, DK.k, 2.6); stroke(c, DK.m, 1.2);
    eyeball(c, ex + tilt + 0.4, -21, 2.6, { ang: 0.8 });
  }
  // shell body
  const path = () => { c.beginPath(); c.ellipse(0, -10, 12.4, 7.6, 0, 0, TAU); };
  solid(c, path, 0, -10, 12.4, 7.6, B, 1.6, f, { gloss: 0.8, rimW: 4 });
  c.save(); path(); c.clip();
  for (const [x, y] of [[-6, -9.6], [-1, -12.2], [5.4, -10.6]]) { dot(c, x, y, 1.15, C.accent); }
  c.restore();
  c.beginPath(); c.moveTo(0.6, -7.6); c.quadraticCurveTo(3.8, -6.4, 6.2, -8); stroke(c, '#4a2a20', 1.0);        // grumpy mouth
}

function miteArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, DK = C.dark;
  const cy = -12.4, R = 10.4;
  // scurrying legs
  for (const side of [-1, 1]) [0, 1, 2].forEach((i) => {
    const a = ph * 2 + i * 2.1 + (side > 0 ? 0 : PI), bx = side * (3.2 + i * 3.0), fx = bx + side * 2 + Math.sin(a) * 2.0, lift = Math.max(0, Math.cos(a)) * 2.2;
    c.beginPath(); c.moveTo(bx, cy + 6); c.quadraticCurveTo(side * (6 + i * 2.6), cy + 8.5, fx, -0.8 - lift); stroke(c, DK.k, 2.5); stroke(c, DK.m, 1.2);
  });
  // fuzzy body: a ring of soft tufts that shiver
  const tufts = 17;
  const fuzz = () => {
    c.beginPath();
    for (let i = 0; i < tufts * 2; i++) {
      const a = i * PI / tufts + Math.sin(ph + i) * 0.03, r = R + (i % 2 ? -0.2 : 2.5 + Math.sin(ph * 2 + i * 1.3) * 0.5);
      c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, cy + Math.sin(a) * r * 0.98);
    }
    c.closePath();
  };
  fuzz(); fill(c, radial(c, -4, cy - 5, 1, R * 1.4, [0, B.l, 0.4, B.m, 1, B.d])); rimStrip(c, fuzz, -3, cy - 3, 8, cy + 9, B.b, 5);
  fuzz(); stroke(c, B.k, 1.5);
  // belly patch, cheeks, two googly eyes, a fanged grin
  ellPath(c, 0, cy + 5.2, 6.4, 3.4); fill(c, rgba(C.accent, 0.5));
  eyeball(c, -2.6, cy - 2.4, 3.5, { ang: 0.8, look: 1.2 });
  eyeball(c, 4.6, cy - 2.2, 3.0, { ang: 0.8, look: 1.2 });
  c.beginPath(); c.moveTo(-3.2, cy + 3.2); c.quadraticCurveTo(0.8, cy + 6.4, 5.2, cy + 3.2); stroke(c, '#3a1f18', 1.1);
  for (const x of [-1.6, 2.6]) { c.beginPath(); c.moveTo(x - 0.9, cy + 4.3); c.lineTo(x, cy + 6.1); c.lineTo(x + 0.9, cy + 4.5); c.closePath(); fill(c, '#ffffff'); }
  gleam(c, -6.2, cy - 7.4, 2.6, 1.4, -0.6, 0.7);
}

const WALKER_ART = { snail: snailArt, caterpillar: caterpillarArt, beetle: beetleArt, crab: crabArt, mite: miteArt };
const WALKER_BOX = { snail: [-22, -29, 22, 3], caterpillar: [-21, -26, 22, 3], beetle: [-21, -25, 24, 3], crab: [-24, -30, 24, 3], mite: [-16, -26, 16, 3] };

/** Colours for a creature (species colour way + soft skin + accent + dark shade), derived from the palette. */
function creatureColors(species, P, ref, dark) {
  const main = creatureMain(species, P, ref, dark);
  const C = { main: creatureFam(main, P), dark: creatureFam(mix(main, '#2b1b4d', 0.38), P), accent: mix(P.accent, '#ffffff', 0.15), alt: null, skin: null };
  C.alt = creatureFam(mix(main, P.accent, 0.38), P);
  if (species === 'snail') C.skin = creatureFam(mix('#ffe2a2', P.accent, 0.3), P);
  if (species === 'caterpillar') C.skin = creatureFam(mix('#ffcf8a', P.accent, 0.3), P);
  C.accent = species === 'snail' ? mix('#fff0c0', P.accent, 0.4) : species === 'beetle' ? mix('#fff3c8', P.accent, 0.3) : mix('#ffe9a8', P.accent, 0.4);
  return C;
}
const enemyGlows = new WeakMap();
/** Dark-chapter rim light + glow for creatures (memoised per palette: this runs every frame for every enemy). */
function ENEMY_GLOW(P) {
  let g = enemyGlows.get(P);
  if (!g) { g = { rim: mix(P.light, '#ffffff', 0.45), glow: rgba(P.light, 0.6), blur: 3.4, w: 0.8 }; enemyGlows.set(P, g); }
  return g;
}

/** One enemy frame, cached per (palette group, species, darkness, facing, frame). */
function enemySprite(cache, kind, species, P, dark, f, fr, box, art, ref) {
  const g = palKey(P);
  useGroup(cache, g);
  return bake(cache, `@${g}|${kind}|${species}|${dark ? 'd' : 'l'}|${fr}`, f, box[0], box[1], box[2], box[3],
    (c, ff) => art(c, fr, ff, creatureColors(species, P, ref, dark)), dark ? ENEMY_GLOW(P) : null, WALK_K[species] || 1);
}
const frameOf = (t, rate, i) => Math.floor(frac(t * rate + i * 0.173) * FRAMES) % FRAMES;

/**
 * A ground enemy. Origin = feet (bottom-centre), art ≈ 34×26 u. `squash` 0..1 = stomped (flattens; renderer fades it).
 * Optional `i` = phase offset (e.g. the enemy id) so neighbours don't march in step; `dark` = dark-chapter rim light + glow.
 */
export function drawWalker(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const species = WALK_RATE[p.species] ? p.species : 'beetle';
  const P = okPalette(p.palette), f = p.face < 0 ? -1 : 1, dark = p.dark === undefined ? paletteIsDark(P) : !!p.dark;
  const fr = frameOf(num(p.t), WALK_RATE[species], num(p.i));
  const s = enemySprite(cache, 'w', species, P, dark, f, fr, WALKER_BOX[species], WALKER_ART[species], 'top');
  const sq = clamp(num(p.squash), 0, 1);
  ctx.save(); ctx.translate(num(p.x), num(p.y));
  if (sq > 0) ctx.scale(1 + 0.4 * sq, 1 - 0.7 * sq);
  blit(ctx, s);
  ctx.restore();
}

/* ═══════════════════════════════════ FLYERS ═══════════════════════════════════ */
const FLY_RATE = { bee: 4.5, moth: 2.2, gull: 1.7, bat: 3.0, owl: 2.0, hawk: 1.8 };
const wingA = (ph, lo, hi) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(ph));

function beeArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, Y = C.main, K = C.dark;
  const bob = Math.sin(ph) * 0.0;
  // far wing, then body, then near wing (translucent, flapping)
  const wing = (rot, a, sc) => {
    c.save(); c.translate(-1.2, -5.4); c.rotate(rot); c.scale(sc, sc);
    c.beginPath(); c.moveTo(0, 0); c.bezierCurveTo(-3, -6.4, -11.5, -7.4, -13.4, -3.6); c.bezierCurveTo(-12, 0.4, -5, 1.2, 0, 0); c.closePath();
    fill(c, rgba('#f2fbff', a)); stroke(c, rgba('#4a6f98', 0.75), 1.0);
    c.beginPath(); c.moveTo(-1.5, -0.6); c.lineTo(-10.5, -3.6); stroke(c, rgba('#4a6f98', 0.35), 0.6);
    c.restore();
  };
  wing(-0.2 - wingA(ph + 1.2, 0.1, 0.9) * 0.6 - 0.2, 0.45, 0.9);
  // sting (it HURTS: a clear dark point at the back)
  c.beginPath(); c.moveTo(-9.6, 1.0); c.lineTo(-15.2, 3.0); c.lineTo(-9.6, 4.8); c.closePath(); fill(c, K.m); stroke(c, K.k, 1.1);
  const body = () => { c.beginPath(); c.ellipse(-1.5, 1.8, 9.8, 7.0, 0, 0, TAU); };
  body(); fill(c, radial(c, -5, -2, 1, 14, [0, Y.l, 0.45, Y.m, 1, Y.d]));
  c.save(); body(); c.clip();
  for (const x of [-6.4, -0.4]) { c.beginPath(); c.moveTo(x, -6); c.quadraticCurveTo(x + 2, 2, x - 0.4, 10); c.lineTo(x + 3.4, 10); c.quadraticCurveTo(x + 5.4, 2, x + 3.2, -6); c.closePath(); fill(c, '#3c2a20'); }
  rimStrip(c, body, -4, -2, 6, 9, Y.b, 4);
  c.restore();
  body(); stroke(c, Y.k, 1.5);
  gleam(c, -6.4, -2.6, 2.4, 1.2, -0.5, 0.85);
  // head with grumpy eye and feelers
  c.beginPath(); c.moveTo(9.6, -4.6); c.quadraticCurveTo(10.6, -8.4, 13.4, -9.4); stroke(c, K.k, 1.1); dot(c, 13.6, -9.6, 1.3, K.m);
  c.beginPath(); c.moveTo(7.4, -5); c.quadraticCurveTo(7.4, -8.6, 9.2, -10.4); stroke(c, K.k, 1.1); dot(c, 9.4, -10.6, 1.3, K.m);
  const head = () => { c.beginPath(); c.ellipse(8.4, -0.2, 5.6, 5.4, 0, 0, TAU); };
  head(); fill(c, ballGrad(c, 8.4, -0.2, 5.6, 5.4, Y, f)); stroke(c, Y.k, 1.4);
  eyeball(c, 9.7, -1.4, 2.8, { ang: 0.9 });
  c.beginPath(); c.moveTo(9.4, 3.2); c.quadraticCurveTo(11.4, 3.6, 12.8, 2.2); stroke(c, '#4a2a20', 0.9);
  // legs
  c.beginPath(); for (const x of [-3, 1.5, 5.4]) { c.moveTo(x, 7); c.lineTo(x - 0.4, 9.6); } stroke(c, K.k, 1.2);
  wing(-0.2 - wingA(ph, 0.1, 0.9) * 0.9, 0.7, 1);
}

function mothArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, W = C.main, K = C.dark;
  c.save();
  // two broad wings fanning up and down at the sides, with eye-spots (the classic moth silhouette)
  const ang = wingA(ph, -0.78, 0.5);
  const wing = (side) => {
    c.save(); c.translate(side * 2.4, -2.6); c.scale(side, 1); c.rotate(ang);
    const path = () => { c.beginPath(); c.moveTo(0.4, -1.6); c.bezierCurveTo(3, -9.4, 12, -13, 17.8, -8.6); c.bezierCurveTo(19.6, -5.6, 17.4, -1.4, 13.6, 0.6); c.bezierCurveTo(14.8, 4, 13, 8.8, 8.2, 9.2); c.bezierCurveTo(4, 9.6, 1.6, 6.8, 0.4, 3.8); c.closePath(); };
    path(); fill(c, radial(c, 6, -6, 1, 22, [0, W.l, 0.5, W.m, 1, W.d])); rimStrip(c, path, 4, -8, 16, 4, W.b, 3.4);
    c.save(); path(); c.clip();
    c.beginPath(); c.moveTo(0.6, -0.6); c.lineTo(15.6, -8); c.moveTo(0.6, 0.6); c.lineTo(15, -0.2); c.moveTo(0.6, 2); c.lineTo(10.4, 8); stroke(c, rgba(W.k, 0.3), 0.7);
    c.restore();
    path(); stroke(c, W.k, 1.5);
    ellPath(c, 11.4, -4.6, 3.5, 3.4); ink(c, C.accent, W.k, 0.9); dot(c, 11.4, -4.6, 1.7, '#3a2a40'); gleam(c, 10.7, -5.4, 0.7, 0.7, 0, 1);
    for (const [x, y] of [[5.6, -3.4], [6.4, 4.4], [12.6, 4.8]]) dot(c, x, y, 0.9, rgba(W.k, 0.45));
    c.restore();
  };
  wing(-1); wing(1);
  // furry body, head with big cross eyes and feathery antennae
  const bodyG = fam(mix(K.m, '#d9b890', 0.35), { k: K.k });
  const body = () => { c.beginPath(); c.ellipse(0, 3.6, 4.0, 7.4, 0, 0, TAU); };
  body(); fill(c, ballGrad(c, 0, 3.6, 4, 7.4, bodyG, f)); stroke(c, bodyG.k, 1.3);
  c.beginPath(); for (const y of [2, 5.4, 8.6]) { c.moveTo(-2.4, y); c.lineTo(0, y + 1.5); c.lineTo(2.4, y); } stroke(c, rgba(bodyG.k, 0.45), 0.8);
  for (const sg of [-1, 1]) {
    c.beginPath(); c.moveTo(sg * 1.4, -8.2); c.quadraticCurveTo(sg * 3.4, -13, sg * 6.6, -14.6 + Math.sin(ph) * 0.6); stroke(c, bodyG.k, 1.1);
    c.beginPath(); for (let i = 1; i <= 4; i++) { const t = i / 5, px = sg * (1.4 + 5.2 * t), py = -8.2 - 6.4 * t; c.moveTo(px, py); c.lineTo(px + sg * 1.5, py - 1.6); } stroke(c, bodyG.k, 0.75);
  }
  const hp = () => { c.beginPath(); c.arc(f * 0.5, -6.4, 3.8, 0, TAU); };
  hp(); fill(c, ballGrad(c, f * 0.5, -6.4, 3.8, 3.8, bodyG, f)); stroke(c, bodyG.k, 1.2);
  eyeball(c, -1.9 + f * 0.5, -6.6, 1.9, { ang: 0.6, look: 0 }); eyeball(c, 2.3 + f * 0.5, -6.6, 1.9, { ang: 0.6, look: 0 });
  c.restore();
}
function mixFam(a, b, t) { return fam(mix(a.m, b.m, t), { k: a.k }); }

function gullArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, W = C.main, K = C.dark;
  const wing = (rot, sc, alpha) => {
    c.save(); c.translate(-1.5, -3); c.rotate(rot); c.scale(sc, sc); c.globalAlpha *= alpha;
    const path = () => { c.beginPath(); c.moveTo(2, 0); c.bezierCurveTo(-2, -5.4, -12, -6.4, -22, -3.6); c.lineTo(-22.6, -1.6); c.bezierCurveTo(-14, 0.2, -6, 3.4, 2, 3.2); c.closePath(); };
    path(); fill(c, linear(c, 0, -6, 0, 3, [0, W.l, 0.55, W.m, 1, W.d])); stroke(c, W.k, 1.3);
    c.save(); path(); c.clip(); c.beginPath(); c.moveTo(-14, -8); c.lineTo(-24, -8); c.lineTo(-24, 6); c.lineTo(-16, 6); c.closePath(); fill(c, '#2c3d58'); c.restore();   // dark wing tips
    path(); stroke(c, W.k, 1.3);
    c.restore();
  };
  const a = wingA(ph, -1.0, 0.5);
  wing(a * 0.7 - 0.2, 0.86, 0.9);
  // tail + body + head
  c.beginPath(); c.moveTo(-8, 1.4); c.lineTo(-15, 0.4); c.lineTo(-14, 5.4); c.lineTo(-8, 5.4); c.closePath(); ink(c, W.m, W.k, 1.2);
  blob(c, (cc) => { ell(cc, -0.6, 2.4, 9.6, 5.6, 0.04); ell(cc, 8.4, -0.4, 4.6, 4.5); }, ballGrad(c, 1, 1, 12, 8, W, f), W.k, 1.3);
  gleam(c, -2.6, -0.8, 3.6, 1.2, -0.1, 0.85);
  // hooked beak (orange) — it bites
  c.beginPath(); c.moveTo(11.8, -2.2); c.bezierCurveTo(14.6, -2.8, 18, -2.4, 18.6, -0.4); c.quadraticCurveTo(17.6, -0.2, 17.2, 1.2); c.bezierCurveTo(15.4, 0.6, 13.4, 0.8, 11.8, 0.8); c.closePath();
  ink(c, linear(c, 0, -3, 0, 1, [0, '#ffd26a', 1, '#f08a1c']), '#8a4a0c', 1.0);
  eyeball(c, 9.6, -1.6, 2.4, { ang: 0.9 });
  wing(a, 1.0, 1);
}

function batArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, M = C.alt;
  c.translate(3.4, 0);                                         // the wings sweep back: nudge the body forward so the art centres on the hitbox
  const wing = (rot, sc, alpha) => {
    c.save(); c.translate(-1.6, -1.2); c.rotate(rot); c.scale(sc, sc); c.globalAlpha *= alpha;
    const path = () => { c.beginPath(); c.moveTo(1, -1); c.quadraticCurveTo(-6, -8, -20, -9.4); c.quadraticCurveTo(-17, -5.6, -19.4, -2.4); c.quadraticCurveTo(-14.6, -3.6, -14.4, 1.2); c.quadraticCurveTo(-10.4, -0.6, -9, 4.6); c.quadraticCurveTo(-5.4, 2.6, 1, 4.4); c.closePath(); };
    path(); fill(c, radial(c, -4, -2, 1, 22, [0, M.l, 0.5, M.m, 1, M.d])); stroke(c, B.k, 1.3);
    c.beginPath(); c.moveTo(0, -0.6); c.lineTo(-19.4, -8.8); c.moveTo(0, 0.4); c.lineTo(-14.4, 0.6); c.moveTo(0, 1.4); c.lineTo(-9, 4.2); stroke(c, rgba(B.k, 0.7), 1.0);
    c.restore();
  };
  const a = wingA(ph, -1.1, 0.45);
  wing(a * 0.75 - 0.1, 0.86, 0.9);
  // ears, body, head
  for (const [ex, ey, dx] of [[2, -7.6, -1], [6.4, -8, 1.4]]) { c.beginPath(); c.moveTo(ex - 2, ey + 3); c.lineTo(ex + dx * 0.4, ey - 4); c.lineTo(ex + 2.6, ey + 3); c.closePath(); ink(c, B.m, B.k, 1.1); }
  const bp = () => { c.beginPath(); c.ellipse(0, 1.2, 5.8, 6.4, 0, 0, TAU); };
  bp(); fill(c, ballGrad(c, 0, 1.2, 5.8, 6.4, B, f)); stroke(c, B.k, 1.4);
  const hp = () => { c.beginPath(); c.arc(4.6, -3.6, 4.8, 0, TAU); };
  hp(); fill(c, ballGrad(c, 4.6, -3.6, 4.8, 4.8, B, f)); stroke(c, B.k, 1.4);
  rimStrip(c, hp, 2, -6, 8, 0, B.b, 2.6);
  // glowing eyes + tiny fangs
  c.save(); eyeball(c, 6.2, -4.2, 2.5, { ang: 0.95, k: '#6a3a00' });
  ellPath(c, 6.9, -4.1, 1.3, 1.9); fill(c, '#ffe05a'); ellPath(c, 7.2, -4.1, 0.55, 1.4); fill(c, INK); c.restore();
  c.beginPath(); c.moveTo(6.4, -0.2); c.lineTo(7.4, 2.4); c.lineTo(8.2, -0.2); c.closePath(); fill(c, '#ffffff'); stroke(c, B.k, 0.5);
  c.beginPath(); c.moveTo(3.4, -0.4); c.lineTo(4.2, 1.8); c.lineTo(5.2, -0.4); c.closePath(); fill(c, '#ffffff'); stroke(c, B.k, 0.5);
  wing(a, 1.0, 1);
}

function owlArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, L = C.alt;
  const wing = (side, rot, alpha) => {
    c.save(); c.translate(side * 7.6, -1.6); c.scale(side, 1); c.rotate(rot); c.globalAlpha *= alpha;
    const path = () => { c.beginPath(); c.moveTo(0, -2.8); c.bezierCurveTo(5, -4.6, 12.2, -3.4, 15.6, 0.4); c.quadraticCurveTo(17, 2.8, 14.2, 3.8); c.quadraticCurveTo(14.2, 6.2, 11.4, 6.0); c.quadraticCurveTo(10.4, 8.4, 7.8, 6.8); c.bezierCurveTo(4, 6, 1.6, 4, 0, 3); c.closePath(); };
    path(); fill(c, linear(c, 0, -4, 0, 6, [0, B.l, 0.5, B.m, 1, B.d])); stroke(c, B.k, 1.3);
    c.beginPath(); c.moveTo(4, 0.6); c.lineTo(12, 1.6); stroke(c, rgba(B.k, 0.4), 0.7);
    c.restore();
  };
  const a = wingA(ph, -0.85, 0.5);
  wing(-1, -a, 0.9); wing(1, -a, 0.9);
  // talons
  for (const x of [-3, 3]) { c.beginPath(); c.moveTo(x - 1.6, 9.2); c.lineTo(x, 11.4); c.lineTo(x + 1.6, 9.2); c.closePath(); ink(c, '#ffb23a', '#8a4a0c', 0.8); }
  // body, belly, ear tufts, face disc
  for (const sg of [-1, 1]) { c.beginPath(); c.moveTo(sg * 8, -7.4); c.lineTo(sg * 6.8, -13.2); c.lineTo(sg * 3, -9.6); c.closePath(); ink(c, B.m, B.k, 1.2); }
  const bp = () => { c.beginPath(); c.moveTo(0, -10.6); c.bezierCurveTo(8.2, -10.6, 10.4, -3, 9.4, 3.4); c.bezierCurveTo(8.4, 9.8, 4, 11, 0, 11); c.bezierCurveTo(-4, 11, -8.4, 9.8, -9.4, 3.4); c.bezierCurveTo(-10.4, -3, -8.2, -10.6, 0, -10.6); c.closePath(); };
  bp(); fill(c, ballGrad(c, 0, 0, 10, 11, B, f)); rimStrip(c, bp, -3, -4, 8, 9, B.b, 5); bp(); stroke(c, B.k, 1.6);
  c.save(); bp(); c.clip();
  ellPath(c, 0, 5.4, 6, 5.4); fill(c, rgba(L.l, 0.9));
  for (const [x, y] of [[-2.4, 3.6], [2.4, 3.6], [0, 6.2], [-3.4, 7.4], [3.4, 7.4]]) { c.beginPath(); c.moveTo(x - 1.4, y); c.quadraticCurveTo(x, y + 1.8, x + 1.4, y); stroke(c, rgba(B.k, 0.5), 0.8); }
  c.restore();
  // big stern eyes, side-looking
  const look = f * 0.9;
  for (const sx of [-1, 1]) {
    ellPath(c, sx * 4.2, -4.4, 4.2, 4.2); ink(c, '#fff6dc', B.k, 1.1);
    ellPath(c, sx * 4.2 + look, -4.2, 2.5, 2.8); fill(c, '#ffbf2e');
    ellPath(c, sx * 4.2 + look * 1.3, -4.1, 1.5, 1.8); fill(c, INK);
    gleam(c, sx * 4.2 + look - 0.8, -5.2, 0.7, 0.7, 0, 1);
    c.beginPath(); c.moveTo(sx * 0.6, -6.4 + 0.2); c.lineTo(sx * 8, -10.2); stroke(c, '#2b1810', 1.6);      // stern V brow
  }
  c.beginPath(); c.moveTo(-1.8, -1.6); c.lineTo(1.8, -1.6); c.lineTo(0, 1.6); c.closePath(); ink(c, '#ffb23a', '#8a4a0c', 0.9);
}

function hawkArt(c, fr, f, C) {
  const ph = fr / FRAMES * TAU, B = C.main, L = C.alt;
  const wing = (rot, sc, alpha) => {
    c.save(); c.translate(-1.2, -2.8); c.rotate(rot); c.scale(sc, sc); c.globalAlpha *= alpha;
    const path = () => { c.beginPath(); c.moveTo(3, 0); c.bezierCurveTo(-1, -5.6, -9, -7, -20, -5.6); for (let i = 0; i < 4; i++) { c.lineTo(-23 + i * 0.4, -4 + i * 2.4 - 0.6); c.lineTo(-18 + i * 2.8, -2.8 + i * 2.2 + 1.4); } c.bezierCurveTo(-8, 3.2, -2, 3.6, 3, 2.6); c.closePath(); };
    path(); fill(c, linear(c, 0, -7, 0, 4, [0, B.l, 0.5, B.m, 1, B.d])); stroke(c, B.k, 1.3);
    c.beginPath(); c.moveTo(-6, -3); c.lineTo(-18, -3.4); stroke(c, rgba(B.k, 0.35), 0.7);
    c.restore();
  };
  const a = wingA(ph, -1.0, 0.45);
  wing(a * 0.7 - 0.2, 0.86, 0.9);
  // tail fan
  c.beginPath(); c.moveTo(-8, 0.4); c.lineTo(-17, -2); c.lineTo(-17.6, 1.4); c.lineTo(-16, 4.4); c.lineTo(-8, 3.4); c.closePath(); ink(c, B.d, B.k, 1.2);
  // talons reaching forward
  for (const x of [1, 5]) { c.beginPath(); c.moveTo(x, 4.4); c.lineTo(x + 1.6, 7.6); c.lineTo(x + 3.2, 7.2); stroke(c, '#8a4a0c', 2.2); stroke(c, '#ffc84a', 1.0); }
  blob(c, (cc) => { ell(cc, -0.6, 0.8, 10.6, 4.9, 0.05); ell(cc, 9.4, -2.2, 4.4, 4.3); }, ballGrad(c, 1, -1, 13, 7, B, f), B.k, 1.4);
  ellPath(c, 1.6, 2.4, 6.4, 2.4, 0.04); fill(c, rgba(L.l, 0.85));
  gleam(c, -2.4, -2.4, 3.4, 1.0, -0.1, 0.8);
  // fierce hooked beak, cap and brow
  c.beginPath(); c.moveTo(12.4, -4.2); c.bezierCurveTo(15.4, -4.8, 18.6, -3.8, 19, -1.2); c.quadraticCurveTo(17.6, -1.4, 17, 0.4); c.bezierCurveTo(15.2, -0.6, 13.6, -0.6, 12.2, -0.8); c.closePath();
  ink(c, linear(c, 0, -5, 0, 0, [0, '#ffe07a', 1, '#f0a020']), '#8a4a0c', 1.0);
  eyeball(c, 10.4, -3.4, 2.5, { ang: 1.0 });
}

const FLYER_ART = { bee: beeArt, moth: mothArt, gull: gullArt, bat: batArt, owl: owlArt, hawk: hawkArt };
const FLYER_BOX = { bee: [-18, -16, 18, 13], moth: [-20, -22, 20, 12], gull: [-26, -19, 22, 13], bat: [-24, -20, 16, 15], owl: [-26, -20, 26, 18], hawk: [-27, -19, 24, 14] };

function flyerColors(species, P, dark) {
  if (species === 'bee') {
    const main = mix('#ffd02e', P.accent, 0.12);
    return { main: creatureFam(main, P), dark: creatureFam('#4a3228', P, { l: '#7a5a48' }), accent: P.accent, alt: null };
  }
  if (species === 'gull') {
    const main = mix('#f6f6ff', P.sky, 0.1);
    return { main: creatureFam(main, P, { d: mix(main, '#6a7aa8', 0.4), k: mix('#3a4a78', P.outline, 0.3) }), dark: creatureFam('#3a4a78', P), accent: P.accent, alt: null };
  }
  const main = creatureMain(species, P, 'sky', dark);
  const C = { main: creatureFam(main, P), dark: creatureFam(mix(main, '#2b1b4d', 0.4), P), accent: mix(P.accent, '#ffffff', 0.2), alt: creatureFam(mix(main, P.accent, 0.42), P) };
  if (species === 'moth') C.accent = mix('#ffb04a', P.accent, 0.3);
  if (species === 'bat') C.alt = creatureFam(mix(main, '#ff7ab0', 0.4), P);
  if (species === 'owl') C.alt = creatureFam(mix(main, '#fff0c8', 0.6), P);
  if (species === 'hawk') C.alt = creatureFam(mix(main, '#fff0c8', 0.65), P);
  return C;
}

/**
 * A flying enemy. Origin = CENTRE (like the sim's flyer y), art ≈ 30×24 u. Optional `i` = phase offset, `dark` = rim light.
 */
export function drawFlyer(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const species = FLY_RATE[p.species] ? p.species : 'bee';
  const P = okPalette(p.palette), f = p.face < 0 ? -1 : 1, dark = p.dark === undefined ? paletteIsDark(P) : !!p.dark;
  const fr = frameOf(num(p.t), FLY_RATE[species], num(p.i));
  const s = flyerSprite(cache, species, P, dark, f, fr);
  ctx.save(); ctx.translate(num(p.x), num(p.y));
  blit(ctx, s);
  ctx.restore();
}
const MOTH_GLOW = { rim: '#fff6c8', glow: 'rgba(255,240,160,0.65)', blur: 3.6, w: 0.5 };   // moths always carry a soft lantern glow
function flyerSprite(cache, species, P, dark, f, fr) {
  const g = palKey(P);
  useGroup(cache, g);
  const box = FLYER_BOX[species];
  const glow = dark ? ENEMY_GLOW(P) : species === 'moth' ? MOTH_GLOW : null;
  return bake(cache, `@${g}|f|${species}|${dark ? 'd' : 'l'}|${fr}`, f, box[0], box[1], box[2], box[3],
    (c, ff) => FLYER_ART[species](c, fr, ff, flyerColors(species, P, dark)), glow, FLY_K[species] || 1);
}

/* ═════════════════════════════════ CHECKPOINT FLAG ═════════════════════════════════ */
const POLE = fam('#fff1d2', { l: '#ffffff', d: '#e2b9a4', b: '#ffe2b8', k: '#7a4a2a' });
const FLAG_H = 56;

function poleArt(c, f, pal) {
  // a little mound, a cream pole and a gold finial
  blob(c, (cc) => { ell(cc, 0, -1.6, 8.4, 3.2); }, linear(c, 0, -5, 0, 1.4, [0, pal.rockL, 1, pal.rockD]), pal.rockK, 1.0);
  rr(c, -1.5, -FLAG_H + 1, 3, FLAG_H - 2, 1.5); ink(c, linear(c, -1.5, 0, 1.5, 0, [0, POLE.l, 0.55, POLE.m, 1, POLE.d]), POLE.k, 1.0);
  c.beginPath(); c.arc(0, -FLAG_H - 0.6, 2.7, 0, TAU); ink(c, ballGrad(c, 0, -FLAG_H - 0.6, 2.7, 2.7, GOLD, 1), GOLD.k, 1.0);
}
function pennantArt(c, fr, active, col, pal) {
  const ph = fr / FRAMES * TAU, L = 27, top = -FLAG_H + 4.4, H = active ? 17.5 : 16;
  const wave = (x, amp) => Math.sin(ph - x * 0.26) * amp * Math.min(1, x / 12);
  const edge = (yOff) => { const pts = []; for (let i = 0; i <= 10; i++) { const x = 1.5 + (L - 1.5) * i / 10; pts.push([x, top + yOff + wave(x, active ? 2.6 : 0.7) + (active ? 0 : i * 0.2)]); } return pts; };
  if (active) {
    const A = edge(0), B = edge(H);
    c.beginPath(); c.moveTo(A[0][0], A[0][1]); for (const [x, y] of A) c.lineTo(x, y);
    c.lineTo(L - 6, top + H / 2 + wave(L - 6, 2.6)); for (let i = B.length - 1; i >= 0; i--) c.lineTo(B[i][0], B[i][1]); c.closePath();
    fill(c, linear(c, 0, top, 0, top + H, [0, col.l, 0.5, col.m, 1, col.d]));
    // fold shading follows the wave
    for (let i = 0; i < 10; i++) {
      const dy = wave(A[i + 1][0], 2.6) - wave(A[i][0], 2.6);
      c.beginPath(); c.moveTo(A[i][0], A[i][1]); c.lineTo(A[i + 1][0], A[i + 1][1]); c.lineTo(B[i + 1][0], B[i + 1][1]); c.lineTo(B[i][0], B[i][1]); c.closePath();
      fill(c, dy > 0 ? 'rgba(40,10,60,0.16)' : 'rgba(255,255,255,0.14)');
    }
    c.beginPath(); c.moveTo(A[0][0], A[0][1]); for (const [x, y] of A) c.lineTo(x, y);
    c.lineTo(L - 6, top + H / 2 + wave(L - 6, 2.6)); for (let i = B.length - 1; i >= 0; i--) c.lineTo(B[i][0], B[i][1]); c.closePath();
    stroke(c, col.k, 1.4);
    // egg emblem on the cloth
    const ex = 10.6, ey = top + H / 2 + wave(10.6, 2.6) * 0.9;
    c.save(); c.translate(ex, ey); eggPath(c, 0, 0, 3.8, 4.8); ink(c, linear(c, 0, -5, 0, 5, [0, '#fffbe0', 1, '#ffd54a']), GOLD.k, 0.9); gleam(c, -1.2, -1.8, 0.8, 1.2, 0.4, 0.9); c.restore();
  } else {
    // waiting: a limp, drooping pennant hanging from the top, faded, with a hollow egg outline to say "touch me"
    const hang = (x, k) => Math.sin(ph - x * 0.3) * 0.5 * k;
    c.beginPath(); c.moveTo(1.5, top); c.quadraticCurveTo(14, top + 2.5, 19, top + 9.5); c.lineTo(16, top + 15 + hang(16, 1)); c.quadraticCurveTo(9, top + 11 + hang(9, 1), 1.5, top + 14.5); c.closePath();
    fill(c, linear(c, 0, top, 0, top + 15, [0, '#dfe8ee', 1, '#a9b6c8'])); stroke(c, '#5a6a82', 1.3);
    c.beginPath(); eggPath(c, 8.4, top + 8, 3.3, 4.2); c.setLineDash([1.4, 1.4]); stroke(c, '#5a6a82', 0.9); c.setLineDash([]);
  }
}
const FLAG_HALO_ART = (c) => flagGlow(c, '#ffe27a');
const flagHalo = (cache) => sprite(cache, 'flag|glow', -24, -24, 24, 24, FLAG_HALO_ART);
function flagGlow(c, col) { c.beginPath(); c.arc(0, 0, 24, 0, TAU); fill(c, radial(c, 0, 0, 2, 24, [0, rgba(col, 0.55), 1, rgba(col, 0)])); }

/** Checkpoint flag. Origin = base of the pole on the ground. Inactive = limp, faded, hollow egg; active = proud, glowing, golden egg. */
const FLAG_GLOW = { rim: '#fff6d8', glow: 'rgba(255,225,150,0.55)', blur: 3.5, w: 0.7 };
const flagStyles = new WeakMap();
/** Cloth colour family + mound colours for a palette (memoised: drawFlag runs every frame). */
function flagStyle(P, dark) {
  let s = flagStyles.get(P);
  if (!s) { s = {}; flagStyles.set(P, s); }
  const k = dark ? 1 : 0;
  if (!s[k]) {
    const colHex = mix(hsl(...pickWay('flag', P, 'top', dark)), P.accent, 0.1);
    s[k] = { col: creatureFam(colHex, P), pal: { rockL: lit(P.rock, 0.25), rockD: shade(P.rock, 0.3), rockK: outline(P.rock, 0.6) } };
  }
  return s[k];
}
/** The cached pole + mound of a flag. */
function flagPole(cache, P, dark) {
  const g = palKey(P);
  useGroup(cache, g);
  const pal = flagStyle(P, dark).pal;
  return bake(cache, `@${g}|pole${dark ? 'd' : ''}`, 1, -10, -FLAG_H - 5, 10, 2, (c, ff) => poleArt(c, ff, pal), dark ? FLAG_GLOW : null);
}
/** One cached frame of a flag's pennant. */
function flagCloth(cache, P, dark, active, fr) {
  const g = palKey(P);
  useGroup(cache, g);
  const { col, pal } = flagStyle(P, dark);
  return bake(cache, `@${g}|pen${active ? 'A' : 'I'}${dark ? 'd' : ''}|${fr}`, 1, -1, -FLAG_H, 30, -FLAG_H + 28, (c) => pennantArt(c, fr, active, col, pal), dark ? FLAG_GLOW : null);
}
export function drawFlag(ctx, cache, p) {
  smoothOn(ctx);
  p = p || {};
  const P = okPalette(p.palette), t = num(p.t), x = num(p.x), y = num(p.y), active = !!p.active;
  const dark = p.dark === undefined ? paletteIsDark(P) : !!p.dark;
  const fr = Math.floor(frac(t * (active ? 1.5 : 0.7)) * FRAMES) % FRAMES;
  const sPole = flagPole(cache, P, dark), sCloth = flagCloth(cache, P, dark, active, fr);
  ctx.save(); ctx.translate(x, y);
  if (active) {
    const gl = flagHalo(cache);
    const pu = 0.5 + 0.5 * Math.sin(t * 3.2);
    blitAt(ctx, gl, 12, -FLAG_H + 12, 0, 1.15, 1.0, 0.35 + 0.25 * pu);
  }
  blit(ctx, sPole);
  blit(ctx, sCloth);
  if (active) {
    const sp = sprite(cache, 'egg|spark', -9, -9, 9, 9, sparkleArt);
    for (let i = 0; i < 3; i++) {
      const k = frac(t * 0.8 + i / 3), a = 1 - Math.abs(k * 2 - 1);
      blitAt(ctx, sp, 6 + i * 9 + Math.sin(t * 2 + i) * 2, -FLAG_H + 2 - k * 9, 0, 0.4 * a + 0.1, 0.4 * a + 0.1, a);
    }
  }
  ctx.restore();
}

/* ═════════════════════════════════ SIZES & WARM-UP ═════════════════════════════════ */
/** Art extents in world units (width × height of the visible art; origin as documented per draw call), plus shadow footprint. */
export const ACTOR_SIZES = Object.freeze({
  mama: Object.freeze({ w: 36, h: 46, bodyW: 31, bodyH: 38, shadowW: 28 }),   // art incl. beak + tuft; the shell alone is 31 × 38 (her hurtbox is 26 × 38)
  duckling: Object.freeze({ w: 26, h: 23, shadowW: 18 }),
  egg: Object.freeze({ w: 15, h: 21 }),                                       // centre origin; bobs ±1.7
  gold: Object.freeze({ w: 22, h: 28, glow: 44 }),                            // centre origin; body only (sparkles/glow reach ~±18)
  walker: Object.freeze({ w: 42, h: 27, shadowW: 28 }),                       // feet origin (hurtbox 34 × 26; the longest, the beetle, is 41 u nose to tail)
  flyer: Object.freeze({ w: 43, h: 31 }),                                     // centre origin, widest species (gull / owl) with wings at full spread (hurtbox 30 × 24)
  pickup: Object.freeze({ w: 25, h: 26 }),                                    // centre origin
  bubble: Object.freeze({ w: 49, h: 56, cy: BUBBLE.cy }),                     // drawn about Mama's feet; centre sits `cy` above them
  flag: Object.freeze({ w: 36, h: 64, shadowW: 16 }),                         // base-of-pole origin, pennant to the right
});

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
/**
 * Bake sprites ahead of time so nothing is drawn for the first time in the middle of a run (a first bake costs 1-8 ms here,
 * about 3x that on a phone, and every walker/flyer frame is its own sprite).
 *
 *   prewarmActors(cache, { palette, species: ['snail','bee'], dark, cast: true, flags: true, budgetMs: 3 }) -> boolean
 *
 *   species  walker / flyer species of the landscape (both facings, every frame) in the given lighting; `dark` omitted =
 *            read off the palette (see paletteIsDark).
 *   cast     also Mama (every face, both facings, shield rim), the ducklings, eggs, hatch burst, pickups and the bubble.
 *   flags    also the checkpoint flag (pole + every pennant frame, active and waiting).
 *   budgetMs stop after the first bake that crosses this many ms and return false: call again next frame to continue (what
 *            is already baked is skipped in microseconds). Default Infinity = do it all now. Returns true when finished.
 *
 * Call it again after the renderer changes cache.setScale() (that clears the cache).
 */
export function prewarmActors(cache, { palette, species = [], dark, cast = false, flags = false, budgetMs = Infinity } = {}) {
  const P = okPalette(palette);
  const d = dark === undefined ? paletteIsDark(P) : !!dark;
  const t0 = nowMs();
  const over = () => nowMs() - t0 >= budgetMs;
  for (let fr = 0; fr < FRAMES; fr++) {
    for (const sp of species) for (const f of [1, -1]) {
      const before = cache.map.size;
      if (WALK_RATE[sp]) enemySprite(cache, 'w', sp, P, d, f, fr, WALKER_BOX[sp], WALKER_ART[sp], 'top');
      else if (FLY_RATE[sp]) flyerSprite(cache, sp, P, d, f, fr);
      if (cache.map.size !== before && over()) return false;
    }
    if (flags) for (const active of [false, true]) {
      const before = cache.map.size;
      flagPole(cache, P, d); flagCloth(cache, P, d, active, fr); flagHalo(cache);
      if (cache.map.size !== before && over()) return false;
    }
  }
  if (cast) {
    // The public draw calls bake exactly the sprites they will need; draw into a 2x2 scratch surface and throw it away.
    const sc = createSurface(2, 2).getContext('2d');
    sc.setTransform(cache.scale, 0, 0, cache.scale, 0, 0);
    const run = (fn) => {
      const before = cache.map.size;
      fn();
      return cache.map.size !== before && over();
    };
    const M = { x: 0, y: 0, vx: 110, t: 1, dark: d };
    for (const face of [1, -1]) {
      for (const extra of [{}, { t: 2.56 /* a blink */ }, { happy: true }, { hurt: 1 }, { shield: true }, { onGround: false, vy: -300 }]) {
        if (run(() => drawMama(sc, cache, Object.assign({ face }, M, extra)))) return false;
      }
      if (run(() => drawDuckling(sc, cache, { face, t: 1, dark: d, air: true }))) return false;
      if (run(() => drawDuckling(sc, cache, { face, t: 0, i: 0, dark: d }))) return false;
    }
    for (const fn of [
      () => drawEgg(sc, cache, { kind: 'egg', dark: d }), () => drawEgg(sc, cache, { kind: 'gold', dark: d }),
      () => drawHatchBurst(sc, cache, { progress: 0.1, dark: d }), () => drawHatchBurst(sc, cache, { progress: 0.6, dark: d }),
      () => drawShieldPickup(sc, cache, { dark: d }), () => drawMagnetPickup(sc, cache, { t: 0, dark: d }),
      () => drawMagnetPickup(sc, cache, { t: 0.1, dark: d }), () => drawMagnetPickup(sc, cache, { t: 0.2, dark: d }),
      () => drawShieldBubble(sc, cache, { dark: d }),
    ]) if (run(fn)) return false;
  }
  return true;
}
