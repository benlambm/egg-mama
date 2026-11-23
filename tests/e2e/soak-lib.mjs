/*
 * Shared plumbing for the SOAK suites (tests/e2e/soak-*.mjs). Not a test by itself.
 *
 *   - startRepoServer()   python http.server rooted at the REPO (not docs/): the page lives at /docs/index.html and the soak driver
 *                         (/tools/soak-driver.mjs) imports the very same '/docs/js/sim.mjs' module instance main.mjs runs on.
 *   - soakBoot()          fresh Chromium context (iPhone 13 landscape by default), a seeded journey in localStorage, ?debug, error
 *                         capture, a PerformanceObserver for long tasks; waits for window.__egg and the soak driver.
 *   - memSample()         JS heap (after a forced GC) + DOM nodes + JS event listeners, straight from the DevTools protocol.
 *   - planSegments()      the Node planner (tests/bot.mjs) over flag-to-flag segments, with traces, for the replay.
 *
 * Everything here reuses tests/e2e/shell-lib.mjs (devices, real CDP touches, reporter). Screenshots go to SHELL_SHOTS / GAME_SHOTS
 * (default: <tmp>/egg-mama-shell), never into the repo.
 */
import { spawn } from 'node:child_process';
import { generateLevel, levelSeed } from '../../docs/js/levelgen.mjs';
import { playLevel, segmentsOf } from '../bot.mjs';
import { levelFingerprint } from '../../tools/soak-driver.mjs';
import { chromium, ROOT, DEVICES, contextOptions, reporter, tapSelector, swipe, shot, gameState, SHOTS } from './shell-lib.mjs';

export { chromium, ROOT, DEVICES, reporter, tapSelector, swipe, shot, gameState, SHOTS, levelFingerprint, generateLevel, levelSeed, segmentsOf, playLevel };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `--name value` / `--flag` command line options. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[name] = isNaN(+next) ? next : +next; i++; } else out[name] = true;
  }
  return out;
}

/** p in 0..1 of a numeric array (nearest rank). */
export const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
export const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

/* ───────────────────────── server ───────────────────────── */

/** A static server for the whole repo on a random port (20000-60000). Always call stop(). */
export async function startRepoServer() {
  const port = 20000 + Math.floor(Math.random() * 40000);
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url); if (r.ok) break; } catch { /* not yet */ }
    await sleep(100);
  }
  const stop = () => { try { child.kill(); } catch { /* gone */ } };
  process.on('exit', stop);
  return { url, port, stop, game: `${url}docs/index.html` };
}

/* ───────────────────────── a seeded journey ───────────────────────── */

/** localStorage init script for a journey standing at (circuit, chapter, flag). */
export function seedJourney({ journeySeed, circuit = 1, chapter = 0, flag = 0, eggs = 0, score = 0, flock = 0, beacons = 0, playSeconds = 0 }) {
  const save = { v: 2, journeySeed, circuit, chapter, flag, eggs, score, flock, beacons, reached: { circuit, chapter }, playSeconds, savedAt: 1 };
  // only when nothing is stored yet: an init script runs again on every reload and must not overwrite what the game saved
  return `try { if (!localStorage.getItem('egg-mama-save-v2')) localStorage.setItem('egg-mama-save-v2', ${JSON.stringify(JSON.stringify(save))}); } catch (e) {}`;
}

/* ───────────────────────── the page ───────────────────────── */

const INIT_COMMON = `
  window.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: Math.round(e.startTime * 10) / 10, d: Math.round(e.duration * 10) / 10 }); }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__ltOff = String(e); }
`;

/**
 * Open the game. Options: device (DEVICES key or object), journeySeed/circuit/chapter/flag (seeded save; omit journeySeed for a fresh
 * browser), errors (array that collects page and console errors), init (extra init script), search (extra query), flags (chromium).
 * Returns { context, page, cdp, errors }.
 */
export async function soakBoot(browser, server, { device = 'iphone13', journeySeed, circuit, chapter, flag, errors = [], init = '', search = '', driver = true, eggs, score, flock } = {}) {
  const dev = typeof device === 'string' ? DEVICES[device] : device;
  const context = await browser.newContext(contextOptions(dev));
  await context.addInitScript(INIT_COMMON + (journeySeed !== undefined ? seedJourney({ journeySeed, circuit, chapter, flag, eggs, score, flock }) : '') + init);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${server.game}?debug${search ? '&' + search : ''}`);
  await page.waitForFunction(() => window.__shell && window.__shell.ui, null, { timeout: 20000 });
  await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 45000 });
  const cdp = await context.newCDPSession(page);
  if (driver) await page.evaluate(async () => { window.__drv = await import('/tools/soak-driver.mjs'); });
  return { context, page, cdp, errors };
}

/** Tap Continue (a save exists) or Play (a fresh browser) with a real touch and wait for the run to start. */
export async function startPlaying(page, cdp, { action } = {}) {
  const act = action || (await page.evaluate(() => (document.querySelector('[data-screen=title] [data-action=continue]') ? 'continue' : 'play')));
  await tapSelector(page, cdp, `[data-screen=title] [data-action=${act}]`);
  await page.waitForFunction(() => window.__egg.state().mode === 'playing', null, { timeout: 15000 });
}

/* ───────────────────────── memory, DOM, listeners ───────────────────────── */

/** Force a GC, then read the JS heap, DOM node count and JS event-listener count from the protocol (not from page JS). */
export async function memSample(cdp) {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch { /* not available */ }
  const [heap, dom] = await Promise.all([cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters')]);
  return { heapMB: +(heap.usedSize / 1048576).toFixed(2), totalMB: +(heap.totalSize / 1048576).toFixed(1), nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents };
}

/** Long tasks seen so far (>= 50 ms) with start times on the page's performance clock. */
export const longTasks = (page) => page.evaluate(() => (window.__lt || []).slice());

/* ───────────────────────── the planner (Node) ───────────────────────── */

export const BOT_OPTS = { allowSteer: false, iceBrake: false };    // what tests/levels.test.mjs calls the oracle

/**
 * Plan flag-to-flag segments with the planner bot, with traces. `which` = array of segment indices; per segment the clean bot,
 * and optionally a human-noise bot. Returns [{ i, from, to, x0, x1, ch, phase, oracle: {...}, noisy?: {...} }].
 */
export function planSegments(level, which, { phase = (i) => (i * 1.37) % 11, noise = null, maxSeconds = 150 } = {}) {
  const segs = segmentsOf(level);
  const out = [];
  for (const i of which) {
    const s = segs[i];
    const ph = typeof phase === 'function' ? phase(i) : phase;
    const base = { startCheckpoint: i, stopAtCheckpoint: s.to ?? undefined, tOffset: ph, trace: true, maxSeconds, ...BOT_OPTS };
    const res = playLevel(level, base);
    const row = { i, from: s.from, to: s.to, x0: s.x0, x1: s.x1, ch: s.ch, phase: ph, oracle: res };
    if (noise) row.noisy = playLevel(level, { ...base, noise });
    out.push(row);
  }
  return out;
}

/** The level a page will build for a seeded journey. */
export function nodeLevel(journeySeed, circuit) {
  const t0 = performance.now();
  const level = generateLevel({ circuit, seed: levelSeed(journeySeed, circuit) });
  return { level, genMs: performance.now() - t0, fp: levelFingerprint(level) };
}
