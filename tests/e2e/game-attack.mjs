#!/usr/bin/env node
/*
 * Egg Mama — QA attack on the integrated game (real main.mjs, real touches, real Chromium). Run by hand, one browser at a time:
 *
 *   node tests/e2e/game-attack.mjs [--only orient,hidden,taps,slow,cycles,reload,noscroll,storage,offline,update,insets,viewports,keyboard,deploy]
 *   GAME_SHOTS=<dir> to choose where screenshots go (default: <tmp>/egg-mama-shell; never the repo)
 *
 * Where shell-attack.mjs attacks the shell, this attacks the WHOLE game in every state it can be in (title, a sheet over the
 * title, playing, dying, beacon celebration, paused, a sheet over pause, dead, finish):
 *   orient     24-flip rotate storms in every state: nothing auto-resumes, nothing is lost, the right screen comes back
 *   hidden     background/foreground storms in every state: paused, ONE music stream, nothing caught up
 *   taps       double-taps on Play / Retry / Keep Going / Yes-start-over, rapid pause/resume, pause in the dying and beacon phases
 *   slow       CPU throttled 6x: an early Play tap is honoured, she still progresses in real time, input and menus keep up
 *   cycles     eight Main Title <-> Continue cycles at full tap speed, three quick Start Overs: no stuck fade, one stream, no runaway memory
 *   reload     reload the page in every state; Continue opens the latest save; the tap-to-jump choice persists; a mid-drag pause leaves no ghost swipe
 *   noscroll   edge drags, pinch, double-tap, long press and wheel on every screen leave the page unscrolled and unzoomed
 *   storage    localStorage missing, throwing, full (quota): the game still starts, plays, retries; nothing is logged as an error
 *   offline    service worker + warm, then the network is cut: reload, play, all 13 paintings, music, a checkpoint save
 *   update     a changed file + tools/sync-sw.mjs: an installed page picks the new version up, progress survives
 *   insets     real env(safe-area-inset-*) (CDP) with the pause button, captions, egg pill and every menu
 *   viewports  640x300, a 4:3 tablet, a tall phone, portrait: fit, no scroll, controls reachable
 *   keyboard   keyboard-only: start, play, pause, mute, a whole death/retry cycle without a pointer
 *   deploy     GitHub Pages: docs/ is self-contained, every URL relative, nothing node-only, nothing off-origin, a cold cache is quiet
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CHAPTERS } from '../../docs/js/chapters.mjs';
import {
  chromium, startServer, reporter, boot, settle, shot, swipe, tap, tapSelector, centerOf, gameState, scrollState, scrollIsZero,
  DEVICES, DOCS, ROOT, SHOTS, seedSave, contextOptions, SAVE_SAMPLE, touchStart, touchMove, touchEnd,
} from './shell-lib.mjs';

const ONLY = (() => { const i = process.argv.indexOf('--only'); return i < 0 ? null : String(process.argv[i + 1] || '').split(','); })();
const want = (name) => !ONLY || ONLY.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = reporter('game attack (real main loop, hostile input)');
const errors = [];

const S = (page) => gameState(page);
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const compact = (page) => page.evaluate(() => {
  const s = window.__egg.state();
  return {
    mode: s.mode, ui: s.ui, status: s.status, x: s.mama ? Math.round(s.mama.x) : 0, tm: s.t, players: s.audio.players, susp: s.audio.suspended,
    ctx: s.audio.ctx, flock: s.flock, eggs: s.eggs, score: s.score, busy: s.busy, circuit: s.circuit, errs: s.errors, crashed: s.crashed,
    stored: s.stored ? `${s.stored.circuit}:${s.stored.chapter}:${s.stored.flag}:${s.stored.eggs}:${s.stored.flock}` : null,
    scroll: [window.scrollX, window.scrollY], phase: s.ui === 'rotate' ? document.querySelector('[data-screen=rotate]').dataset.phase : null,
  };
});
/** Music players settle to exactly one (a song change crossfades for a moment, so two is allowed briefly, never for good). */
async function oneStream(page, ms = 5000) {
  const t0 = Date.now(); let p = -1;
  while (Date.now() - t0 < ms) { p = await page.evaluate(() => window.__egg.state().audio.players); if (p === 1) return true; await sleep(150); }
  return p === 1;
}

/** Start playing from the title with a real tap and wait until she is rolling. */
async function startPlay(page, cdp, { quiet = 600 } = {}) {
  await tapSelector(page, cdp, '[data-screen=title] [data-action=play], [data-screen=title] [data-action=continue]');
  await waitFor(page, () => window.__egg.state().mode === 'playing');
  await sleep(quiet);
}
async function openPause(page, cdp) {
  await tapSelector(page, cdp, '#pause-btn');
  await waitFor(page, () => window.__egg.state().mode === 'paused');
  await settle(page);
}

/* every state the game can be in, and how to get there (each starts from a freshly booted title) */
const STATES = {
  title: { go: async () => {}, mode: 'title', ui: 'title' },
  'title+help': { go: async (page, cdp) => { await tapSelector(page, cdp, '[data-screen=title] [data-action=help]'); await settle(page); }, mode: 'title', ui: 'title', sheet: 'help' },
  'title+confirm': { go: async (page, cdp) => { await tapSelector(page, cdp, '[data-screen=title] [data-action=start-over]'); await settle(page); }, mode: 'title', ui: 'title', sheet: 'reset-confirm', needsSave: true },
  playing: { go: (page, cdp) => startPlay(page, cdp), mode: 'rotate', resumes: 'playing' },
  dying: {
    go: async (page, cdp) => { await startPlay(page, cdp); await page.evaluate(() => window.__egg.forceDead()); await sleep(250); },
    mode: 'rotate', resumes: 'playing', status: 'dead',
  },
  beacon: {
    go: async (page, cdp) => { await startPlay(page, cdp); await page.evaluate(() => window.__egg.forceBeacon()); await waitFor(page, () => window.__egg.game().status === 'beacon', null, 8000); await sleep(200); },
    mode: 'rotate', resumes: 'playing', status: 'beacon',
  },
  paused: { go: async (page, cdp) => { await startPlay(page, cdp); await openPause(page, cdp); }, mode: 'paused', ui: 'pause' },
  'pause+journal': {
    go: async (page, cdp) => { await startPlay(page, cdp); await openPause(page, cdp); await tapSelector(page, cdp, '[data-screen=pause] [data-action=journal]'); await settle(page); },
    mode: 'paused', ui: 'pause',
  },
  dead: { go: async (page, cdp) => { await startPlay(page, cdp); await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 600); }, mode: 'dead', ui: 'dead' },
  finish: { go: async (page, cdp) => { await startPlay(page, cdp); await page.evaluate(() => window.__egg.skipToFinish()); await settle(page, 600); }, mode: 'finish', ui: 'finish' },
};

const BACKGROUND_SAVE = { ...SAVE_SAMPLE, circuit: 1, chapter: 2, flag: 0, eggs: 31, score: 410, flock: 2, reached: { circuit: 1, chapter: 2 } };

/* ═════════════════════════════════ orient: rotate storms in every state ═════════════════════════════════ */
async function orient(browser, server) {
  console.log('\n-- orient: 24-flip rotate storm in every state (iPhone 13 landscape)');
  for (const [name, def] of Object.entries(STATES)) {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: def.needsSave ? seedSave(BACKGROUND_SAVE) : undefined });
    await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
    try {
      await def.go(page, cdp);
      const before = await compact(page);
      const sheetUp = await page.evaluate(() => window.__egg.state().ui);
      for (let i = 0; i < 24; i++) {
        await page.setViewportSize(i % 2 === 0 ? { width: 390, height: 844 } : { width: 844, height: 390 });
        await page.waitForTimeout([0, 8, 25, 60, 130][i % 5]);
      }
      // the storm ends upright first (so we can look at the frozen world), then sideways
      await page.setViewportSize({ width: 390, height: 844 }); await settle(page, 500);
      const up = await compact(page);
      await sleep(500);
      const up2 = await compact(page);
      t.ok(up.ui === 'rotate' && up.phase === 'prompt' && up.susp === true, `${name}: upright -> the rotate prompt, audio suspended`, up);
      t.ok(up2.x === up.x && up2.tm === up.tm, `${name}: nothing moves while upright (sim time and position frozen)`, { up, up2 });
      await page.setViewportSize({ width: 844, height: 390 }); await settle(page, 600);
      const back = await compact(page);
      if (def.resumes === 'playing') {
        t.ok(back.mode === 'rotate' && back.ui === 'rotate' && back.phase === 'ready', `${name}: sideways again -> "Tap to continue", the run did NOT restart by itself`, back);
        t.ok(back.x === before.x || Math.abs(back.x - before.x) < 40, `${name}: position preserved through the storm (${before.x} -> ${back.x})`, { before, back });
        t.ok(back.eggs === before.eggs && back.flock === before.flock && back.score === before.score && back.stored === before.stored, `${name}: eggs, score, flock and the save are untouched`, { before, back });
        await tapSelector(page, cdp, '[data-screen=rotate] [data-action=rotate-continue]');
        await sleep(300);
        const run = await compact(page);
        t.ok(run.mode === 'playing' && run.ui === null && run.susp === false && run.players <= 2, `${name}: a tap resumes (mode ${run.mode}, ui ${run.ui})`, run);
        if (def.status === 'dead') {
          await waitFor(page, () => window.__egg.state().ui === 'dead', null, 4000).catch(() => {});
          const d = await compact(page);
          t.ok(d.mode === 'dead' && d.ui === 'dead', `${name}: the dying phase still ends in the dead screen exactly once`, d);
        } else if (def.status === 'beacon') {
          await waitFor(page, () => window.__egg.state().ui === 'finish', null, 6000).catch(() => {});
          const d = await compact(page);
          t.ok(d.mode === 'finish' && d.ui === 'finish', `${name}: the beacon celebration still ends in the finish screen`, d);
          t.ok(d.stored && d.stored.startsWith('2:0:0'), `${name}: the lit beacon is saved (next circuit's Meadow)`, d);
        } else {
          const x0 = run.x; await sleep(900);
          t.ok((await compact(page)).x > x0 + 20, `${name}: and she rolls again`);
        }
      } else {
        t.ok(back.mode === def.mode && back.ui === def.ui, `${name}: the same screen comes back (mode ${back.mode}, ui ${back.ui})`, back);
        t.ok(back.x === before.x && back.eggs === before.eggs && back.flock === before.flock, `${name}: the world and totals are untouched`, { before, back });
        t.ok(back.stored === before.stored, `${name}: the save is untouched`, { before, back });
        if (def.mode === 'paused') {
          t.ok(back.susp === true, `${name}: audio stays suspended until Resume`, back);
          await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(300);
          t.ok((await compact(page)).mode === 'playing', `${name}: Resume then works`);
        }
      }
      t.ok(Math.abs(before.players - 1) <= 1 && (await compact(page)).players <= 2, `${name}: music players stay bounded`, await compact(page));
      const cv = await page.evaluate(() => { const c = document.getElementById('game').getBoundingClientRect(); return [c.width, c.height]; });
      t.ok(cv[0] === 844 && cv[1] === 390, `${name}: the canvas still equals the viewport`, cv);
      t.ok(scrollIsZero(await scrollState(page)), `${name}: page at (0,0)`);
      t.ok(errs.length === 0, `${name}: no console or page errors`, errs);
    } catch (e) { t.ok(false, `${name}: scenario threw`, String(e && e.stack || e)); }
    await context.close();
  }
}

/* ═════════════════════════════════ hidden: background / foreground storms ═════════════════════════════════ */
const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

async function hidden(browser, server) {
  console.log('\n-- hidden: 20x background/foreground in every state');
  for (const name of ['title', 'playing', 'dying', 'beacon', 'paused', 'dead', 'finish']) {
    const def = STATES[name];
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
    try {
      await def.go(page, cdp);
      const before = await compact(page);
      for (let i = 0; i < 20; i++) { await setHidden(page, true); await sleep([0, 15, 60][i % 3]); await setHidden(page, false); await sleep([0, 20, 90][i % 3]); }
      await setHidden(page, true); await sleep(400);
      const away = await compact(page);
      t.ok(away.susp === true, `${name}: hidden -> audio suspended`, away);
      await sleep(1500);   // the hidden time must never be caught up
      await setHidden(page, false); await settle(page, 500);
      const back = await compact(page);
      const moved = Math.abs(back.x - before.x);
      if (name === 'playing') {
        t.ok(back.mode === 'paused' && back.ui === 'pause' && back.susp === true, `${name}: back in the foreground it is PAUSED (the player decides when to go on)`, back);
        t.ok(moved < 60, `${name}: the time spent away was not caught up (moved ${moved} u)`, { before, back });
        await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(400);
        const r = await compact(page);
        t.ok(r.mode === 'playing' && r.susp === false && (await oneStream(page)), `${name}: Resume starts ONE music stream (players ${r.players})`, r);
      } else if (name === 'dying' || name === 'beacon') {
        t.ok(back.mode === 'paused' && back.ui === 'pause', `${name}: hidden in the ${name} phase pauses too`, back);
        await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
        await waitFor(page, (u) => window.__egg.state().ui === u, name === 'dying' ? 'dead' : 'finish', 6000).catch(() => {});
        const r = await compact(page);
        t.ok(r.ui === (name === 'dying' ? 'dead' : 'finish'), `${name}: then the ${name === 'dying' ? 'dead' : 'finish'} screen comes up once`, r);
      } else if (name === 'paused') {
        t.ok(back.mode === 'paused' && back.susp === true, `${name}: stays paused and silent until Resume`, back);
      } else {
        t.ok(back.mode === def.mode && back.ui === def.ui, `${name}: the same screen is back (${back.mode}/${back.ui})`, back);
        t.ok(back.susp === false && back.players <= 1, `${name}: music is back, ONE stream (players ${back.players}, ctx ${back.ctx})`, back);
      }
      t.ok(back.crashed === false && back.errs === 0, `${name}: no frame errors`, back);
      t.ok(errs.length === 0, `${name}: no console or page errors`, errs);
    } catch (e) { t.ok(false, `${name}: scenario threw`, String(e && e.stack || e)); }
    await context.close();
  }
}

/* ═════════════════════════════════ taps: double-taps, rapid pause/resume ═════════════════════════════════ */
async function taps(browser, server) {
  console.log('\n-- taps: double-taps and rapid pause/resume');
  // double tap on Play: one launch, then at most a jump
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    const c = await centerOf(page, '[data-screen=title] [data-action=play]');
    await tap(cdp, c, 25); await sleep(50); await tap(cdp, c, 25);
    await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(900);
    const s = await compact(page);
    t.ok(s.mode === 'playing' && s.status === 'running' && s.ui === null && s.stored && s.stored.startsWith('1:0:0'), 'double-tap Play: one run, no menu, one stored journey', s);
    t.ok(await oneStream(page), 'double-tap Play: ONE music stream once the title song has crossfaded out', await compact(page));
    t.ok(errs.length === 0, 'double-tap Play: no errors', errs);
    await context.close();
  }
  // double tap on Retry / Keep Going / Main title(dead)
  for (const [name, action, after] of [['dead', 'retry', 'playing'], ['finish', 'keep-going', 'playing']]) {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await STATES[name].go(page, cdp);
    await sleep(450);
    const c = await centerOf(page, `[data-screen=${name}] [data-action=${action}]`);
    await tap(cdp, c, 25); await sleep(50); await tap(cdp, c, 25);
    await waitFor(page, () => window.__egg.state().mode === 'playing', null, 6000);
    await sleep(1200);
    const s = await compact(page);
    t.ok(s.mode === after && s.status === 'running' && s.ui === null, `double-tap ${action}: one clean restart, no stuck menu (circuit ${s.circuit})`, s);
    t.ok(await oneStream(page), `double-tap ${action}: ONE music stream`, await compact(page));
    const exp = name === 'finish' ? 2 : 1;
    t.ok(s.circuit === exp, `double-tap ${action}: circuit ${exp}`, s);
    t.ok(errs.length === 0, `double-tap ${action}: no errors`, errs);
    await context.close();
  }
  // double tap on "Yes, start over": the second tap must not press whatever the title shows under it
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: seedSave(BACKGROUND_SAVE) });
    await tapSelector(page, cdp, '[data-screen=title] [data-action=start-over]'); await settle(page);
    const c = await centerOf(page, '[data-screen=reset-confirm] [data-action=confirm-start-over]');
    await tap(cdp, c, 25); await sleep(60); await tap(cdp, c, 25);
    await sleep(2200);
    const s = await compact(page);
    t.ok(s.mode === 'title' && s.ui === 'title' && s.stored === '1:0:0:0:0', 'double-tap "Yes, start over": a new journey, back on the title, the confirm did not reopen', s);
    t.ok(errs.length === 0, 'double-tap start over: no errors', errs);
    await context.close();
  }
  // double tap on "Keep my journey" (cancel) must not press Continue behind it
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: seedSave(BACKGROUND_SAVE) });
    await tapSelector(page, cdp, '[data-screen=title] [data-action=start-over]'); await settle(page);
    const c = await centerOf(page, '[data-screen=reset-confirm] [data-action=cancel-start-over]');
    await tap(cdp, c, 25); await sleep(60); await tap(cdp, c, 25);
    await sleep(900);
    const s = await compact(page);
    t.ok(s.mode === 'title' && s.ui === 'title' && s.stored === '1:2:0:31:2', 'double-tap "Keep my journey": the save is intact and the title is still up (no accidental Continue)', s);
    t.ok(errs.length === 0, 'double-tap Keep my journey: no errors', errs);
    await context.close();
  }
  // double tap on the close X of a sheet must not press a button of the screen beneath
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: seedSave(BACKGROUND_SAVE) });
    await tapSelector(page, cdp, '[data-screen=title] [data-action=help]'); await settle(page);
    const c = await centerOf(page, '[data-screen=help] [data-action=close]');
    await tap(cdp, c, 25); await sleep(60); await tap(cdp, c, 25);
    await sleep(800);
    const s = await compact(page);
    t.ok(s.mode === 'title' && s.ui === 'title', 'double-tap Close on How to play: back on the title, nothing underneath was pressed', s);
    t.ok(errs.length === 0, 'double-tap Close: no errors', errs);
    await context.close();
  }
  // double tap on the pause button: pause once and STAY paused (the second tap must not press what the pause menu shows under it);
  // two switches tapped one right after the other (no screen change between them) both work
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await startPlay(page, cdp, 700);
    const c = await centerOf(page, '#pause-btn');
    await tap(cdp, c, 25); await sleep(70); await tap(cdp, c, 25);
    await sleep(900);
    let s = await compact(page);
    t.ok(s.mode === 'paused' && s.ui === 'pause', 'double-tap on the pause button: paused, and still paused (the second tap did not press Resume or anything else)', s);
    const a0 = await page.evaluate(() => ({ m: window.__egg.state().audio.muted, tj: window.__egg.state().settings.tapToJump }));
    const p1 = await centerOf(page, '[data-screen=pause] [data-action=sound]'), p2 = await centerOf(page, '[data-screen=pause] [data-action=tap-to-jump]');
    await tap(cdp, p1, 20); await sleep(40); await tap(cdp, p2, 20); await sleep(300);
    const a1 = await page.evaluate(() => ({ m: window.__egg.state().audio.muted, tj: window.__egg.state().settings.tapToJump }));
    t.ok(a1.m !== a0.m && a1.tj !== a0.tj, 'Sound then Tap to jump tapped in quick succession: both switches flip (no screen changed between them, so nothing is swallowed)', { a0, a1 });
    t.ok(errs.length === 0, 'pause double-tap: no errors', errs);
    await context.close();
  }
  // rapid pause / resume with real touches and with P
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await startPlay(page, cdp);
    for (let i = 0; i < 12; i++) {
      await tapSelector(page, cdp, '#pause-btn', 20); await sleep(30);
      const r = await centerOf(page, '[data-screen=pause] [data-action=resume]');
      if (r) await tap(cdp, r, 20);
      await sleep(40);
    }
    await sleep(500);
    let s = await compact(page);
    t.ok((s.mode === 'playing' && s.ui === null) || (s.mode === 'paused' && s.ui === 'pause'), `12 rapid pause/resume taps: a consistent state (${s.mode}/${s.ui})`, s);
    t.ok(s.players <= 1 && s.errs === 0, 'rapid pause/resume taps: one music stream, no frame errors', s);
    if (s.mode === 'paused') { await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(400); }
    for (let i = 0; i < 30; i++) { await page.keyboard.press('p'); await sleep(i % 3 === 0 ? 0 : 25); }
    await sleep(500);
    s = await compact(page);
    t.ok((s.mode === 'playing' && s.ui === null && s.susp === false) || (s.mode === 'paused' && s.ui === 'pause' && s.susp === true), `30 rapid P presses: consistent (${s.mode}/${s.ui}, suspended ${s.susp})`, s);
    if (s.mode === 'paused') { await page.keyboard.press('p'); await sleep(400); }
    s = await compact(page);
    t.ok(s.mode === 'playing' && s.players <= 1, 'after the P storm, play continues with one music stream', s);
    // she keeps being safe: the pause/resume dance does not freeze or corrupt the sim
    const x0 = s.x; await sleep(1500);
    t.ok((await compact(page)).x > x0 + 30, 'and she keeps rolling');
    t.ok(errs.length === 0, 'rapid pause/resume: no errors', errs);
    await context.close();
  }
}

/* ═════════════════════════════════ slow: a phone 6x slower than this machine ═════════════════════════════════ */
async function slow(browser, server) {
  console.log('\n-- slow: CPU throttled 6x (a modest phone), Play tapped the moment the title appears');
  const errs = [];
  const context = await browser.newContext(contextOptions(DEVICES.iphone13));
  const page = await context.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.goto(server.url + '?debug');
  // press Play in the very first moment the button exists (the world is generated after the first paint: this is the "tapped too early" path)
  await page.waitForFunction(() => !!document.querySelector('[data-screen=title] [data-action=play]'), null, { timeout: 30000, polling: 'raf' });
  const early = await page.evaluate(() => { const ready = !!(window.__egg && window.__egg.state().worldReady); document.querySelector('[data-screen=title] [data-action=play]').click(); return { ready }; });
  t.ok(!early.ready, `Play pressed while the world was NOT ready yet (it is made after the first paint)`, early);
  await page.waitForFunction(() => window.__egg && window.__egg.state().mode === 'playing', null, { timeout: 40000, polling: 100 });
  const s0 = await S(page);
  t.ok(s0.mode === 'playing' && s0.status === 'running', `the early tap is honoured: she rolls as soon as the world exists (world made in ${s0.genMs} ms at 6x slow-down)`, s0);
  await page.evaluate(() => window.__egg.autoplay(true));          // the debug autopilot keeps her alive over the gaps (a thumb would jump them)
  await page.evaluate(() => window.__egg.resetPerf());
  await sleep(14000);
  const s1 = await S(page);
  const perf = await page.evaluate(() => window.__egg.perfStats());
  await page.evaluate(() => window.__egg.autoplay(false));
  t.ok(s1.mama.x > s0.mama.x + 800 && s1.t - s0.t > 8, `at 6x slow-down she still covers ground in real time (${(s1.mama.x - s0.mama.x).toFixed(0)} u in ~14 s; ${(s1.t - s0.t).toFixed(1)} s of game time)`, { dx: s1.mama.x - s0.mama.x, dt: s1.t - s0.t, gapP50: perf.gapP50, gapP95: perf.gapP95 });
  t.ok(s1.dpr <= 3 && s1.canvas.w > 0, `adaptive resolution under load: dpr ${s1.dpr} (device 3), frame gap p50 ${perf.gapP50} ms p95 ${perf.gapP95} ms`);
  await page.evaluate(() => { window.__egg.actionLog.length = 0; });
  await swipe(cdp, { x: 300, y: 330 }, { x: 300, y: 220 }, { steps: 6, stepMs: 8 }); await sleep(400);
  t.ok((await page.evaluate(() => window.__egg.actionLog.slice().join())) === 'jump', 'a swipe is still recognised at once');
  await tapSelector(page, cdp, '#pause-btn'); await waitFor(page, () => window.__egg.state().mode === 'paused', null, 8000);
  t.ok((await S(page)).ui === 'pause', 'the pause menu opens');
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(1500);
  const s2 = await S(page);
  t.ok(s2.mode === 'playing' && !s2.crashed && s2.errors === 0, 'and resumes: no frame errors, no crash screen', s2.errors);
  t.ok(errs.length === 0, 'slow device: no console or page errors', errs);
  await context.close();
}

/* ═════════════════════════════════ cycles: Main Title <-> Continue as fast as a child can tap ═════════════════════════════════ */
async function cycles(browser, server) {
  console.log('\n-- cycles: Play -> pause -> Main Title -> Continue, eight times at full tap speed; Start Over three times');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlay(page, cdp, 500);
  const lvl0 = await page.evaluate(() => { window.__lv = window.__egg.level(); return window.__egg.state().genMs; });
  const heap0 = await page.evaluate(() => { window.__egg.gc(); return window.__egg.heap(); });
  for (let i = 0; i < 8; i++) {
    await tapSelector(page, cdp, '#pause-btn', 20);
    await waitFor(page, () => window.__egg.state().ui === 'pause', null, 4000);
    await sleep(260);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=title]', 20);
    // tap Continue the very moment it exists (and twice), without waiting for the fade
    await waitFor(page, () => window.__egg.state().ui === 'title' && !!document.querySelector('[data-screen=title].is-open [data-action=continue]'), null, 6000);
    const c = await centerOf(page, '[data-screen=title] [data-action=continue]');
    await tap(cdp, c, 15); await sleep(40); await tap(cdp, c, 15);
    await waitFor(page, () => window.__egg.state().mode === 'playing', null, 6000);
    await sleep(350);
  }
  await sleep(1500);
  let s = await compact(page);
  t.ok(s.mode === 'playing' && s.status === 'running' && s.ui === null && s.errs === 0, 'eight Main Title / Continue cycles: playing, no menu stuck, no frame errors', s);
  t.ok(await oneStream(page), 'eight cycles: ONE music stream', await compact(page));
  t.ok(await page.evaluate(() => window.__egg.level() === window.__lv), 'eight cycles: the world was never regenerated (same level object)');
  const heap1 = await page.evaluate(() => { window.__egg.gc(); return window.__egg.heap(); });
  t.ok(heap0 === 0 || heap1 < heap0 + 25e6, `eight cycles: no memory runaway (heap ${(heap0 / 1e6).toFixed(1)} -> ${(heap1 / 1e6).toFixed(1)} MB)`);
  // Start Over three times in a row, quickly: always a clean Meadow journey, never a stuck fade
  await page.evaluate(() => window.__egg.pause()); await settle(page);
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=title]'); await waitFor(page, () => window.__egg.state().ui === 'title' && !window.__egg.state().busy, null, 6000); await settle(page);
  const seeds = [];
  for (let i = 0; i < 3; i++) {
    await tapSelector(page, cdp, '[data-screen=title] [data-action=start-over]'); await settle(page, 300);
    await tapSelector(page, cdp, '[data-screen=reset-confirm] [data-action=confirm-start-over]');
    await waitFor(page, () => !window.__egg.state().busy && window.__egg.state().ui === 'title', null, 6000);
    await sleep(500);
    const st = await S(page);
    seeds.push(st.stored.journeySeed);
    if (!(st.circuit === 1 && st.eggs === 0 && st.flock === 0 && st.stored.chapter === 0 && st.fade === 0)) t.ok(false, `start over ${i + 1}: clean Meadow journey`, st);
  }
  t.ok(new Set(seeds).size === 3, 'three Start Overs: three different journeys (new route each time), each in the Meadow with nothing', seeds);
  s = await compact(page);
  t.ok(s.mode === 'title' && s.ui === 'title' && !s.busy, 'and the title is up, not busy', s);
  await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]'); await waitFor(page, () => window.__egg.state().mode === 'playing', null, 6000); await sleep(800);
  t.ok((await S(page)).status === 'running', 'and the new journey plays');
  t.ok(errs.length === 0, 'cycles: no console or page errors', errs);
  await context.close();
}

/* ═════════════════════════════════ reload: Continue after a reload from every state ═════════════════════════════════ */
async function reload(browser, server) {
  console.log('\n-- reload: reload the page in every state; Continue must open the latest save');
  for (const name of ['title', 'playing', 'paused', 'dying', 'dead', 'beacon', 'finish']) {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    try {
      await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
      if (name !== 'title') {
        await startPlay(page, cdp);
        // earn something worth keeping and reach a flag (so the save has totals in it)
        await page.evaluate(() => { const g = window.__egg.game(); g.eggs = 21; g.score = 600; g.flock = 3; });
        const cp = await page.evaluate(() => window.__egg.level().checkpoints[4].x);
        await page.evaluate((x) => window.__egg.teleport(x - 150), cp);
        await waitFor(page, () => window.__egg.state().checkpoint === 4, null, 12000);
        await sleep(300);
        await page.evaluate(() => { window.__egg.game().eggs += 3; });          // collected after the flag: not part of the save
      }
      if (name === 'paused') await openPause(page, cdp);
      if (name === 'dying') { await page.evaluate(() => window.__egg.forceDead()); await sleep(300); }
      if (name === 'dead') { await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 600); }
      if (name === 'beacon') { await page.evaluate(() => window.__egg.forceBeacon()); await waitFor(page, () => window.__egg.game().status === 'beacon', null, 8000); await sleep(300); }
      if (name === 'finish') { await page.evaluate(() => window.__egg.skipToFinish()); await settle(page, 600); }
      const before = await S(page);
      const finishLike = name === 'beacon' || name === 'finish';
      await page.reload();
      await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
      const title = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
      if (name === 'title') {
        t.ok(/Play/.test(title) && !/Continue/.test(title), 'title: a reload before any play still offers Play');
      } else {
        t.ok(/Continue/.test(title), `${name}: after a reload the title offers Continue`, title.slice(0, 120));
        await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
        const after = await S(page);
        if (finishLike) {
          t.ok(after.circuit === 2 && after.chapter === 0 && after.flock === before.flock && after.eggs >= before.eggs && after.eggs <= before.eggs + 2, `${name}: the lit beacon was saved at once: Continue opens circuit 2's Meadow with the flock (${after.flock}) and eggs (${after.eggs} vs ${before.eggs})`, { before: before.stored, after: after.stored });
        } else {
          t.ok(after.circuit === 1 && after.checkpoint === 4 && after.flock === 3 && after.eggs >= before.stored.eggs && after.eggs <= before.stored.eggs + 2 && after.eggs < before.eggs, `${name}: Continue opens the latest flag (4) with the saved totals (${before.stored.eggs} eggs), not the unsaved ones (${before.eggs}); now ${after.eggs} eggs, flock ${after.flock}`, { after, stored: before.stored });
        }
        t.ok(after.mode === 'playing' && after.status === 'running' && after.followers === after.flock, `${name}: she rolls, her followers are all there`);
      }
      t.ok(errs.length === 0, `${name}: no errors`, errs);
    } catch (e) { t.ok(false, `${name}: scenario threw`, String((e && e.stack) || e)); }
    await context.close();
  }
  // the Tap-to-jump choice is remembered, applied at boot, and a swipe still works with it off
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await startPlay(page, cdp);
    await openPause(page, cdp);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=tap-to-jump]'); await settle(page, 200);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(400);
    await page.reload(); await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
    await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(900);
    t.ok(await page.evaluate(() => window.__egg.input.tapToJump === false && window.__egg.state().settings.tapToJump === false), 'tap-to-jump off survives a reload and reaches the input');
    await page.evaluate(() => { window.__egg.actionLog.length = 0; });
    await tap(cdp, { x: 300, y: 250 }, 40); await sleep(100);
    t.ok((await page.evaluate(() => window.__egg.actionLog.length)) === 0, 'with it off a tap does nothing');
    await jumpSwipe(cdp); await sleep(150);
    t.ok((await page.evaluate(() => window.__egg.actionLog.slice().join())) === 'jump', 'with it off a swipe up still jumps');
    t.ok(errs.length === 0, 'tap-to-jump: no errors', errs);
    await context.close();
  }
  // a finger that is mid-drag when the pause menu opens must not leave a ghost swipe behind
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await startPlay(page, cdp, 900);
    await page.evaluate(() => { window.__egg.actionLog.length = 0; });
    await touchStart(cdp, [{ x: 300, y: 330, id: 0 }]);
    await touchMove(cdp, [{ x: 300, y: 322, id: 0 }]); await sleep(30);
    await page.keyboard.press('p'); await sleep(450);                         // pause opens under the finger
    for (let i = 1; i <= 8; i++) { await touchMove(cdp, [{ x: 300, y: 322 - i * 14, id: 0 }]); await sleep(10); }
    await touchEnd(cdp); await sleep(200);
    const s = await compact(page);
    t.ok(s.mode === 'paused' && (await page.evaluate(() => window.__egg.actionLog.length)) === 0, 'a drag that continues after the pause menu opened fires nothing, and lifting does not resume or jump', s);
    await page.keyboard.press('p'); await sleep(300);
    await page.evaluate(() => { window.__egg.actionLog.length = 0; });
    await sleep(300);
    t.ok((await page.evaluate(() => window.__egg.actionLog.length)) === 0, 'and no jump appears after resuming (no stale finger)');
    t.ok(errs.length === 0, 'mid-drag pause: no errors', errs);
    await context.close();
  }
}
const jumpSwipe = (cdp) => swipe(cdp, { x: 300, y: 330 }, { x: 300, y: 220 }, { steps: 6, stepMs: 8 });

/* ═════════════════════════════════ noscroll: every screen, every gesture ═════════════════════════════════ */
async function noscroll(browser, server) {
  console.log('\n-- noscroll: swipes from every edge, pinch, double-tap, long-press on every screen');
  const W = 844, H = 390;
  for (const name of ['title', 'title+help', 'title+confirm', 'playing', 'paused', 'pause+journal', 'dead', 'finish']) {
    const def = STATES[name];
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: def.needsSave ? seedSave(BACKGROUND_SAVE) : undefined });
    try {
      await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
      await def.go(page, cdp);
      const vv = () => page.evaluate(() => ({ scale: visualViewport.scale, left: visualViewport.offsetLeft, top: visualViewport.offsetTop, sx: scrollX, sy: scrollY, docs: [document.scrollingElement.scrollTop, document.scrollingElement.scrollLeft, document.body.scrollTop], c: (() => { const r = document.getElementById('game').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })() }));
      const m0 = await compact(page);
      const dirs = [[{ x: W / 2, y: 4 }, { x: W / 2, y: H - 4 }], [{ x: W / 2, y: H - 4 }, { x: W / 2, y: 4 }], [{ x: 4, y: H / 2 }, { x: W - 4, y: H / 2 }], [{ x: W - 4, y: H / 2 }, { x: 4, y: H / 2 }], [{ x: 3, y: 3 }, { x: W - 3, y: H - 3 }]];
      for (const [a, b] of dirs) await swipe(cdp, a, b, { steps: 10, stepMs: 8 });
      // pinch out, then a double tap and a long press on bare scrim / bare world (never on a button), then the wheel
      await touchStart(cdp, [{ x: 400, y: 190, id: 0 }, { x: 440, y: 190, id: 1 }]);
      for (let i = 1; i <= 10; i++) { await touchMove(cdp, [{ x: 400 - i * 25, y: 190, id: 0 }, { x: 440 + i * 25, y: 190, id: 1 }]); await sleep(8); }
      await touchEnd(cdp);
      await tap(cdp, { x: 8, y: H - 8 }, 20); await sleep(60); await tap(cdp, { x: 10, y: H - 9 }, 20);
      await touchStart(cdp, [{ x: 8, y: H - 8 }]); await sleep(700); await touchEnd(cdp);
      await page.mouse.wheel(0, 400).catch(() => {});
      await sleep(400);
      const v = await vv(), m1 = await compact(page);
      t.ok(v.scale === 1 && v.left === 0 && v.top === 0 && v.sx === 0 && v.sy === 0 && v.docs.every((x) => x === 0) && v.c[0] === 0 && v.c[1] === 0 && v.c[2] === W && v.c[3] === H, `${name}: edge drags, pinch, double-tap, long press and the wheel leave the page unscrolled, unzoomed and the canvas where it was`, v);
      if (def.resumes !== 'playing') t.ok(m1.mode === m0.mode && m1.ui === m0.ui, `${name}: and the screen did not change by itself (${m0.mode}/${m0.ui} -> ${m1.mode}/${m1.ui})`, { m0, m1 });
      t.ok(errs.length === 0, `${name}: no console or page errors`, errs);
    } catch (e) { t.ok(false, `${name}: scenario threw`, String((e && e.stack) || e)); }
    await context.close();
  }
}

/* ═════════════════════════════════ storage: missing, throwing, full ═════════════════════════════════ */
const PLAY_SAVE_WEIRD = { v: 2, journeySeed: 4242, circuit: 7, chapter: 12, flag: 500, eggs: 999999999, score: 999999999, flock: 5, beacons: 6, reached: { circuit: 7, chapter: 12 }, playSeconds: 99999999, savedAt: 1 };

async function storage(browser, server) {
  console.log('\n-- storage: localStorage missing, throwing, full, wiped mid-run, corrupt, extreme');
  // A. localStorage throws a SecurityError on every access (cookies blocked / some private modes)
  {
    const errs = [];
    const init = `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });`;
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init });
    await startPlay(page, cdp);
    const lvl = await page.evaluate(() => { const l = window.__egg.level(); return { cp2: l.checkpoints[2].x }; });
    await page.evaluate((x) => window.__egg.teleport(x - 150), lvl.cp2);
    await waitFor(page, () => window.__egg.state().checkpoint === 2, null, 10000);
    await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 700); await sleep(400);
    await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
    let s = await S(page);
    t.ok(s.checkpoint === 2 && s.mode === 'playing' && s.save && s.save.flag === 2, 'storage blocked: the game plays, saves in memory and Retry returns to the latest flag', { cp: s.checkpoint, save: s.save });
    await openPause(page, cdp);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=sound]'); await tapSelector(page, cdp, '[data-screen=pause] [data-action=tap-to-jump]');
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=title]');
    await waitFor(page, () => window.__egg.state().mode === 'title' && !window.__egg.state().busy, null, 6000); await settle(page);
    const label = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
    t.ok(/Continue/.test(label), 'storage blocked: Main Title still offers Continue (the journey lives in memory for this visit)', label.slice(0, 120));
    await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
    s = await S(page);
    t.ok(s.checkpoint === 2 && s.crashed === false, 'storage blocked: Continue resumes at the same flag', s.checkpoint);
    t.ok(errs.length === 0, 'storage blocked: not one console or page error', errs);
    await context.close();
  }
  // B. the disk fills up during play: setItem starts throwing QuotaExceededError
  {
    const errs = [];
    const init = `const set = Storage.prototype.setItem; window.__full = false; Storage.prototype.setItem = function (k, v) { if (window.__full) throw new DOMException('quota', 'QuotaExceededError'); return set.call(this, k, v); };`;
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init });
    await startPlay(page, cdp);
    const lvl = await page.evaluate(() => { const l = window.__egg.level(); return { cp2: l.checkpoints[2].x, cp3: l.checkpoints[3].x }; });
    await page.evaluate(() => { window.__full = true; });
    await page.evaluate((x) => window.__egg.teleport(x - 150), lvl.cp2);
    await waitFor(page, () => window.__egg.state().checkpoint === 2, null, 10000);
    await page.evaluate(() => window.__egg.flushSave());
    let s = await S(page);
    t.ok(s.save.flag === 2 && s.stored.flag === 0, 'storage full: the checkpoint is kept in memory while the stored copy is stale (nothing thrown)', { save: s.save.flag, stored: s.stored && s.stored.flag });
    await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 700); await sleep(400);
    await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(400);
    s = await S(page);
    t.ok(s.checkpoint === 2, 'storage full: Retry uses the in-memory save (flag 2), not the stale stored one', s.checkpoint);
    await openPause(page, cdp);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=sound]');
    t.ok((await S(page)).audio.muted === true, 'storage full: the Sound switch still works for this visit');
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(300);
    await page.evaluate(() => { window.__full = false; });                                    // space is freed
    await page.evaluate((x) => window.__egg.teleport(x - 150), lvl.cp3);
    await waitFor(page, () => window.__egg.state().checkpoint === 3, null, 10000);
    await page.evaluate(() => window.__egg.flushSave());
    s = await S(page);
    t.ok(s.stored && s.stored.flag === 3, 'storage full: once there is room again the next checkpoint is written', s.stored && s.stored.flag);
    t.ok(errs.length === 0, 'storage full: not one console or page error', errs);
    await context.close();
  }
  // C. site data wiped from under the running game (another tab, "clear browsing data")
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await startPlay(page, cdp);
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 700); await sleep(400);
    await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(400);
    const lvl = await page.evaluate(() => window.__egg.level().checkpoints[1].x);
    await page.evaluate((x) => window.__egg.teleport(x - 150), lvl);
    await waitFor(page, () => window.__egg.state().checkpoint === 1, null, 10000);
    await page.evaluate(() => window.__egg.flushSave());
    const s = await S(page);
    t.ok(s.mode === 'playing' && s.stored && s.stored.flag === 1, 'storage wiped mid-run: Retry still works and the next checkpoint writes a fresh, valid save', s.stored);
    t.ok(errs.length === 0, 'storage wiped: no errors', errs);
    await context.close();
  }
  // D. corrupt values everywhere
  {
    const errs = [];
    const init = `localStorage.setItem('egg-mama-save-v2', '{"v":2,"journeySeed":"x"'); localStorage.setItem('egg-mama-settings-v1', '[1,2,3]'); localStorage.setItem('egg-hero-journey-v1', '{"format":1,"state":{"stage":"nope"}}'); localStorage.setItem('egg-hero-best', 'NaN');`;
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init });
    const label = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
    t.ok(/Play/.test(label) && !/Continue/.test(label), 'corrupt save + settings + legacy data: the title simply offers Play', label.slice(0, 100));
    await startPlay(page, cdp);
    const s = await S(page);
    t.ok(s.mode === 'playing' && s.stored && s.stored.circuit === 1 && s.settings.tapToJump === true && s.settings.muted === false, 'corrupt data: a clean journey and default settings take over', s.stored);
    t.ok(errs.length === 0, 'corrupt data: no errors', errs);
    await context.close();
  }
  // E. an extreme but valid save (circuit 7, last landscape, flag 500, a billion eggs)
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: seedSave(PLAY_SAVE_WEIRD) });
    await startPlay(page, cdp, 1500);
    const s = await S(page);
    const last = await page.evaluate(() => { const l = window.__egg.level(); return { n: l.checkpoints.length, first: l.chapters[12].flag }; });
    t.ok(s.mode === 'playing' && s.circuit === 7 && s.chapter === 12 && s.checkpoint >= last.first && s.checkpoint < last.n && s.flock === 5, `extreme save: Continue opens circuit 7, Beacon Summit, on one of its flags (flag ${s.checkpoint}), flock 5`, s);
    await openPause(page, cdp);
    const txt = await page.evaluate(() => document.querySelector('[data-screen=pause]').innerText.replace(/\s+/g, ' '));
    t.ok(/Landscape 13 of 13/i.test(txt) && /Circuit 7/i.test(txt), 'extreme save: the pause menu reads it back sensibly', txt.slice(0, 160));
    const box = await page.evaluate(() => { const c = document.querySelector('[data-screen=pause] .card').getBoundingClientRect(); return { l: c.left, r: c.right, t: c.top, b: c.bottom, iw: innerWidth, ih: innerHeight }; });
    t.ok(box.l >= 0 && box.r <= box.iw && box.t >= 0 && box.b <= box.ih, 'extreme save: huge numbers do not break the pause card', box);
    t.ok(errs.length === 0, 'extreme save: no errors', errs);
    await context.close();
  }
}

/* ═════════════════════════════════ offline: install, warm, cut the network, play everything ═════════════════════════════════ */
const cacheKeys = (page) => page.evaluate(async () => { const k = (await caches.keys()).find((n) => n.startsWith('egg-mama-')); if (!k) return []; const c = await caches.open(k); return (await c.keys()).map((r) => new URL(r.url).pathname); });

async function offline(browser, server) {
  console.log('\n-- offline: service worker installed, warmed by play, then the network is cut');
  const errs = [], failed = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, search: '?sw' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await startPlay(page, cdp);
  // the real warm path: main.mjs asks the worker to fetch the other paintings WARM_DELAY after play starts
  let n = 0;
  for (let i = 0; i < 160 && n < 13; i++) { await sleep(250); n = (await cacheKeys(page)).filter((p) => p.includes('/assets/')).length; }
  t.ok(n === 13, `the game itself warms all 13 paintings into the offline copy after play starts (${n} of 13)`);
  const files = await cacheKeys(page);
  t.ok(files.some((f) => f.endsWith('/js/main.mjs')) && files.some((f) => f.endsWith('/js/levels/beats5.mjs')) && files.some((f) => f.endsWith('/icons/icon-512.png')), `all code, icons and the manifest are in the copy (${files.length} entries)`);
  await page.evaluate(() => window.__egg.flushSave());
  await context.setOffline(true);
  page.on('requestfailed', (r) => failed.push(r.url()));
  await page.reload();
  await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
  let s = await S(page);
  t.ok(s.mode === 'title' && s.ui === 'title', 'offline: a reload opens the game on the title');
  const label = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
  t.ok(/Continue/.test(label), 'offline: Continue is there (the save is local)', label.slice(0, 100));
  await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(600);
  await page.evaluate(() => window.__egg.adaptive().enabled = false);
  // visit every landscape: its painting must decode from the copy, the right song must play, no request may fail
  const missing = [], wrongSong = [];
  const picked = [];
  for (let k = 0; k < CHAPTER_COUNT_(); k++) {
    await page.evaluate((i) => { const l = window.__egg.level(); window.__egg.teleport(l.chapters[i].x0 + 500); }, k);
    const ok = await page.waitForFunction((i) => { const r = window.__egg.renderer; return !!r.paintings.get(i) && r.stats.paintingMissing === 0; }, k, { timeout: 8000, polling: 100 }).then(() => true, () => false);
    if (!ok) missing.push(k);
    await sleep(700);
    const song = await page.evaluate(() => window.__egg.state().audio.song);
    if (k === 0 || k === 6 || k === 8 || k === 12) { picked.push(k); await shot(page, `offline-landscape-${k + 1}`); }
    if (!song) wrongSong.push([k, song]);
    t.ok(true, `landscape ${k + 1}: painting ${ok ? 'decoded' : 'MISSING'}, song "${song}"`);
  }
  t.ok(missing.length === 0, `offline: all 13 paintings load from the copy (missing: ${missing.join(', ') || 'none'})`);
  t.ok(wrongSong.length === 0, 'offline: every landscape plays its song (the music is synthesised, nothing to download)', wrongSong);
  s = await S(page);
  t.ok(s.audio.ctx === 'running' && s.audio.scheduler === true, 'offline: audio runs', s.audio);
  // checkpoint save, death and Retry all work with no network
  await page.evaluate(() => { const l = window.__egg.level(); window.__egg.teleport(l.checkpoints[20].x - 150); });
  await waitFor(page, () => window.__egg.state().checkpoint === 20, null, 10000);
  await page.evaluate(() => window.__egg.flushSave());
  s = await S(page);
  t.ok(s.stored && s.stored.flag >= 0 && s.checkpoint === 20, 'offline: a checkpoint is saved', s.stored);
  await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 700); await sleep(400);
  await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
  t.ok((await S(page)).checkpoint === 20, 'offline: death and Retry checkpoint work');
  // Keep Going (a whole new circuit) offline too
  await page.evaluate(() => window.__egg.forceBeacon()); await waitFor(page, () => window.__egg.state().ui === 'finish', null, 15000); await sleep(500);
  await tapSelector(page, cdp, '[data-screen=finish] [data-action=keep-going]'); await waitFor(page, () => window.__egg.state().circuit === 2 && window.__egg.state().mode === 'playing', null, 15000);
  t.ok((await S(page)).circuit === 2, 'offline: the beacon and Keep Going (circuit 2) work');
  t.ok(failed.length === 0, 'offline: not one request failed during the whole visit', failed);
  await context.setOffline(false);
  t.ok(errs.length === 0, 'offline: no console or page errors', errs);
  await context.close();
}
const CHAPTER_COUNT_ = () => 13;

/* ═════════════════════════════════ update: a new version arrives while the game is open ═════════════════════════════════ */
async function update(browser) {
  console.log('\n-- update: edit a file + tools/sync-sw.mjs while a game is running');
  const { precacheList, rewrite } = await import('../../tools/sync-sw.mjs');
  const copy = fs.mkdtempSync(path.join(process.env.GAME_SHOTS || process.env.SHELL_SHOTS || os.tmpdir(), 'swcopy-'));
  fs.cpSync(DOCS, copy, { recursive: true });
  const walk = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));
  const swp = path.join(copy, 'sw.js'), idx = path.join(copy, 'index.html');
  const sync = () => fs.writeFileSync(swp, rewrite(fs.readFileSync(swp, 'utf8'), precacheList(walk(copy)), (rel) => fs.readFileSync(path.join(copy, rel))));
  sync();
  const port = 20000 + Math.floor(Math.random() * 40000);
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', copy], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch { /* not yet */ } await sleep(100); }
    const errs = [];
    const { page, cdp, context } = await boot(browser, { url: `http://127.0.0.1:${port}/` }, DEVICES.iphone13, { errors: errs, search: '?sw' });
    await page.evaluate(async () => { const c = await caches.open('other-game-v7'); await c.put('/x', new Response('hi')); });
    await page.evaluate(() => navigator.serviceWorker.ready); await sleep(800);
    await startPlay(page, cdp);
    await page.evaluate(() => { const g = window.__egg.game(); g.eggs = 33; g.score = 777; g.flock = 2; });
    const cp = await page.evaluate(() => window.__egg.level().checkpoints[3].x);
    await page.evaluate((x) => window.__egg.teleport(x - 150), cp);
    await waitFor(page, () => window.__egg.state().checkpoint === 3, null, 10000);
    await page.evaluate(() => window.__egg.flushSave());
    const v1 = (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('egg-mama-'));
    t.ok(v1.length === 1, 'update: version 1 is installed (one fingerprinted cache)', v1);
    // ship version 2: change the page and a module, run the release step, let the browser look for an update (the game keeps running)
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<title>Egg Mama</title>', '<title>Egg Mama v2</title>'));
    const tun = path.join(copy, 'js', 'tuning.mjs');
    fs.writeFileSync(tun, fs.readFileSync(tun, 'utf8') + '\n// v2\n');
    sync();
    const xBefore = (await S(page)).mama.x;
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await sleep(2500);
    const keys = await page.evaluate(() => caches.keys());
    t.ok(keys.filter((k) => k.startsWith('egg-mama-')).length === 1 && !keys.includes(v1[0]) && keys.includes('other-game-v7'), 'update: the new version replaced the old copy, and another game\'s cache on the address survived', keys);
    const mid = await S(page);
    t.ok(mid.mode === 'playing' && mid.mama.x > xBefore && mid.errors === 0, 'update: the game that was running is not interrupted (still playing, no frame errors)', { mode: mid.mode, errors: mid.errors });
    // the running (old) page keeps working when the worker swapped underneath it: a landscape painting it had not loaded yet still comes
    await page.evaluate(() => { const l = window.__egg.level(); window.__egg.teleport(l.chapters[8].x0 + 400); });
    const ok = await page.waitForFunction(() => !!window.__egg.renderer.paintings.get(8), null, { timeout: 8000 }).then(() => true, () => false);
    t.ok(ok, 'update: the old page still gets a painting it had not loaded yet (served by the new worker)');
    await page.evaluate(() => window.__egg.flushSave());
    // next visit: the new version, and the progress is exactly where it was
    await page.reload(); await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
    t.ok((await page.title()) === 'Egg Mama v2', 'update: the next load runs the new version');
    t.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'update: ...served by the worker');
    const st = await S(page);
    t.ok(st.save && st.save.eggs >= 33 && st.save.flock === 2, 'update: the journey (eggs, flock, flag) survived the update', st.save);
    await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
    t.ok((await S(page)).mode === 'playing', 'update: Continue plays on the new version');
    t.ok(errs.length === 0, 'update: no console or page errors', errs);
    await context.close();
  } finally { srv.kill(); fs.rmSync(copy, { recursive: true, force: true }); }
}

/* ═════════════════════════════════ insets: real env(safe-area-inset-*) ═════════════════════════════════ */
async function insets(browser, server) {
  console.log('\n-- insets: Emulation.setSafeAreaInsetsOverride (a notch, a rounded corner, the home indicator)');
  const cases = [
    { dev: DEVICES.iphone13, ins: { top: 0, left: 59, right: 34, bottom: 21 }, tag: 'iPhone 13 (left notch 59, right 34, home bar 21)' },
    { dev: DEVICES.small, ins: { top: 24, left: 47, right: 47, bottom: 21 }, tag: '640x300 (status bar 24, notch 47 both sides, home bar 21)' },
    { dev: DEVICES.pixel7, ins: { top: 0, left: 0, right: 48, bottom: 0 }, tag: 'Pixel 7 (camera cut-out on the right 48)' },
  ];
  for (const { dev, ins, tag } of cases) {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, dev, { errors: errs, init: seedSave(SAVE_SAMPLE) });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: ins });
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await sleep(500);
    const probe = await page.evaluate(() => window.__egg.ui.insets());
    t.ok(probe.top === ins.top && probe.left === ins.left && probe.right === ins.right && probe.bottom === ins.bottom, `${tag}: the game reads the real insets`, probe);
    t.ok(await page.evaluate(([l, r, tp, b]) => { const v = window.__egg.renderer.ins; return v.left === l && v.right === r && v.top === tp && v.bottom === b; }, [ins.left, ins.right, ins.top, ins.bottom]), `${tag}: the renderer was told (egg pill, captions and the respawn veil use them)`);
    const W = dev.viewport.width, H = dev.viewport.height;
    const inside = (name) => page.evaluate(([name, ins, W, H]) => {
      const el = document.querySelector(`.screen[data-screen=${name}]`); if (!el) return null;
      const bad = [];
      for (const b of el.querySelectorAll('button, .card, .logo, h1, h2, .tagline, .lede, .tally')) {
        const r = b.getBoundingClientRect(); if (!r.width || !r.height) continue;
        if (r.left < ins.left - 0.5 || r.right > W - ins.right + 0.5 || r.top < ins.top - 0.5 || r.bottom > H - ins.bottom + 0.5) bad.push(`${b.dataset.action || b.className || b.tagName}@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
      return bad;
    }, [name, ins, W, H]);
    const show = async (name, data) => { await page.evaluate(([n, d]) => { window.__shell.setMode(n === 'title' ? 'title' : n === 'rotate' ? 'rotate' : 'paused'); window.__shell.ui.show(n, d); }, [name, data]); await settle(page, 400); };
    const D = { eggs: 1234, score: 56789, flock: 5, circuit: 12, chapter: 12, progress: 0.97, playSeconds: 99999, save: SAVE_SAMPLE, reached: { circuit: 12, chapter: 12 }, newBest: true };
    for (const name of ['title', 'pause', 'dead', 'finish', 'journal', 'help', 'reset-confirm', 'rotate']) {
      await show(name, name === 'rotate' ? { phase: 'ready' } : D);
      const bad = await inside(name);
      t.ok(bad && bad.length === 0, `${tag}: ${name} keeps every control and card inside the safe area`, bad);
    }
    // the pause button over live play, and a real egg pill + caption (screenshot to look at)
    await page.evaluate(() => { window.__shell.ui.hide(); window.__shell.setMode('title'); window.__shell.startRun(); }); await sleep(900);
    const pb = await page.evaluate(() => { const r = document.getElementById('pause-btn').getBoundingClientRect(); return { l: r.left, r: innerWidth - r.right, t: r.top, w: r.width }; });
    t.ok(pb.r >= ins.right + 4 && pb.l >= ins.left && pb.t >= ins.top + 4 && pb.w >= 48, `${tag}: the pause button sits inside the insets (right gap ${pb.r.toFixed(0)} >= ${ins.right}, top ${pb.t.toFixed(0)} >= ${ins.top}) and is >= 48 px`, pb);
    await page.evaluate(() => { const l = window.__egg.level(); const g = l.pickups.find((p) => p.kind === 'gold'); window.__egg.teleport(g.x - 150); }); await sleep(3600);
    await shot(page, `insets-${dev.viewport.width}x${dev.viewport.height}`);
    // a swipe in the left unsafe strip and the right unsafe strip still works (the play area is the whole screen)
    await page.evaluate(() => { window.__shell.actionLog.length = 0; });
    await swipe(cdp, { x: 4, y: H * 0.7 }, { x: 4, y: H * 0.3 }, { steps: 5, stepMs: 8 });
    await swipe(cdp, { x: W - 4, y: H * 0.7 }, { x: W - 4, y: H * 0.3 }, { steps: 5, stepMs: 8 });
    await sleep(100);
    const log = await page.evaluate(() => window.__shell.actionLog.slice());
    t.ok(log.length === 2 && log.every((a) => a === 'jump'), `${tag}: swipes that start in the notch strips still jump (the whole glass is the play area)`, log);
    const c = await page.evaluate(() => { const r = document.getElementById('game').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    t.ok(c[0] === 0 && c[1] === 0 && c[2] === W && c[3] === H, `${tag}: the canvas still covers the whole screen under the insets`, c);
    t.ok(errs.length === 0, `${tag}: no errors`, errs);
    await context.close();
  }
}

/* ═════════════════════════════════ viewports: 640x300, 4:3 tablet, SE, desktop mouse ═════════════════════════════════ */
async function viewports(browser, server) {
  console.log('\n-- viewports: 640x300, iPad 4:3, iPhone SE, desktop with a mouse, tall portrait');
  const cases = [
    { name: '640x300 phone with toolbars', ctx: { viewport: { width: 640, height: 300 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: 'iPad 4:3 landscape', ctx: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: 'iPhone SE landscape', ctx: { viewport: { width: 568, height: 320 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: 'desktop 1280x720 mouse', ctx: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false } },
    { name: 'ultra-wide 2400x800', ctx: { viewport: { width: 2400, height: 800 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false } },
  ];
  for (const c of cases) {
    const errs = [];
    const context = await browser.newContext(c.ctx);
    const page = await context.newPage();
    page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(server.url + '?debug');
    await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
    const W = c.ctx.viewport.width, H = c.ctx.viewport.height, touch = c.ctx.hasTouch;
    const cdp = touch ? await context.newCDPSession(page) : null;
    const geo = await page.evaluate(() => { const v = window.__egg.renderer.view, cv = document.getElementById('game').getBoundingClientRect(); return { view: v, cv: [cv.width, cv.height], ty: window.__egg.renderer.ty, cw: document.getElementById('game').width, ch: document.getElementById('game').height }; });
    t.ok(geo.cv[0] === W && geo.cv[1] === H, `${c.name}: the canvas fills the viewport`, geo.cv);
    t.ok(geo.view.h >= 360 - 0.5 && geo.view.w >= 560 - 0.5, `${c.name}: the world is at least 360 u tall and 560 u wide on screen (${geo.view.w.toFixed(0)}x${geo.view.h.toFixed(0)} u)`, geo.view);
    t.ok(geo.ch - Math.round(geo.ty) === Math.round(360 * geo.view.scale * geo.view.dpr) || Math.abs(geo.ch - geo.ty - 360 * geo.view.scale * geo.view.dpr) < 2, `${c.name}: the bottom of the world sits on the bottom edge of the screen`, geo);
    // every screen fits
    const fit = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const D = { eggs: 1234, score: 56789, flock: 5, circuit: 12, chapter: 12, progress: 0.97, playSeconds: 99999, save: { v: 2, circuit: 12, chapter: 12, eggs: 1234, score: 56789, flock: 5, reached: { circuit: 12, chapter: 12 } }, reached: { circuit: 12, chapter: 12 }, newBest: true };
      const bad = [];
      for (const name of ['title', 'pause', 'dead', 'finish', 'journal', 'help', 'reset-confirm', 'rotate']) {
        window.__shell.setMode(name === 'title' ? 'title' : name === 'rotate' ? 'rotate' : 'paused'); window.__shell.ui.show(name, name === 'rotate' ? { phase: 'ready' } : D); await sleep(380);
        const el = document.querySelector(`.screen[data-screen=${name}]`);
        for (const b of el.querySelectorAll('button, .card')) {
          const r = b.getBoundingClientRect(); if (!r.width) continue;
          if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5) bad.push(`${name}:${b.dataset.action || b.className}`);
          if (b.tagName === 'BUTTON' && !b.classList.contains('chip-ch') && !b.classList.contains('tab') && (r.height < 43.5 || r.width < 43.5)) bad.push(`${name}:small:${b.dataset.action}:${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        if (document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth) bad.push(`${name}:page scrolls`);
      }
      return bad;
    });
    t.ok(fit.length === 0, `${c.name}: every menu fits, every button is at least 44 px, the page never scrolls`, fit);
    await page.evaluate(() => { window.__shell.ui.hide(); window.__shell.setMode('title'); });
    await page.evaluate(() => window.__shell.startRun()); await sleep(1500);
    // swipe up / push / brake with the pointer this device really has
    const doSwipe = async (a, b) => {
      if (touch) await swipe(cdp, a, b, { steps: 6, stepMs: 8 });
      else { await page.mouse.move(a.x, a.y); await page.mouse.down(); for (let i = 1; i <= 6; i++) { await page.mouse.move(a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6); await sleep(8); } await page.mouse.up(); }
    };
    await page.evaluate(() => { window.__shell.actionLog.length = 0; });
    await doSwipe({ x: W * 0.3, y: H * 0.8 }, { x: W * 0.3, y: H * 0.45 });
    await doSwipe({ x: W * 0.3, y: H * 0.6 }, { x: W * 0.55, y: H * 0.6 });
    await doSwipe({ x: W * 0.7, y: H * 0.6 }, { x: W * 0.4, y: H * 0.6 });
    await sleep(120);
    const log = await page.evaluate(() => window.__shell.actionLog.slice());
    t.ok(JSON.stringify(log) === '["jump","push","brake"]', `${c.name}: swipe up / right / left (${touch ? 'touch' : 'mouse drag'}) = jump / push / brake`, log);
    const pb = await page.evaluate(() => { const r = document.getElementById('pause-btn').getBoundingClientRect(); return { r: innerWidth - r.right, t: r.top, w: r.width, vis: !document.getElementById('pause-btn').hidden }; });
    t.ok(pb.vis && pb.w >= 48 && pb.r < 30 && pb.t < 30, `${c.name}: the pause button is in the top-right corner`, pb);
    await shot(page, `viewport-${W}x${H}`);
    t.ok(scrollIsZero(await scrollState(page)), `${c.name}: page at (0,0)`);
    t.ok(errs.length === 0, `${c.name}: no errors`, errs);
    await context.close();
  }
  // a desktop window dragged around: thirty random sizes (some tiny, some ultra-wide, some upright) during play
  {
    const errs = [];
    const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
    await startPlay(page, cdp, 700);
    let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const sizes = [[120, 80], [3000, 400], [320, 180], [700, 700], [641, 300], [1920, 1080], [200, 900]];
    for (let i = 0; i < 30; i++) {
      const [w, h] = i < sizes.length ? sizes[i] : [Math.round(200 + rnd() * 1800), Math.round(100 + rnd() * 900)];
      await page.setViewportSize({ width: w, height: h });
      await sleep(30 + (i % 4) * 40);
    }
    await page.setViewportSize({ width: 1000, height: 500 }); await sleep(900);
    let s = await compact(page);
    const cv = await page.evaluate(() => { const r = document.getElementById('game').getBoundingClientRect(); return [r.width, r.height, window.__egg.state().canvas]; });
    t.ok(cv[0] === 1000 && cv[1] === 500, 'a window resized 30 times to random sizes: the canvas ends up equal to the viewport', cv);
    t.ok(s.crashed === false && s.errs === 0, 'resize storm: no frame errors', s);
    if (s.mode === 'rotate') { await tapSelector(page, cdp, '[data-screen=rotate] [data-action=rotate-continue]'); await sleep(500); s = await compact(page); }
    t.ok(s.mode === 'playing' || s.mode === 'rotate', `resize storm: the run is intact (${s.mode}, x ${s.x})`, s);
    t.ok(errs.length === 0, 'resize storm: no console or page errors', errs);
    await context.close();
  }
  // tall portrait phone: only the rotate prompt, which fits, and the world is not drawn over it
  {
    const errs = [];
    const { page, context } = await boot(browser, server, DEVICES.portrait, { errors: errs });
    const s = await S(page);
    const fit = await page.evaluate(() => { const b = document.querySelector('[data-screen=rotate]').getBoundingClientRect(); const btns = [...document.querySelectorAll('[data-screen=rotate] button')].filter((x) => x.offsetParent); return { ok: b.width === innerWidth && b.height === innerHeight, scrolls: document.documentElement.scrollHeight > innerHeight, btns: btns.length }; });
    t.ok(s.ui === 'rotate' && fit.ok && !fit.scrolls, 'portrait 390x844: the rotate prompt covers the screen and nothing scrolls', { ui: s.ui, fit });
    await shot(page, 'viewport-portrait');
    await page.setViewportSize({ width: 768, height: 1024 }); await settle(page, 500);
    t.ok((await S(page)).ui === 'rotate', 'portrait tablet 768x1024: the rotate prompt too');
    t.ok(errs.length === 0, 'portrait: no errors', errs);
    await context.close();
  }
}

/* ═════════════════════════════════ keyboard: a whole run with no pointer ═════════════════════════════════ */
async function keyboard(browser, server) {
  console.log('\n-- keyboard: start, play, pause, mute, die, retry, keep going with the keyboard alone');
  const errs = [];
  const { page, context } = await boot(browser, server, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }, { errors: errs });
  const key = async (k, ms = 60) => { await page.keyboard.press(k); await sleep(ms); };
  const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset && a.dataset.action) || a.id || a.tagName : null; });
  t.ok((await active()) === 'play', 'keyboard: the title puts focus on Play');
  await key('Enter', 500);
  await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(900);
  await page.evaluate(() => { window.__egg.actionLog.length = 0; });
  await key('Space'); await key('ArrowUp'); await key('w');
  const log1 = await page.evaluate(() => window.__egg.actionLog.slice());
  t.ok(log1.length === 3 && log1.every((a) => a === 'jump'), 'keyboard: Space, Up and W each jump once', log1);
  await sleep(1200);
  const v0 = (await S(page)).mama.vx;
  await page.keyboard.down('ArrowRight'); await sleep(500);
  const pushed = (await S(page)).mama.vx;
  await page.keyboard.up('ArrowRight'); await sleep(900);
  await page.keyboard.down('a'); await sleep(500);
  const braked = (await S(page)).mama.vx;
  await page.keyboard.up('a'); await sleep(1500);
  t.ok(pushed > v0 + 15 && braked < 30, `keyboard: held Right pushes (vx ${v0.toFixed(0)} -> ${pushed.toFixed(0)}), held A brakes (${braked.toFixed(0)})`);
  await key('p', 450);
  t.ok((await S(page)).ui === 'pause' && (await active()) === 'resume', 'keyboard: P pauses and focus lands on Resume');
  await key('Enter', 450);
  t.ok((await S(page)).mode === 'playing' && (await active()) !== 'resume', 'keyboard: Enter on Resume plays again and the focus leaves the hidden menu');
  await page.evaluate(() => { window.__egg.actionLog.length = 0; });
  await key('Space');
  t.ok((await page.evaluate(() => window.__egg.actionLog.slice())).join() === 'jump', 'keyboard: Space is a jump again right after resuming (no stale focus eats it)');
  await key('m', 150);
  t.ok((await S(page)).audio.muted === true, 'keyboard: M mutes');
  await key('m', 150);
  await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 700);
  t.ok((await active()) === 'retry', 'keyboard: the dead screen focuses Retry checkpoint');
  await key('Enter', 500);
  await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
  t.ok((await S(page)).status === 'running', 'keyboard: Enter retries');
  await page.evaluate(() => window.__egg.skipToFinish()); await settle(page, 700);
  t.ok((await active()) === 'keep-going', 'keyboard: the beacon screen focuses Keep going');
  await key('Enter', 600);
  await waitFor(page, () => window.__egg.state().circuit === 2 && window.__egg.state().mode === 'playing', null, 10000);
  t.ok(true, 'keyboard: Enter keeps going into circuit 2');
  await key('Escape', 450);
  await key('Tab', 100); await key('Tab', 100); await key('Tab', 100);
  await key('Escape', 450);
  t.ok((await S(page)).mode === 'playing', 'keyboard: Esc pauses and Esc resumes');
  t.ok(errs.length === 0, 'keyboard run: no errors', errs);
  await context.close();
}

/* ═════════════════════════════════ deploy: GitHub Pages ═════════════════════════════════ */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
const walkDocs = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDocs(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));

async function deploy(browser) {
  console.log('\n-- deploy: GitHub Pages (static files under /egg-mama/, case-sensitive, nothing but the origin)');
  // ── static analysis of everything that ships ──
  const files = walkDocs(DOCS);
  t.ok(fs.existsSync(path.join(DOCS, '.nojekyll')), 'docs/.nojekyll exists (GitHub Pages serves the files as they are, no Jekyll pass)');
  t.ok(fs.existsSync(path.join(DOCS, 'index.html')), 'docs/index.html is the entry page');
  const odd = files.filter((f) => !/^[A-Za-z0-9._\-\/]+$/.test(f) || /\/\./.test(f) && !f.endsWith('.nojekyll'));
  t.ok(odd.length === 0, 'file names are plain (no spaces, no odd characters, no hidden files other than .nojekyll)', odd);
  const code = files.filter((f) => /\.(mjs|js)$/.test(f));
  const badImports = [], nodeish = [], absolute = [];
  for (const f of code) {
    const src = fs.readFileSync(path.join(DOCS, f), 'utf8');
    for (const m of src.matchAll(/(?:^|[;\s}])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)) {
      const spec = m[1] || m[2] || m[3];
      if (!/^\.{1,2}\//.test(spec)) badImports.push(`${f}: ${spec}`);
    }
    if (/\brequire\s*\(|\bprocess\.(env|argv|exit|cwd)|\bfrom\s+['"]node:|\b__dirname\b|\bBuffer\.from\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) nodeish.push(f);
    const stripped = src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of stripped.matchAll(/['"`](https?:\/\/[^'"`\s]+|\/\/[a-z0-9.-]+\.[a-z]{2,}[^'"`\s]*)['"`]/gi)) if (!/^https?:\/\/www\.w3\.org\//.test(m[1])) absolute.push(`${f}: ${m[1]}`);
    for (const m of stripped.matchAll(/(?:fetch|new URL|new Request|new Image\(\)\.src\s*=|\.register|importScripts)\s*\(?\s*['"`](\/[^'"`]*)['"`]/g)) absolute.push(`${f}: ${m[1]}`);
  }
  t.ok(badImports.length === 0, `every import in docs/js is a relative path (${code.length} modules scanned)`, badImports);
  t.ok(nodeish.length === 0, 'nothing node-only (require, process, node: imports, Buffer) ships in docs/', nodeish);
  t.ok(absolute.length === 0, 'no absolute or off-origin URL in any script (no CDN, no analytics, no root-relative fetch)', absolute);
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]);
  const css = fs.readFileSync(path.join(DOCS, 'style.css'), 'utf8');
  const cssUrls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.webmanifest'), 'utf8'));
  const mRefs = [manifest.start_url, manifest.scope, manifest.id, ...manifest.icons.map((i) => i.src)];
  const abs = [...refs, ...cssUrls, ...mRefs].filter((u) => /^(\/|https?:|\/\/)/.test(u));
  t.ok(abs.length === 0, 'index.html, style.css and the manifest reference only relative paths (start_url, scope, id, icons too)', abs);
  const missing = [...refs, ...cssUrls, ...manifest.icons.map((i) => i.src)].filter((u) => !u.startsWith('data:') && !u.startsWith('#')).map((u) => u.split(/[?#]/)[0]).filter((u) => !fs.existsSync(path.join(DOCS, u)));
  t.ok(missing.length === 0, 'every file index.html, style.css and the manifest point at exists with exactly that spelling (GitHub Pages is case-sensitive)', missing);
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const swFiles = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  t.ok(swFiles.every((f) => f === './' || f.startsWith('./')) && swFiles.every((f) => f === './' || fs.existsSync(path.join(DOCS, f))), `the service worker's file list is relative and every entry exists (${swFiles.length} files)`);
  const total = files.reduce((n, f) => n + fs.statSync(path.join(DOCS, f)).size, 0);
  t.ok(total < 20e6, `docs/ is ${(total / 1e6).toFixed(1)} MB in ${files.length} files (well inside the Pages limits)`);
  // every ./asset the game can ask for exists: all 13 paintings named in chapters.mjs
  const bgs = CHAPTERS_BG();
  t.ok(bgs.every((b) => fs.existsSync(path.join(DOCS, b))), 'all 13 painting paths named in chapters.mjs exist', bgs.filter((b) => !fs.existsSync(path.join(DOCS, b))));

  // ── serve it the way GitHub Pages does: a project site under /egg-mama/, case-sensitive, 404 for everything else ──
  const reqLog = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    reqLog.push(u.pathname);
    if (u.pathname === '/egg-mama') { res.writeHead(301, { Location: '/egg-mama/' }); return res.end(); }
    if (!u.pathname.startsWith('/egg-mama/')) { res.writeHead(404); return res.end('not found'); }
    let rel = decodeURIComponent(u.pathname.slice('/egg-mama/'.length)); if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}/egg-mama/`;
  try {
    const errs = [], warns = [], bad = [], urls = [];
    const context = await browser.newContext(contextOptions(DEVICES.iphone13));
    const page = await context.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); else if (m.type() === 'warning') warns.push(m.text()); });
    context.on('request', (r) => urls.push(r.url()));
    context.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    await page.goto(base + '?sw&debug');                       // a cold cache: a brand-new profile
    await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
    t.ok(true, 'the deployed layout loads: the game is on the title at /egg-mama/');
    await startPlay(page, await context.newCDPSession(page), 400);
    await sleep(1500);
    const manifestOk = await page.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); const j = await r.json(); const icons = await Promise.all(j.icons.map(async (i) => { const x = await fetch(new URL(i.src, document.querySelector('link[rel=manifest]').href)); const b = await createImageBitmap(await x.blob()); return [i.sizes, b.width + 'x' + b.height, x.status]; })); return { status: r.status, start: new URL(j.start_url, document.querySelector('link[rel=manifest]').href).pathname, scope: new URL(j.scope, document.querySelector('link[rel=manifest]').href).pathname, icons }; });
    t.ok(manifestOk.status === 200 && manifestOk.start === '/egg-mama/' && manifestOk.scope === '/egg-mama/' && manifestOk.icons.every(([a, b, c]) => a === b && c === 200), 'the manifest, its start_url / scope (/egg-mama/) and both icons resolve under the project path', manifestOk);
    await page.evaluate(() => navigator.serviceWorker.ready); await sleep(2000);
    const sc = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? r.scope : null; });
    t.ok(sc === base, `the service worker registers with scope ${sc}`);
    const cached = (await cacheKeys(page));
    t.ok(cached.length >= swFiles.length && cached.every((p) => p.startsWith('/egg-mama/')), `the install precached ${cached.length} files, all under /egg-mama/`);
    const origin = new URL(base).origin;
    const foreign = urls.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    t.ok(foreign.length === 0, `all ${urls.length} requests of a cold first visit stay on the origin (no CDN, no font, no analytics)`, foreign);
    const outside = urls.filter((u) => u.startsWith(origin) && !new URL(u).pathname.startsWith('/egg-mama/'));
    t.ok(outside.length === 0, 'nothing is requested outside /egg-mama/ (no /favicon.ico, no root-relative asset)', outside);
    t.ok(bad.length === 0, 'no 404 or error response anywhere in the first visit', bad);
    t.ok(errs.length === 0, 'no console errors on a cold cache first load and a short game', errs);
    t.ok(warns.length === 0, 'no console warnings either', warns);
    // second visit offline from the project path
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }).catch(() => {});
    t.ok(await page.evaluate(() => !!window.__egg && window.__egg.state().worldReady), 'an offline reload of /egg-mama/ opens the game from the copy');
    await context.setOffline(false);
    await context.close();
  } finally { server.close(); }
}
function CHAPTERS_BG() { return CHAPTERS.map((c) => c.bg); }

/* ═════════════════════════════════ main ═════════════════════════════════ */
async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    if (want('orient')) await orient(browser, server);
    if (want('hidden')) await hidden(browser, server);
    if (want('taps')) await taps(browser, server);
    if (want('slow')) await slow(browser, server);
    if (want('cycles')) await cycles(browser, server);
    if (want('reload')) await reload(browser, server);
    if (want('noscroll')) await noscroll(browser, server);
    if (want('storage')) await storage(browser, server);
    if (want('offline')) await offline(browser, server);
    if (want('update')) await update(browser);
    if (want('insets')) await insets(browser, server);
    if (want('viewports')) await viewports(browser, server);
    if (want('keyboard')) await keyboard(browser, server);
    if (want('deploy')) await deploy(browser);
  } catch (e) {
    t.ok(false, 'attack run threw', String(e && e.stack || e));
  } finally {
    await browser.close();
    server.stop();
  }
  const failed = t.done();
  process.exitCode = failed ? 1 : 0;
}
main();
