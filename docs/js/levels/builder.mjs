/*
 * Egg Mama — the level builder.
 *
 * A Builder lays a world out left to right with a CURSOR: the ground island Mama is rolling on at the end of
 * what has been built (`cur`, its right end `x`, its top `y`). Beats (beats.mjs) extend the island, hop to the
 * next platform, and sprinkle eggs, enemies and hazards. Everything is deterministic: all randomness comes
 * from the seeded `rand` passed in.
 *
 * Builders support mark() / rollback(): a beat that does not fit (or that fails its fairness check) is simply
 * undone and a different one is tried. The builder also keeps the books the pacing controller works from: `events` (the
 * required events built so far, eventsSince(mark) counts them and says where the first / last one sits), `lastEventX` (flat
 * ground since then is recovery room), `stationLen` and the beat log (`beatLog` / `beatX`, rolled back with everything else).
 */
import { T } from '../tuning.mjs';
import { C, flightTime, heightAt, trainFeasible, jumpWindow, spikeWindow, MAX_RISE } from './phys.mjs';

export const Y0 = T.groundY;
const rd = Math.round;
const r1 = (n) => Math.round(n * 10) / 10;

export class Builder {
  constructor(rand, { circuit = 1 } = {}) {
    this.rand = rand;
    this.circuit = circuit;
    this.ch = 0;
    this.plats = []; this.picks = []; this.enemies = []; this.hazards = []; this.springs = []; this.cps = [];
    this.quiet = [];          // [x0, x1] hazard-free flat stretches (cue / flag placement)
    this.firsts = [];         // first appearance of an element in a landscape: { ch, kind, x }
    this.seen = new Set();
    this.cur = null; this.x = 0; this.y = Y0;
    this.bad = null;          // set when a beat produced something unfair; the act loop rolls it back
    this.lastGold = 0; this.lastShield = 0; this.lastMagnet = 0; this.sawGap = false;
    this.iceMode = false;          // Frostline: every platform built while this is on is slippery
    this.joinFlagX = Infinity;     // where the next landscape's opening flag will be (acts look ahead to keep flags <= 35 s apart)   // main-route distance since the last gold / shield / magnet
    this.stats = { train: 0 };
    this.events = 0;               // required events built so far (hops, lifts, movers, walkers, flyers, spikes): the pacing controller's books
    this.stationLen = 0;           // total length of flag stations so far (safe ground that is not counted toward pacing)
    this.beatLog = [];             // names of the beats built, in order (acts record their slice; the variety tests read it)
    this.beatX = [];               // where each of them starts (u), parallel to beatLog
    this.logStart = 0;             // where this landscape's beats begin in beatLog
    this.evFirst = Infinity; this.evLast = -Infinity;   // see eventsSince()
    this.lastEventX = -1e9;        // the end of the last required event built (the flat ground since then counts as recovery room)
    this.helped = new Set();       // landscapes whose first hazard already got its little help (a golden egg, a shield)
    this.rich = {};                // spec -> { ev, len }: how many events per length each spec has delivered so far (learned as the world is built)
  }

  /* ───────── undo ───────── */
  mark() {
    return { p: this.plats.length, k: this.picks.length, e: this.enemies.length, h: this.hazards.length, s: this.springs.length,
      c: this.cps.length, q: this.quiet.length, f: this.firsts.length, seen: new Set(this.seen), cur: this.cur,
      curW: this.cur ? this.cur.w : 0, x: this.x, y: this.y, lg: this.lastGold, ls: this.lastShield, lm: this.lastMagnet, sg: this.sawGap,
      ev: this.events, sl: this.stationLen, bl: this.beatLog.length, le: this.lastEventX };
  }
  rollback(m) {
    this.plats.length = m.p; this.picks.length = m.k; this.enemies.length = m.e; this.hazards.length = m.h;
    this.springs.length = m.s; this.cps.length = m.c; this.quiet.length = m.q; this.firsts.length = m.f;
    this.seen = m.seen; this.cur = m.cur; if (m.cur) m.cur.w = m.curW; this.x = m.x; this.y = m.y; this.bad = null; this.lastGold = m.lg; this.lastShield = m.ls; this.lastMagnet = m.lm; this.sawGap = m.sg;
    this.lastEventX = m.le; this.events = m.ev; this.stationLen = m.sl; this.beatLog.length = m.bl; this.beatX.length = m.bl;
  }

  /**
   * How many REQUIRED events the geometry built since mark `m` asks of her: hops (a gap, or a wall higher than she steps
   * onto) between static main-route platforms, a lift or mover (a jump on and a jump off), walkers, flyers, spikes.
   * The pacing controller books these as it goes; tests/felt.mjs counts the same kind of thing from the finished level.
   */
  eventsSince(m) {
    let n = this.enemies.length - m.e + this.hazards.length - m.h;
    let first = Infinity, last = -Infinity;
    for (let k = m.e; k < this.enemies.length; k++) { const e = this.enemies[k]; const x = e.kind === 'walker' ? e.x0 : e.cx - e.ax; first = Math.min(first, x); last = Math.max(last, e.kind === 'walker' ? e.x1 : e.cx + e.ax); }
    for (let k = m.h; k < this.hazards.length; k++) { first = Math.min(first, this.hazards[k].x); last = Math.max(last, this.hazards[k].x + this.hazards[k].w); }
    let prev = null;
    for (let k = m.p - 1; k >= 0 && !prev; k--) if (!this.plats[k].o) prev = this.plats[k];
    for (let k = m.p; k < this.plats.length; k++) {
      const q = this.plats[k];
      if (q.o) continue;
      const dyn = (p) => !!p.motion && !(p.kind === 'ledge' && p.motion.amp <= 10);
      if (dyn(q)) { n += 2; first = Math.min(first, q.x); last = Math.max(last, q.x + q.w); }
      else if (prev && !dyn(prev)) { const gap = q.x - (prev.x + prev.w); if (gap > 0 || prev.y - q.y > T.stepUp) { n++; first = Math.min(first, prev.x + prev.w); last = Math.max(last, prev.x + prev.w); } }
      prev = q;
    }
    this.evFirst = first; this.evLast = last;           // where the first / last of those events sit (u): the pacing controller schedules by them
    return n;
  }
  fail(why) { if (!this.bad) this.bad = why; }
  /** Record that the beat `name` starts at the cursor (variety bookkeeping and the beat listings of the report). */
  logBeat(name) { this.beatLog.push(name); this.beatX.push(rd(this.x)); }

  /* ───────── platforms ───────── */
  plat(kind, x, y, w, o = {}) {
    const p = { id: this.plats.length, kind, x: rd(x), y: rd(y), w: rd(w), h: o.h ?? (kind === 'ground' ? this.rand.int(96, 132) : this.rand.int(14, 18)), ch: this.ch };
    if (o.ice || (this.iceMode && o.ice !== false && kind !== 'lift' && kind !== 'mover')) p.ice = true;
    if (o.motion) p.motion = o.motion;
    if (o.opt) p.o = 1;
    if (o.solid === false) p.solid = false;
    this.plats.push(p);
    return p;
  }
  /** A new, empty ground island right where the current one ends (a skin seam: platforms from here carry `this.ch`). */
  newIsland(o = {}) { return this.setCursor(this.plat('ground', this.x, this.y, 0, o)); }
  setCursor(p) { this.cur = p; this.x = p.x + p.w; this.y = p.y; return p; }
  begin(x, y, w, o = {}) { return this.setCursor(this.plat('ground', x, y, w, o)); }

  /** Extend the current ground island by `len` u of flat ground, with an egg pattern. */
  run(len, pat = 'auto', o = {}) {
    len = rd(len);
    if (len <= 0) return;
    const cur = this.cur, x0 = this.x;
    cur.w += len; this.x += len;
    this.runEggs(x0, this.x, cur.y, pat);
    if (o.quiet !== false && len >= 280 && pat !== 'none') this.quiet.push([x0, this.x]);   // hazard-free flat stretch
  }

  /**
   * Hop to the next platform after a gap, `dy` lower (negative = higher). Becomes the cursor. kind: 'ground' | 'ledge'
   * | 'crumble'. Does not add eggs (train() / the beat does).
   */
  hop(gap, w, dy, o = {}) {
    const kind = o.kind ?? 'ground';
    const p = this.plat(kind, this.x + gap, this.y + dy, w, o);
    this.setCursor(p);
    return p;
  }

  /* ───────── pickups ───────── */
  egg(x, y) { this.picks.push({ id: this.picks.length, kind: 'egg', x: r1(x), y: r1(y) }); }
  gold(x, y) { this.picks.push({ id: this.picks.length, kind: 'gold', x: r1(x), y: r1(y) }); }
  pickup(kind, x, y) { this.picks.push({ id: this.picks.length, kind, x: r1(x), y: r1(y) }); }

  runEggs(x0, x1, top, pat) {
    const rand = this.rand;
    if (pat === 'auto') pat = rand.pick(['line', 'wave', 'wave', 'dash', 'pairs', 'hops', 'hops']);
    if (pat === 'none' || x1 - x0 < 90) return;
    const a = x0 + 28, b = x1 - 28;
    if (pat === 'line') for (let x = a; x <= b; x += 40) this.egg(x, top - 24);
    else if (pat === 'wave') { let i = 0; for (let x = a; x <= b; x += 36, i++) this.egg(x, top - 30 - 12 * Math.sin(i * 0.8)); }
    else if (pat === 'pairs') for (let x = a; x <= b - 30; x += 120) { this.egg(x, top - 26); this.egg(x + 30, top - 26); }
    else if (pat === 'dash') for (let x = a; x <= b - 80; x += 170) for (let k = 0; k < 4; k++) this.egg(x + k * 24, top - 24);
    else if (pat === 'hops') {            // arcs of eggs over flat ground: a jump for the fun of it (real parabolas)
      const n = Math.max(1, Math.floor((b - a - 60) / 250));
      for (let i = 0; i < n; i++) {
        const x = a + 40 + i * ((b - a - 60 - 110) / Math.max(1, n)) + rand.range(0, 30);
        this.arc(x, top, 0, 5);
        if (i < n - 1 || rand.chance(0.5)) for (let k = 0; k < 3; k++) this.egg(x + 130 + k * 26, top - 24);
      }
    }
  }

  /** Remove the ordinary eggs placed since pick index `from` that lie inside the box [x0,x1] x [y0,y1] (an optional ledge must never have eggs buried in it). */
  clearEggs(from, x0, x1, y0, y1) {
    for (let i = this.picks.length - 1; i >= from; i--) {
      const q = this.picks[i];
      if (q.kind === 'egg' && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) this.picks.splice(i, 1);
    }
    for (let i = from; i < this.picks.length; i++) this.picks[i].id = i;
  }

  /** `n` eggs along the real jump taking off at feet (x, yFeet) and landing `dyEnd` lower. Body centre = feet - 20. */
  arc(x, yFeet, dyEnd, n = 4, o = {}) {
    const t = flightTime(dyEnd);
    if (!(t > 0)) return;
    for (let i = 1; i <= n; i++) {
      const tt = t * (i / (n + 1));
      const px = x + C * tt, py = yFeet - heightAt(tt) - 20;
      if (o.goldMid && i === Math.round((n + 1) / 2)) this.gold(px, py); else this.egg(px, py);
    }
  }

  /* ───────── hazards, enemies, springs ───────── */
  walker(x0, x1, speed, phase = 0, y = this.y) { this.enemies.push({ id: this.enemies.length, kind: 'walker', x0: rd(x0), x1: rd(x1), y, speed: r1(speed), phase: r1(phase) }); }
  flyer(cx, cy, ax, ay, period, phase = 0) { this.enemies.push({ id: this.enemies.length, kind: 'flyer', cx: rd(cx), cy: rd(cy), ax: rd(ax), ay: rd(ay), period: r1(period), phase: r1(phase) }); }
  spikes(x, w, cycle = null) {
    const h = { id: this.hazards.length, kind: 'spikes', x: rd(x), y: this.y, w: rd(w) };
    if (cycle) h.cycle = { period: r1(cycle.period), up: r1(cycle.up), phase: r1(cycle.phase) };
    this.hazards.push(h);
    return h;
  }
  spring(x) { this.springs.push({ id: this.springs.length, x: rd(x), y: this.y }); }

  /** Remember the first appearance of an element in this landscape (for tips and the signature tests). */
  tag(kind, x) {
    const key = this.ch + ':' + kind;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.firsts.push({ ch: this.ch, kind, x: rd(x) });
  }

  /* ───────── flags ───────── */
  flag() {
    const c = this.cur;
    this.cps.push({ id: this.cps.length, x: rd(this.x), y: c.y, platform: c.id, ch: this.ch });
  }
  /** Quiet flat ground, a checkpoint flag with >= 250 u of hazard-free ground behind it and >= `after` ahead. */
  station({ before = 250, after = 380, pat = 'line' } = {}) {
    this.run(before, pat);
    this.flag();
    this.run(after, pat === 'line' ? 'hops' : pat);        // eggs hung in an arc to jump for: even a flag's quiet ground has something to do
    this.stationLen += before + after;
  }

  /* ───────── trains of static platforms ───────── */
  /**
   * Build a chain of hops from the current (static) platform: specs [{ gap, w, dy, kind, ice, eggs, gold }].
   * Verifies the whole chain with phys.trainFeasible (jump-only, every window >= minSecs) and lays an egg arc
   * along each real jump. If the chain is unfair the builder is marked bad (the caller will roll back).
   */
  train(specs, o = {}) {
    const start = this.cur;
    const stat = (p) => ({ x: p.x, end: p.x + p.w, top: p.y, kind: p.kind });
    const list = [stat(start)];
    const made = [];
    for (const s of specs) {
      const p = this.hop(s.gap, s.w, s.dy ?? 0, { kind: s.kind, ice: s.ice ?? start.ice ?? false, opt: s.opt, h: s.h });
      made.push(p); list.push(stat(p));
    }
    const res = trainFeasible(list, { minSecs: o.minSecs ?? Math.max(T.minWindow, 0.2) });
    this.stats.train++;
    if (!res.ok) { this.fail('train'); return res; }
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      if (s.eggs === false) continue;
      const dyEnd = list[i + 1].top - list[i].top;
      this.arc(res.takeoffs[i], list[i].top, dyEnd, s.n ?? 4, { goldMid: s.gold });
    }
    res.plats = made;
    return res;
  }

  /** Eggs along a hop over a spike (or any short obstacle at x..x+w) on the cursor's flat ground. */
  spikeArc(h, o = {}) {
    const sw = spikeWindow(h.x, h.w);
    if (!(sw.width > 0)) { this.fail('spike'); return; }
    this.arc((sw.lo + sw.hi) / 2, h.y, 0, o.n ?? 4, { goldMid: o.gold });
  }
}

export { r1, rd, trainFeasible, jumpWindow, MAX_RISE };
