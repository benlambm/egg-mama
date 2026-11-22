/*
 * Egg Mama — input (DESIGN.md §8): swipes, taps, keyboard, and the scroll/zoom lock.
 *
 *   swipe up    -> 'jump'      swipe left -> 'brake'      swipe right -> 'push'      swipe down -> nothing
 *   short tap   -> 'jump'      (only while input.tapToJump; so small children can play)
 *   A/Left, D/Right  are HELD steering (input.held.left / .right, read every sim step)
 *   Space/Up/W = jump (not on key repeat)   P/Esc = onPause()   M = onMute()
 *
 * One swipe = one action, fired the moment the drag passes the threshold (not on release), once per
 * pointer. Every finger is tracked on its own, so both thumbs work at the same time.
 * Pointers that start on UI (menus, the pause button) are ignored here: the DOM handles those.
 *
 * Nothing in here may let the page scroll, bounce, pull-to-refresh or zoom. The stylesheet does most of
 * that (position:fixed, overscroll-behavior:none, touch-action:none); this module adds the JS belt-and-braces
 * Safari still needs (non-passive touchmove, gesture*, dblclick, contextmenu, selectstart).
 */

// ── Swipe feel. Cosmetic/UX numbers (not game rules), so they live here rather than in tuning.mjs. ──
export const SWIPE = Object.freeze({
  thresholdFrac: 0.08,   // a swipe is a drag of this fraction of the screen height…
  thresholdMin: 20,      // …but never less than this many CSS px (a jittery tap must not count)…
  thresholdMax: 40,      // …and never more than this (tablets)
  jumpBias: 1.2,         // an upward drag is a jump while |dx| <= jumpBias * |dy| (±50° of straight up):
                         // thumbs drift sideways when they flick up, and a jump matters more than a nudge
  tapSlopFrac: 0.55,     // a tap may wander this fraction of the swipe threshold…
  tapSlopMin: 10, tapSlopMax: 18,   // …clamped to this many CSS px
  tapMaxMs: 380,         // a tap is released within this long; holding longer is not a jump
  fallbackHeight: 390,   // used when the surface height is unknown
});

/** Drag distance (CSS px) at which a swipe fires, for a play surface `surfaceHeight` CSS px tall. */
export function swipeThreshold(surfaceHeight) {
  const h = Number.isFinite(surfaceHeight) && surfaceHeight > 0 ? surfaceHeight : SWIPE.fallbackHeight;
  return Math.min(SWIPE.thresholdMax, Math.max(SWIPE.thresholdMin, h * SWIPE.thresholdFrac));
}

/** Largest wobble (CSS px) that still counts as a tap rather than the start of a drag. */
export function tapSlop(surfaceHeight) {
  return Math.min(SWIPE.tapSlopMax, Math.max(SWIPE.tapSlopMin, swipeThreshold(surfaceHeight) * SWIPE.tapSlopFrac));
}

/**
 * Turn a drag (dx, dy in CSS px, y DOWN) into an action. Pure.
 * Returns 'jump' | 'brake' | 'push', or null if the drag is too short or points down.
 * An upward-ish drag within ±50° of vertical is a jump; otherwise the sign of dx decides.
 */
export function classifySwipe(dx, dy, surfaceHeight) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.hypot(dx, dy) < swipeThreshold(surfaceHeight)) return null;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (dy < 0 && ay * SWIPE.jumpBias >= ax) return 'jump';
  if (dy >= 0 && ay > ax) return null;            // down means nothing
  return dx > 0 ? 'push' : 'brake';
}

// Things a finger can land on that are NOT the play surface.
const UI_SELECTOR = '[data-ui], button, a, input, select, textarea, label, [role="dialog"], [data-scroll]';
const closest = (node, sel) => (node && typeof node.closest === 'function' ? node.closest(sel) : null);

export class Input {
  /**
   * @param {HTMLElement} stage  the full-viewport stage element
   * @param {{ onAction(a:string):void, onPause():void, onMute():void, isActive():boolean, onFirstGesture?():void }} cb
   */
  constructor(stage, { onAction, onPause, onMute, isActive, onFirstGesture } = {}) {
    this.stage = stage;
    this.onAction = onAction || (() => {});
    this.onPause = onPause || (() => {});
    this.onMute = onMute || (() => {});
    this.isActive = isActive || (() => true);
    this.onFirstGesture = onFirstGesture || null;
    /** Keyboard steering, read by the main loop: step(game, input.held). */
    this.held = { left: false, right: false };
    /** A short tap jumps (setting in the pause menu). */
    this.tapToJump = true;
    this._pointers = new Map();
    this._listeners = [];
    this._touchY = 0;
    this._lastTouchEnd = 0;
    this._gestured = false;
    this._attach();
  }

  /* ── plumbing ── */
  _on(target, type, fn, opts) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }
  _surfaceHeight() {
    const s = this.stage;
    return (s && (s.clientHeight || (s.getBoundingClientRect && s.getBoundingClientRect().height))) || SWIPE.fallbackHeight;
  }
  _firstGesture() {
    if (this._gestured) return;
    this._gestured = true;
    if (this.onFirstGesture) { try { this.onFirstGesture(); } catch { /* best effort */ } }
  }
  _fire(action) {
    if (!this.isActive()) return;
    this.onAction(action);
  }

  _attach() {
    const stage = this.stage;
    const doc = stage.ownerDocument || stage;
    const win = (doc && doc.defaultView) || doc;
    const stop = (e) => { if (e.cancelable !== false) e.preventDefault(); };

    // pointers: swipes and taps on the play surface
    this._on(stage, 'pointerdown', (e) => this._down(e));
    this._on(stage, 'pointermove', (e) => this._move(e));
    this._on(stage, 'pointerup', (e) => this._up(e));
    this._on(stage, 'pointercancel', (e) => this._pointers.delete(e.pointerId));

    // never let the page move: touchmove is non-passive so preventDefault really works on iOS
    this._on(doc, 'touchstart', (e) => { this._touchY = e.touches && e.touches[0] ? e.touches[0].clientY : 0; }, { passive: true });
    this._on(doc, 'touchmove', (e) => this._touchMove(e), { passive: false });
    this._on(doc, 'touchend', (e) => {
      // old iOS still double-tap-zooms despite touch-action; swallow a second quick tap that is not on UI
      const now = e.timeStamp || Date.now();
      if (now - this._lastTouchEnd < 320 && !closest(e.target, UI_SELECTOR)) stop(e);
      this._lastTouchEnd = now;
    }, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) this._on(doc, type, stop, { passive: false });
    this._on(doc, 'dblclick', stop);
    this._on(doc, 'contextmenu', stop);
    this._on(doc, 'selectstart', stop);
    this._on(doc, 'dragstart', stop);
    // ctrl/cmd + wheel and trackpad pinch zoom the page on desktop
    this._on(doc, 'wheel', (e) => { if (e.ctrlKey || !closest(e.target, '[data-scroll]')) stop(e); }, { passive: false });

    // keyboard + losing focus
    this._on(win, 'keydown', (e) => this._keyDown(e));
    this._on(win, 'keyup', (e) => this._keyUp(e));
    this._on(win, 'blur', () => this.releaseAll());
    this._on(doc, 'visibilitychange', () => { if (doc.hidden) this.releaseAll(); });
  }

  /* ── pointers ── */
  _down(e) {
    if (closest(e.target, UI_SELECTOR)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!this.isActive()) return;
    this._pointers.set(e.pointerId, { x0: e.clientX, y0: e.clientY, t0: e.timeStamp, decided: false });
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  }

  _move(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p || p.decided) return;
    const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    const h = this._surfaceHeight();
    if (Math.hypot(dx, dy) < swipeThreshold(h)) return;
    p.decided = true;                       // this finger has made its one decision (even if it was "down" = nothing)
    const action = classifySwipe(dx, dy, h);
    if (action) this._fire(action);
  }

  _up(e) {
    // touch only grants "user activation" (orientation lock, fullscreen, audio) when the finger LIFTS
    this._firstGesture();
    const p = this._pointers.get(e.pointerId);
    this._pointers.delete(e.pointerId);
    if (!p || p.decided || !this.tapToJump) return;
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (moved <= tapSlop(this._surfaceHeight()) && e.timeStamp - p.t0 <= SWIPE.tapMaxMs) this._fire('jump');
  }

  _touchMove(e) {
    const scroller = closest(e.target, '[data-scroll]');
    if (scroller && e.touches && e.touches.length === 1) {
      // let a menu list scroll, but never chain the scroll out to the page at its ends
      const y = e.touches[0].clientY;
      const down = y > this._touchY;                       // finger moving down = content going up
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const canScroll = scroller.scrollHeight > scroller.clientHeight + 1;
      if (canScroll && !((down && atTop) || (!down && atBottom))) return;
    }
    if (e.cancelable !== false) e.preventDefault();
  }

  /* ── keyboard ── */
  _keyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;         // leave browser shortcuts alone
    const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const active = this.isActive();
    switch (key) {
      case 'ArrowLeft': case 'a': this.held.left = true; this._firstGesture(); if (active) e.preventDefault(); return;
      case 'ArrowRight': case 'd': this.held.right = true; this._firstGesture(); if (active) e.preventDefault(); return;
      case 'ArrowUp': case 'w': case ' ': case 'Spacebar':
        this._firstGesture();
        if (!active) return;                                // in a menu Space/Enter must still press the focused button
        e.preventDefault();
        if (!e.repeat) this._fire('jump');
        return;
      case 'p': case 'Escape':
        if (e.repeat) return;
        this._firstGesture(); e.preventDefault(); this.onPause(); return;
      case 'm':
        if (e.repeat) return;
        this._firstGesture(); e.preventDefault(); this.onMute(); return;
      default: return;
    }
  }

  _keyUp(e) {
    const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'ArrowLeft' || key === 'a') this.held.left = false;
    else if (key === 'ArrowRight' || key === 'd') this.held.right = false;
  }

  /** Forget every finger and key (call when play is interrupted so nothing stays "held"). */
  releaseAll() {
    this.held.left = false;
    this.held.right = false;
    this._pointers.clear();
  }
  /** Forget only the fingers that are down (e.g. after a menu opens mid-swipe). */
  cancelPointers() { this._pointers.clear(); }

  destroy() {
    for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
    this._pointers.clear();
  }
}
