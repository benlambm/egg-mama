import assert from "node:assert/strict";
import test from "node:test";
import { classifySwipe, swipeThreshold, tapSlop, SWIPE, Input } from "../docs/js/input.mjs";

/* ───────── classifySwipe (pure) ───────── */

const H = 390;                                   // an iPhone 13 held sideways
const TH = swipeThreshold(H);

test("swipe threshold scales with screen height and is clamped", () => {
  assert.ok(Math.abs(TH - 31.2) < 1e-9);
  assert.equal(swipeThreshold(100), SWIPE.thresholdMin);
  assert.equal(swipeThreshold(2000), SWIPE.thresholdMax);
  assert.equal(swipeThreshold(undefined), swipeThreshold(SWIPE.fallbackHeight));
  assert.equal(swipeThreshold(0), swipeThreshold(SWIPE.fallbackHeight));
  assert.equal(swipeThreshold(NaN), swipeThreshold(SWIPE.fallbackHeight));
  assert.ok(tapSlop(H) < swipeThreshold(H), "a tap's wobble is always smaller than a swipe");
  for (const h of [200, 300, 390, 412, 800, 1200]) assert.ok(tapSlop(h) < swipeThreshold(h));
});

test("the four directions", () => {
  assert.equal(classifySwipe(0, -80, H), "jump");
  assert.equal(classifySwipe(-80, 0, H), "brake");
  assert.equal(classifySwipe(80, 0, H), "push");
  assert.equal(classifySwipe(0, 80, H), null);
});

test("short drags are not swipes (a jittery tap must not steer)", () => {
  assert.equal(classifySwipe(0, -(TH - 0.5), H), null);
  assert.equal(classifySwipe(TH - 0.5, 0, H), null);
  assert.equal(classifySwipe(0, 0, H), null);
  assert.equal(classifySwipe(0, -TH, H), "jump", "exactly at the threshold fires");
  assert.equal(classifySwipe(-20, -20, H), null, "hypot 28 < 31");
});

test("diagonals: thumbs drift, so up-ish drags jump and flat ones steer", () => {
  assert.equal(classifySwipe(30, -60, H), "jump");
  assert.equal(classifySwipe(-30, -60, H), "jump");
  assert.equal(classifySwipe(60, -60, H), "jump", "45 degrees up still jumps");
  assert.equal(classifySwipe(72, -60, H), "jump", "right on the 1.2 bias line");
  assert.equal(classifySwipe(73, -60, H), "push");
  assert.equal(classifySwipe(-73, -60, H), "brake");
  assert.equal(classifySwipe(80, -20, H), "push");
  assert.equal(classifySwipe(-80, -20, H), "brake");
});

test("drags that point down never jump; shallow-down ones still steer", () => {
  assert.equal(classifySwipe(0, 90, H), null);
  assert.equal(classifySwipe(30, 60, H), null);
  assert.equal(classifySwipe(-30, 60, H), null);
  assert.equal(classifySwipe(80, 40, H), "push", "down-right but flatter than 45 degrees");
  assert.equal(classifySwipe(-80, 40, H), "brake");
  assert.equal(classifySwipe(60, 60, H), "push", "exactly 45 degrees down is treated as horizontal");
});

test("sweep every 5 degrees: sectors are as documented and mirror-symmetric", () => {
  for (let deg = 0; deg < 360; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a) * 100, dy = -Math.sin(a) * 100;          // deg 0 = right, 90 = up (screen y is down)
    const got = classifySwipe(dx, dy, H);
    const mirrored = classifySwipe(-dx, dy, H);
    if (got === "push") assert.equal(mirrored, "brake", `mirror of ${deg}`);
    else if (got === "brake") assert.equal(mirrored, "push", `mirror of ${deg}`);
    else assert.equal(mirrored, got, `mirror of ${deg}`);
    if (dy < 0) {
      const expected = Math.abs(dy) * SWIPE.jumpBias >= Math.abs(dx) ? "jump" : (dx > 0 ? "push" : "brake");
      assert.equal(got, expected, `deg ${deg}`);
    } else if (dy > 0 && Math.abs(dy) > Math.abs(dx)) {
      assert.equal(got, null, `deg ${deg} points down`);
    }
    if (got === "jump") assert.ok(dy < 0, `a jump must point up (deg ${deg})`);
  }
});

test("bad numbers give null", () => {
  assert.equal(classifySwipe(NaN, -90, H), null);
  assert.equal(classifySwipe(10, Infinity, H), null);
  assert.equal(classifySwipe(undefined, undefined, H), null);
});

test("the same flick is easier to trigger on a small screen than a big one", () => {
  assert.equal(classifySwipe(0, -26, 300), "jump");
  assert.equal(classifySwipe(0, -26, 600), null);
});

/* ───────── Input with a fake DOM (Node has EventTarget but no document) ───────── */

function makeDom(height = 390) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { defaultView: win, hidden: false });
  const stage = Object.assign(new EventTarget(), { ownerDocument: doc, clientHeight: height, captured: [], setPointerCapture(id) { this.captured.push(id); } });
  return { win, doc, stage };
}
/** Dispatch a synthetic event with read-only fields (target, timeStamp…) overridden. */
function fire(on, type, props = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v, configurable: true });
  on.dispatchEvent(e);
  return e;
}
const el = (matches = []) => ({ closest: (sel) => (matches.some((m) => sel.includes(m)) ? {} : null) });
const uiButton = el(["button", "data-ui"]);

function rig(opts = {}) {
  const dom = makeDom(opts.height);
  const log = { actions: [], pauses: 0, mutes: 0, gestures: 0 };
  let active = true;
  const input = new Input(dom.stage, {
    onAction: (a) => log.actions.push(a),
    onPause: () => log.pauses++, onMute: () => log.mutes++,
    isActive: () => active,
    onFirstGesture: () => log.gestures++,
  });
  let t = 1000;
  const touch = (id, type, x, y, extra = {}) => fire(dom.stage, type, { pointerId: id, clientX: x, clientY: y, timeStamp: t += extra.dt ?? 16, pointerType: "touch", button: 0, target: extra.target ?? dom.stage });
  const swipe = (id, from, to, steps = 5, extra = {}) => {
    touch(id, "pointerdown", from[0], from[1], extra);
    for (let i = 1; i <= steps; i++) touch(id, "pointermove", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    touch(id, "pointerup", to[0], to[1]);
  };
  return { ...dom, input, log, touch, swipe, setActive: (v) => { active = v; }, clock: () => t, advance: (ms) => { t += ms; } };
}

test("exactly one action per swipe, in all four directions, from either half of the screen", () => {
  for (const x of [120, 700]) {                                       // left thumb zone, right thumb zone
    const r = rig();
    r.swipe(1, [x, 300], [x, 220]);                  assert.deepEqual(r.log.actions, ["jump"]);
    r.swipe(1, [x, 200], [x - 90, 200]);             assert.deepEqual(r.log.actions, ["jump", "brake"]);
    r.swipe(1, [x, 200], [x + 90, 200]);             assert.deepEqual(r.log.actions, ["jump", "brake", "push"]);
    r.swipe(1, [x, 150], [x, 250]);                  assert.deepEqual(r.log.actions, ["jump", "brake", "push"], "down does nothing, and is not a tap-jump on release");
    r.input.destroy();
  }
});

test("the action fires as soon as the drag passes the threshold, before the finger lifts", () => {
  const r = rig();
  r.touch(1, "pointerdown", 300, 300);
  r.touch(1, "pointermove", 300, 290);
  assert.deepEqual(r.log.actions, [], "10 px is still a wobble");
  r.touch(1, "pointermove", 300, 262);
  assert.deepEqual(r.log.actions, ["jump"], "38 px: fired mid-drag");
  r.touch(1, "pointermove", 300, 100);
  r.touch(1, "pointermove", 600, 100);
  r.touch(1, "pointerup", 600, 100);
  assert.deepEqual(r.log.actions, ["jump"], "dragging on does not fire again");
});

test("a long drag is still one action, even if it curls", () => {
  const r = rig();
  r.touch(1, "pointerdown", 100, 300);
  for (let i = 1; i <= 40; i++) r.touch(1, "pointermove", 100 + i * 6, 300 - Math.sin(i / 6) * 90);
  r.touch(1, "pointerup", 340, 300);
  assert.equal(r.log.actions.length, 1);
});

test("both thumbs work at the same time, each with its own single action", () => {
  const r = rig();
  r.touch(1, "pointerdown", 100, 320);
  r.touch(2, "pointerdown", 740, 320);
  r.touch(1, "pointermove", 100, 270);
  r.touch(2, "pointermove", 800, 320);
  r.touch(1, "pointermove", 100, 220);
  r.touch(2, "pointermove", 840, 320);
  r.touch(1, "pointerup", 100, 220);
  r.touch(2, "pointerup", 840, 320);
  assert.deepEqual(r.log.actions, ["jump", "push"]);
});

test("tap-to-jump: a quick low-movement tap jumps on release", () => {
  const r = rig();
  r.touch(1, "pointerdown", 400, 200);
  assert.deepEqual(r.log.actions, [], "not on touch-down (it might be the start of a swipe)");
  r.touch(1, "pointerup", 403, 202, { dt: 90 });
  assert.deepEqual(r.log.actions, ["jump"]);
});

test("tap-to-jump off: taps do nothing but swipes still work", () => {
  const r = rig();
  r.input.tapToJump = false;
  r.touch(1, "pointerdown", 400, 200);
  r.touch(1, "pointerup", 400, 200, { dt: 60 });
  assert.deepEqual(r.log.actions, []);
  r.swipe(1, [400, 300], [400, 220]);
  assert.deepEqual(r.log.actions, ["jump"]);
});

test("a long press, or a slow wobble between tap and swipe, is not a jump", () => {
  const r = rig();
  r.touch(1, "pointerdown", 400, 200);
  r.touch(1, "pointerup", 400, 200, { dt: SWIPE.tapMaxMs + 50 });
  assert.deepEqual(r.log.actions, [], "held too long");
  r.touch(1, "pointerdown", 400, 200);
  r.touch(1, "pointermove", 400, 200 - (tapSlop(390) + 4));          // past tap slop, short of a swipe
  r.touch(1, "pointerup", 400, 200 - (tapSlop(390) + 4), { dt: 50 });
  assert.deepEqual(r.log.actions, [], "neither a tap nor a swipe");
});

test("a swipe never also counts as a tap on release", () => {
  const r = rig();
  r.swipe(1, [400, 300], [460, 300], 6);
  assert.deepEqual(r.log.actions, ["push"]);
});

test("pointercancel forgets the finger", () => {
  const r = rig();
  r.touch(1, "pointerdown", 100, 300);
  r.touch(1, "pointercancel", 100, 300);
  r.touch(1, "pointermove", 100, 200);
  r.touch(1, "pointerup", 100, 200);
  assert.deepEqual(r.log.actions, []);
});

test("fingers that start on UI (buttons, menus) are ignored by the play surface", () => {
  const r = rig();
  r.swipe(1, [400, 300], [400, 200], 5, { target: uiButton });
  r.touch(2, "pointerdown", 50, 50, { target: uiButton });
  r.touch(2, "pointerup", 50, 50, { dt: 40, target: uiButton });
  assert.deepEqual(r.log.actions, []);
  assert.deepEqual(r.stage.captured, [], "no pointer capture stolen from the button");
});

test("isActive() false (menus, pause) ignores gestures, even a finger already down", () => {
  const r = rig();
  r.setActive(false);
  r.swipe(1, [400, 300], [400, 200]);
  r.touch(1, "pointerdown", 400, 200); r.touch(1, "pointerup", 400, 200, { dt: 50 });
  assert.deepEqual(r.log.actions, []);
  r.setActive(true);
  r.touch(3, "pointerdown", 400, 300);
  r.setActive(false);
  r.touch(3, "pointermove", 400, 200);
  r.setActive(true);
  r.touch(3, "pointerup", 400, 200);
  assert.deepEqual(r.log.actions, [], "the swipe began and fired while inactive");
});

test("right mouse button does not steer", () => {
  const r = rig();
  fire(r.stage, "pointerdown", { pointerId: 1, clientX: 5, clientY: 300, timeStamp: 10, pointerType: "mouse", button: 2, target: r.stage });
  fire(r.stage, "pointermove", { pointerId: 1, clientX: 5, clientY: 100, timeStamp: 20, pointerType: "mouse", button: 2, target: r.stage });
  assert.deepEqual(r.log.actions, []);
});

test("pointer capture is requested so a drag that leaves the stage still ends", () => {
  const r = rig();
  r.touch(7, "pointerdown", 10, 10);
  assert.deepEqual(r.stage.captured, [7]);
});

test("onFirstGesture fires once, on the first lift or key (touch only grants activation on lift)", () => {
  const r = rig();
  r.touch(1, "pointerdown", 10, 10);
  assert.equal(r.log.gestures, 0);
  r.touch(1, "pointerup", 10, 10);
  r.touch(1, "pointerdown", 10, 10); r.touch(1, "pointerup", 10, 10);
  fire(r.win, "keydown", { key: "x" });
  assert.equal(r.log.gestures, 1);
});

/* ───────── keyboard ───────── */

const key = (r, type, k, extra = {}) => fire(r.win, type, { key: k, repeat: false, ...extra });

test("A/D and the arrows are HELD steering, released on keyup", () => {
  const r = rig();
  key(r, "keydown", "ArrowLeft");  assert.deepEqual(r.input.held, { left: true, right: false });
  key(r, "keydown", "d");          assert.deepEqual(r.input.held, { left: true, right: true });
  key(r, "keyup", "ArrowLeft");    assert.deepEqual(r.input.held, { left: false, right: true });
  key(r, "keyup", "D");            assert.deepEqual(r.input.held, { left: false, right: false });
  key(r, "keydown", "a");          assert.equal(r.input.held.left, true);
  key(r, "keyup", "a");            assert.equal(r.input.held.left, false);
  assert.deepEqual(r.log.actions, [], "steering keys are held state, not actions");
});

test("Space / Up / W jump once per press (key repeat ignored), and stop the page scrolling", () => {
  const r = rig();
  for (const k of [" ", "ArrowUp", "w"]) {
    const e = key(r, "keydown", k);
    assert.equal(e.defaultPrevented, true, `${k} must not scroll the page`);
    key(r, "keydown", k, { repeat: true });
    key(r, "keyup", k);
  }
  assert.deepEqual(r.log.actions, ["jump", "jump", "jump"]);
});

test("P and Escape pause, M mutes, once per press", () => {
  const r = rig();
  key(r, "keydown", "p"); key(r, "keydown", "Escape"); key(r, "keydown", "P");
  key(r, "keydown", "p", { repeat: true });
  key(r, "keydown", "m"); key(r, "keydown", "M", { repeat: true });
  assert.equal(r.log.pauses, 3);
  assert.equal(r.log.mutes, 1);
});

test("browser shortcuts (Ctrl/Cmd/Alt combos) are left alone", () => {
  const r = rig();
  const e = key(r, "keydown", "p", { ctrlKey: true });
  key(r, "keydown", "m", { metaKey: true });
  key(r, "keydown", "a", { altKey: true });
  assert.equal(e.defaultPrevented, false);
  assert.equal(r.log.pauses + r.log.mutes, 0);
  assert.equal(r.input.held.left, false);
});

test("in a menu (isActive false) Space/Enter keep working for the focused button, but pause and mute still answer", () => {
  const r = rig();
  r.setActive(false);
  const space = key(r, "keydown", " ");
  assert.equal(space.defaultPrevented, false, "Space must still press a focused menu button");
  assert.deepEqual(r.log.actions, []);
  key(r, "keydown", "p");
  key(r, "keydown", "m");
  assert.equal(r.log.pauses, 1);
  assert.equal(r.log.mutes, 1);
});

test("losing focus or hiding the tab releases held keys and fingers", () => {
  const r = rig();
  key(r, "keydown", "d");
  r.touch(1, "pointerdown", 100, 300);
  fire(r.win, "blur");
  assert.deepEqual(r.input.held, { left: false, right: false });
  r.touch(1, "pointermove", 100, 200);
  assert.deepEqual(r.log.actions, [], "the finger was forgotten");
  key(r, "keydown", "a");
  r.doc.hidden = true; fire(r.doc, "visibilitychange");
  assert.equal(r.input.held.left, false);
});

/* ───────── page lock ───────── */

test("touchmove, pinch and context-menu gestures are cancelled so the page can never move", () => {
  const r = rig();
  const stage = r.stage;
  assert.equal(fire(r.doc, "touchmove", { target: stage, touches: [{ clientY: 10 }] }).defaultPrevented, true);
  assert.equal(fire(r.doc, "touchmove", { target: stage, touches: [{ clientY: 10 }, { clientY: 50 }] }).defaultPrevented, true, "two-finger pinch");
  for (const type of ["gesturestart", "gesturechange", "gestureend", "contextmenu", "selectstart", "dblclick", "dragstart"]) {
    assert.equal(fire(r.doc, type, { target: stage }).defaultPrevented, true, type);
  }
  assert.equal(fire(r.doc, "wheel", { target: stage, ctrlKey: true }).defaultPrevented, true, "ctrl+wheel zoom");
  assert.equal(fire(r.doc, "wheel", { target: stage }).defaultPrevented, true);
});

test("a second quick tap that is not on UI cannot double-tap zoom", () => {
  const r = rig();
  const first = fire(r.doc, "touchend", { target: r.stage, timeStamp: 1000 });
  const second = fire(r.doc, "touchend", { target: r.stage, timeStamp: 1150 });
  assert.equal(first.defaultPrevented, false);
  assert.equal(second.defaultPrevented, true);
  const ui1 = fire(r.doc, "touchend", { target: uiButton, timeStamp: 2000 });
  const ui2 = fire(r.doc, "touchend", { target: uiButton, timeStamp: 2100 });
  assert.equal(ui2.defaultPrevented, false, "a menu button must still receive its click");
  assert.equal(ui1.defaultPrevented, false);
});

/** A scrollable menu list: scrolls inside, but never chains out to the page. */
function scroller(scrollTop, clientHeight = 200, scrollHeight = 500) {
  return { scrollTop, clientHeight, scrollHeight, closest: (sel) => (sel.includes("data-scroll") ? scroller_ref : null) };
}
let scroller_ref;
test("menu lists may scroll with a finger, but not at their ends (no scroll chaining / bounce)", () => {
  const r = rig();
  const move = (s, fromY, toY) => {
    scroller_ref = s;
    fire(r.doc, "touchstart", { target: s, touches: [{ clientY: fromY }] });
    return fire(r.doc, "touchmove", { target: s, touches: [{ clientY: toY }] }).defaultPrevented;
  };
  assert.equal(move(scroller(100), 300, 250), false, "middle, moving up: scroll");
  assert.equal(move(scroller(100), 300, 350), false, "middle, moving down: scroll");
  assert.equal(move(scroller(0), 300, 350), true, "at top, pulling down: would bounce the page");
  assert.equal(move(scroller(0), 300, 250), false, "at top, moving up: scroll");
  assert.equal(move(scroller(300), 300, 250), true, "at bottom, pushing up: would chain");
  assert.equal(move(scroller(300), 300, 350), false, "at bottom, moving back down: scroll");
  assert.equal(move(scroller(0, 200, 200), 300, 250), true, "content that fits is not scrollable at all");
});

test("destroy() detaches everything", () => {
  const r = rig();
  r.input.destroy();
  r.swipe(1, [400, 300], [400, 200]);
  key(r, "keydown", "p");
  key(r, "keydown", "a");
  assert.deepEqual(r.log.actions, []);
  assert.equal(r.log.pauses, 0);
  assert.equal(r.input.held.left, false);
  assert.equal(fire(r.doc, "touchmove", { target: r.stage, touches: [{ clientY: 1 }] }).defaultPrevented, false, "listeners gone");
});
