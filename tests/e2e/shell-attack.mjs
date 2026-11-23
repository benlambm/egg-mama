/*
 * SHELL audit regression: the things most likely to hurt a child on a real phone, tried the nasty way.
 *   node tests/e2e/shell-attack.mjs
 *
 *   - network: every request (page AND service worker) goes to our own origin, nothing else
 *   - real env(safe-area-inset-*) (Chromium's Emulation.setSafeAreaInsetsOverride, not a CSS-variable stand-in):
 *     every screen and the pause button stay inside the notch / home-indicator insets
 *   - orientation storm: 24 upright/sideways flips at random speeds never lose the run, never auto-resume, and a
 *     thumb that was already on the glass while the phone turned does not tap "Tap to continue" by lifting off
 *   - touches: Play/Resume followed at once by a swipe (the fade-out must not eat it), swipes from the extreme edges,
 *     a thumb resting on the pause button, hold-then-drag, four fingers at once
 *   - keyboard: focus order, Enter/Space on a focused menu button is not stolen as "jump", focus returns to the
 *     opener, Tab reaches the pause button during play, no stuck steering
 *   - updates: edit a file, run tools/sync-sw.mjs, and an installed phone picks the new page up while another game's
 *     cache on the same address survives (a temp copy of docs/ is served for this one)
 *
 * Like the other shell-*.mjs suites it talks to the page through window.__shell (see shell-lib.mjs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEVICES, DOCS, boot, contextOptions, reporter, run, settle, swipe, tap, touchStart, touchMove, touchEnd, show, scrollState, scrollIsZero, SAVE_SAMPLE, seedSave } from './shell-lib.mjs';
import { precacheList, rewrite } from '../../tools/sync-sw.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inScreen = (sel) => `.screen.is-open ${sel}`;
const center = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
const actions = (page) => page.evaluate(() => window.__shell.actionLog.slice());
const clearActions = (page) => page.evaluate(() => { window.__shell.actionLog.length = 0; });

async function networkAndSafeAreas(browser, server, R) {
  // ── every request is same-origin, including the service worker's own (context-level events) ──
  {
    const errors = [], reqs = [];
    const context = await browser.newContext(contextOptions(DEVICES.iphone13));
    await context.addInitScript(seedSave(SAVE_SAMPLE));
    context.on('request', (r) => reqs.push(r.url()));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(server.url + '?sw&debug');                            // ?sw: main skips the worker on localhost otherwise; ?debug installs window.__shell
    await page.waitForFunction(() => window.__shell && window.__shell.ui);
    await settle(page);
    for (const sel of ['[data-action="journal"]', '[data-action="close"]', '[data-action="help"]', '[data-action="close"]', '[data-action="continue"]']) { await page.click(inScreen(sel)); await settle(page, 300); }
    await page.click('#pause-btn'); await settle(page, 300);
    for (const sel of ['[data-action="sound"]', '[data-action="tap-to-jump"]', '[data-action="journal"]', '[data-action="close"]', '[data-action="resume"]']) { await page.click(inScreen(sel)); await settle(page, 300); }
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(2500);                                      // let the install fetch its files
    const origin = new URL(server.url).origin;
    const foreign = reqs.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    R.ok(foreign.length === 0, `every network request (page + service worker: ${reqs.length}) is same-origin`, foreign);
    R.ok(reqs.length > 30, `the service worker really ran its install (${reqs.length} requests seen)`);
    R.ok(errors.length === 0, 'no console errors on a tour with the service worker enabled', errors);
    await context.close();
  }
  // ── real env() safe areas ──
  for (const dev of [DEVICES.iphone13, DEVICES.small]) {
    const errors = [];
    const { page, cdp, context } = await boot(browser, server, dev, { errors, init: seedSave(SAVE_SAMPLE) });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, right: 47, bottom: 21 } });
    await settle(page, 300);
    const ins = await page.evaluate(() => window.__shell.ui.insets());
    R.ok(ins.left === 47 && ins.right === 47 && ins.bottom === 21, `${dev.label}: real env() insets are read back by ui.insets()`, ins);
    const screens = [['title', { save: SAVE_SAMPLE, best: { score: 1, eggs: 1 } }], ['pause', { eggs: 1, score: 1, flock: 2, circuit: 2, chapter: 8, progress: 0.5, playSeconds: 99 }], ['dead', { eggs: 1, score: 1, flock: 0 }], ['finish', { eggs: 1, score: 1, flock: 5, circuit: 1 }], ['journal', {}], ['help', {}], ['reset-confirm', { save: SAVE_SAMPLE }], ['rotate', { phase: 'ready' }]];
    for (const [name, data] of screens) {
      await show(page, name, data);
      const bad = await page.evaluate(([n, inset]) => {
        const vw = innerWidth, vh = innerHeight, out = [];
        for (const b of window.__shell.ui.el(n).querySelectorAll('button, .card, .title-hero > *, h1, h2')) {
          if (b.offsetParent === null) continue;
          const r = b.getBoundingClientRect();
          if (!r.width) continue;
          if (r.left < inset.left - 0.5 || r.right > vw - inset.right + 0.5 || r.bottom > vh - inset.bottom + 0.5) out.push(`${b.tagName}.${b.className} ${r.left.toFixed(0)}-${r.right.toFixed(0)} ${r.top.toFixed(0)}-${r.bottom.toFixed(0)}`);
        }
        return out;
      }, [name, ins]);
      R.ok(bad.length === 0, `${dev.label}: ${name} stays inside the real safe area`, bad.slice(0, 4));
    }
    await page.evaluate(() => window.__shell.startRun()); await settle(page);
    const pb = await page.evaluate(() => { const b = document.getElementById('pause-btn').getBoundingClientRect(); return { r: b.right, t: b.top, w: innerWidth }; });
    R.ok(pb.r <= pb.w - 47 && pb.t >= 0, `${dev.label}: the pause button is inside the safe area`, pb);
    R.ok(errors.length === 0, `${dev.label}: no errors`, errors);
    await context.close();
  }
}

async function orientationStorm(browser, server, R) {
  const errors = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors, init: seedSave(SAVE_SAMPLE) });
  await page.evaluate(() => window.__shell.startRun()); await settle(page);
  await page.evaluate(() => { const r = window.__shell.run; r.eggs = 77; r.flock = 4; });
  const before = await page.evaluate(() => ({ eggs: window.__shell.run.eggs, flock: window.__shell.run.flock, save: JSON.stringify(window.__shell.save) }));
  for (let i = 0; i < 24; i++) {
    await page.setViewportSize(i % 2 === 0 ? { width: 390, height: 844 } : { width: 844, height: 390 });
    await page.waitForTimeout([0, 10, 30, 60, 120][i % 5]);
  }
  await page.setViewportSize({ width: 844, height: 390 }); await settle(page, 600);
  const st = await page.evaluate(() => {
    const c = document.getElementById('game').getBoundingClientRect();
    return { mode: window.__shell.mode, cur: window.__shell.ui.current, phase: window.__shell.ui.el('rotate').dataset.phase, eggs: window.__shell.run.eggs, flock: window.__shell.run.flock, save: JSON.stringify(window.__shell.save), cw: c.width, ch: c.height };
  });
  R.ok(st.mode === 'rotate' && st.cur === 'rotate' && st.phase === 'ready', 'after a 24-flip storm that ends sideways: "Tap to continue" is up and the run did NOT restart by itself', st);
  R.ok(st.eggs === before.eggs && st.flock === before.flock && st.save === before.save, 'run state and save are untouched by the storm');
  R.ok(st.cw === 844 && st.ch === 390, 'the canvas still equals the viewport after the storm', st);
  await tap(cdp, { x: 400, y: 200 }); await settle(page);
  R.ok((await page.evaluate(() => window.__shell.mode)) === 'playing' && (await page.evaluate(() => window.__shell.ui.current)) === null, 'a fresh tap anywhere on the ready screen resumes');

  // a thumb already on the glass while the phone turned must not resume by lifting off
  await page.setViewportSize({ width: 390, height: 844 }); await settle(page, 500);
  R.ok((await page.evaluate(() => window.__shell.ui.el('rotate').dataset.phase)) === 'prompt', 'upright again: prompt');
  await touchStart(cdp, [{ x: 195, y: 420, id: 0 }]);                                   // finger down during the prompt…
  await page.setViewportSize({ width: 844, height: 390 }); await settle(page, 500);     // …phone turns: "Tap to continue"
  await touchEnd(cdp); await sleep(200);                                                // …finger lifts
  const held = await page.evaluate(() => ({ mode: window.__shell.mode, cur: window.__shell.ui.current, phase: window.__shell.ui.el('rotate').dataset.phase }));
  R.ok(held.mode === 'rotate' && held.cur === 'rotate' && held.phase === 'ready', 'a finger that went down during the prompt and lifts after the turn does NOT resume the run', held);
  const btn = await center(page, inScreen('[data-action="rotate-continue"]'));
  await tap(cdp, btn); await settle(page);
  R.ok((await page.evaluate(() => window.__shell.mode)) === 'playing', '...but the next real tap on the button does');
  // a keyboard click on the focused button (detail 0) is always allowed
  await page.setViewportSize({ width: 390, height: 844 }); await settle(page, 400);
  await page.setViewportSize({ width: 844, height: 390 }); await settle(page, 500);
  await page.keyboard.press('Enter'); await settle(page);
  R.ok((await page.evaluate(() => window.__shell.mode)) === 'playing', 'Enter on the focused "Tap to continue" works for keyboard players');

  // rotating with a sheet open over the pause menu comes back to the pause menu, never silently to play
  await page.evaluate(() => { window.__shell.ui.hide(); window.__shell.setMode('playing'); window.__shell.pauseGame(); }); await settle(page);
  await page.click(inScreen('[data-action="journal"]')); await settle(page, 300);
  await page.setViewportSize({ width: 390, height: 844 }); await settle(page, 400);
  await page.setViewportSize({ width: 844, height: 390 }); await settle(page, 500);
  const back = await page.evaluate(() => ({ mode: window.__shell.mode, cur: window.__shell.ui.current, eggs: window.__shell.run.eggs }));
  R.ok(back.mode === 'paused' && back.cur === 'pause' && back.eggs >= 77 && back.eggs <= 90, 'rotating with the journal open over pause returns to the pause menu with the run intact', back);
  R.ok(errors.length === 0, 'no errors in the orientation storm', errors);
  await context.close();
}

async function touchesAndKeys(browser, server, R) {
  for (const dev of [DEVICES.iphone13, DEVICES.small]) {
    const errors = [];
    const { page, cdp, context } = await boot(browser, server, dev, { errors });
    const W = dev.viewport.width, H = dev.viewport.height, L = dev.label;
    await clearActions(page);
    await tap(cdp, await center(page, inScreen('[data-action="play"]')));
    await sleep(40);
    await swipe(cdp, { x: W * 0.3, y: H * 0.8 }, { x: W * 0.3, y: H * 0.4 }, { steps: 5, stepMs: 8 });
    await sleep(100);
    R.ok(JSON.stringify(await actions(page)) === '["jump"]', `${L}: tap Play then an immediate swipe = exactly one jump (the fade-out does not eat the swipe)`, await actions(page));
    const top = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.id || e.tagName); }, [W / 2, H / 2]);
    R.ok(/^(game|CANVAS)$/i.test(String(top)), `${L}: nothing sits above the canvas while playing`, top);
    await tap(cdp, await center(page, '#pause-btn')); await settle(page, 350);
    R.ok((await page.evaluate(() => window.__shell.mode)) === 'paused', `${L}: the pause button (real touch) pauses`);
    await clearActions(page);
    await tap(cdp, await center(page, inScreen('[data-action="resume"]')));
    await sleep(30);
    await swipe(cdp, { x: W * 0.8, y: H * 0.8 }, { x: W * 0.95, y: H * 0.8 }, { steps: 5, stepMs: 8 });
    await sleep(100);
    R.ok(JSON.stringify(await actions(page)) === '["push"]', `${L}: Resume then an immediate right swipe = one push`, await actions(page));
    await clearActions(page);
    await swipe(cdp, { x: 3, y: H * 0.7 }, { x: 3, y: H * 0.3 }, { steps: 5, stepMs: 8 });
    await swipe(cdp, { x: W - 3, y: H * 0.7 }, { x: W - 3, y: H * 0.3 }, { steps: 5, stepMs: 8 });
    await swipe(cdp, { x: W / 2, y: H - 3 }, { x: W / 2, y: H - 80 }, { steps: 5, stepMs: 8 });
    await swipe(cdp, { x: W / 2, y: 3 }, { x: W / 2 - 80, y: 3 }, { steps: 5, stepMs: 8 });
    await sleep(100);
    R.ok(JSON.stringify(await actions(page)) === '["jump","jump","jump","brake"]', `${L}: swipes that start on the extreme edges register`, await actions(page));
    await clearActions(page);
    const pb = await center(page, '#pause-btn');
    await touchStart(cdp, [{ ...pb, id: 0 }]); await sleep(30);
    await touchStart(cdp, [{ ...pb, id: 0 }, { x: W * 0.3, y: H * 0.8, id: 1 }]);
    for (let i = 1; i <= 5; i++) { await touchMove(cdp, [{ ...pb, id: 0 }, { x: W * 0.3, y: H * 0.8 - i * 14, id: 1 }]); await sleep(10); }
    await touchEnd(cdp); await sleep(150);
    const rest = await page.evaluate(() => ({ mode: window.__shell.mode, log: window.__shell.actionLog.slice() }));
    R.ok(rest.log.length === 1 && rest.log[0] === 'jump', `${L}: a finger resting on the pause button does not stop the other thumb jumping`, rest);
    if (rest.mode === 'paused') await page.evaluate(() => { window.__shell.ui.hide(); window.__shell.setMode('playing'); window.__shell.ui.setPauseButton(true); });
    await clearActions(page);
    await touchStart(cdp, [{ x: W * 0.4, y: H * 0.8, id: 0 }]); await sleep(600);
    for (let i = 1; i <= 5; i++) { await touchMove(cdp, [{ x: W * 0.4, y: H * 0.8 - i * 12, id: 0 }]); await sleep(8); }
    await touchEnd(cdp); await sleep(100);
    R.ok(JSON.stringify(await actions(page)) === '["jump"]', `${L}: hold-then-drag is still exactly one swipe`, await actions(page));
    await clearActions(page);
    const four = (s) => [0, 1, 2, 3].map((i) => ({ x: 100 + i * 60, y: H * 0.7 - s * 15, id: i }));
    await touchStart(cdp, four(0));
    for (let s = 1; s <= 6; s++) { await touchMove(cdp, four(s)); await sleep(8); }
    await touchEnd(cdp); await sleep(100);
    const fourLog = await actions(page);
    R.ok(fourLog.length === 4 && fourLog.every((a) => a === 'jump'), `${L}: four fingers = four independent jumps, one each`, fourLog);
    R.ok(scrollIsZero(await scrollState(page)), `${L}: the page is still at (0,0)`);
    R.ok(errors.length === 0, `${L}: no errors`, errors);
    await context.close();
  }

  // the death / beacon screens pop up while a child is still mashing the screen: those first taps must not press a button
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.small, { errors: errs, init: seedSave(SAVE_SAMPLE) });
    await page.evaluate(() => window.__shell.startRun()); await settle(page);
    for (const [screen, action] of [['dead', 'retry'], ['finish', 'keep-going']]) {
      await page.evaluate((n) => { window.__shell.setMode(n); window.__shell.ui.show(n, { eggs: 3, score: 30, flock: 0, circuit: 1, chapter: 0 }); }, screen);
      await sleep(120);
      const pos = await center(page, inScreen(`[data-action="${action}"]`));
      await tap(cdp, pos); await sleep(60);
      R.ok((await page.evaluate(() => window.__shell.ui.current)) === screen, `${screen}: a tap on ${action} in the first moments (leftover play tap) is ignored`);
      await sleep(450);
      await tap(cdp, pos); await settle(page);
      R.ok((await page.evaluate(() => window.__shell.mode)) === 'playing', `${screen}: ...and a deliberate tap a moment later works`);
    }
    R.ok(errs.length === 0, 'guarded screens: no errors', errs);
    await context.close();
  }

  const errors = [];
  const { page, context } = await boot(browser, server, DEVICES.small, { errors, init: seedSave(SAVE_SAMPLE) });
  const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset && a.dataset.action) || a.id || a.tagName : null; });
  const current = () => page.evaluate(() => window.__shell.ui.current);
  R.ok((await active()) === 'continue', 'keyboard: the title puts focus on Continue');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  R.ok((await active()) === 'help', 'keyboard: Tab walks Journal, then How to play', await active());
  await page.keyboard.press('Enter'); await settle(page, 350);
  R.ok((await current()) === 'help', 'keyboard: Enter on a focused button presses it');
  await page.keyboard.press('Escape'); await settle(page, 350);
  R.ok((await current()) === 'title' && (await active()) === 'help', 'keyboard: Esc closes the sheet and focus returns to the button that opened it', await active());
  await page.keyboard.press('Space'); await settle(page, 350);
  R.ok((await current()) === 'help' && (await page.evaluate(() => window.__shell.actionLog.length)) === 0, 'keyboard: Space on a focused menu button presses it and is not stolen as a jump');
  await page.keyboard.press('Escape'); await settle(page, 350);
  await page.focus(inScreen('[data-action="continue"]')); await page.keyboard.press('Enter'); await settle(page, 350);
  R.ok((await page.evaluate(() => window.__shell.mode)) === 'playing', 'keyboard: Enter on Continue starts play');
  await page.keyboard.press('Space'); await sleep(50);
  R.ok((await page.evaluate(() => window.__shell.actionLog.length)) === 1, 'keyboard: Space is a jump during play (no stale focus eats it)');
  await page.keyboard.press('Tab'); await sleep(50);
  R.ok((await active()) === 'pause-btn' || (await active()) === 'pause', 'keyboard: Tab during play lands on the pause button', await active());
  await page.keyboard.press('Enter'); await settle(page, 350);
  R.ok((await current()) === 'pause' && (await active()) === 'resume', 'keyboard: Enter pauses and focus lands on Resume');
  await page.keyboard.down('ArrowRight'); await page.keyboard.press('Escape'); await settle(page, 350); await page.keyboard.up('ArrowRight');
  R.ok(await page.evaluate(() => window.__shell.input.held.right === false), 'keyboard: a key released after a menu leaves no stuck steering');
  R.ok(errors.length === 0, 'keyboard: no errors', errors);
  await context.close();
}

/** Edit a file in a temp copy of docs/, sync the worker, and see an installed page update; another game's cache survives. */
async function updateFlow(browser, R) {
  const copy = fs.mkdtempSync(path.join(process.env.SHELL_SHOTS || os.tmpdir(), 'swcopy-'));
  fs.cpSync(DOCS, copy, { recursive: true });
  const walk = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));
  const swp = path.join(copy, 'sw.js'), idx = path.join(copy, 'index.html');
  const sync = () => fs.writeFileSync(swp, rewrite(fs.readFileSync(swp, 'utf8'), precacheList(walk(copy)), (rel) => fs.readFileSync(path.join(copy, rel))));
  sync();
  const port = 20000 + Math.floor(Math.random() * 40000);
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', copy], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch { /* not yet */ } await sleep(100); }
    const context = await browser.newContext(contextOptions(DEVICES.iphone13));
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${port}/?sw&debug`;
    await page.goto(url); await page.waitForFunction(() => window.__shell);
    await page.evaluate(async () => { const c = await caches.open('other-game-v7'); await c.put('/x', new Response('hi')); });
    await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForTimeout(800);
    const v1 = (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('egg-mama-'));
    R.ok(v1.length === 1 && /^egg-mama-v-[0-9a-f]{10}$/.test(v1[0]), 'update: the first install made one fingerprinted cache', v1);
    await page.reload(); await page.waitForFunction(() => window.__shell);
    R.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'update: the page is controlled by the worker');
    // deploy: edit a page, sync (the one release step), let the phone check for an update
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<title>Egg Mama</title>', '<title>Egg Mama v2</title>'));
    sync();
    const v2name = /const VERSION = PREFIX \+ '([^']+)'/.exec(fs.readFileSync(swp, 'utf8'))[1];
    R.ok(`egg-mama-${v2name}` !== v1[0], 'update: editing a file and syncing changed VERSION without anyone bumping it by hand');
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await page.waitForTimeout(2500);
    const keys = await page.evaluate(() => caches.keys());
    R.ok(keys.includes(`egg-mama-${v2name}`) && !keys.includes(v1[0]) && keys.includes('other-game-v7'), 'update: new version installed, this game\'s old cache deleted, another game\'s cache kept', keys);
    await page.reload(); await page.waitForFunction(() => window.__shell);
    R.ok((await page.title()) === 'Egg Mama v2', 'update: the next load serves the edited page');
    R.ok(errors.length === 0, 'update: no page errors', errors);
    await context.close();
  } finally { srv.kill(); fs.rmSync(copy, { recursive: true, force: true }); }
}

await run(async (browser, server) => {
  const R = reporter('SHELL audit regression (network, real safe areas, orientation storm, touches, keyboard, updates)');
  await networkAndSafeAreas(browser, server, R);
  await orientationStorm(browser, server, R);
  await touchesAndKeys(browser, server, R);
  await updateFlow(browser, R);
  return R.done();
});
