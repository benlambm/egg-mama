/*
 * Egg Mama — the small pure parts of the main loop (DESIGN.md §11), split out of main.mjs so `node --test` can check them.
 * Nothing here touches the DOM, storage or the clock on its own: time and timers are always passed in.
 *
 *   FixedStepper   the fixed-timestep accumulator: real frame time in, a number of T.step sim steps (and an alpha) out.
 *   AdaptiveRes    the render-resolution safety net: a smoothed rAF frame time that stays slow for ~2 s steps the canvas
 *                  dpr down one notch; it steps back up at most once per ~30 s and never back to a level that already failed.
 *   SaveThrottle   autosaves: the newest save wins, storage is written at most once per minGap, flush() on the way out.
 *   SongTracker    which landscape's song should be playing, with hysteresis at the boundaries (a restart begins a song
 *                  from its first step, so braking back and forth over a landscape edge must not thrash the music).
 */
import { chapterSlotAt } from './sim.mjs';

/* ───────────────────────── fixed timestep ───────────────────────── */

export class FixedStepper {
  /**
   * @param step      seconds per simulation step (T.step)
   * @param maxFrame  the longest real frame we will catch up on, seconds (T.maxFrame); time beyond it is dropped
   */
  constructor(step, maxFrame) {
    this.step = step;
    this.maxFrame = maxFrame;
    this.acc = 0;
  }
  /** Add `dt` real seconds (times `scale`, the debug speed-up) and return how many whole steps to run now. */
  advance(dt, scale = 1) {
    if (!(dt > 0)) return 0;
    const cap = this.maxFrame * (scale > 1 ? scale : 1);
    this.acc += Math.min(dt * scale, cap);
    let n = 0;
    while (this.acc >= this.step) { this.acc -= this.step; n++; }
    return n;
  }
  /** Fraction of a step the renderer should interpolate by (0..1). */
  get alpha() { return this.acc / this.step; }
  /** Forget banked time (pause, resume, a new game): nothing that happened while we were away is ever caught up. */
  reset() { this.acc = 0; }
}

/* ───────────────────────── adaptive resolution ───────────────────────── */

/** The dpr notches, highest first. The device's own dpr (capped at 3) tops the list; nothing goes below the last. */
export const DPR_LEVELS = Object.freeze([3, 2.5, 2, 1.5, 1.25]);

export function dprLadder(deviceDpr, levels = DPR_LEVELS) {
  const top = Math.min(3, Math.max(1, Number.isFinite(deviceDpr) ? deviceDpr : 1));
  const floor = levels[levels.length - 1];
  const out = [top];
  for (const l of levels) if (l < top - 1e-9 && l >= floor) out.push(l);
  return out;
}

export class AdaptiveRes {
  /**
   * @param o.deviceDpr  window.devicePixelRatio
   * @param o.slowMs     smoothed frame time above this is "slow"                       (default 24)
   * @param o.slowFor    ...for this long (ms) before stepping down                      (default 2000)
   * @param o.fastMs     smoothed frame time at or below this is "comfortable"           (default 17.4: 60 Hz holds)
   * @param o.upFor      ...for this long (ms), and this long since the last change, before stepping up (default 30000)
   * @param o.settle     frames to ignore after a change / reset (a resize makes a few slow frames of its own)
   */
  constructor({ deviceDpr = 1, slowMs = 24, slowFor = 2000, fastMs = 17.4, upFor = 30000, settle = 30, smooth = 0.08 } = {}) {
    this.ladder = dprLadder(deviceDpr);
    this.i = 0;                       // index into the ladder: 0 = sharpest
    this.slowMs = slowMs; this.slowFor = slowFor; this.fastMs = fastMs; this.upFor = upFor;
    this.settleFrames = settle; this.k = smooth;
    this.ema = 16.7;
    this.slowSince = 0; this.fastSince = 0;
    this.lastChange = -Infinity; this.lastUp = -Infinity;
    this.settle = settle;
    this.badIndex = -1;               // the least sharp ladder index that failed right after a step-up: it and every sharper level are never tried again
    this.enabled = true;
    this.downs = 0; this.ups = 0;
  }
  get dpr() { return this.ladder[this.i]; }
  /** Ignore the next frames and forget the slow/fast streaks (a resize, a pause, a new screen). */
  reset() { this.settle = this.settleFrames; this.slowSince = 0; this.fastSince = 0; }
  /**
   * Feed one frame's rAF-to-rAF time (ms) at time `now` (ms). Returns the new dpr when it should change, else null.
   * Call it only for frames that are really playing / drawing the live world (not paused, hidden or just after a resize).
   */
  sample(dtMs, now) {
    if (!this.enabled) return null;
    if (this.settle > 0) { this.settle--; return null; }
    if (!(dtMs > 0) || dtMs > 250) { this.slowSince = 0; this.fastSince = 0; return null; }   // a tab switch / debugger stop is not a performance signal
    this.ema += (Math.min(dtMs, 100) - this.ema) * this.k;
    if (this.ema > this.slowMs) {
      this.fastSince = 0;
      if (!this.slowSince) this.slowSince = now;
      else if (now - this.slowSince >= this.slowFor) return this._down(now);
    } else {
      this.slowSince = 0;
      if (this.ema <= this.fastMs && this.i > 0 && this.i - 1 > this.badIndex) {
        if (!this.fastSince) this.fastSince = now;
        else if (now - this.fastSince >= this.upFor && now - this.lastChange >= this.upFor) return this._up(now);
      } else this.fastSince = 0;
    }
    return null;
  }
  _changed(now) { this.lastChange = now; this.ema = 16.7; this.slowSince = 0; this.fastSince = 0; this.settle = this.settleFrames; }
  _down(now) {
    if (this.i >= this.ladder.length - 1) { this.slowSince = 0; return null; }      // already at the floor: nothing left to give
    // stepping down shortly after stepping up means that sharper level does not fit this device: remember, never go back
    if (now - this.lastUp < this.upFor * 2) this.badIndex = Math.max(this.badIndex, this.i);
    this.i++; this.downs++;
    this._changed(now);
    return this.dpr;
  }
  _up(now) {
    this.i--; this.ups++; this.lastUp = now;
    this._changed(now);
    return this.dpr;
  }
}

/* ───────────────────────── autosave throttle ───────────────────────── */

export class SaveThrottle {
  /**
   * @param write     (save) => void   actually stores it (must not throw; it is wrapped anyway)
   * @param o.minGap  ms between storage writes
   * @param o.now     () => ms
   * @param o.setTimer / o.clearTimer   timers (setTimeout / clearTimeout)
   */
  constructor(write, { minGap = 1000, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.write = write; this.minGap = minGap; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.pending = null; this.last = -Infinity; this.timer = null; this.writes = 0;
  }
  /** The newest save replaces any waiting one. Written now when the last write was long enough ago, else a moment later. */
  request(save) {
    this.pending = save;
    const wait = this.minGap - (this.now() - this.last);
    if (wait <= 0) this.flush();
    else if (this.timer === null) this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, wait);
  }
  /** Write whatever is waiting, right now (pause, hide, pagehide, Main Title). */
  flush() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.pending) return false;
    const s = this.pending; this.pending = null;
    this.last = this.now();
    this.writes++;
    try { this.write(s); } catch { /* a full disk or a private window must never break play */ }
    return true;
  }
}

/* ───────────────────────── music at landscape boundaries ───────────────────────── */

export class SongTracker {
  /**
   * @param level  the world (level.chapters = [{ index, x0, … }])
   * @param hyst   units past a boundary before a change that did not come from the sim's 'chapter-enter' is believed
   * @param x      where Mama starts
   */
  constructor(level, hyst, x = 0) {
    this.level = level; this.hyst = hyst;
    this.slot = chapterSlotAt(level, x);
  }
  /** The landscape (0..12) whose song is current. */
  get index() { const cs = this.level.chapters; return cs && cs.length ? cs[this.slot].index : (this.level.chapter | 0); }
  /** Jump straight to wherever Mama is (a new run, a retry, a teleport). Returns the landscape index. */
  reset(x) { this.slot = chapterSlotAt(this.level, x); return this.index; }
  /** The sim says she walked forward into a new landscape. True when the song should change. */
  enter(slot) {
    if (slot > this.slot) { this.slot = slot; return true; }
    return false;
  }
  /**
   * Position check, every frame. Going back needs hyst units inside the previous landscape; going forward again after a
   * backward change (the sim only announces each crossing once) needs hyst units inside the next one. True when changed.
   */
  update(x) {
    const cs = this.level.chapters;
    if (!cs || cs.length < 2) return false;
    const s = chapterSlotAt(this.level, x);
    if (s > this.slot && x >= cs[s].x0 + this.hyst) { this.slot = s; return true; }
    if (s < this.slot && x < cs[this.slot].x0 - this.hyst) { this.slot = s; return true; }
    return false;
  }
}
