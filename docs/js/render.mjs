/*
 * Egg Mama — the Renderer (DESIGN.md sections 2 and 6).
 *
 *   const r = new Renderer(canvas);   await r.load();
 *   r.resize(cssW, cssH, devicePixelRatio, insets);          // insets {top,right,bottom,left} in CSS px (safe areas)
 *   r.resetCamera(game);  await r.whenReady();               // snap to Mama, start decoding her landscape's painting
 *   r.spawn(drainEvents(game), game);                        // visual-only reactions to sim events
 *   r.draw({ game, now, alpha, mode, reducedMotion, fade, paused });
 *
 * ── what it draws, back to front ─────────────────────────────────────────────────────────────────────────────────
 *   painting(s) -> atmosphere -> pit shade -> water -> platforms -> contact shadows -> landmarks (gate, beacon), spikes,
 *   springs, flags -> pickups -> enemies -> ducklings -> Mama (+ bubble, magnet badge) -> particles/sprite effects ->
 *   front flakes -> screen space: popups, egg pill, captions, respawn veil -> fade.
 *   (Deviation from the DESIGN list: contact shadows are drawn right after the platforms, UNDER the spikes/pickups/enemies
 *   they fall on, so a shadow never paints over a creature's feet. Weather and fog are behind everything that is solid.)
 *
 * ── the view ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *   360 u of world height is always visible. scale = cssH / 360; on squarish screens (cssW / scale < 560) scale =
 *   cssW / 560 and the extra height is sky above (the world's bottom edge stays on the screen's bottom edge).
 *   The camera follows Mama at T.mamaScreenX with smoothing and a little lead while she pushes; there is no vertical
 *   movement at all. Its translation is rounded to whole DEVICE pixels, so static art never shimmers.
 *
 * ── cost ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 *   Every list of the level (platforms, pickups, enemies, hazards, springs, flags, gates) is indexed ONCE per level into
 *   typed arrays; a frame binary-searches them, so cost is O(what is on screen), never O(world). A hot frame allocates
 *   nothing of its own: scratch objects are reused. Cached art (sprites, tiles) is bounded by the art modules; the
 *   renderer keeps at most 3 decoded paintings.
 *
 * ── API notes (beyond DESIGN) ────────────────────────────────────────────────────────────────────────────────
 *   resize() owns the canvas backing store: it sets canvas.width/height (dpr capped at 3 and ~3.6 M pixels; the capped
 *     value is `view.dpr`). Give it the stage's CSS size and the safe-area insets; call it on every size change, BEFORE draw.
 *   `now` is the rAF timestamp in MILLISECONDS. Only ambient loops use it (frozen worlds stay frozen; `paused` slows them).
 *   spawn(events, game) needs the game (positions, platforms, followers); call it every step batch, before draw().
 *   ready / whenReady()            first-paint gate: true once the painting of Mama's landscape is decoded (call after
 *                                  resetCamera; it resolves without a draw() call). preload(i) also bakes that landscape's sprites.
 *   announceChapter(index)         show 'Chapter N · Name' + its story (e.g. Continue at a landscape's first flag: no
 *                                  chapter-enter event fires there).
 *   draw opts: mode 'title'|'play'|'paused'|'dead'|'finish', fade 0..1 over everything, fadeColor ('#000' default).
 *     title: live world, idle Mama + flock, no HUD, painting drifts gently. paused: frozen, ambient at quarter speed.
 *     dead: camera frozen, Mama tumbles. finish: camera centres the beacon, confetti, Mama happy.
 *   camera (getter) { x, y: 0 }    world x of the screen's left edge.   stats / lastFrameMs  diagnostics.
 *   layers                         dev toggles { paint, atmo, plats, ... } (tools/render-demo cost breakdowns).
 *   dispose()                      closes the decoded paintings and clears the sprite cache.
 */
import { T, clamp, smooth } from './tuning.mjs';
import { CHAPTERS } from './chapters.mjs';
import { SpriteCache } from './artkit.mjs';
import { hazardWarn, FLYER } from './sim.mjs';
import {
  drawMama, drawDuckling, drawEgg, drawShieldPickup, drawMagnetPickup, drawShieldBubble, drawWalker, drawFlyer, drawFlag,
  ACTOR_SIZES, prewarmActors,
} from './art-actors.mjs';
import { drawPlatform, drawSpikes, drawSpring, drawGate, drawBeacon, drawWater, platformPadding, warmTerrainSteps } from './art-terrain.mjs';
import { Effects } from './effects.mjs';
import { Paintings, Atmosphere, fillSky } from './background.mjs';

const TAU = Math.PI * 2;
const now$ = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ───────── cosmetic constants (everything the player can feel is in tuning.mjs) ───────── */
const MAX_PIXELS = 3.6e6;           // cap on canvas pixels so big phones stay smooth
const CAM_START_MARGIN = 120;       // the camera never shows more than this much world before the start flag
const CAM_END_MARGIN = 260;         // ...nor more than this beyond the end of the world
const CAM_FOLLOW = 8.5;             // 1/s: how tightly the camera follows Mama
const CAM_LEAD_RATE = 2.4;          // 1/s: how quickly the push look-ahead builds
const GATE_DX = 130;                // the landscape-start arch stands this far past its first flag
const PRELOAD_AHEAD = 3500;         // start decoding the next painting this far before its dissolve begins
const WARM_AHEAD = 5200;            // ...and baking the next landscape's sprites this far ahead
const SHADOW_FADE_H = 140;          // a shadow fades 1 -> 0.45 over this much height
const WARM_BUDGET_MS = 3;
const DEAD_TUMBLE = 5.5;            // rad/s
const DRIFT_CAP = 90;               // CSS px: the most a frozen world (title / pause / finish) drifts its painting by itself

/* ═════════════════════════ per-level index (built once per level, read every frame) ═════════════════════════ */

/**
 * Index of a list that is (nearly) sorted by a key: per element the key, the running maximum of its right extent
 * (so "first element that can still reach the screen" is a binary search) and the largest left overhang (so "last
 * element that can already reach the screen" is another). Unsorted input is sorted into an index array first.
 */
function buildSpan(list, keyOf, loOf, hiOf) {
  const n = list.length, keys = new Float64Array(n);
  let sorted = true;
  for (let i = 0; i < n; i++) { keys[i] = keyOf(list[i]); if (i && keys[i] < keys[i - 1]) sorted = false; }
  let idx = null;
  if (!sorted) { idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i; idx.sort((a, b) => keys[a] - keys[b] || a - b); }
  const key = new Float64Array(n), hi = new Float64Array(n);
  let run = -Infinity, lo = 0;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k, it = list[i];
    key[k] = keys[i];
    const h = hiOf(it); if (h > run) run = h; hi[k] = run;
    const l = key[k] - loOf(it); if (l > lo) lo = l;
  }
  return { n, idx, key, hi, lo };
}
/** First k whose running-max right edge reaches L. */
function firstReaching(sp, L) {
  let a = 0, b = sp.n;
  while (a < b) { const m = (a + b) >> 1; if (sp.hi[m] < L) a = m + 1; else b = m; }
  return a;
}
/** One past the last k whose key is not beyond R (plus the largest left overhang). */
function endBefore(sp, R) {
  const lim = R + sp.lo;
  let a = 0, b = sp.n;
  while (a < b) { const m = (a + b) >> 1; if (sp.key[m] <= lim) a = m + 1; else b = m; }
  return a;
}

const ampX = (p) => (p.motion && p.motion.axis === 'x' ? p.motion.amp : 0);
const levelIndexes = new WeakMap();
function indexLevel(level) {
  let ix = levelIndexes.get(level);
  if (ix) return ix;
  ix = {};
  ix.platforms = buildSpan(level.platforms, (p) => p.x,
    (p) => p.x - platformPadding(p).left - ampX(p), (p) => p.x + p.w + platformPadding(p).right + ampX(p));
  // exact horizontal extent of every platform's art (padding + mover amplitude), by platform index: no per-frame allocation
  const np = level.platforms.length;
  ix.pLo = new Float64Array(np); ix.pHi = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    const p = level.platforms[i], pad = platformPadding(p), am = ampX(p);
    ix.pLo[i] = p.x - pad.left - am; ix.pHi[i] = p.x + p.w + pad.right + am;
  }
  ix.pickups = buildSpan(level.pickups, (p) => p.x, (p) => p.x - 34 - T.magnetRadius, (p) => p.x + 34 + T.magnetRadius);
  ix.enemies = buildSpan(level.enemies,
    (e) => (e.kind === 'walker' ? e.x0 : e.cx - e.ax),
    (e) => (e.kind === 'walker' ? e.x0 - 44 : e.cx - e.ax - 44), (e) => (e.kind === 'walker' ? e.x1 + 44 : e.cx + e.ax + 44));
  ix.hazards = buildSpan(level.hazards, (h) => h.x, (h) => h.x - 12, (h) => h.x + h.w + 12);
  ix.springs = buildSpan(level.springs, (s) => s.x, (s) => s.x - 28, (s) => s.x + 28);
  ix.flags = buildSpan(level.checkpoints, (c) => c.x, (c) => c.x - 40, (c) => c.x + 56);

  // landscapes: slot starts (the first is -infinity so every x has a slot), their real origins and landscape indices
  const cs = level.chapters;
  if (cs && cs.length) {
    ix.nslots = cs.length;
    ix.cx0 = new Float64Array(cs.length); ix.corg = new Float64Array(cs.length); ix.cidx = new Int32Array(cs.length); ix.cspan = new Float64Array(cs.length);
    for (let k = 0; k < cs.length; k++) {
      ix.cx0[k] = k ? cs[k].x0 : -Infinity; ix.corg[k] = cs[k].x0; ix.cidx[k] = cs[k].index;
      const end = k + 1 < cs.length ? cs[k + 1].x0 : (cs[k].x1 !== undefined ? cs[k].x1 : level.endX);       // how far this painting stays on screen
      ix.cspan[k] = Math.max(1000, end - cs[k].x0);
    }
    ix.gates = [];
    for (let k = 0; k < cs.length; k++) {
      const cp = level.checkpoints[cs[k].flag] || level.checkpoints[0];
      ix.gates.push({ x: cp.x + GATE_DX, y: cp.y, ci: cs[k].index });
    }
  } else {
    const ci = level.chapter | 0, sx = level.start ? level.start.x : 0;
    ix.nslots = 1; ix.cx0 = new Float64Array([-Infinity]); ix.corg = new Float64Array([sx]); ix.cidx = new Int32Array([ci]);
    ix.cspan = new Float64Array([Math.max(1000, (level.endX !== undefined ? level.endX : sx + 20000) - sx)]);
    ix.gates = level.beacon ? [] : [{ x: level.endX, y: (level.checkpoints[level.checkpoints.length - 1] || level.start).y, ci, exit: true }];
  }
  ix.gateSpan = buildSpan(ix.gates, (g) => g.x, (g) => g.x - 130, (g) => g.x + 130);
  ix.endX = level.endX !== undefined ? level.endX : Infinity;
  levelIndexes.set(level, ix);
  return ix;
}
/** Binary search: which landscape slot owns world x. */
function slotAt(ix, x) {
  const a = ix.cx0;
  let lo = 0, hi = ix.nslots - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid] <= x) lo = mid; else hi = mid - 1; }
  return lo;
}

/** The sim's enemyPosAt without the allocation (identical formula; the smoke test compares the two). */
function enemyAt(e, t, out) {
  if (e.kind === 'walker') {
    const range = Math.max(1, e.x1 - e.x0), p2 = 2 * range;
    const d = ((t * e.speed + (e.phase || 0) * p2) % p2 + p2) % p2;
    out.x = e.x0 + (d < range ? d : p2 - d); out.y = e.y; out.face = d < range ? 1 : -1;
  } else {
    const a = TAU * t / e.period + (e.phase || 0);
    out.x = e.cx + e.ax * Math.sin(a); out.y = e.cy + e.ay * Math.cos(a); out.face = Math.cos(a) * e.ax >= 0 ? 1 : -1;
  }
}
export { enemyAt as _enemyAt };      // for tests

/* ═════════════════════════════════════════ the renderer ═════════════════════════════════════════ */

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cache = new SpriteCache();
    this.paintings = new Paintings(CHAPTERS);
    this.atmo = new Atmosphere();
    this.fx = new Effects();

    this._view = { w: 640, h: 360, scale: 1, dpr: 1 };
    this.ins = { top: 0, right: 0, bottom: 0, left: 0 };
    this.S = 1;                       // device px per world unit
    this.ty = 0;                      // device y of world y = 0
    this.worldTop = 0;                // world y of the screen's top edge (negative on tall screens)
    this._sized = false;

    this.level = null; this.ix = null;
    this.cam = 0; this.lead = 0; this._snap = true; this._tgt = 0; this._gy = 0; this._sx0 = 0; this._sx1 = 0;
    this.lastNow = -1; this.ambient = 0; this.bgDrift = 0;
    this.blinkUntil = -1;
    this.finishT = 0; this.lastMode = '';
    this.reduced = false;
    this._rock = 0; this._dt = 0;       // Mama's smoothed rock angle; this frame's dt (seconds)

    this.ready = false; this._wantIdx = -1;
    this._readyResolve = null;
    this._readyPromise = new Promise((r) => { this._readyResolve = r; });

    // warm-up queue: sprites are baked a few ms per frame, ahead of need
    this._warmed = new Set(); this._jobs = [];

    // scratch (no per-frame allocation)
    this._pos = { x: 0, y: 0, face: 1 };
    this._mp = { x: 0, y: 0, face: 1, vx: 0, vy: 0, phase: 0, onGround: true, squash: 0, hurt: 0, invulnFlash: false, shield: false, happy: false, t: 0, rock: 0, dark: false };
    this._dp = { x: 0, y: 0, face: 1, air: false, t: 0, i: 0, alpha: 1, dark: false };
    this._ep = { x: 0, y: 0, kind: 'egg', t: 0, i: 0, dark: false };
    this._pk = { x: 0, y: 0, t: 0, dark: false };
    this._wp = { species: 'snail', palette: null, x: 0, y: 0, face: 1, t: 0, squash: 0, i: 0, dark: false };
    this._fp = { species: 'bee', palette: null, x: 0, y: 0, face: 1, t: 0, i: 0, dark: false };
    this._flp = { x: 0, y: 0, active: false, t: 0, palette: null, dark: false };
    this._gp = { x: 0, y: 0, chapter: null, t: 0, progress: 1 };
    this._bp = { x: 0, y: 0, lit: false, litT: 0, t: 0 };
    this._bub = { x: 0, y: 0, t: 0, pop: 0, dark: false };
    this._wat = { x0: 0, x1: 0, y: 330, bottom: 364, chapter: null, t: 0 };
    this._sp = { x: 0, y: 0, w: 34, bounceT: -9 };
    this._ag = { w: 0, top: 0, bottom: 360, cam: 0, t: 0, density: 1, S: 1, ty: 0 };
    this._sv = { w: 0, h: 0, ins: this.ins, scale: 1, cam: 0, worldTop: 0, hud: false };
    this._fxEnv = { mx: 0, my: 0, dark: false, camX: 0, viewW: 640, top: 0, titleFor: null, chapterTitle: null, lastFollower: null };
    this._lastF = []; for (let i = 0; i < 6; i++) this._lastF.push({ x: 0, y: 0, face: 1, ok: false });
    this._need = [];
    this.visP = new Int32Array(1024); this.visN = 0;
    this.visX = new Float32Array(1024); this.visY = new Float32Array(1024); this.visW = new Float32Array(1024); this.visSolid = new Uint8Array(1024);
    this._pitGrad = null; this._gaps = new Float64Array(16); this._ng = 0;
    this._fxg = { t: 0, dark: false, mx: 0, my: 0 };

    const env = this._fxEnv;
    env.titleFor = (x) => this._titleAt(x);
    env.chapterTitle = (index) => `Chapter ${index + 1} · ${CHAPTERS[index].name}`;
    env.lastFollower = (i) => { const f = this._lastF[i]; return f && f.ok ? f : null; };

    /** Dev toggles (tools/render-demo cost breakdown): set a layer to false to skip it. */
    this.layers = { paint: true, atmo: true, pit: true, water: true, plats: true, shadows: true, land: true, pick: true, enemies: true, flock: true, mama: true, fx: true, front: true, hud: true };
    this.stats = { ms: 0, msAvg: 0, platforms: 0, pickups: 0, enemies: 0, hazards: 0, springs: 0, flags: 0, scanned: 0, frames: 0, particles: 0, decoded: 0, paintingMissing: 0, paintOff: 0, paintSlack: 0 };
    this.lastFrameMs = 0;
  }

  /* ───────────────────────── lifecycle ───────────────────────── */

  /** Nothing heavy: paintings are decoded lazily as the camera approaches them. */
  async load() { return true; }

  get view() { return this._view; }
  get camera() { return { x: this.cam, y: 0 }; }
  /** Resolves when the painting of Mama's current landscape has been decoded (call after resetCamera). */
  whenReady() { return this.ready ? Promise.resolve(true) : this._readyPromise; }

  /**
   * Decode landscape `i`'s painting and bake its sprites (a few ms at a time, yielding between chunks) so that its first
   * frame on screen does not hitch. Resolves when both are done.
   */
  async preload(i) {
    i = clamp(i | 0, 0, CHAPTERS.length - 1);
    await this.paintings.request(i);
    if (this._sized) {
      this._queueWarm(i);
      while (this._jobs.length) {
        this._runJobs(5);
        if (this._jobs.length) await new Promise((r) => setTimeout(r, 0));
      }
    }
    return true;
  }

  resize(cssW, cssH, dpr, insets) {
    cssW = Math.max(1, cssW || 1); cssH = Math.max(1, cssH || 1);
    dpr = clamp(dpr || 1, 1, 3);
    while (cssW * cssH * dpr * dpr > MAX_PIXELS && dpr > 1) dpr = Math.max(1, dpr - 0.25);
    let scale = cssH / T.viewH;
    if (cssW / scale < T.viewMinW) scale = cssW / T.viewMinW;       // squarish: show extra sky, never squeeze
    const v = this._view;
    v.w = cssW / scale; v.h = cssH / scale; v.scale = scale; v.dpr = dpr;
    const W = Math.max(1, Math.round(cssW * dpr)), H = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    if (insets) { this.ins.top = insets.top || 0; this.ins.right = insets.right || 0; this.ins.bottom = insets.bottom || 0; this.ins.left = insets.left || 0; }
    this.S = scale * dpr;
    this.ty = Math.round(H - T.viewH * this.S);                     // world bottom stays on the screen's bottom edge
    this.worldTop = T.viewH - v.h;
    this._pitGrad = null;
    const before = this.cache.scale, first = !this._sized;
    this.cache.setScale(this.S);
    this._sized = true;
    if (this.cache.scale !== before || first) {                     // sprites were cleared: bake again, incrementally
      this._warmed.clear(); this._jobs.length = 0;
      if (this.ix) this._queueWarm(this.ix.cidx[slotAt(this.ix, this.cam + v.w * T.mamaScreenX)]);
    }
    this._snap = true;
    this.ctx.imageSmoothingEnabled = true;
  }

  dispose() { this.paintings.dispose(); this.cache.clear(); }

  /** Snap the camera to Mama, forget old effects, start loading her landscape. */
  resetCamera(game) {
    this._useLevel(game.level);
    const m = game.mama;
    this._snap = true; this.lead = 0; this.ambient = 0; this.bgDrift = 0; this.lastNow = -1;
    this._target(game, m.x, 'play'); this.cam = this._tgt;
    this.fx.reset(game.eggs);
    this.blinkUntil = -1; this.finishT = 0; this._rock = 0;
    for (const f of this._lastF) f.ok = false;
    const ix = this.ix, s = slotAt(ix, m.x), li = ix.cidx[s];
    const pr = this.paintings.request(li);
    this._queueWarm(li);
    this._wantIdx = li;
    if (this.paintings.get(li)) this._markReady();
    else {
      if (this.ready) { this.ready = false; this._readyPromise = new Promise((r) => { this._readyResolve = r; }); }
      pr.then((ok) => { if (ok && this._wantIdx === li) this._markReady(); });     // resolves without needing a draw() call
    }
  }
  _markReady() { this.ready = true; if (this._readyResolve) { this._readyResolve(true); this._readyResolve = null; } }

  /** Show 'Chapter N · Name' with its story (e.g. when the player continues at a landscape's first flag). */
  announceChapter(index, withStory = true) {
    const i = clamp(index | 0, 0, CHAPTERS.length - 1), c = CHAPTERS[i];
    this.fx.caption('chapter', `Chapter ${i + 1} · ${c.name}`, withStory ? c.story : '', withStory ? Math.min(8, 2.2 + c.story.length * 0.052) : 3.6);
  }

  _useLevel(level) {
    if (this.level === level) return;
    this.level = level; this.ix = indexLevel(level);
    this._snap = true;
  }

  _titleAt(x) {
    const ix = this.ix, ci = ix ? ix.cidx[slotAt(ix, x)] : 0;
    return `Chapter ${ci + 1} · ${CHAPTERS[ci].name}`;
  }

  /* ───────────────────────── events ───────────────────────── */

  /** Visual reactions to sim events. Call with drainEvents(game) after stepping, before draw(). */
  spawn(events, game) {
    if (!events || !events.length) return;
    this._useLevel(game.level);
    const m = game.mama, env = this._fxEnv, ix = this.ix;
    const ci = ix.cidx[slotAt(ix, m.x)], ch = CHAPTERS[ci];
    env.mx = m.x; env.my = m.y; env.dark = !!ch.dark; env.camX = this.cam; env.viewW = this._view.w; env.top = this.worldTop;
    this.fx.setDebrisColors(ch.palette.rock, ch.palette.soil, ch.palette.shadow);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'respawn') {
        this._snap = true; this.blinkUntil = game.t + m.invuln;
        // the sim moves the followers to the checkpoint without touching their previous position: without this, the frame that
        // follows would draw them sliding across the whole level between the old and the new spot
        for (let k = 0; k < game.followers.length; k++) { const f = game.followers[k]; f.px = f.x; f.py = f.y; }
        for (const f of this._lastF) f.ok = false;
      }
      else if (e.type === 'hit') this.blinkUntil = game.t + Math.max(m.invuln, 0.9);
      this.fx.handle(e, game, env);
    }
  }

  /* ───────────────────────── camera ───────────────────────── */

  _target(game, mx, mode) {
    const lvl = game.level, v = this._view;
    let target = mx - v.w * T.mamaScreenX + this.lead;
    if (mode === 'finish' && lvl.beacon) target = lvl.beacon.x - v.w * 0.5;
    const lo = (lvl.start ? lvl.start.x : 0) - CAM_START_MARGIN;
    const hi = Math.max(lo, (this.ix ? this.ix.endX : Infinity) + CAM_END_MARGIN - v.w);
    this._tgt = target < lo ? lo : target > hi ? hi : target;       // (a field, not a return value: no boxed double per frame)
  }

  /* ───────────────────────── warm-up ───────────────────────── */

  _queueWarm(ci) {
    if (!this._sized || this._warmed.has(ci)) return;
    this._warmed.add(ci);
    const ch = CHAPTERS[ci];
    this._jobs.push({ t: 0, ci, fn: null });
    const steps = warmTerrainSteps(this.cache, ch, this.ctx);
    for (let i = 0; i < steps.length; i++) this._jobs.push({ t: 1, ci, fn: steps[i] });
    const weather = this.atmo.prepareSteps(ch, this.S);
    for (let i = 0; i < weather.length; i++) this._jobs.push({ t: 1, ci, fn: weather[i] });
  }
  _runJobs(budgetMs) {
    const t0 = now$();
    while (this._jobs.length) {
      const el = now$() - t0;
      if (el >= budgetMs) break;
      const j = this._jobs[0];
      if (j.t === 0) {
        const ch = CHAPTERS[j.ci];
        const done = prewarmActors(this.cache, { palette: ch.palette, species: [ch.skin.walker, ch.skin.flyer], dark: ch.dark, cast: true, flags: true, budgetMs: Math.max(0.8, budgetMs - el) });
        if (done) this._jobs.shift(); else break;
      } else { j.fn(); this._jobs.shift(); }
    }
  }

  /* ═════════════════════════════════════════ the frame ═════════════════════════════════════════ */

  draw(o) {
    const t0 = now$();
    const game = o.game, ctx = this.ctx, canvas = this.canvas;
    const W = canvas.width, H = canvas.height;
    if (!game) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#10182a'; ctx.fillRect(0, 0, W, H); return; }
    const alpha = o.alpha === undefined ? 1 : clamp(o.alpha, 0, 1);
    const mode = o.mode || 'play';
    const reduced = !!o.reducedMotion, paused = !!o.paused || mode === 'paused';
    const level = game.level;
    this._useLevel(level);
    const ix = this.ix, v = this._view, S = this.S, fx = this.fx;
    if (reduced !== this.reduced) { this.reduced = reduced; fx.setReduced(reduced); }

    // ── clocks ──
    const nowMs = o.now === undefined ? now$() : o.now;
    let dt = this.lastNow < 0 ? 0 : (nowMs - this.lastNow) / 1000;
    this.lastNow = nowMs;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    this.ambient += dt * (paused ? 0.25 : reduced ? 0.6 : 1);
    const t = this.ambient, gt = game.t;
    this._dt = dt;
    if (mode !== this.lastMode) { if (mode === 'finish') this.finishT = 0; this.lastMode = mode; }
    if (mode === 'finish') this.finishT += dt;

    // ── Mama (interpolated) ──
    const m = game.mama;
    const mx = m.px + (m.x - m.px) * alpha, my = m.py + (m.y - m.py) * alpha;
    const mslot = slotAt(ix, mx), mch = CHAPTERS[ix.cidx[mslot]], mdark = !!mch.dark;

    // ── camera ──
    if (mode !== 'dead' && !paused) {
      const pushing = mode === 'play' && m.vx > T.cruise * 1.35 && game.status === 'running';
      this.lead += ((pushing ? T.lookAhead * v.w : 0) - this.lead) * (1 - Math.exp(-dt * CAM_LEAD_RATE));
      this._target(game, mx, mode); const target = this._tgt;
      if (this._snap || Math.abs(target - this.cam) > v.w * 0.9) { this.cam = target; this._snap = false; }
      else this.cam += (target - this.cam) * (1 - Math.exp(-dt * (mode === 'finish' ? (reduced ? 40 : 2.6) : CAM_FOLLOW)));
    } else if (this._snap) { this._target(game, mx, 'play'); this.cam = this._tgt; this._snap = false; }
    const cam = this.cam;
    const camPx = Math.round(cam * S);                                  // whole device pixels: static art never shimmers
    const camL = cam - 6, camR = cam + v.w + 6;
    const focus = cam + v.w * T.mamaScreenX;

    // ── which painting(s) ──
    const s = slotAt(ix, focus), bh = T.blendHalf;
    let sa = s, sb = -1, bt = 0;
    if (s + 1 < ix.nslots && focus > ix.cx0[s + 1] - bh) { sb = s + 1; bt = smooth((focus - (ix.cx0[s + 1] - bh)) / (2 * bh)); }
    else if (s > 0 && focus < ix.cx0[s] + bh) { sa = s - 1; sb = s; bt = smooth((focus - (ix.cx0[s] - bh)) / (2 * bh)); }
    const ia = ix.cidx[sa], ib = sb >= 0 ? ix.cidx[sb] : -1;
    this._streamPaintings(ix, s, focus, ia, ib);
    const pa = this.paintings.get(ia), pb = ib >= 0 ? this.paintings.get(ib) : null;
    if (!this.ready && this.paintings.get(ix.cidx[s])) this._markReady();

    // ── 1. painting (device pixels) ──
    // The painting is zoomed a little past the screen (SLACK) and slides through that spare width over the whole stretch
    // of world it is shown for, at most T.backgroundParallax of the camera's travel: it never runs out, so it is never
    // tiled (no mirror seam). Frozen worlds (title, pause, finish) add a small bounded drift of their own, which fades
    // out again in play so it can not eat the slack the real travel needs.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (paused || mode === 'title' || mode === 'finish') this.bgDrift = Math.min(DRIFT_CAP * v.dpr, this.bgDrift + dt * 3 * v.dpr * (reduced ? 0.4 : 1));
    else if (this.bgDrift > 0) this.bgDrift = Math.max(0, this.bgDrift - dt * 4 * v.dpr);
    const L = this.layers;
    if (!L.paint) { ctx.fillStyle = '#456'; ctx.fillRect(0, 0, W, H); }
    else if (pa) { const o = this._paintOff(pa, ix, sa, cam, bh, W, H, S); this.stats.paintOff = o; this.stats.paintSlack = pa.fit.slack; this.paintings.draw(ctx, pa, W, H, o, 1); }
    else fillSky(ctx, W, H, CHAPTERS[ia].palette, 1);
    if (pb && L.paint) this.paintings.draw(ctx, pb, W, H, this._paintOff(pb, ix, sb, cam, bh, W, H, S), bt);

    // ── 2. atmosphere (view space: x from the screen's left edge) ──
    ctx.setTransform(S, 0, 0, S, 0, this.ty);
    const ag = this._ag;
    ag.w = v.w; ag.top = this.worldTop; ag.bottom = T.viewH; ag.cam = cam; ag.t = t; ag.density = reduced ? 0.6 : 1; ag.S = S; ag.ty = this.ty;
    const both = ib >= 0 && !!pb, wa = both ? 1 - bt : 1, wb = both ? bt : 0;     // weather follows the painting's dissolve
    if (L.atmo) { this.atmo.draw(ctx, CHAPTERS[ia], wa, ag); if (both) this.atmo.draw(ctx, CHAPTERS[ib], wb, ag); }

    // ── world transform ──
    ctx.setTransform(S, 0, 0, S, -camPx, this.ty);

    // ── 3. pit shade + water ──
    this._findGaps(game, ix, camL, camR);
    if (L.pit) this._drawPitShade(ctx);
    if (L.water) this._drawWater(ctx, level, ix, camL, camR, t, bh);

    // ── 4. platforms ──
    if (L.plats) this._drawPlatforms(ctx, game, ix, camL, camR, alpha, gt);

    // ── 5. contact shadows (under everything that stands or flies over a platform) ──
    if (L.shadows) this._drawShadows(ctx, game, ix, camL, camR, alpha, gt, mx, my, mode);

    // ── 6. landmarks, hazards, springs, flags ──
    if (L.land) this._drawLandmarks(ctx, game, ix, camL, camR, mx, gt, t);

    // ── 7. pickups ──
    if (L.pick) this._drawPickups(ctx, game, ix, camL, camR, t);

    // ── 8. enemies ──
    if (L.enemies) this._drawEnemies(ctx, game, ix, camL, camR, alpha, gt, t);

    // ── 9. ducklings, Mama ──
    if (L.flock) this._drawFlock(ctx, game, alpha, t, mdark);
    if (L.mama) this._drawMama(ctx, game, mode, mx, my, t, mdark, reduced);

    // ── 10. particles / sprite effects, front flakes ──
    if (!paused && mode !== 'title') {
      fx.update(dt);
      if (mode === 'finish') fx.celebrate(dt, cam, v.w, this.worldTop);
      fx.magnetField(dt, mx, my, game.magnet > 0 && mode === 'play');
    }
    const fxg = this._fxg;
    fxg.t = t; fxg.dark = mdark; fxg.mx = mx; fxg.my = my;
    if (L.fx) fx.drawWorld(ctx, this.cache, fxg);

    ctx.setTransform(S, 0, 0, S, 0, this.ty);
    if (L.front && L.atmo) { this.atmo.draw(ctx, CHAPTERS[ia], wa, ag, true); if (both) this.atmo.draw(ctx, CHAPTERS[ib], wb, ag, true); }

    // ── 11. screen space ──
    const dpr = v.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sv = this._sv;
    sv.w = W / dpr; sv.h = H / dpr; sv.scale = v.scale; sv.cam = cam; sv.worldTop = this.worldTop;
    sv.hud = mode === 'play' || mode === 'dead' || mode === 'finish';
    fx.setEggs(game.eggs);
    if (L.hud) fx.drawScreen(ctx, sv);

    // ── 12. fade ──
    const fade = o.fade || 0;
    if (fade > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = fade > 1 ? 1 : fade;
      ctx.fillStyle = o.fadeColor || '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // ── warm-up, stats ──
    if (this._jobs.length) this._runJobs(WARM_BUDGET_MS);
    const ms = now$() - t0;
    this.lastFrameMs = ms;
    const st = this.stats;
    st.ms = ms; st.msAvg += (ms - st.msAvg) * 0.05; st.frames++; st.particles = fx.liveCount; st.decoded = this.paintings.decoded;
    st.paintingMissing = !pa || (ib >= 0 && !pb) ? 1 : 0;           // this frame had to fall back to the previous painting / the sky colour
  }

  /* ───────────────────────── paintings: stream, keep, preload ───────────────────────── */

  /** Device px the painting of slot `k` is scrolled at camera x `cam`: 0 when its dissolve begins, its whole slack when it ends. */
  _paintOff(p, ix, k, cam, bh, W, H, S) {
    const slack = this.paintings.fitOf(p, W, H).slack;
    const travel = cam - (ix.corg[k] - bh);
    const perUnit = Math.min(T.backgroundParallax * S, slack / (ix.cspan[k] + 2 * bh));
    const o = travel * perUnit + this.bgDrift;
    return o < 0 ? 0 : o > slack ? slack : o;
  }

  _streamPaintings(ix, s, focus, ia, ib) {
    const need = this._need; need.length = 0;
    need.push(ia); if (ib >= 0) need.push(ib);
    const cur = ix.cidx[s];
    if (need.indexOf(cur) < 0) need.push(cur);
    const bh = T.blendHalf;
    if (s + 1 < ix.nslots && focus > ix.cx0[s + 1] - bh - PRELOAD_AHEAD) { const n = ix.cidx[s + 1]; if (need.indexOf(n) < 0) need.push(n); }
    if (s > 0 && focus < ix.cx0[s] + bh + 1500) { const p = ix.cidx[s - 1]; if (need.indexOf(p) < 0) need.push(p); }
    for (let i = 0; i < need.length; i++) this.paintings.request(need[i]);
    this.paintings.keepOnly(need);
    // bake the next landscape's sprites while it is still far away
    this._queueWarm(cur);
    if (s + 1 < ix.nslots && focus > ix.cx0[s + 1] - bh - WARM_AHEAD) this._queueWarm(ix.cidx[s + 1]);
  }

  /* ───────────────────────── layers ───────────────────────── */

  /**
   * Gaps between thick islands, as [x0, x1] pairs in this._gaps (this._ng of them): the places where the painting shows
   * through below the ground line. The islands are sorted by x, so one sweep finds them.
   */
  _findGaps(game, ix, camL, camR) {
    const sp = ix.platforms, plats = game.platforms, gaps = this._gaps;
    const k0 = firstReaching(sp, camL), k1 = endBefore(sp, camR);
    let reach = camL, ng = 0;
    for (let k = k0; k < k1 && ng < 7; k++) {
      const p = plats[sp.idx ? sp.idx[k] : k];
      if (p.kind !== 'ground' || p.solid === false) continue;
      if (p.x > reach + 0.5) { gaps[ng * 2] = reach; gaps[ng * 2 + 1] = Math.min(p.x, camR); ng++; }
      const e = p.x + p.w; if (e > reach) reach = e;
      if (reach >= camR) break;
    }
    if (reach < camR && ng < 7) { gaps[ng * 2] = reach; gaps[ng * 2 + 1] = camR; ng++; }
    this._ng = ng;
  }

  /** A soft darkening toward the bottom of each gap (behind the platforms), so a gap reads as a drop. */
  _drawPitShade(ctx) {
    if (!this._ng) return;
    let g = this._pitGrad;
    if (!g) {
      g = this._pitGrad = ctx.createLinearGradient(0, 270, 0, T.viewH + 6);
      g.addColorStop(0, 'rgba(14,16,44,0)'); g.addColorStop(0.45, 'rgba(14,16,44,0.28)'); g.addColorStop(1, 'rgba(10,10,32,0.62)');
    }
    ctx.fillStyle = g;
    for (let i = 0; i < this._ng; i++) { const x0 = this._gaps[i * 2] - 8, x1 = this._gaps[i * 2 + 1] + 8; ctx.fillRect(x0, 270, x1 - x0, T.viewH + 6 - 270); }
  }

  /** The flood / sea band: only in landscapes whose chapter says `water`, fading in and out over the dissolve. */
  _drawWater(ctx, level, ix, camL, camR, t, bh) {
    if (!level.water) return;
    const w = this._wat; w.y = level.water.y; w.bottom = T.viewH + 6; w.t = t;
    if (!level.chapters) { w.chapter = CHAPTERS[level.chapter | 0]; w.x0 = camL - 20; w.x1 = camR + 20; drawWater(ctx, w); return; }
    const s0 = slotAt(ix, camL - bh), s1 = slotAt(ix, camR + bh), K = 10;
    for (let s = s0; s <= s1; s++) {
      const ch = CHAPTERS[ix.cidx[s]];
      if (!ch.water) continue;
      w.chapter = ch;
      const x0 = ix.corg[s], x1 = s + 1 < ix.nslots ? ix.corg[s + 1] : ix.endX + 4000;
      const a0 = s === 0 ? -1e9 : x0 + bh, a1 = s + 1 >= ix.nslots ? 1e9 : x1 - bh;       // fully opaque stretch
      if (a1 > camL && a0 < camR) { w.x0 = a0; w.x1 = a1; ctx.globalAlpha = 1; drawWater(ctx, w); }
      for (let side = 0; side < 2; side++) {
        if ((side === 0 && s === 0) || (side === 1 && s + 1 >= ix.nslots)) continue;
        const b0 = side === 0 ? x0 - bh : x1 - bh;
        for (let i = 0; i < K; i++) {
          const sx0 = b0 + (i * 2 * bh) / K, sx1 = b0 + ((i + 1) * 2 * bh) / K;
          if (sx1 < camL - 8 || sx0 > camR + 8) continue;
          const f = smooth((i + 0.5) / K);
          ctx.globalAlpha = side === 0 ? f : 1 - f;
          w.x0 = sx0; w.x1 = sx1; drawWater(ctx, w);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  _chapterOf(p, ix) { return CHAPTERS[p.ch !== undefined ? p.ch : ix.cidx[0]]; }

  _drawPlatforms(ctx, game, ix, camL, camR, alpha, gt) {
    const sp = ix.platforms, plats = game.platforms;
    const k0 = firstReaching(sp, camL), k1 = endBefore(sp, camR);
    this.stats.scanned = k1 - k0;
    let vn = 0;
    // pass 1: thick islands, pass 2: everything thin (so a ledge is never painted under the island it floats over)
    for (let pass = 0; pass < 2; pass++) {
      for (let k = k0; k < k1; k++) {
        const i = sp.idx ? sp.idx[k] : k, p = plats[i];
        if ((p.kind === 'ground') !== (pass === 0)) continue;
        if (ix.pHi[i] < camL || ix.pLo[i] > camR) continue;
        drawPlatform(ctx, this.cache, p, this._chapterOf(p, ix), gt, alpha);
        if (vn < 1024) {
          const a = alpha < 1 && p.pcx !== undefined;
          this.visP[vn] = i;
          this.visX[vn] = a ? p.pcx + (p.cx - p.pcx) * alpha : p.cx; this.visY[vn] = a ? p.pcy + (p.cy - p.pcy) * alpha : p.cy;
          this.visW[vn] = p.w; this.visSolid[vn] = p.state === 'fall' ? 0 : 1;
          vn++;
        }
      }
    }
    this.visN = vn; this.stats.platforms = vn;
  }

  /** Nearest platform top at or below (x, y) that holds x: sets this._gy (its y) and this._sx0/_sx1 (its extent); false if none. */
  _groundBelow(x, y) {
    let best = NaN;
    for (let k = 0; k < this.visN; k++) {
      if (!this.visSolid[k]) continue;
      const px = this.visX[k], py = this.visY[k];
      if (x < px - 1 || x > px + this.visW[k] + 1 || py < y - 3) continue;
      if (best !== best || py < best) { best = py; this._sx0 = px; this._sx1 = px + this.visW[k]; }
    }
    this._gy = best;
    return best === best;
  }

  /** A soft two-layer ellipse on the surface below, shrinking and fading with height so a landing can be judged. */
  _shadow(ctx, x, y, baseRx, strength) {
    if (!this._groundBelow(x, y)) return;
    const top = this._gy, d = Math.max(0, top - y), k = d > SHADOW_FADE_H ? 1 : d / SHADOW_FADE_H;
    const s = (1 - 0.55 * k) * strength, rx = baseRx * (1 - 0.32 * k);
    let x0 = x - rx, x1 = x + rx;
    if (x0 < this._sx0) x0 = this._sx0;
    if (x1 > this._sx1) x1 = this._sx1;
    if (x1 - x0 < 3) return;
    // it lies ON the lit cap (a few units below the top edge), not across the dark outline, so it reads as a shadow on the surface
    const cx = (x0 + x1) / 2, hw = (x1 - x0) / 2, ry = Math.max(1.9, rx * 0.15), cy = top + 3.1;
    ctx.fillStyle = '#241648';
    ctx.globalAlpha = 0.3 * s;
    ctx.beginPath(); ctx.ellipse(cx, cy, hw, ry, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.4 * s;
    ctx.beginPath(); ctx.ellipse(cx, cy, hw * 0.62, ry * 0.66, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  _drawShadows(ctx, game, ix, camL, camR, alpha, gt, mx, my, mode) {
    const m = game.mama;
    if (!(mode === 'dead' && game.status === 'dead' && m.y > T.viewH)) this._shadow(ctx, mx, my, ACTOR_SIZES.mama.shadowW * 0.62, 1);
    const fl = game.followers;
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      this._shadow(ctx, f.px + (f.x - f.px) * alpha, f.py + (f.y - f.py) * alpha, ACTOR_SIZES.duckling.shadowW * 0.55, 0.85);
    }
    // creatures
    const sp = ix.enemies, es = game.enemies, pos = this._pos;
    const k0 = firstReaching(sp, camL), k1 = endBefore(sp, camR), tt = gt - (1 - alpha) * T.step;
    for (let k = k0; k < k1; k++) {
      const e = es[sp.idx ? sp.idx[k] : k];
      if (e.defeated) continue;
      enemyAt(e, tt, pos);
      if (pos.x < camL - 30 || pos.x > camR + 30) continue;
      if (e.kind === 'walker') this._shadow(ctx, pos.x, pos.y, ACTOR_SIZES.walker.shadowW * 0.5, 0.9);
      else this._shadow(ctx, pos.x, pos.y + FLYER.h / 2, 11, 0.5);
    }
  }

  _drawLandmarks(ctx, game, ix, camL, camR, mx, gt, t) {
    const lvl = game.level, cache = this.cache;
    // gates (the landscape-start arch; the ribbon parts as Mama rolls through)
    const gs = ix.gateSpan, gates = ix.gates;
    let k0 = firstReaching(gs, camL), k1 = endBefore(gs, camR);
    const gp = this._gp;
    for (let k = k0; k < k1; k++) {
      const g = gates[gs.idx ? gs.idx[k] : k];
      if (g.x + 130 < camL || g.x - 130 > camR) continue;
      gp.x = g.x; gp.y = g.y; gp.chapter = CHAPTERS[g.ci]; gp.t = t;
      gp.progress = g.exit ? (game.status === 'exit' ? 1 : 0.2) : smooth((mx - (g.x - 46)) / 64);
      drawGate(ctx, cache, gp);
    }
    // the beacon
    const b = lvl.beacon;
    if (b && b.x + 215 >= camL && b.x - 215 <= camR) {
      const bp = this._bp;
      bp.x = b.x; bp.y = b.y; bp.lit = !!game.beaconLit; bp.litT = game.status === 'beacon' ? game.statusT : 9; bp.t = t;
      drawBeacon(ctx, cache, bp);
    }
    // spikes
    let sp = ix.hazards; k0 = firstReaching(sp, camL); k1 = endBefore(sp, camR);
    const hz = lvl.hazards;
    let nh = 0;
    for (let k = k0; k < k1; k++) {
      const h = hz[sp.idx ? sp.idx[k] : k];
      if (h.x + h.w + 12 < camL || h.x - 12 > camR) continue;
      drawSpikes(ctx, cache, h, CHAPTERS[this._chIdx(ix, h.x)], gt, hazardWarn(h, gt));
      nh++;
    }
    // springs
    sp = ix.springs; k0 = firstReaching(sp, camL); k1 = endBefore(sp, camR);
    for (let k = k0; k < k1; k++) {
      const s = game.springs[sp.idx ? sp.idx[k] : k];
      if (s.x + 28 < camL || s.x - 28 > camR) continue;
      drawSpring(ctx, cache, s, CHAPTERS[this._chIdx(ix, s.x)], gt);
    }
    this.stats.hazards = nh;
    // flags (active up to and including the last checkpoint passed)
    sp = ix.flags; k0 = firstReaching(sp, camL); k1 = endBefore(sp, camR);
    const fp = this._flp, cps = lvl.checkpoints;
    for (let k = k0; k < k1; k++) {
      const i = sp.idx ? sp.idx[k] : k, c = cps[i];
      if (c.x + 56 < camL || c.x - 40 > camR) continue;
      const ch = CHAPTERS[c.ch !== undefined ? c.ch : this._chIdx(ix, c.x)];
      fp.x = c.x; fp.y = c.y; fp.active = i <= game.checkpoint; fp.t = t; fp.palette = ch.palette; fp.dark = !!ch.dark;
      drawFlag(ctx, cache, fp);
    }
  }

  _chIdx(ix, x) { return ix.cidx[slotAt(ix, x)]; }

  _drawPickups(ctx, game, ix, camL, camR, t) {
    const sp = ix.pickups, list = game.pickups, cache = this.cache;
    const k0 = firstReaching(sp, camL), k1 = endBefore(sp, camR);
    this.stats.scanned += k1 - k0;
    const ep = this._ep, pk = this._pk;
    let n = 0;
    for (let k = k0; k < k1; k++) {
      const p = list[sp.idx ? sp.idx[k] : k];
      if (p.taken || p.x < camL - 34 || p.x > camR + 34) continue;
      const dark = !!CHAPTERS[ix.cidx[slotAt(ix, p.x)]].dark;
      if (p.kind === 'egg' || p.kind === 'gold') { ep.x = p.x; ep.y = p.y; ep.kind = p.kind; ep.t = t; ep.i = p.id; ep.dark = dark; drawEgg(ctx, cache, ep); }
      else { pk.x = p.x; pk.y = p.y; pk.t = t; pk.dark = dark; if (p.kind === 'shield') drawShieldPickup(ctx, cache, pk); else drawMagnetPickup(ctx, cache, pk); }
      n++;
    }
    this.stats.pickups = n;
  }

  _drawEnemies(ctx, game, ix, camL, camR, alpha, gt, t) {
    const sp = ix.enemies, es = game.enemies, cache = this.cache, pos = this._pos;
    const k0 = firstReaching(sp, camL), k1 = endBefore(sp, camR), tt = gt - (1 - alpha) * T.step;
    const wp = this._wp, fp = this._fp;
    let n = 0;
    for (let k = k0; k < k1; k++) {
      const e = es[sp.idx ? sp.idx[k] : k];
      let age = 0;
      if (e.defeated) { age = gt - e.defeatT; if (age > 1.1 || age < 0) continue; pos.x = e.x; pos.y = e.y; pos.face = e.face; }
      else enemyAt(e, tt, pos);
      if (pos.x < camL - 36 || pos.x > camR + 36) continue;
      const ch = CHAPTERS[ix.cidx[slotAt(ix, pos.x)]];
      n++;
      if (e.kind === 'walker') {
        wp.species = ch.skin.walker; wp.palette = ch.palette; wp.x = pos.x; wp.y = pos.y; wp.face = pos.face; wp.t = t; wp.i = e.id; wp.dark = !!ch.dark;
        wp.squash = e.defeated ? Math.min(1, age / 0.16) : 0;
        if (e.defeated) { ctx.globalAlpha = age < 0.45 ? 1 : Math.max(0, 1 - (age - 0.45) / 0.55); }
        drawWalker(ctx, cache, wp);
        if (e.defeated) ctx.globalAlpha = 1;
      } else {
        fp.species = ch.skin.flyer; fp.palette = ch.palette; fp.face = pos.face; fp.t = t; fp.i = e.id; fp.dark = !!ch.dark;
        if (e.defeated) {
          ctx.save();
          const fall = 0.5 * 900 * age * age;
          ctx.translate(pos.x, pos.y + fall); ctx.rotate(age * 5 * (pos.face || 1));
          ctx.globalAlpha = Math.max(0, 1 - age / 1.0);
          fp.x = 0; fp.y = 0; drawFlyer(ctx, cache, fp);
          ctx.restore();
        } else { fp.x = pos.x; fp.y = pos.y; drawFlyer(ctx, cache, fp); }
      }
    }
    this.stats.enemies = n;
  }

  _drawFlock(ctx, game, alpha, t, dark) {
    const fl = game.followers, dp = this._dp, cache = this.cache;
    for (let i = fl.length - 1; i >= 0; i--) {
      const f = fl[i];
      const x = f.px + (f.x - f.px) * alpha, y = f.py + (f.y - f.py) * alpha;
      dp.x = x; dp.y = y; dp.face = f.face; dp.air = f.air; dp.t = t; dp.i = i; dp.dark = dark;
      dp.alpha = f.born > 0.01 ? clamp((game.t - f.born) / 0.45, 0, 1) : 1;
      drawDuckling(ctx, cache, dp);
      const lf = this._lastF[i];
      if (lf) { lf.x = x; lf.y = y; lf.face = f.face; lf.ok = true; }
    }
    for (let i = fl.length; i < this._lastF.length; i++) this._lastF[i].ok = this._lastF[i].ok && i === fl.length;     // remember the one just lost
  }

  _drawMama(ctx, game, mode, mx, my, t, dark, reduced) {
    const m = game.mama, cache = this.cache, p = this._mp;
    const dead = game.status === 'dead' || mode === 'dead';
    if (dead && my > T.viewH + 60) return;
    const speed = Math.min(1.5, Math.abs(m.vx) / T.cruise);
    p.x = mx; p.y = my; p.face = m.face; p.vx = m.vx; p.vy = m.vy; p.phase = m.phase; p.onGround = dead ? false : m.onGround; p.squash = m.squash;
    p.hurt = dead ? 1 : clamp(m.hurtT / 0.6, 0, 1);
    p.invulnFlash = !dead && m.invuln > 0 && game.t < this.blinkUntil && ((game.t * (reduced ? 2.4 : 5)) | 0) % 2 === 1;
    p.shield = !!game.shield;
    p.happy = game.status === 'beacon' || mode === 'finish';
    p.t = t; p.dark = dark;
    // her shell rocks with her travel; the horizon never tilts. Reduced motion softens it to a quarter. The angle goes through a
    // light low-pass (about 45 ms) so it eases out at take-off and back in on landing instead of snapping by up to 0.1 rad.
    const rockTarget = m.onGround && !dead ? Math.sin(m.phase * 0.09) * 0.10 * speed * (reduced ? 0.25 : 1) : 0;
    this._rock += (rockTarget - this._rock) * (1 - Math.exp(-this._dt * 22));
    p.rock = this._rock;
    if (dead) {
      const spin = (game.statusT || 0) * DEAD_TUMBLE * (m.vx < 0 || m.face < 0 ? -1 : 1) * (reduced ? 0.4 : 1);
      ctx.save(); ctx.translate(mx, my - 19); ctx.rotate(spin); p.x = 0; p.y = 19;
      drawMama(ctx, cache, p);
      ctx.restore();
      return;
    }
    drawMama(ctx, cache, p);
    if (game.shield) {
      const b = this._bub; b.x = mx; b.y = my; b.t = t; b.pop = 0; b.dark = dark;
      drawShieldBubble(ctx, cache, b);
    }
    if (game.magnet > 0 && mode !== 'title') {                    // the magnet badge floats above her while it is on
      const k = game.magnet / T.magnetSeconds, blink = game.magnet < 1.6 && ((t * 6) | 0) % 2 === 0;
      if (!blink) {
        const pk = this._pk;
        ctx.save(); ctx.translate(mx, my - 62); ctx.scale(0.72, 0.72);
        pk.x = 0; pk.y = 0; pk.t = t; pk.dark = dark; drawMagnetPickup(ctx, cache, pk);
        ctx.restore();
        ctx.lineWidth = 2.2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(mx, my - 62, 14, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
      }
    }
  }
}
