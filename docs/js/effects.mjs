/*
 * Egg Mama — transient effects: pooled particles, sprite effects, popups, captions and the egg pill.
 *
 * Nothing here is a permanent HUD (VIEW-3): only things that appear for a moment and go away. Everything lives in fixed
 * pools, so a whole hour of play does not grow the heap (the only per-event allocations are the few strings of a caption
 * or popup; per frame only the boxed numbers the canvas API itself needs).
 *
 *   world space (drawn under the camera transform)   particles, hatch burst, flying duckling, shield pop
 *   screen space (CSS px, identity * dpr)            popups (+10), captions, the egg pill, the respawn fade
 *
 * The renderer feeds sim events in through `handle(event, game, env)`; `update(dt)` advances the pools; the draw calls
 * are `drawWorld` and `drawScreen`. All motion is driven by dt, never wall time, so a frozen world stays frozen.
 */
import { TAU, rr, star, mix, createSurface } from './artkit.mjs';
import { drawHatchBurst, drawDuckling, drawShieldBubble } from './art-actors.mjs';
import { T } from './tuning.mjs';

const FONT = 'ui-rounded, "Arial Rounded MT Bold", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif';

/* ───────── particle kinds ───────── */
const DOT = 1, SPARK = 2, RING = 3, CONFETTI = 4, FEATHER = 5, PUFF = 6, DEBRIS = 7, STAR = 8, STREAK = 9, FLASH = 10, BEAM = 11;

/** Static colours (indices into the palette strings); 16.. are per-event "dynamic" slots (debris takes the landscape's rock). */
const PAL = ['#fff6dc', '#ffd23f', '#ffffff', '#f2e2bd', '#e3d2ac', '#7fc4ff', '#ff9ec0', '#ff9a3c', '#ff6b5e', '#8be07a', '#b48cff', '#dfe7f5', '#fff0a8', '#4fd0ff', '#ffb347', '#a47bff',
  '#8a6a4a', '#b08a5c', '#6a5a4a', '#cdb487'];
const C = { cream: 0, gold: 1, white: 2, shell: 3, dust: 4, blue: 5, pink: 6, orange: 7, red: 8, green: 9, purple: 10, silver: 11, pale: 12, cyan: 13, amber: 14, violet: 15, dyn: 16 };
const CONFETTI_COLORS = [C.red, C.gold, C.cyan, C.green, C.pink, C.violet, C.amber];

const POOL = 420;
const POP_NEAR = 74, POP_GAP = 21, POP_SPEED = 30;      // popups closer than this (x, y) stack; every popup rises at POP_SPEED u/s
const smooth = (v) => { v = v < 0 ? 0 : v > 1 ? 1 : v; return v * v * (3 - 2 * v); };

/** Soft glow sprites (a white-hot core fading out), baked once per colour: used by flashes and the checkpoint beam. */
const GLOWS = new Map();
function glow(color) {
  let g = GLOWS.get(color);
  if (g) return g;
  g = createSurface(64, 64);
  const x = g.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.25, color); gr.addColorStop(0.6, color.replace(/[\d.]+\)$/, '0.22)')); gr.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  GLOWS.set(color, g);
  return g;
}
let BEAM_SPRITE = null;
function beamSprite() {
  if (BEAM_SPRITE) return BEAM_SPRITE;
  BEAM_SPRITE = createSurface(32, 128);
  const x = BEAM_SPRITE.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,240,160,0)'); g.addColorStop(0.7, 'rgba(255,240,160,0.55)'); g.addColorStop(1, 'rgba(255,255,230,0.9)');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(12, 0); x.lineTo(20, 0); x.lineTo(32, 128); x.lineTo(0, 128); x.closePath(); x.fill();
  const h = x.createLinearGradient(0, 0, 32, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)'); h.addColorStop(0.5, 'rgba(255,255,255,0.45)'); h.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = h; x.fillRect(0, 0, 32, 128);
  return BEAM_SPRITE;
}

/* ───────── captions ───────── */
const PRIO = { event: 2, chapter: 1, tip: 1, story: 1, trail: 0 };
const FADE_IN = 0.28, FADE_OUT = 0.45;

const makeCaption = () => ({
  live: false, kind: 'tip', prio: 1, title: '', sub: '', icon: 0, age: 0, dur: 3, fo: FADE_OUT, fi: FADE_IN, lw: 0, lh: 0,
  lines: [], bw: 0, bh: 0, tw: 0, titleFs: 0, subFs: 0, titleShown: '', pad: 0, padY: 0, fontTitle: '', fontSub: '',
});

export class Effects {
  constructor() {
    const n = POOL;
    this.kind = new Uint8Array(n); this.ci = new Uint8Array(n);
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.size = new Float32Array(n);
    this.rot = new Float32Array(n); this.vr = new Float32Array(n); this.g = new Float32Array(n); this.aux = new Float32Array(n);
    this.head = 0; this.liveCount = 0;
    this.pal = PAL.slice();

    // sprite effects: hatch burst, flying duckling, shield pop
    this.spr = [];
    for (let i = 0; i < 14; i++) this.spr.push({ type: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0, dur: 1, face: 1, rot: 0, vr: 0, dark: false, idx: 0 });

    // popups
    this.pops = [];
    for (let i = 0; i < 18; i++) this.pops.push({ live: false, x: 0, y: 0, text: '', ci: 0, size: 16, age: 0, dur: 1, rise: 36, stack: 0 });

    // captions: one visible at a time (`cap`), the rest wait in `queue` (priority order)
    this.cap = makeCaption();
    this.queue = [makeCaption(), makeCaption(), makeCaption(), makeCaption(), makeCaption()];
    this.qn = 0;

    // egg pill
    this.eggs = -1; this.eggStr = '0'; this.pillT = 99; this.pillBump = 0;

    this.respawnT = 0;
    this.reduced = false; this.dens = 1;
    this.seed = 12345;
    this.rain = 0;                  // confetti rain budget (seconds left)
    this.rainAcc = 0;
    this.magAcc = 0;
    this._pillStr = ''; this._pillK = 0; this._pillTw = 0;
  }

  /** Forget everything (new game / retry). `eggs` = the current total so the pill does not flash on load. */
  reset(eggs = -1) {
    this.kind.fill(0); this.liveCount = 0; this.head = 0;
    for (const s of this.spr) s.type = 0;
    for (const p of this.pops) p.live = false;
    this.cap.live = false; this.qn = 0;
    this.eggs = eggs; this.eggStr = String(Math.max(0, eggs)); this.pillT = 99;
    this.respawnT = 0; this.rain = 0; this.rainAcc = 0; this.seed = 12345; this.magAcc = 0;
  }

  setReduced(b) { this.reduced = !!b; this.dens = b ? 0.5 : 1; }

  /** Deterministic pseudo-random in [0,1) (xorshift; no Math.random so scenes are repeatable). */
  rnd() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s >>> 0; return (this.seed >>> 0) / 4294967296; }
  rr(a, b) { return a + (b - a) * this.rnd(); }

  /* ═════════════ particles ═════════════ */

  add(kind, x, y, vx, vy, life, size, ci, g = 0, rot = 0, vr = 0, aux = 0) {
    const i = this.head; this.head = (i + 1) % POOL;
    if (this.kind[i] === 0) this.liveCount++;
    this.kind[i] = kind; this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.ci[i] = ci; this.g[i] = g; this.rot[i] = rot; this.vr[i] = vr; this.aux[i] = aux;
    return i;
  }
  count(n) { return Math.max(1, Math.round(n * this.dens)); }
  slow() { return this.reduced ? 0.62 : 1; }

  ring(x, y, r0, rate, life, ci, flat = 1) { this.add(RING, x, y, rate * this.slow(), 0, life, r0, ci, 0, 0, 0, flat); }
  sparks(x, y, n, sp0, sp1, life, size, ci, ci2 = ci, up = 0) {
    n = this.count(n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + this.rnd() * 0.6, sp = this.rr(sp0, sp1) * this.slow();
      this.add(SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp - up, life * this.rr(0.8, 1.2), size * this.rr(0.8, 1.3), i & 1 ? ci2 : ci, 30, this.rnd() * TAU, this.rr(-3, 3));
    }
  }
  stars(x, y, n, sp0, sp1, life, size) {
    n = this.count(n);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n - 0.5) * 3.6 + this.rr(-0.2, 0.2), sp = this.rr(sp0, sp1) * this.slow();
      this.add(STAR, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * this.rr(0.85, 1.15), size * this.rr(0.8, 1.2), i % 3 ? C.gold : C.pale, 260, this.rnd() * TAU, this.rr(-5, 5));
    }
  }
  puffs(x, y, n, spread, rise, size, ci = C.dust, life = 0.5) {
    n = this.count(n);
    for (let i = 0; i < n; i++) {
      const s = (n === 1 ? 0 : (i / (n - 1)) * 2 - 1) * spread;
      this.add(PUFF, x + s * 0.25, y - 1, s + this.rr(-8, 8), -rise * this.rr(0.6, 1.2), life * this.rr(0.8, 1.2), size * this.rr(0.8, 1.2), ci);
    }
  }
  feathers(x, y, n, sp) {
    n = this.count(n);
    for (let i = 0; i < n; i++) this.add(FEATHER, x, y, this.rr(-sp, sp), -this.rr(sp * 0.5, sp * 1.3), this.rr(0.9, 1.5), this.rr(4.6, 6.6), i % 4 ? C.cream : C.gold, 55, this.rnd() * TAU, this.rr(-5, 5), this.rnd() * TAU);
  }
  debris(x, y, n, w, ci0) {
    n = this.count(n);
    for (let i = 0; i < n; i++) this.add(DEBRIS, x + this.rr(-w / 2, w / 2), y, this.rr(-40, 40), this.rr(-30, 30), this.rr(0.55, 1.0), this.rr(2, 4.2), ci0 + (i % 3), 760, this.rnd() * TAU, this.rr(-8, 8));
  }
  confetti(n, x0, x1, y, vyMax) {
    for (let i = 0; i < n; i++) {
      this.add(CONFETTI, this.rr(x0, x1), y + this.rr(-30, 10), this.rr(-30, 30), this.rr(20, vyMax), this.rr(3.2, 5), this.rr(4, 7.5), CONFETTI_COLORS[(this.rnd() * 7) | 0], 40, this.rnd() * TAU, this.rr(-6, 6), this.rnd() * TAU);
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const n = POOL, kind = this.kind, life = this.life;
    let live = 0;
    for (let i = 0; i < n; i++) {
      const k = kind[i];
      if (!k) continue;
      const l = life[i] - dt;
      if (l <= 0) { kind[i] = 0; continue; }
      live++;
      life[i] = l;
      if (k === RING) { this.size[i] += this.vx[i] * dt; continue; }
      if (k === BEAM || k === FLASH) continue;
      this.vy[i] += this.g[i] * dt;
      if (k === PUFF) { this.vx[i] *= 1 - 3 * dt; this.vy[i] *= 1 - 2.4 * dt; }
      else if (k === FEATHER) { this.vx[i] = this.vx[i] * (1 - 1.5 * dt) + Math.sin(this.aux[i] + l * 6) * 40 * dt; this.vy[i] = Math.min(this.vy[i], 50); }
      else if (k === CONFETTI) { this.vx[i] += Math.sin(this.aux[i] + l * 5) * 70 * dt; this.vy[i] = Math.min(this.vy[i], 62); this.aux[i] += 7 * dt; }
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.vr[i] * dt;
    }
    this.liveCount = live;
    for (let i = 0; i < this.spr.length; i++) {
      const s = this.spr[i];
      if (!s.type) continue;
      s.age += dt;
      if (s.age >= s.dur) { s.type = 0; continue; }
      if (s.type === 2) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 520 * dt; s.rot += s.vr * dt; }
    }
    for (let i = 0; i < this.pops.length; i++) { const p = this.pops[i]; if (p.live) { p.age += dt; if (p.age >= p.dur) p.live = false; } }
    if (this.pillT < 99) this.pillT += dt;
    if (this.respawnT > 0) this.respawnT = Math.max(0, this.respawnT - dt);
    if (this.cap.live) { this.cap.age += dt; if (this.cap.age >= this.cap.dur) this.cap.live = false; }
    if (!this.cap.live && this.qn > 0) this._next();
    if (this.rain > 0) this.rain -= dt;
  }

  /* ═════════════ sprite effects ═════════════ */
  sprite(type, x, y, dur, dark) {
    let s = null;
    for (let i = 0; i < this.spr.length; i++) if (!this.spr[i].type) { s = this.spr[i]; break; }
    if (!s) s = this.spr[0];
    s.type = type; s.x = x; s.y = y; s.vx = 0; s.vy = 0; s.age = 0; s.dur = dur; s.face = 1; s.rot = 0; s.vr = 0; s.dark = dark;
    return s;
  }

  /* ═════════════ popups ═════════════ */
  popup(x, y, text, ci, size = 17, dur = 0.95) {
    let p = null;
    for (let i = 0; i < this.pops.length; i++) if (!this.pops[i].live) { p = this.pops[i]; break; }
    if (!p) { p = this.pops[0]; for (let i = 1; i < this.pops.length; i++) if (this.pops[i].age > p.age) p = this.pops[i]; }
    // A popup that appears on top of another one is placed just above it instead of overprinting. Every popup rises at
    // the SAME constant speed (a decelerating rise let the newer one catch up with the older one and overprint it again),
    // so the gap chosen here holds for the popups' whole life.
    let stack = 0;
    for (let i = 0; i < this.pops.length; i++) {
      const q = this.pops[i];
      if (!q.live || q === p || Math.abs(q.x - x) > POP_NEAR) continue;
      const qy = q.y - q.age * POP_SPEED;                              // where q is right now
      if (Math.abs(qy - y) < POP_GAP) stack = Math.max(stack, y - qy + POP_GAP);
    }
    p.live = true; p.x = x; p.y = y - stack; p.stack = stack; p.text = text; p.ci = ci; p.size = size; p.age = 0; p.dur = dur;
  }

  /* ═════════════ captions ═════════════ */

  /** Queue a caption. kind: 'event' (short, jumps the queue) | 'chapter' | 'tip' | 'trail'. */
  caption(kind, title, sub = '', dur = 3, icon = 0) {
    const prio = PRIO[kind] ?? 1;
    const cur = this.cap;
    // an urgent caption shortens whatever is on screen (after it has been readable for a moment)
    if (cur.live && prio > cur.prio) { const end = Math.max(cur.age, 1.2) + 0.16; if (cur.dur > end) { cur.fo = 0.16; cur.dur = end; } }     // readable for 1.2 s at least
    if (!cur.live) { this._fill(cur, kind, prio, title, sub, dur, icon); return cur; }
    // find a slot in the queue ordered by priority (FIFO within a priority); drop the weakest if it is full
    let slot;
    if (this.qn < this.queue.length) slot = this.queue[this.qn++];
    else {
      let w = 0;
      for (let i = 1; i < this.qn; i++) if (this.queue[i].prio <= this.queue[w].prio) w = i;
      if (this.queue[w].prio > prio) return null;
      slot = this.queue[w];
      this.queue.splice(w, 1); this.queue.push(slot);
      this.qn = this.queue.length;
    }
    this._fill(slot, kind, prio, title, sub, dur, icon);
    // bubble it forward past lower priorities
    for (let i = this.qn - 1; i > 0 && this.queue[i].prio > this.queue[i - 1].prio; i--) { const t = this.queue[i]; this.queue[i] = this.queue[i - 1]; this.queue[i - 1] = t; }
    return slot;
  }
  _fill(c, kind, prio, title, sub, dur, icon) {
    c.live = true; c.kind = kind; c.prio = prio; c.title = title; c.sub = sub; c.dur = dur; c.age = 0; c.icon = icon; c.lw = 0;
    c.fo = FADE_OUT; c.fi = prio >= 2 ? 0.14 : FADE_IN;
    return c;
  }
  _next() {
    const q = this.queue, c = q[0];
    // swap the front of the queue into the live slot
    const cur = this.cap;
    cur.live = true; cur.kind = c.kind; cur.prio = c.prio; cur.title = c.title; cur.sub = c.sub; cur.dur = c.dur; cur.age = 0; cur.icon = c.icon; cur.lw = 0; cur.fo = c.fo; cur.fi = c.fi;
    c.live = false;
    q.shift(); q.push(c); this.qn--;
  }
  /** The landscape's story arrives a moment after the chapter-enter caption: it becomes that caption's subtitle. */
  story(text, fallbackTitle) {
    const readable = Math.min(8, Math.max(4.6, 2.2 + text.length * 0.052));
    const find = (c) => c.live && c.kind === 'chapter' && !c.sub && c.age < 6;
    let c = find(this.cap) ? this.cap : null;
    if (!c) for (let i = 0; i < this.qn; i++) if (find(this.queue[i])) { c = this.queue[i]; break; }
    if (c) { c.sub = text; c.dur = Math.max(c.dur, c.age + readable); c.lw = 0; return; }
    this.caption('chapter', fallbackTitle, text, readable);
  }
  /** Drop the captions (menus, new game). */
  clearCaptions() { this.cap.live = false; this.qn = 0; }

  /* ═════════════ egg pill ═════════════ */
  setEggs(n) {
    if (n === this.eggs) return;
    const first = this.eggs < 0;
    this.eggs = n; this.eggStr = String(n);
    if (!first) { this.pillT = 0; this.pillBump = 1; }
  }

  /* ═════════════ the sim events -> effects ═════════════ */

  /**
   * `env` = { fx: Effects-independent hints from the renderer }:
   *   env.mx, env.my   Mama's feet now          env.dark   the landscape at Mama is a dark one
   *   env.titleFor(x)  'Chapter 3 · Reedwater' for the landscape at x      env.lastFollower(i) -> {x,y,face} | null
   *   env.chapterName(index) -> string          env.rock                     the landscape's rock colour (hex)
   */
  handle(e, game, env) {
    const m = game.mama;
    switch (e.type) {
      case 'jump': this.puffs(e.x, e.y, 2, 34, 8, 4.5, C.dust, 0.38); break;
      case 'land': {
        const hard = e.hard;
        this.puffs(e.x, e.y, hard ? 6 : 3, hard ? 78 : 50, hard ? 14 : 8, hard ? 7 : 5, C.dust, hard ? 0.6 : 0.44);
        break;
      }
      case 'egg':
        this.ring(e.x, e.y, 6, 70, 0.36, C.pale);
        this.sparks(e.x, e.y, 5, 36, 70, 0.5, 5, C.gold, C.white);
        this.popup(e.x, e.y - 14, '+' + e.points, C.white, 16);
        break;
      case 'gold':
        this.ring(e.x, e.y, 8, 120, 0.5, C.gold);
        this.ring(e.x, e.y, 4, 80, 0.6, C.white);
        this.stars(e.x, e.y, 9, 70, 150, 0.85, 7);
        this.popup(e.x, e.y - 20, '+' + e.points, C.gold, 21, 1.15);
        if (e.hatched) {
          this.sprite(1, e.x, e.y, 0.9, env.dark);
          const n = this.count(8);
          for (let i = 0; i < n; i++) this.add(DEBRIS, e.x, e.y, this.rr(-80, 80), this.rr(-150, -50), this.rr(0.5, 0.9), this.rr(2.2, 3.8), i & 1 ? C.shell : C.pale, 640, this.rnd() * TAU, this.rr(-9, 9));
        } else {
          this.caption('event', `The flock is full! +${e.points}`, '', 2.2, 1);
        }
        break;
      case 'hatch':
        this.caption('event', `Duckling hatched! ${e.flock}/${T.maxFlock}`, '', 2.2, 1);
        this.sparks(m.x, m.y - 22, 8, 40, 90, 0.7, 5, C.pale, C.white);
        break;
      case 'shield':
        this.ring(e.x, e.y, 10, 110, 0.5, C.blue);
        this.sparks(e.x, e.y, 8, 40, 100, 0.6, 5.5, C.cyan, C.white);
        this.popup(e.x, e.y - 34, 'Shield!', C.cyan, 16, 1.2);
        break;
      case 'shield-break': {
        const s = this.sprite(3, m.x, m.y, 0.45, env.dark); s.idx = 0;
        this.sparks(e.x, e.y, 8, 60, 120, 0.5, 5, C.cyan, C.white);
        break;
      }
      case 'magnet':
        this.ring(e.x, e.y, 10, 110, 0.5, C.red);
        this.sparks(e.x, e.y, 8, 40, 100, 0.6, 5.5, C.red, C.silver);
        this.popup(e.x, e.y - 34, 'Magnet!', C.red, 16, 1.2);
        break;
      case 'stomp':
        this.stars(e.x, e.y, 7, 60, 130, 0.7, 6.5);
        this.puffs(e.x, e.y + 2, 4, 60, 8, 6, C.dust, 0.5);
        this.popup(e.x, e.y - 12, '+' + e.points, C.amber, 17);
        break;
      case 'spring':
        this.ring(e.x, e.y - 3, 8, 95, 0.4, C.white, 0.35);
        this.ring(e.x, e.y - 3, 4, 70, 0.55, C.pale, 0.3);
        this.puffs(e.x, e.y, 4, 60, 10, 5.5, C.dust, 0.45);
        break;
      case 'hit':
        this.add(FLASH, e.x, e.y, 0, 0, 0.32, 48, C.white, 0, 0, 0, 0);
        this.feathers(e.x, e.y, 8, 90);
        if (e.source === 'spikes') this.sparks(e.x, e.y, 5, 50, 110, 0.4, 4, C.red, C.orange);
        break;
      case 'duckling-lost': {
        const lf = env.lastFollower(e.flock);
        const x = lf ? lf.x : e.x, y = lf ? lf.y : e.y + 18;
        const s = this.sprite(2, x, y, 1.15, env.dark);
        s.vx = -70 - this.rnd() * 30; s.vy = -240; s.vr = -7; s.face = lf ? lf.face : 1;
        this.feathers(x, y - 8, 4, 60);
        break;
      }
      case 'respawn':
        this.respawnT = 0.5;
        this.ring(e.x, e.y - 20, 8, 130, 0.5, C.white);
        this.sparks(e.x, e.y - 20, 12, 50, 120, 0.7, 5.5, C.pale, C.white);
        break;
      case 'checkpoint':
        this.add(BEAM, e.x + 2, e.y, 0, 0, 1.1, 1, C.pale);
        this.ring(e.x, e.y - 30, 8, 100, 0.55, C.pale);
        this.sparks(e.x + 6, e.y - 36, 10, 30, 80, 0.9, 5.5, C.gold, C.white, 40);
        this.caption('event', 'Checkpoint saved', '', 2.0, 2);
        break;
      case 'crumble-start': {
        const p = game.platforms[e.id];
        if (p) { this.debris(p.cx + p.w / 2, p.cy + p.h, 3, Math.min(p.w, 90), C.dyn); this.puffs(p.cx + p.w / 2, p.cy + p.h, 2, 40, 6, 4, C.dust, 0.5); }
        break;
      }
      case 'crumble-fall': {
        const p = game.platforms[e.id];
        if (p) { this.debris(p.cx + p.w / 2, p.cy + p.h / 2, 12, Math.min(p.w, 140), C.dyn); this.puffs(p.cx + p.w / 2, p.cy + p.h / 2, 4, 90, 8, 6.5, C.dust, 0.6); }
        break;
      }
      case 'steer': {
        if (!m.onGround) break;
        const d = e.dir;
        if (d > 0) {
          this.puffs(m.x - 14, m.y, 2, 40, 6, 4.5, C.dust, 0.4);
          for (let i = 0; i < 3; i++) this.add(STREAK, m.x - 16 - i * 5, m.y - 8 - i * 8, -120, 0, 0.28, 12 + i * 3, C.white);
        } else {
          this.puffs(m.x + 8, m.y, 3, 50, 7, 5, C.dust, 0.42);
        }
        break;
      }
      case 'dead':
        this.feathers(m.x, m.y - 20, 12, 120);
        break;
      case 'beacon': {
        this.add(FLASH, e.x, e.y - 130, 0, 0, 0.9, 190, C.pale, 0, 0, 0, 0);
        this.sparks(e.x, e.y - 130, 22, 80, 230, 1.3, 7, C.gold, C.white);
        this.rain = 6; this.rainAcc = 0;
        this.confetti(this.count(60), (env.camX || e.x) - 40, (env.camX || e.x) + (env.viewW || 640) + 40, (env.top || 0) - 20, 70);
        this.caption('event', 'The beacon is lit!', `+${T.scoreBeacon}`, 3.2, 1);
        break;
      }
      case 'cue':
        if (e.kind === 'story') this.story(e.text, env.titleFor(m.x));
        else if (e.kind === 'trail') this.caption('trail', e.text, '', Math.min(7.5, 2.4 + e.text.length * 0.05));
        else this.caption('tip', e.text, '', Math.min(5, 2.6 + e.text.length * 0.04));
        break;
      case 'chapter-enter':
        this.caption('chapter', env.chapterTitle(e.index), '', 3.6);
        break;
      default: break;
    }
  }

  /** The beacon celebration keeps raining confetti for a few seconds (called every frame while mode is 'finish'). */
  celebrate(dt, camX, viewW, top) {
    if (this.rain <= 0) return;
    this.rainAcc += dt * 34 * this.dens;
    const n = Math.floor(this.rainAcc);
    if (n > 0) { this.rainAcc -= n; this.confetti(n, camX - 20, camX + viewW + 20, top - 16, 70); }
  }

  /** Orbiting sparks that stream into Mama while the magnet is on. */
  magnetField(dt, mx, my, active) {
    if (!active) { this.magAcc = 0; return; }
    this.magAcc += dt * 14 * this.dens;
    while (this.magAcc >= 1) {
      this.magAcc -= 1;
      const a = this.rnd() * TAU, r = this.rr(62, 96);
      this.add(SPARK, mx + Math.cos(a) * r, my - 20 + Math.sin(a) * r * 0.8, -Math.cos(a) * r * 1.7, -Math.sin(a) * r * 1.4, 0.55, 4.5, this.rnd() < 0.5 ? C.red : C.silver, 0, this.rnd() * TAU, 3);
    }
  }

  /* ═════════════ drawing: world space ═════════════ */

  /** Sprite effects (they use the art cache) + particles. `g` = { t, dark, mx, my } (mx,my = Mama's feet, for the shield pop). */
  drawWorld(ctx, cache, g) {
    for (let i = 0; i < this.spr.length; i++) {
      const s = this.spr[i];
      if (!s.type) continue;
      if (s.type === 1) drawHatchBurst(ctx, cache, { x: s.x, y: s.y, progress: s.age / s.dur, dark: s.dark });
      else if (s.type === 2) {
        const k = s.age / s.dur;
        ctx.save(); ctx.translate(s.x, s.y - 10); ctx.rotate(s.rot);
        drawDuckling(ctx, cache, { x: 0, y: 10, face: s.face, air: true, t: g.t + s.age * 6, i: 0, alpha: k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45, dark: s.dark });
        ctx.restore();
      } else if (s.type === 3) {
        drawShieldBubble(ctx, cache, { x: g.mx, y: g.my, t: g.t, pop: Math.min(1, s.age / s.dur), dark: s.dark });
      }
    }
    this.drawParticles(ctx);
  }

  drawParticles(ctx) {
    const n = POOL, kind = this.kind, life = this.life, max = this.max, pal = this.pal;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // confetti first, batched by colour (a hundred pieces become seven fills)
    let any = false;
    for (let i = 0; i < n; i++) if (kind[i] === CONFETTI) { any = true; break; }
    if (any) {
      for (let c = 0; c < CONFETTI_COLORS.length; c++) {
        const ci = CONFETTI_COLORS[c];
        ctx.beginPath();
        let has = false;
        for (let i = 0; i < n; i++) {
          if (kind[i] !== CONFETTI || this.ci[i] !== ci) continue;
          has = true;
          const s = this.size[i], flip = Math.cos(this.aux[i] * 1.7 + 1), w = s, h = s * 0.5 * (0.35 + 0.65 * Math.abs(flip));
          const cr = Math.cos(this.rot[i]), sr = Math.sin(this.rot[i]), x = this.x[i], y = this.y[i];
          ctx.moveTo(x + (-w * cr + h * sr) * 0.5, y + (-w * sr - h * cr) * 0.5);
          ctx.lineTo(x + (w * cr + h * sr) * 0.5, y + (w * sr - h * cr) * 0.5);
          ctx.lineTo(x + (w * cr - h * sr) * 0.5, y + (w * sr + h * cr) * 0.5);
          ctx.lineTo(x + (-w * cr - h * sr) * 0.5, y + (-w * sr + h * cr) * 0.5);
          ctx.closePath();
        }
        if (has) { ctx.fillStyle = pal[ci]; ctx.globalAlpha = 0.95; ctx.fill(); }
      }
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i < n; i++) {
      const k = kind[i];
      if (!k || k === CONFETTI) continue;
      const f = life[i] / max[i];                 // 1 -> 0
      const x = this.x[i], y = this.y[i], s = this.size[i];
      switch (k) {
        case DOT:
          ctx.globalAlpha = Math.min(1, f * 1.6); ctx.fillStyle = pal[this.ci[i]];
          ctx.beginPath(); ctx.arc(x, y, s * (0.4 + 0.6 * f), 0, TAU); ctx.fill();
          break;
        case SPARK: {
          const a = Math.sin(Math.PI * (1 - f)), r = s * (0.35 + 0.8 * a), q = r * 0.24, cr = Math.cos(this.rot[i]), sr = Math.sin(this.rot[i]);
          ctx.globalAlpha = Math.min(1, a * 1.5); ctx.fillStyle = pal[this.ci[i]];
          ctx.beginPath();
          ctx.moveTo(x - r * sr, y + r * cr); ctx.lineTo(x + q * cr - q * sr, y + q * sr + q * cr);
          ctx.lineTo(x + r * cr, y + r * sr); ctx.lineTo(x + q * cr + q * sr, y + q * sr - q * cr);
          ctx.lineTo(x + r * sr, y - r * cr); ctx.lineTo(x - q * cr + q * sr, y - q * sr - q * cr);
          ctx.lineTo(x - r * cr, y - r * sr); ctx.lineTo(x - q * cr - q * sr, y - q * sr + q * cr);
          ctx.closePath(); ctx.fill();
          break;
        }
        case RING: {
          const fl = this.aux[i] || 1;
          ctx.globalAlpha = Math.min(1, f * 1.4); ctx.strokeStyle = pal[this.ci[i]]; ctx.lineWidth = 0.8 + 2.6 * f;
          ctx.beginPath(); ctx.ellipse(x, y, s, s * fl, 0, 0, TAU); ctx.stroke();
          break;
        }
        case FEATHER: {
          const cr = Math.cos(this.rot[i]), sr = Math.sin(this.rot[i]);
          ctx.globalAlpha = Math.min(1, f * 1.5); ctx.fillStyle = pal[this.ci[i]];
          ctx.beginPath(); ctx.moveTo(x + s * cr, y + s * sr); ctx.ellipse(x, y, s, s * 0.3, this.rot[i], 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(150,110,70,0.6)'; ctx.lineWidth = 0.7;
          ctx.beginPath(); ctx.moveTo(x - s * cr, y - s * sr); ctx.lineTo(x + s * cr, y + s * sr); ctx.stroke();
          break;
        }
        case PUFF: {
          const r = s * (1 + 1.3 * (1 - f));
          ctx.fillStyle = pal[this.ci[i]];
          ctx.globalAlpha = 0.34 * f; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
          ctx.globalAlpha = 0.3 * f; ctx.beginPath(); ctx.arc(x, y, r * 0.66, 0, TAU); ctx.fill();
          break;
        }
        case DEBRIS: {
          const cr = Math.cos(this.rot[i]) * s, sr = Math.sin(this.rot[i]) * s;
          ctx.globalAlpha = Math.min(1, f * 2); ctx.fillStyle = pal[this.ci[i]];
          ctx.beginPath(); ctx.moveTo(x - cr - sr * 0.5, y - sr + cr * 0.5); ctx.lineTo(x + cr - sr * 0.5, y + sr + cr * 0.5); ctx.lineTo(x + cr * 0.4 + sr, y + sr * 0.4 - cr); ctx.closePath(); ctx.fill();
          break;
        }
        case STAR:
          ctx.globalAlpha = Math.min(1, f * 1.8); ctx.fillStyle = pal[this.ci[i]]; ctx.strokeStyle = 'rgba(150,90,10,0.7)'; ctx.lineWidth = 0.9;
          star(ctx, x, y, s * (0.5 + 0.5 * f), 5, 0.46, this.rot[i]); ctx.fill(); ctx.stroke();
          break;
        case STREAK:
          ctx.globalAlpha = f * 0.7; ctx.strokeStyle = pal[this.ci[i]]; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - this.vx[i] * 0.1, y); ctx.stroke();
          break;
        case FLASH: {
          const r = s * (0.55 + 0.7 * (1 - f));
          ctx.globalAlpha = f * f * 0.9;
          ctx.drawImage(glow('rgba(255,236,170,1)'), x - r, y - r, r * 2, r * 2);
          break;
        }
        case BEAM: {
          const k = 1 - f, a = k < 0.15 ? k / 0.15 : f / 0.85;
          ctx.globalAlpha = Math.min(1, a) * 0.85;
          ctx.drawImage(beamSprite(), x - 10, y - 92 - 18 * k, 20, 92 + 18 * k);
          break;
        }
        default: break;
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ═════════════ drawing: screen space ═════════════ */

  /**
   * v = { w, h (CSS px), ins: {top,right,bottom,left}, scale (css px per u), cam (world x of the left edge), worldTop, hud (bool) }
   * ctx carries the (dpr,0,0,dpr,0,0) transform.
   */
  drawScreen(ctx, v) {
    if (this.respawnT > 0) {
      ctx.globalAlpha = 0.5 * smooth(this.respawnT / 0.5);
      ctx.fillStyle = '#0d1530'; ctx.fillRect(0, 0, v.w, v.h);
      ctx.globalAlpha = 1;
    }
    if (!v.hud) return;
    this.drawPopups(ctx, v);
    this.drawPill(ctx, v);
    this.drawCaption(ctx, v);
  }

  drawPopups(ctx, v) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (let i = 0; i < this.pops.length; i++) {
      const p = this.pops[i];
      if (!p.live) continue;
      const k = p.age / p.dur;
      const sx = (p.x - v.cam) * v.scale, sy = (p.y - v.worldTop) * v.scale - p.age * POP_SPEED * v.scale;
      if (sx < -60 || sx > v.w + 60) continue;
      const pop = k < 0.12 ? 0.7 + 3 * k / 0.12 * 0.1 : 1;
      const fs = p.size * Math.max(0.9, Math.min(1.25, v.h / 390)) * (k < 0.12 ? 0.75 + 0.25 * (k / 0.12) : 1) * pop;
      ctx.font = `900 ${fs}px ${FONT}`;
      ctx.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
      ctx.lineWidth = Math.max(2.5, fs * 0.2); ctx.strokeStyle = 'rgba(30,26,70,0.78)';
      ctx.strokeText(p.text, sx, sy);
      ctx.fillStyle = this.pal[p.ci];
      ctx.fillText(p.text, sx, sy);
    }
    ctx.globalAlpha = 1;
  }

  drawPill(ctx, v) {
    const t = this.pillT;
    if (t > 2.3) return;
    const a = t < 0.18 ? t / 0.18 : t > 1.85 ? Math.max(0, 1 - (t - 1.85) / 0.45) : 1;
    if (a <= 0.01) return;
    const k = Math.max(0.8, Math.min(1.2, v.h / 390));
    const h = 32 * k, x = v.ins.left + 12, y = v.ins.top + 10 - (1 - smooth(Math.min(1, t / 0.18))) * 8;
    const bump = this.pillBump = Math.max(0, this.pillBump - 0.05);
    ctx.font = `900 ${19 * k}px ${FONT}`;
    if (this._pillStr !== this.eggStr || this._pillK !== k) { this._pillStr = this.eggStr; this._pillK = k; this._pillTw = ctx.measureText(this.eggStr).width; }
    const tw = this._pillTw, w = 14 * k + 20 * k + 7 * k + tw + 14 * k;
    ctx.globalAlpha = a;
    rr(ctx, x, y, w, h, h / 2); ctx.fillStyle = 'rgba(22,34,62,0.62)'; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
    // the egg icon: a small cream egg with speckles, bumping when the count changes
    const ex = x + 14 * k + 8 * k, ey = y + h / 2, s = k * (1 + 0.28 * Math.min(1, bump + (t < 0.2 ? 1 - t / 0.2 : 0)));
    ctx.save(); ctx.translate(ex, ey); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, -10); ctx.bezierCurveTo(6, -10, 9, -2, 9, 3); ctx.bezierCurveTo(9, 8, 5, 11, 0, 11); ctx.bezierCurveTo(-5, 11, -9, 8, -9, 3); ctx.bezierCurveTo(-9, -2, -6, -10, 0, -10); ctx.closePath();
    ctx.fillStyle = '#fff6dc'; ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = '#a9794a'; ctx.stroke();
    ctx.fillStyle = '#c99a62';
    ctx.beginPath(); ctx.arc(-2.6, 1, 1.15, 0, TAU); ctx.arc(2.4, -2.4, 1, 0, TAU); ctx.arc(2.2, 4.4, 1.1, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fffaf0';
    ctx.fillText(this.eggStr, x + 14 * k + 20 * k + 3 * k, y + h / 2 + 1);
    ctx.globalAlpha = 1;
  }

  _layout(ctx, c, v) {
    const k = Math.max(0.78, Math.min(1.15, v.h / 390));
    const titleFs = Math.round(Math.max(12, Math.min(16.5, v.h * 0.041)) * 10) / 10, subFs = Math.max(10.5, Math.round(titleFs * 0.8 * 10) / 10);
    // the band is symmetric about the centre and clear of the egg pill (left) and the pause button (right)
    const L = v.ins.left + 12 + 96 * k + 10, R = v.w - v.ins.right - 12 - 52 - 10;
    const half = Math.max(120, Math.min(v.w / 2 - L, R - v.w / 2));
    const maxW = Math.min(580, half * 2), padX = 13 * k, padY = 6 * k, innerW = maxW - padX * 2 - (c.icon ? 18 : 0);
    const budget = Math.max(34, v.h * 0.2 - 6);
    ctx.font = `800 ${titleFs}px ${FONT}`;
    c.lines.length = 0;
    // title: one line; shrink a little, then truncate
    let title = c.title, fs = titleFs;
    while (ctx.measureText(title).width > innerW && fs > 11) { fs -= 0.5; ctx.font = `800 ${fs}px ${FONT}`; }
    if (ctx.measureText(title).width > innerW) { while (title.length > 4 && ctx.measureText(title + '…').width > innerW) title = title.slice(0, -1); title += '…'; }
    let tw = ctx.measureText(title).width;
    const titleH = fs * 1.2;
    let lines = 0, sw = 0;
    if (c.sub) {
      ctx.font = `700 ${subFs}px ${FONT}`;
      const maxLines = Math.max(1, Math.min(2, Math.floor((budget - titleH - padY * 2 - 2) / (subFs * 1.2))));
      const words = c.sub.split(' ');
      let line = '';
      for (let i = 0; i < words.length; i++) {
        const next = line ? line + ' ' + words[i] : words[i];
        if (ctx.measureText(next).width <= innerW || !line) { line = next; continue; }
        c.lines[lines++] = line; line = words[i];
        if (lines === maxLines) { line = ''; c.lines[lines - 1] += '…'; break; }
      }
      if (line && lines < maxLines) c.lines[lines++] = line;
      for (let i = 0; i < lines; i++) { const w = ctx.measureText(c.lines[i]).width; if (w > sw) sw = w; }
      // a truncated last line must still fit
      for (let i = 0; i < lines; i++) while (ctx.measureText(c.lines[i]).width > innerW && c.lines[i].length > 4) c.lines[i] = c.lines[i].slice(0, -2) + '…';
    }
    const contentW = Math.max(tw + (c.icon ? 18 : 0), sw);
    c.lines.length = lines;
    c.bw = Math.ceil(contentW + padX * 2); c.bh = Math.ceil(padY * 2 + titleH + (lines ? 2 + lines * subFs * 1.2 : 0));
    c.titleFs = fs; c.subFs = subFs; c.fontTitle = `800 ${fs}px ${FONT}`; c.fontSub = `700 ${subFs}px ${FONT}`; c.tw = tw; c.titleShown = title; c.lw = v.w; c.lh = v.h; c.pad = padX; c.padY = padY;
  }

  drawCaption(ctx, v) {
    const c = this.cap;
    if (!c.live) return;
    if (c.lw !== v.w || c.lh !== v.h) this._layout(ctx, c, v);
    const a = c.age < c.fi ? smooth(c.age / c.fi) : c.age > c.dur - c.fo ? smooth((c.dur - c.age) / c.fo) : 1;
    if (a <= 0.01) return;
    const x = Math.round((v.w - c.bw) / 2), y = Math.round(v.ins.top + 8 - (1 - a) * 6);
    ctx.globalAlpha = a;
    rr(ctx, x, y, c.bw, c.bh, 12); ctx.fillStyle = 'rgba(18,28,56,0.66)'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.stroke();
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    let tx = x + (c.bw - c.tw - (c.icon ? 18 : 0)) / 2;
    if (c.icon) {                                       // a little star (hatch / flock / beacon) or flag (checkpoint) badge
      const ix = tx + 7, iy = y + c.padY + c.titleFs * 0.58;
      ctx.fillStyle = c.icon === 2 ? '#7fe08a' : '#ffd23f'; ctx.strokeStyle = c.icon === 2 ? '#2f7a3f' : '#a8690a'; ctx.lineWidth = 1;
      if (c.icon === 2) { ctx.fillRect(ix - 5, iy - 6, 1.8, 12); ctx.beginPath(); ctx.moveTo(ix - 3.2, iy - 6); ctx.lineTo(ix + 6, iy - 3); ctx.lineTo(ix - 3.2, iy); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      else { star(ctx, ix, iy, 6.4, 5, 0.46); ctx.fill(); ctx.stroke(); }
      tx += 18;
    }
    ctx.font = c.fontTitle;
    ctx.fillStyle = '#fffaf0';
    ctx.fillText(c.titleShown, tx, y + c.padY);
    if (c.lines.length) {
      ctx.font = c.fontSub;
      ctx.fillStyle = '#dfe9ff';
      ctx.textAlign = 'center';
      const cx = x + c.bw / 2;
      for (let i = 0; i < c.lines.length; i++) ctx.fillText(c.lines[i], cx, y + c.padY + c.titleFs * 1.2 + 2 + i * c.subFs * 1.2);
    }
    ctx.globalAlpha = 1;
  }

  /** Write the landscape's rock colours into the debris slots (call before spawning crumble debris). */
  setDebrisColors(rock, soil, shade) { this.pal[16] = rock; this.pal[17] = soil; this.pal[18] = mix(rock, shade, 0.4); }
}
