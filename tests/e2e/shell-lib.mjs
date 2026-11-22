/*
 * Shared helpers for the SHELL end-to-end checks (tests/e2e/shell-*.mjs). Run them by hand, one at a time:
 *
 *   node tests/e2e/shell-layout.mjs      page lock, canvas == viewport, every screen fits, screenshots
 *   node tests/e2e/shell-input.mjs       real touch swipes (CDP), taps, multi-touch, zoom/scroll lock
 *   node tests/e2e/shell-flow.mjs        click-through of every screen, saves, legacy migration, rotate, offline
 *
 * They drive the real page in headless Chromium (Playwright is installed globally; nothing to install),
 * serve docs/ with `python3 -m http.server` on a random port, and put screenshots in SHELL_SHOTS
 * (default: <OS temp dir>/egg-mama-shell). They never write inside the repo.
 *
 * Everything here talks to the REAL main.mjs, which installs its test hooks only when the URL has ?debug:
 *   window.__shell  the small surface the shell suites were written against (ui, input, mode, save, settings, actionLog,
 *                   run {eggs, score, flock}, setMode, startRun, showTitle, pauseGame)
 *   window.__egg    the integration hooks (game(), level(), state(), teleport(), fastForward(), forceBeacon(), forceDead() ...)
 * boot() adds ?debug for you. tests/e2e/game-*.mjs build on the same helpers.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOCS = path.join(ROOT, 'docs');
export const SHOTS = process.env.SHELL_SHOTS || path.join(os.tmpdir(), 'egg-mama-shell');
fs.mkdirSync(SHOTS, { recursive: true });

/** Devices from the task: phones held sideways (and one portrait). `toolbar` shrinks the visible height like Safari's bars do. */
export const DEVICES = {
  iphone13: { label: 'iPhone 13 landscape', viewport: { width: 844, height: 390 }, deviceScaleFactor: 3 },
  pixel7: { label: 'Pixel 7 landscape', viewport: { width: 915, height: 412 }, deviceScaleFactor: 2.625 },
  small: { label: 'small 640x300', viewport: { width: 640, height: 300 }, deviceScaleFactor: 2 },
  se: { label: 'iPhone SE landscape 568x320', viewport: { width: 568, height: 320 }, deviceScaleFactor: 2 },
  portrait: { label: 'iPhone 13 portrait', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
};
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
export const contextOptions = (d) => ({ viewport: d.viewport, screen: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: true, isMobile: true, userAgent: IPHONE_UA });

/* ───────── server ───────── */
export async function startServer() {
  const port = 20000 + Math.floor(Math.random() * 40000);
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', DOCS], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 50; i++) {                                    // wait until it answers
    try { const r = await fetch(url); if (r.ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = () => { try { child.kill(); } catch { /* gone */ } };
  process.on('exit', stop);
  return { url, port, stop };
}

/* ───────── pass/fail bookkeeping ───────── */
export function reporter(title) {
  const failures = [];
  let passed = 0;
  console.log(`\n== ${title}`);
  return {
    ok(cond, name, detail = '') {
      if (cond) { passed++; console.log(`  ok   ${name}`); }
      else { failures.push(name); console.log(`  FAIL ${name}${detail ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); }
      return !!cond;
    },
    info(msg) { console.log(`       ${msg}`); },
    done() {
      console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ${passed} ok, ${failures.length} failed${failures.length ? '\n - ' + failures.join('\n - ') : ''}`);
      return failures.length;
    },
  };
}

/* ───────── pages ───────── */
/** Open the game in a fresh context. `init` runs before the page's own scripts (seed localStorage here). */
export async function boot(browser, server, device, { init, search = '', errors } = {}) {
  if (!/[?&]debug\b/.test(search)) search = search ? `${search}&debug` : '?debug';
  const context = await browser.newContext(contextOptions(device));
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror', (e) => { (errors || []).push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') (errors || []).push(`console.error: ${m.text()}`); });
  await page.goto(server.url + search);
  await page.waitForFunction(() => window.__shell && window.__shell.ui, null, { timeout: 15000 });
  await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 });
  await settle(page);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}
/** Wait out the 240 ms screen fade + a frame. */
export const settle = (page, ms = 420) => page.waitForTimeout(ms);

export const SAVE_SAMPLE = { v: 2, journeySeed: 5, circuit: 2, chapter: 8, flag: 1, eggs: 42, score: 1830, flock: 3, beacons: 1, reached: { circuit: 2, chapter: 8 }, playSeconds: 4321, savedAt: 1 };
export const seedSave = (save) => `localStorage.setItem('egg-mama-save-v2', ${JSON.stringify(JSON.stringify(save))});`;

/* ───────── real touches via the DevTools protocol ───────── */
const pt = (p, i = 0) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 2, radiusY: 2, force: 1 });
export async function touchStart(cdp, points) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points.map(pt) }); }
export async function touchMove(cdp, points) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points.map(pt) }); }
export async function touchEnd(cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }

/** One finger: down at `from`, drag to `to` in `steps`, lift. */
export async function swipe(cdp, from, to, { steps = 8, stepMs = 12, hold = 0 } = {}) {
  await touchStart(cdp, [from]);
  for (let i = 1; i <= steps; i++) {
    await touchMove(cdp, [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    if (stepMs) await new Promise((r) => setTimeout(r, stepMs));
  }
  if (hold) await new Promise((r) => setTimeout(r, hold));
  await touchEnd(cdp);
}
/** Several fingers at once: [{from, to}, …] moving in lock-step. */
export async function multiSwipe(cdp, fingers, { steps = 8, stepMs = 12 } = {}) {
  await touchStart(cdp, fingers.map((f, i) => ({ ...f.from, id: i })));
  for (let s = 1; s <= steps; s++) {
    await touchMove(cdp, fingers.map((f, i) => ({ x: f.from.x + ((f.to.x - f.from.x) * s) / steps, y: f.from.y + ((f.to.y - f.from.y) * s) / steps, id: i })));
    await new Promise((r) => setTimeout(r, stepMs));
  }
  await touchEnd(cdp);
}
export async function tap(cdp, p, ms = 50) { await touchStart(cdp, [p]); await new Promise((r) => setTimeout(r, ms)); await touchEnd(cdp); }

/* ───────── page probes ───────── */
export const scrollState = (page) => page.evaluate(() => ({
  x: window.scrollX, y: window.scrollY,
  docTop: document.scrollingElement.scrollTop, docLeft: document.scrollingElement.scrollLeft,
  bodyTop: document.body.scrollTop, bodyLeft: document.body.scrollLeft,
  docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth,
  bodyH: document.body.scrollHeight, bodyW: document.body.scrollWidth,
  iw: window.innerWidth, ih: window.innerHeight,
  vvScale: window.visualViewport ? window.visualViewport.scale : 1,
  vvTop: window.visualViewport ? window.visualViewport.offsetTop : 0, vvLeft: window.visualViewport ? window.visualViewport.offsetLeft : 0,
}));
export const scrollIsZero = (s) => s.x === 0 && s.y === 0 && s.docTop === 0 && s.docLeft === 0 && s.bodyTop === 0 && s.bodyLeft === 0;

/** Centre of an element in CSS px (for real touches), or null when it is not on screen. */
export const centerOf = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, selector);
/** A real touch tap on the centre of the first element matching `selector`. Throws when it cannot be found. */
export async function tapSelector(page, cdp, selector, ms = 50) {
  const c = await centerOf(page, selector);
  if (!c) throw new Error(`tapSelector: ${selector} is not on screen`);
  await tap(cdp, c, ms);
  return c;
}
/** The game's own state() snapshot (needs ?debug; boot() adds it). */
export const gameState = (page) => page.evaluate(() => window.__egg.state());

/** Show a screen through the ui and wait for it to finish fading in. */
export async function show(page, name, data) {
  await page.evaluate(([n, d]) => { window.__shell.setMode(n === 'title' ? 'title' : 'paused'); window.__shell.ui.show(n, d); }, [name, data]);
  await settle(page);
}

export async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Run `main(browser, server)` with a browser + server that are ALWAYS cleaned up. Returns the failure count. */
export async function run(main) {
  const server = await startServer();
  const browser = await chromium.launch();
  let failures = 1;
  try { failures = await main(browser, server); }
  catch (err) { console.error('\nUNCAUGHT:', err); }
  finally { await browser.close(); server.stop(); }
  process.exitCode = failures ? 1 : 0;
}
