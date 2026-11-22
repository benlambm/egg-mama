/*
 * SHELL input check with REAL touch events (Chromium DevTools Input.dispatchTouchEvent, not synthetic JS events).
 *   node tests/e2e/shell-input.mjs
 *
 *  - swipes up / left / right / down from both screen halves, short, long, curved and diagonal:
 *    exactly one action per swipe, classified correctly, page scroll stays (0,0)
 *  - tap-to-jump on/off, both thumbs at once, swipes that start on UI are ignored, menus swallow gestures
 *  - pull-down "refresh" drag, double-tap and pinch cannot move or zoom the page
 *  - a menu list (journal) CAN be scrolled with a finger without moving the page or firing game actions
 *  - control experiment: the very same swipe DOES scroll an ordinary page (so "scroll stayed 0" means something)
 *  - keyboard: held steering, jump once per press, P/Esc pause, M mute
 */
import { DEVICES, SAVE_SAMPLE, boot, reporter, run, scrollState, scrollIsZero, swipe, multiSwipe, tap, touchStart, touchMove, touchEnd, seedSave, settle, show } from './shell-lib.mjs';

const clearLog = (page) => page.evaluate(() => { window.__shell.actionLog.length = 0; });
const log = (page) => page.evaluate(() => [...window.__shell.actionLog]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startPlaying(page) {
  await page.evaluate(() => { window.__shell.startRun(); });
  await settle(page, 350);
}

async function swipeMatrix(t, page, cdp, device) {
  const { width: W, height: H } = device.viewport;
  const tag = device.label;
  const halves = { left: Math.round(W * 0.15), right: Math.round(W * 0.85) };
  const cases = [
    // name, dx, dy, expected, startY
    ['up', 0, -90, 'jump', 0.72], ['up short', 0, -48, 'jump', 0.72], ['up long', 0, -240, 'jump', 0.8], ['up-right diagonal', 55, -80, 'jump', 0.72], ['up-left diagonal', -55, -80, 'jump', 0.72],
    ['left', -90, 0, 'brake', 0.5], ['left short', -48, 0, 'brake', 0.5], ['left long', -260, 0, 'brake', 0.5], ['left with upward drift', -110, -35, 'brake', 0.5],
    ['right', 90, 0, 'push', 0.5], ['right short', 48, 0, 'push', 0.5], ['right long', 260, 0, 'push', 0.5], ['right with upward drift', 110, -35, 'push', 0.5],
    ['down', 0, 90, null, 0.25], ['down long', 0, 220, null, 0.15], ['down-right steep', 30, 90, null, 0.25],
  ];
  let bad = 0;
  for (const [side, x0] of Object.entries(halves)) {
    for (const [name, dx, dy, want, fy] of cases) {
      await clearLog(page);
      const from = { x: x0, y: Math.round(H * fy) };
      const to = { x: Math.min(W - 2, Math.max(2, from.x + dx)), y: Math.min(H - 2, Math.max(2, from.y + dy)) };
      await swipe(cdp, from, to, { steps: 9, stepMs: 10 });
      await sleep(40);
      const got = await log(page);
      const expected = want ? [want] : [];
      if (JSON.stringify(got) !== JSON.stringify(expected)) { bad++; t.ok(false, `${tag}: swipe ${name} from the ${side} half`, { got, expected, from, to }); }
      const sc = await scrollState(page);
      if (!scrollIsZero(sc) || sc.vvScale !== 1) { bad++; t.ok(false, `${tag}: ${name} (${side}) moved the page`, sc); }
    }
  }
  t.ok(bad === 0, `${tag}: ${cases.length * 2} swipes (8 directions/lengths x both halves): one correct action each, page never moved`);
}

async function curvedAndRepeated(t, page, cdp, device) {
  const { width: W, height: H } = device.viewport;
  const tag = device.label;
  // a long wobbling drag is still ONE action
  await clearLog(page);
  await touchStart(cdp, [{ x: 100, y: H * 0.8 }]);
  for (let i = 1; i <= 40; i++) { await touchMove(cdp, [{ x: 100 + i * 8, y: H * 0.8 - Math.sin(i / 5) * 120 - i * 2 }]); await sleep(5); }
  await touchEnd(cdp);
  await sleep(40);
  const got = await log(page);
  t.ok(got.length === 1, `${tag}: a long curling drag fires exactly one action`, got);
  // rapid separate swipes are separate actions
  await clearLog(page);
  for (let i = 0; i < 5; i++) await swipe(cdp, { x: W * 0.8, y: H * 0.8 }, { x: W * 0.8, y: H * 0.8 - 90 }, { steps: 5, stepMs: 6 });
  await sleep(40);
  t.ok((await log(page)).join() === 'jump,jump,jump,jump,jump', `${tag}: five quick swipes are five jumps`, await log(page));
}

async function taps(t, page, cdp, device) {
  const { width: W, height: H } = device.viewport;
  const tag = device.label;
  await clearLog(page);
  await tap(cdp, { x: W * 0.5, y: H * 0.5 }, 60);
  await sleep(40);
  t.ok((await log(page)).join() === 'jump', `${tag}: a quick tap jumps (tap-to-jump on)`, await log(page));
  await clearLog(page);
  await tap(cdp, { x: W * 0.5, y: H * 0.5 }, 600);
  await sleep(40);
  t.ok((await log(page)).length === 0, `${tag}: a long press is not a jump`, await log(page));
  await clearLog(page);
  await swipe(cdp, { x: 300, y: 200 }, { x: 318, y: 200 }, { steps: 4, stepMs: 8 });
  await sleep(40);
  t.ok((await log(page)).length === 0, `${tag}: an 18 px wobble is neither a tap nor a swipe`, await log(page));
  await page.evaluate(() => { window.__shell.input.tapToJump = false; });
  await clearLog(page);
  await tap(cdp, { x: W * 0.5, y: H * 0.5 }, 60);
  await swipe(cdp, { x: 300, y: 300 }, { x: 300, y: 220 });
  await sleep(40);
  t.ok((await log(page)).join() === 'jump', `${tag}: tap-to-jump off: the tap does nothing, the swipe still jumps`, await log(page));
  await page.evaluate(() => { window.__shell.input.tapToJump = true; });
}

async function bothThumbs(t, page, cdp, device) {
  const { width: W, height: H } = device.viewport;
  const tag = device.label;
  await clearLog(page);
  await multiSwipe(cdp, [{ from: { x: W * 0.12, y: H * 0.8 }, to: { x: W * 0.12, y: H * 0.8 - 100 } }, { from: { x: W * 0.8, y: H * 0.5 }, to: { x: W * 0.8 + 100, y: H * 0.5 } }], { steps: 8, stepMs: 10 });
  await sleep(40);
  const got = (await log(page)).sort();
  t.ok(got.join() === 'jump,push', `${tag}: left thumb up + right thumb right at the same time = jump + push, once each`, got);
  await clearLog(page);
  await multiSwipe(cdp, [{ from: { x: W * 0.12, y: H * 0.8 }, to: { x: W * 0.12, y: H * 0.8 - 100 } }, { from: { x: W * 0.85, y: H * 0.8 }, to: { x: W * 0.85, y: H * 0.8 - 100 } }]);
  await sleep(40);
  t.ok((await log(page)).join() === 'jump,jump', `${tag}: two thumbs jumping = two jumps`, await log(page));
}

async function uiIsIgnored(t, page, cdp, device) {
  const { width: W, height: H } = device.viewport;
  const tag = device.label;
  const box = await page.evaluate(() => { const r = document.getElementById('pause-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hidden: document.getElementById('pause-btn').hidden }; });
  t.ok(!box.hidden, `${tag}: pause button is visible while playing`);
  await clearLog(page);
  await swipe(cdp, { x: box.x, y: box.y + 20 }, { x: box.x, y: box.y - 20 }, { steps: 4, stepMs: 8 });      // swipe that starts on the button
  await sleep(40);
  t.ok((await log(page)).length === 0, `${tag}: a swipe that starts on the pause button is not a game action`, await log(page));
  await page.evaluate(() => { window.__shell.setMode('playing'); window.__shell.ui.hide(); window.__shell.ui.setPauseButton(true); });
  await settle(page, 300);
  await clearLog(page);
  await tap(cdp, { x: box.x, y: box.y }, 70);
  await sleep(450);
  const after = await page.evaluate(() => ({ mode: window.__shell.mode, cur: window.__shell.ui.current, hidden: document.getElementById('pause-btn').hidden }));
  t.ok(after.mode === 'paused' && after.cur === 'pause' && after.hidden, `${tag}: tapping the pause button pauses (pause screen up, button hidden behind it)`, after);
  t.ok((await log(page)).length === 0, `${tag}: ...and that tap did not also jump`, await log(page));
  // with a menu open, gestures on the scrim do nothing
  await clearLog(page);
  await swipe(cdp, { x: 8, y: H * 0.7 }, { x: 8, y: H * 0.7 - 120 });
  await tap(cdp, { x: 6, y: 6 }, 50);
  await swipe(cdp, { x: W - 8, y: H * 0.5 }, { x: W - 130, y: H * 0.5 });
  await sleep(40);
  t.ok((await log(page)).length === 0, `${tag}: with the pause menu open, swipes and taps on the scrim do nothing`, await log(page));
  const sc = await scrollState(page);
  t.ok(scrollIsZero(sc), `${tag}: ...and the page stays put`, sc);
  await page.evaluate(() => { window.__shell.setMode('playing'); window.__shell.ui.hide(); window.__shell.ui.setPauseButton(true); window.__shell.input.releaseAll(); });
  await settle(page, 300);
}

async function pageLock(t, page, cdp, device) {
  const { width: W, height: H } = device.viewport;
  const tag = device.label;
  await page.evaluate(() => { window.__marker = 'same page'; });
  // pull-to-refresh style drag from the very top edge, slowly, far
  await swipe(cdp, { x: W / 2, y: 2 }, { x: W / 2, y: H - 4 }, { steps: 30, stepMs: 16 });
  // and the other way, from the very bottom edge
  await swipe(cdp, { x: W / 2, y: H - 2 }, { x: W / 2, y: 4 }, { steps: 30, stepMs: 16 });
  await swipe(cdp, { x: 2, y: H / 2 }, { x: W - 4, y: H / 2 }, { steps: 30, stepMs: 16 });                 // edge-swipe "back"
  await sleep(300);
  let sc = await scrollState(page);
  t.ok(scrollIsZero(sc) && sc.vvScale === 1 && sc.vvTop === 0, `${tag}: pull-down / pull-up / edge drags: scroll (0,0), no zoom, no pan`, sc);
  t.ok(await page.evaluate(() => window.__marker === 'same page'), `${tag}: ...and the page did not reload (no pull-to-refresh)`);
  // double tap
  await tap(cdp, { x: W * 0.5, y: H * 0.4 }, 30); await sleep(70); await tap(cdp, { x: W * 0.5, y: H * 0.4 }, 30);
  await sleep(350);
  sc = await scrollState(page);
  t.ok(sc.vvScale === 1 && scrollIsZero(sc), `${tag}: double tap does not zoom`, sc);
  // pinch out with two fingers
  await multiSwipe(cdp, [{ from: { x: W / 2 - 20, y: H / 2 }, to: { x: W / 2 - 160, y: H / 2 - 60 } }, { from: { x: W / 2 + 20, y: H / 2 }, to: { x: W / 2 + 160, y: H / 2 + 60 } }], { steps: 14, stepMs: 12 });
  await sleep(300);
  sc = await scrollState(page);
  t.ok(sc.vvScale === 1 && scrollIsZero(sc), `${tag}: pinch does not zoom`, sc);
  // text selection by long press must not happen
  await touchStart(cdp, [{ x: W / 2, y: H / 2 }]); await sleep(800); await touchEnd(cdp);
  const sel = await page.evaluate(() => String(getSelection()));
  t.ok(sel === '', `${tag}: long press selects nothing`, sel);
}

async function menuScrolls(t, page, cdp, device) {
  const tag = device.label;
  await show(page, 'journal', { circuit: 2, chapter: 12, reached: { circuit: 2, chapter: 12 } });
  const pane = await page.evaluate(() => { const e = document.querySelector('.j-detail'), r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, scroll: e.scrollHeight, client: e.clientHeight, st: e.scrollTop }; });
  t.info(`journal pane ${pane.client}px tall holds ${pane.scroll}px`);
  if (pane.scroll <= pane.client + 1) { t.ok(true, `${tag}: (journal fits without scrolling here; scroll test skipped)`); return; }
  await clearLog(page);
  await swipe(cdp, { x: pane.x, y: pane.bottom - 14 }, { x: pane.x, y: pane.top + 14 }, { steps: 10, stepMs: 12 });
  await sleep(250);
  let st = await page.evaluate(() => document.querySelector('.j-detail').scrollTop);
  let sc = await scrollState(page);
  t.ok(st > 0, `${tag}: a finger drag scrolls the journal list (scrollTop ${st.toFixed(0)})`, st);
  t.ok(scrollIsZero(sc), `${tag}: ...without moving the page`, sc);
  t.ok((await log(page)).length === 0, `${tag}: ...and without firing a game action`, await log(page));
  // keep pushing past the end: must not chain out to the page
  await swipe(cdp, { x: pane.x, y: pane.bottom - 14 }, { x: pane.x, y: pane.top + 14 }, { steps: 10, stepMs: 12 });
  await swipe(cdp, { x: pane.x, y: pane.top + 14 }, { x: pane.x, y: pane.bottom - 14 }, { steps: 10, stepMs: 12 });     // back to the top
  await swipe(cdp, { x: pane.x, y: pane.top + 14 }, { x: pane.x, y: pane.bottom - 14 }, { steps: 10, stepMs: 12 });     // over-pull at the top
  await sleep(250);
  sc = await scrollState(page);
  st = await page.evaluate(() => document.querySelector('.j-detail').scrollTop);
  t.ok(scrollIsZero(sc) && st === 0, `${tag}: over-scrolling the list at either end never moves the page`, { sc, st });
  // a drag on the part of the card that doesn't scroll does nothing at all
  await swipe(cdp, { x: 40, y: 200 }, { x: 40, y: 80 });
  sc = await scrollState(page);
  t.ok(scrollIsZero(sc) && (await log(page)).length === 0, `${tag}: dragging on a non-scrolling part of a menu does nothing`, sc);
  await page.evaluate(() => { window.__shell.setMode('playing'); window.__shell.ui.hide(); window.__shell.ui.setPauseButton(true); });
  await settle(page, 300);
}

async function control(t, browser, device) {
  // The same CDP swipe on a plain tall page: it must scroll. If it did not, the harness could not see scrolling at all.
  const { contextOptions } = await import('./shell-lib.mjs');
  const context = await browser.newContext(contextOptions(device));
  const page = await context.newPage();
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div style="height:4000px;background:linear-gradient(red,blue)"></div>');
  const cdp = await context.newCDPSession(page);
  await swipe(cdp, { x: 200, y: 320 }, { x: 200, y: 60 }, { steps: 20, stepMs: 12 });
  await sleep(500);
  const y = await page.evaluate(() => window.scrollY);
  t.ok(y > 50, `control: an ordinary page DOES scroll under the same swipe (scrollY ${y.toFixed(0)}), so "stays at 0" is meaningful`, y);
  await context.close();
}

async function keyboard(t, page, device) {
  const tag = device.label;
  await clearLog(page);
  await page.keyboard.down('ArrowRight');
  const h1 = await page.evaluate(() => ({ ...window.__shell.input.held }));
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('a');
  const h2 = await page.evaluate(() => ({ ...window.__shell.input.held }));
  await page.keyboard.up('a');
  const h3 = await page.evaluate(() => ({ ...window.__shell.input.held }));
  t.ok(h1.right && !h1.left && h2.left && !h2.right && !h3.left && !h3.right, `${tag}: arrows/A/D are held steering and release on key up`, [h1, h2, h3]);
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.down('w'); await page.keyboard.down('w'); await page.keyboard.up('w');             // down twice = auto-repeat
  await sleep(40);
  t.ok((await log(page)).join() === 'jump,jump,jump', `${tag}: Space, Up and W jump once per press (auto-repeat ignored)`, await log(page));
  const before = await page.evaluate(() => window.__shell.settings.muted);
  await page.keyboard.press('m');
  const after = await page.evaluate(() => ({ muted: window.__shell.settings.muted, sw: document.querySelector('[data-action="sound"]') }));
  t.ok(after.muted === !before, `${tag}: M toggles mute`, after);
  await page.keyboard.press('m');
  await page.keyboard.press('p');
  await sleep(450);
  t.ok(await page.evaluate(() => window.__shell.mode === 'paused' && window.__shell.ui.current === 'pause'), `${tag}: P pauses`);
  await page.keyboard.press('Escape');
  await sleep(450);
  t.ok(await page.evaluate(() => window.__shell.mode === 'playing' && window.__shell.ui.current === null), `${tag}: Esc resumes`);
  const sc = await scrollState(page);
  t.ok(scrollIsZero(sc), `${tag}: keyboard (Space/arrows) never scrolls the page`, sc);
}

run(async (browser, server) => {
  const t = reporter('SHELL input (real touch events)');
  const errors = [];
  for (const dev of ['iphone13', 'pixel7', 'small']) {
    const device = DEVICES[dev];
    const { context, page, cdp } = await boot(browser, server, device, { errors, init: seedSave(SAVE_SAMPLE) });
    await startPlaying(page);
    await swipeMatrix(t, page, cdp, device);
    if (dev !== 'pixel7') {
      await curvedAndRepeated(t, page, cdp, device);
      await taps(t, page, cdp, device);
      await bothThumbs(t, page, cdp, device);
      await uiIsIgnored(t, page, cdp, device);
      await pageLock(t, page, cdp, device);
    }
    if (dev === 'small') { await menuScrolls(t, page, cdp, device); await keyboard(t, page, device); }
    await context.close();
  }
  await control(t, browser, DEVICES.iphone13);
  t.ok(errors.length === 0, 'no console errors or page errors', errors.slice(0, 5));
  return t.done();
});
