#!/usr/bin/env node
/*
 * Egg Mama — the whole game, end to end, in a real Chromium (run by hand; NOT part of `node --test`).
 *
 *   node tests/e2e/game-flow.mjs [--quick]       exit code 0 = everything passed
 *   GAME_SHOTS=<dir> to choose where screenshots go (default: <tmp>/egg-mama-shell; never the repo)
 *
 * Real main.mjs, real sim / levelgen / renderer / audio / ui / input, served from docs/ with python3 -m http.server.
 * Touches are real: CDP Input.dispatchTouchEvent, so Input sees pointer events exactly as a phone sends them.
 * The ?debug hooks (window.__egg) are used to read state and to teleport / force the beacon (they step the REAL sim and
 * the real event handling); nothing about the game is mocked.
 *
 *   1. iPhone 13 landscape (844x390 @3): title -> Play -> swipes (jump / push / brake) seen in game.mama -> eggs + first
 *      golden egg -> checkpoint autosave (stored Save) -> deliberate fall -> respawn at the checkpoint -> death with no
 *      duckling / shield -> dead screen -> Retry (same world, saved snapshot) -> Start Over (cancel, then confirm) -> beacon ->
 *      finish -> Keep Going (circuit 2 saved, totals carried) -> reload -> Continue -> Main Title keeps the save.
 *   2. legacy GitHub-Pages save (egg-hero-journey-v1) Continues; 3. mute persists across reload; 4. portrait pauses + rotate
 *      prompt + resume (also from the dead and finish screens); 5. hidden tab pauses and suspends audio; 6. no page scroll /
 *      zoom / overscroll with swipes of every direction; 7. frame-error safety net; 8. no console errors anywhere.
 *   9. a lighter pass at 915x412 and 640x300.
 */
import path from 'node:path';
import {
  chromium, startServer, reporter, boot, settle, shot, swipe, multiSwipe, tap, tapSelector, centerOf, gameState, scrollState, scrollIsZero,
  DEVICES, SHOTS, seedSave,
} from './shell-lib.mjs';

const QUICK = process.argv.includes('--quick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (page) => gameState(page);
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const t = reporter('game flow (real main loop, real touches)');
const errors = [];
const where = (page) => page.evaluate(() => { const s = window.__egg.state(); return { mode: s.mode, ui: s.ui, x: Math.round(s.mama ? s.mama.x : 0), status: s.status }; });

/** Swipes inside the play area (CSS px), away from the pause button in the top-right corner. */
const SW = {
  up: [{ x: 300, y: 330 }, { x: 300, y: 220 }],
  right: [{ x: 180, y: 250 }, { x: 320, y: 250 }],
  left: [{ x: 520, y: 250 }, { x: 380, y: 250 }],
  down: [{ x: 300, y: 150 }, { x: 300, y: 260 }],
};
const doSwipe = (cdp, dir) => swipe(cdp, SW[dir][0], SW[dir][1], { steps: 6, stepMs: 8 });

/* ───────────────────────────────── 1. the whole journey on an iPhone ───────────────────────────────── */
async function journey(browser, server) {
  console.log('\n-- 1. iPhone 13 landscape: a whole journey');
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors });
  await page.evaluate(() => window.__egg.adaptive().enabled = false);     // the dpr safety net has its own test; keep resolution fixed here
  try {
    // ── title ──
    let s = await st(page);
    t.ok(s.mode === 'title' && s.ui === 'title', 'boots to the title', where(page));
    t.ok(s.status === 'ready' && s.circuit === 1 && s.mama.x === 300 || s.mama.x > 0, 'the title shows the live world (Mama at the start, status ready)');
    t.ok(s.canvas.w === 2532 && s.canvas.h === 1170, `canvas is the stage at dpr 3 (${s.canvas.w}x${s.canvas.h})`);
    t.ok(await page.evaluate(() => !!document.querySelector('[data-screen=title] [data-action=play]')), 'a fresh browser offers Play (not Continue)');
    t.ok(await page.evaluate(() => !document.querySelector('[data-screen=title] [data-action=start-over]')), 'no Start Over without a save');
    await shot(page, 'game-01-title');

    // ── Play ──
    await page.evaluate(() => { window.__lvl0 = window.__egg.level(); });
    await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    s = await st(page);
    t.ok(s.mode === 'playing' && s.status === 'running' && s.ui === null, 'Play: playing, sim running, menu gone');
    t.ok(s.stored && s.stored.circuit === 1 && s.stored.chapter === 0 && s.stored.eggs === 0, 'the new journey is stored the moment it is played', s.stored);
    t.ok(await page.evaluate(() => window.__egg.level() === window.__lvl0), 'the title world IS the world that is played (no regeneration)');
    t.ok(await page.evaluate(() => !document.getElementById('pause-btn').hidden), 'the pause button is there');
    await sleep(700);
    const x1 = (await st(page)).mama.x;
    await sleep(400);
    const s2 = await st(page);
    t.ok(s2.mama.x > x1 + 10, `she rolls on her own (x ${x1.toFixed(0)} -> ${s2.mama.x.toFixed(0)})`);
    await shot(page, 'game-02-rolling');

    // ── swipes (real touch) ──
    await sleep(700);                                                        // past the ease-in
    await doSwipe(cdp, 'up');
    let air = false;
    for (let i = 0; i < 12 && !air; i++) { await sleep(25); const m = (await st(page)).mama; air = !m.onGround && m.vy < 0; }
    t.ok(air, 'swipe up: Mama jumps (airborne, vy < 0)');
    await sleep(120);
    await shot(page, 'game-03-jump');
    await waitFor(page, () => window.__egg.state().mama.onGround, null, 3000);
    await sleep(500);
    const base = (await st(page)).mama.vx;
    await doSwipe(cdp, 'right');
    await sleep(450);
    const pushed = await st(page);
    t.ok(pushed.mama.steerDir === 1 && pushed.mama.vx > base + 15, `swipe right: push ahead (vx ${base.toFixed(0)} -> ${pushed.mama.vx.toFixed(0)})`);
    await sleep(1100);                                                       // the steer expires: back to the gentle roll
    const settled = (await st(page)).mama.vx;
    t.ok(Math.abs(settled - 110) < 12, `the roll returns to cruise after the steer (vx ${settled.toFixed(0)})`);
    await doSwipe(cdp, 'left');
    await sleep(500);
    const braked = await st(page);
    t.ok(braked.mama.steerDir === -1 && braked.mama.vx < 30, `swipe left: brake / back up (vx ${braked.mama.vx.toFixed(0)})`);
    await shot(page, 'game-04-brake');
    const log = await page.evaluate(() => window.__egg.actionLog.slice());
    t.ok(['jump', 'push', 'brake'].every((a) => log.includes(a)), `Input classified jump, push and brake (${log.join(',')})`);
    await sleep(1200);

    // ── eggs, the first golden egg ──
    await waitFor(page, () => window.__egg.state().eggs > 0, null, 25000);
    t.ok(true, 'ordinary eggs are collected');
    await waitFor(page, () => window.__egg.state().flock >= 1, null, 25000);
    s = await st(page);
    t.ok(s.flock >= 1 && s.followers >= 1 && s.score >= 50, `the first golden egg hatches a duckling that follows (flock ${s.flock}, score ${s.score})`);
    await shot(page, 'game-05-hatch');

    // ── checkpoint autosave ──
    const lvl = await page.evaluate(() => { const l = window.__egg.level(); return { cp1: l.checkpoints[1].x, cp2: l.checkpoints[2].x, n: l.checkpoints.length }; });
    await page.evaluate((x) => window.__egg.teleport(x - 200), lvl.cp2);
    await waitFor(page, () => window.__egg.state().checkpoint === 2, null, 8000);
    await sleep(300);
    s = await st(page);
    t.ok(s.stored && s.stored.flag === 2 && s.stored.chapter === 0 && s.stored.eggs === s.eggs && s.stored.flock === s.flock, 'checkpoint event autosaves flag, eggs, score and flock to localStorage', s.stored);
    t.ok(s.stored && s.stored.score === s.score && s.stored.playSeconds > 0, `stored score ${s.stored && s.stored.score}, playSeconds ${s.stored && s.stored.playSeconds.toFixed(1)}`);
    await shot(page, 'game-06-checkpoint');
    const saved = s.stored;
    const cpX = lvl.cp2;

    // ── a deliberate fall: respawn at the checkpoint, costing a duckling ──
    const gap = await page.evaluate(() => {
      const g = window.__egg.game(), P = g.platforms.filter((p) => p.kind === 'ground');
      const m = g.mama;
      for (let i = 0; i + 1 < P.length; i++) if (P[i].x + P[i].w > m.x + 300 && P[i + 1].x - (P[i].x + P[i].w) > 20) return { edge: P[i].x + P[i].w, cp: g.level.checkpoints[g.checkpoint].x };
      return null;
    });
    t.ok(!!gap, 'there is a gap ahead to fall into', gap);
    await page.evaluate(() => { const g = window.__egg.game(); g.flock = 2; g.shield = false; });
    await page.evaluate((x) => window.__egg.teleport(x - 90), gap.edge);
    await waitFor(page, () => window.__egg.state().mama.y > 330 || window.__egg.state().flock < 2, null, 8000);
    await sleep(250);
    s = await st(page);
    t.ok(s.flock === 1 && s.status === 'running' && s.mode === 'playing', `a fall with ducklings costs one and carries on (flock ${s.flock}, ${s.status})`);
    t.ok(Math.abs(s.mama.x - gap.cp) < 40 && s.mama.onGround, `...back on safe footing at the latest checkpoint (x ${s.mama.x.toFixed(0)} vs flag ${gap.cp})`);
    await shot(page, 'game-07-respawn');

    // ── death: no duckling, no shield ──
    await page.evaluate(() => { const g = window.__egg.game(); g.flock = 0; g.shield = false; });
    await page.evaluate((x) => window.__egg.teleport(x - 90), gap.edge);
    await waitFor(page, () => window.__egg.state().ui === 'dead', null, 10000);
    s = await st(page);
    t.ok(s.mode === 'dead' && s.renderMode === 'dead', 'a fall with nothing to lose ends the attempt: the dead screen');
    t.ok(s.settings.best.score > 0, `best score recorded (${s.settings.best.score})`);
    t.ok(!!(await page.evaluate(() => document.querySelector('[data-screen=dead] [data-action=retry]'))), 'the dead screen offers Retry checkpoint');
    await shot(page, 'game-08-dead');
    t.ok(s.stored && s.stored.flag === saved.flag && s.stored.eggs === saved.eggs, 'dying does not touch the save', s.stored);

    // ── Retry: instant, same world, the saved snapshot ──
    await sleep(450);                                                          // past the "leftover taps" guard
    const t0 = Date.now();
    await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]');
    await waitFor(page, () => window.__egg.state().mode === 'playing', null, 3000);
    const dt = Date.now() - t0;
    s = await st(page);
    t.ok(s.status === 'running' && s.ui === null, `Retry starts play at once (${dt} ms including the tap)`);
    t.ok(await page.evaluate(() => window.__egg.level() === window.__lvl0), 'Retry keeps the same world object (never regenerated)');
    t.ok(Math.abs(s.mama.x - cpX) < 40 && s.checkpoint === 2, `Retry puts her on the saved flag (x ${s.mama.x.toFixed(0)}, flag ${s.checkpoint})`);
    t.ok(s.eggs === saved.eggs && s.score === saved.score && s.flock === saved.flock, `Retry restores the saved totals (eggs ${s.eggs}, score ${s.score}, flock ${s.flock})`);
    await sleep(1500);
    t.ok((await st(page)).mama.x > s.mama.x + 30, 'and she rolls again (ease-in)');

    // ── pause screen ──
    await tapSelector(page, cdp, '#pause-btn');
    await waitFor(page, () => window.__egg.state().mode === 'paused');
    await settle(page);
    s = await st(page);
    t.ok(s.ui === 'pause' && s.audio.suspended === true, 'the pause button pauses and suspends audio');
    const frozenX = s.mama.x, frozenT = s.t;
    await sleep(600);
    s = await st(page);
    t.ok(s.mama.x === frozenX && s.t === frozenT, 'nothing runs while paused (sim time and position frozen)');
    const txt = await page.evaluate(() => document.querySelector('[data-screen=pause]').innerText.replace(/\s+/g, ' '));
    t.ok(/Landscape 1 of 13/.test(txt) && /Meadow/.test(txt) && /% to the beacon/.test(txt) && /eggs/.test(txt) && /score/.test(txt) && /flock \d\/5/.test(txt), 'the pause screen shows landscape, progress, eggs, score and flock', txt.slice(0, 200));
    await shot(page, 'game-09-pause');
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    s = await st(page);
    t.ok(s.audio.suspended === false && s.ui === null, 'Resume plays again and wakes the audio');
    const tBefore = s.t; await sleep(500);
    t.ok((await st(page)).t > tBefore + 0.3, 'sim time moves again');

    // ── Main Title keeps the save; Start Over: cancel, then confirm ──
    await tapSelector(page, cdp, '#pause-btn');
    await waitFor(page, () => window.__egg.state().ui === 'pause'); await settle(page);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=title]');
    await waitFor(page, () => window.__egg.state().mode === 'title' && window.__egg.state().ui === 'title' && !window.__egg.state().busy, null, 6000);
    await settle(page);
    s = await st(page);
    t.ok(s.stored && s.stored.flag === saved.flag && s.stored.eggs === saved.eggs, 'Main Title keeps the save');
    t.ok(await page.evaluate(() => !!document.querySelector('[data-screen=title] [data-action=continue]')), 'the title now says Continue');
    t.ok(s.mama.x > 0 && Math.abs(s.mama.x - cpX) < 40 && s.status === 'ready', 'the title world waits at the saved flag');
    await shot(page, 'game-10-title-continue');
    const oldSeed = saved.journeySeed;
    await tapSelector(page, cdp, '[data-screen=title] [data-action=start-over]');
    await waitFor(page, () => window.__egg.state().ui === 'reset-confirm'); await settle(page);
    await shot(page, 'game-11-confirm');
    await tapSelector(page, cdp, '[data-screen=reset-confirm] [data-action=cancel-start-over]');
    await waitFor(page, () => window.__egg.state().ui === 'title'); await settle(page);
    s = await st(page);
    t.ok(s.stored && s.stored.journeySeed === oldSeed && s.stored.eggs === saved.eggs && s.stored.flag === saved.flag, 'Cancel preserves the save');
    await tapSelector(page, cdp, '[data-screen=title] [data-action=start-over]');
    await waitFor(page, () => window.__egg.state().ui === 'reset-confirm'); await settle(page);
    await tapSelector(page, cdp, '[data-screen=reset-confirm] [data-action=confirm-start-over]');
    await waitFor(page, () => window.__egg.state().ui === 'title' && !window.__egg.state().busy && window.__egg.state().fade === 0, null, 8000);
    await settle(page);
    s = await st(page);
    t.ok(s.stored && s.stored.journeySeed !== oldSeed && s.stored.eggs === 0 && s.stored.flock === 0 && s.stored.circuit === 1 && s.stored.chapter === 0 && s.stored.flag === 0 && s.stored.score === 0,
      'Confirm starts a new journey: Meadow, zero eggs, zero flock, a new seed', s.stored);
    t.ok(s.eggs === 0 && s.flock === 0 && s.followers === 0 && s.mama.x < 400, 'the world behind the title is the new Meadow with no flock');

    // ── a fresh Meadow run to the beacon ──
    await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    await waitFor(page, () => window.__egg.state().flock >= 1 && window.__egg.state().eggs >= 3, null, 30000);
    s = await st(page);
    const carry = { eggs: s.eggs, score: s.score, flock: s.flock };
    t.ok(carry.flock >= 1, `new journey: first duckling again (eggs ${carry.eggs}, flock ${carry.flock})`);
    const forced = await page.evaluate(() => window.__egg.forceBeacon());
    t.ok(forced, 'forceBeacon teleports Mama just before the summit beacon (the real sim fires the event)');
    await waitFor(page, () => window.__egg.state().status === 'beacon', null, 6000);
    s = await st(page);
    t.ok(s.renderMode === 'finish', 'the beacon starts the celebration (renderer mode finish)');
    t.ok(s.audio.song === 'beacon', 'music: the beacon song');
    t.ok(s.save && s.save.circuit === 2 && s.save.chapter === 0 && s.save.flag === 0 && s.save.beacons === 1, 'the beacon saves the NEXT circuit\'s Meadow with beacons+1', s.save);
    t.ok(s.stored && s.stored.circuit === 2 && s.stored.beacons === 1, 'that save is in localStorage already');
    await sleep(1000);
    await shot(page, 'game-12-celebration');
    await waitFor(page, () => window.__egg.state().ui === 'finish', null, 6000);
    await settle(page);
    s = await st(page);
    const afterBeacon = { eggs: s.eggs, score: s.score, flock: s.flock };
    t.ok(afterBeacon.score >= carry.score + 500 && afterBeacon.eggs >= carry.eggs, `finish screen (score includes the +500 beacon bonus: ${afterBeacon.score})`);
    const ftxt = await page.evaluate(() => document.querySelector('[data-screen=finish]').innerText.replace(/\s+/g, ' '));
    t.ok(/Circuit 1 complete/.test(ftxt) && /beacon is lit/i.test(ftxt), 'finish screen names the circuit just completed', ftxt.slice(0, 120));
    await shot(page, 'game-13-finish');

    // ── Keep Going ──
    await sleep(400);
    await tapSelector(page, cdp, '[data-screen=finish] [data-action=keep-going]');
    await waitFor(page, () => window.__egg.state().mode === 'playing', null, 10000);
    await waitFor(page, () => window.__egg.state().fade === 0, null, 4000);
    s = await st(page);
    t.ok(s.circuit === 2 && s.status === 'running' && s.mama.x < 600, `Keep Going: circuit 2, a fresh Meadow, rolling (x ${s.mama.x.toFixed(0)})`);
    t.ok(s.eggs === afterBeacon.eggs && s.score === afterBeacon.score && s.flock === afterBeacon.flock, `flock, eggs and score carried (${s.eggs}/${s.score}/${s.flock})`);
    t.ok(await page.evaluate(() => window.__egg.level() !== window.__lvl0 && window.__egg.level().circuit === 2), 'a different world (circuit 2)');
    t.ok(s.stored && s.stored.circuit === 2 && s.stored.chapter === 0 && s.stored.flag === 0 && s.stored.eggs === afterBeacon.eggs, 'circuit 2 is saved', s.stored);
    t.ok(s.audio.song === 'meadow', 'music returns to the Meadow song');
    await sleep(1200);
    await shot(page, 'game-14-circuit2');

    // ── reload: Continue opens the saved flag ──
    await page.reload();
    await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 });
    await page.evaluate(() => window.__egg.adaptive().enabled = false);
    await settle(page);
    s = await st(page);
    t.ok(s.ui === 'title' && s.circuit === 2 && s.eggs === afterBeacon.eggs && s.flock === afterBeacon.flock, 'after a reload the title world is circuit 2 with the saved flock');
    const ttxt = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
    t.ok(/Continue/.test(ttxt) && /circuit 2/.test(ttxt), 'Continue names circuit 2', ttxt.slice(0, 160));
    await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    s = await st(page);
    t.ok(s.circuit === 2 && s.checkpoint === 0 && s.mama.x < 600 && s.eggs === afterBeacon.eggs, 'Continue opens at the saved flag (circuit 2, the Meadow start)');
    await sleep(500);
    await tapSelector(page, cdp, '#pause-btn');
    await waitFor(page, () => window.__egg.state().ui === 'pause'); await settle(page);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=title]');
    await waitFor(page, () => window.__egg.state().mode === 'title' && !window.__egg.state().busy, null, 6000);
    s = await st(page);
    t.ok(s.stored && s.stored.circuit === 2 && s.stored.eggs === afterBeacon.eggs, 'Main Title keeps the save');

    // ── the same flow must not have produced a single scroll ──
    const sc = await scrollState(page);
    t.ok(scrollIsZero(sc) && sc.vvScale === 1, 'the page never scrolled or zoomed during the whole journey', sc);
  } finally { await context.close(); }
}

/* ───────────────────────────────── 2. legacy GitHub Pages save ───────────────────────────────── */
async function legacy(browser, server) {
  console.log('\n-- 2. legacy save (egg-hero-journey-v1) continues');
  const legacy = { format: 1, state: { stage: 14, generatedStage: 14, ducklings: 4, collected: 120, points: 3400, beaconsLit: 1, over: false, platforms: [], eggs: [], enemies: [], objects: [] } };
  const init = `localStorage.setItem('egg-hero-journey-v1', ${JSON.stringify(JSON.stringify(legacy))}); localStorage.setItem('egg-hero-sound','off'); localStorage.setItem('egg-hero-best','777');`;
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { init, errors });
  try {
    await page.evaluate(() => window.__egg.adaptive().enabled = false);
    let s = await st(page);
    const txt = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
    t.ok(/Continue/.test(txt) && /Clover Mill/.test(txt) && /circuit 2/.test(txt), 'the old browser save shows as Continue · Clover Mill · circuit 2', txt.slice(0, 200));
    t.ok(s.circuit === 2 && s.eggs === 120 && s.score === 3400 && s.flock === 4 && s.followers === 4, 'the world behind the title carries the old totals (120 eggs, 3400 points, 4 ducklings)');
    t.ok(s.stored && s.stored.v === 2 && s.stored.beacons === 1 && s.stored.chapter === 1 && s.stored.circuit === 2, 'it was converted to a v2 save', s.stored);
    t.ok(s.settings.muted === true && s.settings.best.score === 777, 'the old mute and best score came along');
    t.ok(s.audio.muted === true, 'audio starts muted');
    await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    s = await st(page);
    t.ok(s.status === 'running' && s.chapter === 1 && s.mama.x > 20000, `play starts in Clover Mill at its first flag (x ${s.mama.x.toFixed(0)})`);
    const cap = await page.evaluate(() => { const c = window.__egg.renderer.fx.cap; return c && c.live ? c.title : ''; });
    t.ok(/Clover Mill/.test(cap), `the landscape is announced (${cap})`);
    await sleep(900);
    await shot(page, 'game-15-legacy-cloverMill');
    t.ok((await st(page)).mama.x > s.mama.x, 'and she rolls');
  } finally { await context.close(); }
}

/* ───────────────────────────────── 3. mute persists ───────────────────────────────── */
async function mute(browser, server) {
  console.log('\n-- 3. mute persists across reloads');
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors });
  try {
    await tapSelector(page, cdp, '[data-screen=title] [data-action=sound]');
    await sleep(150);
    let s = await st(page);
    t.ok(s.audio.muted === true && s.settings.muted === true, 'the Sound switch mutes the audio engine synchronously and persists');
    t.ok(await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked')) === 'false', 'the switch shows off');
    t.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('egg-mama-settings-v1')).muted === true), 'stored in egg-mama-settings-v1');
    await page.reload();
    await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 });
    await settle(page);
    s = await st(page);
    t.ok(s.audio.muted === true && s.settings.muted === true, 'muted after a reload');
    t.ok(await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked')) === 'false', 'the switch still shows off');
    await tapSelector(page, cdp, '[data-screen=title] [data-action=sound]');
    await sleep(150);
    s = await st(page);
    t.ok(s.audio.muted === false && s.settings.muted === false, 'unmute works again');
    // keyboard M
    await page.keyboard.press('m');
    await sleep(100);
    t.ok((await st(page)).audio.muted === true, 'the M key mutes too');
  } finally { await context.close(); }
}

/* ───────────────────────────────── 4. rotate ───────────────────────────────── */
async function rotate(browser, server) {
  console.log('\n-- 4. portrait pauses; the rotate prompt; resume');
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors });
  try {
    await page.evaluate(() => window.__egg.adaptive().enabled = false);
    await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    await waitFor(page, () => window.__egg.state().eggs >= 1, null, 20000);
    await sleep(500);
    let before = await st(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(page, () => window.__egg.state().mode === 'rotate', null, 5000);
    await settle(page);
    let s = await st(page);
    t.ok(s.ui === 'rotate' && await page.evaluate(() => window.__shell.ui.el('rotate').dataset.phase) === 'prompt', 'turned upright: the rotate prompt appears');
    t.ok(s.audio.suspended === true, 'audio suspended during the interruption');
    await shot(page, 'game-16-rotate-prompt');
    const frozen = s.t; await sleep(500);
    t.ok((await st(page)).t === frozen, 'the run is frozen while upright');
    await page.setViewportSize({ width: 844, height: 390 });
    await waitFor(page, () => window.__shell.ui.current === 'rotate' && window.__shell.ui.el('rotate').dataset.phase === 'ready', null, 5000);
    await settle(page);
    s = await st(page);
    t.ok(s.mode === 'rotate', 'landscape again: still paused, "Tap to continue" is up (the player decides)');
    await shot(page, 'game-17-rotate-ready');
    await tapSelector(page, cdp, '[data-screen=rotate] [data-action=rotate-continue]');
    await waitFor(page, () => window.__egg.state().mode === 'playing', null, 3000);
    s = await st(page);
    t.ok(s.eggs === before.eggs && s.flock === before.flock && Math.abs(s.mama.x - before.mama.x) < 40, `same run resumes: position, eggs and flock preserved (x ${before.mama.x.toFixed(0)} -> ${s.mama.x.toFixed(0)})`);
    t.ok(s.audio.suspended === false, 'audio resumed');
    await sleep(1500);
    t.ok((await st(page)).mama.x > s.mama.x + 30, 'and she rolls (ease-in)');

    // rotate twice, from the pause screen: the pause screen comes back
    await tapSelector(page, cdp, '#pause-btn');
    await waitFor(page, () => window.__egg.state().ui === 'pause'); await settle(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(page, () => window.__egg.state().mode === 'rotate', null, 5000);
    await page.setViewportSize({ width: 844, height: 390 });
    await waitFor(page, () => window.__egg.state().mode === 'paused' && window.__egg.state().ui === 'pause', null, 5000);
    t.ok(true, 'rotating away from the pause screen and back returns to the pause screen');

    // ...and from the dead screen
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    await page.evaluate(() => window.__egg.forceDead());
    await waitFor(page, () => window.__egg.state().ui === 'dead', null, 8000);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(page, () => window.__egg.state().mode === 'rotate', null, 5000);
    await page.setViewportSize({ width: 844, height: 390 });
    await waitFor(page, () => window.__egg.state().mode === 'dead' && window.__egg.state().ui === 'dead', null, 5000);
    t.ok(true, 'rotating during the dead screen puts the dead screen back (not the title)');
    await sleep(450);
    await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');

    // ...and from the finish screen
    await page.evaluate(() => window.__egg.forceBeacon());
    await waitFor(page, () => window.__egg.state().ui === 'finish', null, 10000);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(page, () => window.__egg.state().mode === 'rotate', null, 5000);
    await page.setViewportSize({ width: 844, height: 390 });
    await waitFor(page, () => window.__egg.state().mode === 'finish' && window.__egg.state().ui === 'finish', null, 5000);
    t.ok(true, 'rotating during the finish screen puts the finish screen back');

    // ...and a phone that STARTS upright
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 });
    await settle(page);
    s = await st(page);
    t.ok(s.mode === 'rotate' && s.ui === 'rotate', 'a phone that opens upright gets the rotate prompt');
    await page.setViewportSize({ width: 844, height: 390 });
    await waitFor(page, () => window.__egg.state().mode === 'title' && window.__egg.state().ui === 'title', null, 5000);
    t.ok(true, 'turning it sideways brings the title');
  } finally { await context.close(); }
}

/* ───────────────────────────────── 5. hidden tab ───────────────────────────────── */
async function hidden(browser, server) {
  console.log('\n-- 5. hidden tab pauses and suspends the audio');
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors });
  try {
    await page.evaluate(() => window.__egg.adaptive().enabled = false);
    await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    await sleep(600);
    let s = await st(page);
    t.ok(s.audio.ctx === 'running' && s.audio.running === true, `audio is running while playing (context ${s.audio.ctx}, song ${s.audio.song})`);
    t.ok(s.audio.scheduler === true, 'exactly one music scheduler is running');
    const hide = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const show = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await hide();
    await sleep(400);
    s = await st(page);
    t.ok(s.mode === 'paused' && s.ui === 'pause', 'visibilitychange hidden: the game pauses (pause screen is up when she comes back)');
    t.ok(s.audio.running === false && s.audio.scheduler === false && s.audio.ctx === 'suspended', `...and the audio context is suspended, no scheduler (ctx ${s.audio.ctx})`);
    const x = s.mama.x;
    await show();
    await sleep(2200);                                                     // time away must not be caught up, and nothing runs while paused
    s = await st(page);
    t.ok(s.mode === 'paused' && Math.abs(s.mama.x - x) < 1, 'coming back leaves it paused at the same spot (the hidden time is not caught up)');
    t.ok(s.audio.running === false, 'music waits for the Resume tap');
    await settle(page);
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    await sleep(500);
    s = await st(page);
    t.ok(s.audio.running === true && s.audio.scheduler === true && s.audio.players <= 2, `Resume starts ONE music stream (players ${s.audio.players}, ctx ${s.audio.ctx})`);
    // pagehide
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await sleep(300);
    s = await st(page);
    t.ok(s.mode === 'paused' && s.audio.running === false, 'pagehide pauses too');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    // blur
    await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(200);
    t.ok((await st(page)).mode === 'paused', 'window blur pauses');
    // keyboard P / Esc
    await page.keyboard.press('p');
    await sleep(150);
    t.ok((await st(page)).mode === 'playing', 'P resumes from the pause screen');
    await page.keyboard.press('Escape');
    await sleep(150);
    t.ok((await st(page)).mode === 'paused', 'Esc pauses');
    await page.keyboard.press('Escape');
    await sleep(150);
    t.ok((await st(page)).mode === 'playing', 'Esc resumes');
  } finally { await context.close(); }
}

/* ───────────────────────────────── 6. no scroll, zoom or bounce ───────────────────────────────── */
async function noScroll(browser, server) {
  console.log('\n-- 6. no page scroll / zoom / overscroll');
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors });
  try {
    await page.evaluate(() => window.__egg.adaptive().enabled = false);
    const base = await scrollState(page);
    await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    for (const dir of ['up', 'down', 'left', 'right', 'down', 'up']) { await doSwipe(cdp, dir); await sleep(60); }
    // diagonals, long drags off the top and bottom, two thumbs, a pinch
    await swipe(cdp, { x: 100, y: 380 }, { x: 160, y: 5 }, { steps: 10, stepMs: 6 });
    await swipe(cdp, { x: 700, y: 5 }, { x: 640, y: 385 }, { steps: 10, stepMs: 6 });
    await multiSwipe(cdp, [{ from: { x: 150, y: 300 }, to: { x: 150, y: 120 } }, { from: { x: 650, y: 300 }, to: { x: 650, y: 120 } }], { steps: 8, stepMs: 8 });
    await multiSwipe(cdp, [{ from: { x: 300, y: 200 }, to: { x: 200, y: 200 } }, { from: { x: 400, y: 200 }, to: { x: 500, y: 200 } }], { steps: 8, stepMs: 8 });
    await sleep(200);
    const s = await scrollState(page);
    t.ok(scrollIsZero(s), 'the document never moved', s);
    t.ok(s.vvScale === 1 && s.vvTop === 0 && s.vvLeft === 0, `visualViewport scale ${s.vvScale} offset (${s.vvLeft}, ${s.vvTop})`);
    t.ok(s.docW <= s.iw && s.docH <= s.ih && s.bodyW <= s.iw && s.bodyH <= s.ih, 'the page is exactly one viewport: nothing to scroll', { dw: s.docW, dh: s.docH, iw: s.iw, ih: s.ih });
    t.ok(base.iw === s.iw && base.ih === s.ih, 'the viewport did not change size');
    const canvas = await page.evaluate(() => { const r = document.getElementById('game').getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(); return { c: [r.left, r.top, r.width, r.height], s: [st.left, st.top, st.width, st.height] }; });
    t.ok(JSON.stringify(canvas.c) === JSON.stringify(canvas.s) && canvas.c[2] === 844 && canvas.c[3] === 390, 'canvas == stage == viewport', canvas);
    // keyboard: arrows and space must not scroll either
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('PageDown'); await page.keyboard.press('Space'); await page.keyboard.press('End');
    t.ok(scrollIsZero(await scrollState(page)), 'keyboard scrolling keys do nothing');
  } finally { await context.close(); }
}

/* ───────────────────────────────── 7. frame-error safety net ───────────────────────────────── */
async function crash(browser, server) {
  console.log('\n-- 7. one exception never freezes the screen silently');
  const errs = [];
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  try {
    await page.evaluate(() => window.__egg.adaptive().enabled = false);
    await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
    await waitFor(page, () => window.__egg.state().mode === 'playing');
    // a single failing frame: logged, the loop carries on
    await page.evaluate(() => { const r = window.__egg.renderer, d = r.draw; let once = true; r.draw = function (o) { if (once) { once = false; throw new Error('one bad frame'); } return d.call(this, o); }; });
    await sleep(500);
    let s = await st(page);
    t.ok(s.crashed === false && s.mode === 'playing' && s.errors >= 1, 'a single failing frame is logged and the loop continues');
    const x = s.mama.x; await sleep(400);
    t.ok((await st(page)).mama.x > x, 'the game keeps running after it');
    // a draw that always fails: stop and say so
    await page.evaluate(() => { window.__egg.renderer.draw = () => { throw new Error('always bad'); }; });
    await sleep(800);
    s = await st(page);
    t.ok(s.crashed === true, 'repeated failures stop the loop...');
    const msg = await page.evaluate(() => { const c = document.getElementById('crash'); return c ? c.innerText.replace(/\s+/g, ' ') : ''; });
    t.ok(/Something went wrong/.test(msg) && /reload/i.test(msg), `...and show a friendly message instead of a frozen canvas (${msg})`);
    await shot(page, 'game-18-crash');
    const loggedErrors = errs.filter((e) => /bad frame|always bad/.test(e)).length;
    t.ok(loggedErrors >= 1 && loggedErrors <= 4, `the console is not flooded (${loggedErrors} error lines)`);
    errs.length = 0;                                                       // these errors were deliberate
  } finally { await context.close(); }
}

/* ───────────────────────────────── 9. other phones ───────────────────────────────── */
async function otherPhones(browser, server) {
  for (const key of ['pixel7', 'small']) {
    const d = DEVICES[key];
    console.log(`\n-- 9. ${d.label}`);
    const { context, page, cdp } = await boot(browser, server, d, { errors });
    try {
      await page.evaluate(() => window.__egg.adaptive().enabled = false);
      const vp = d.viewport;
      let s = await st(page);
      t.ok(s.canvas.w === Math.round(vp.width * s.view.dpr) && s.canvas.h === Math.round(vp.height * s.view.dpr), `canvas is the stage (${s.canvas.w}x${s.canvas.h} at dpr ${s.view.dpr})`);
      await shot(page, `game-${key}-title`);
      await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
      await waitFor(page, () => window.__egg.state().mode === 'playing');
      await sleep(1300);
      const swp = (a, b) => swipe(cdp, a, b, { steps: 6, stepMs: 8 });
      const W = vp.width, H = vp.height;
      await swp({ x: W * 0.35, y: H * 0.8 }, { x: W * 0.35, y: H * 0.45 });
      let air = false;
      for (let i = 0; i < 10 && !air; i++) { await sleep(25); const m = (await st(page)).mama; air = !m.onGround; }
      t.ok(air, 'swipe up jumps');
      await waitFor(page, () => window.__egg.state().mama.onGround, null, 3000);
      await sleep(400);
      const v0 = (await st(page)).mama.vx;
      await swp({ x: W * 0.25, y: H * 0.6 }, { x: W * 0.4, y: H * 0.6 });
      await sleep(400);
      t.ok((await st(page)).mama.vx > v0 + 15, 'swipe right pushes');
      await sleep(1000);
      await swp({ x: W * 0.7, y: H * 0.6 }, { x: W * 0.55, y: H * 0.6 });
      await sleep(400);
      t.ok((await st(page)).mama.vx < 40, 'swipe left brakes (from the right half of the screen too)');
      await shot(page, `game-${key}-play`);
      const pb = await page.evaluate(() => { const r = document.getElementById('pause-btn').getBoundingClientRect(); return { r: r.right, t: r.top, w: r.width, h: r.height, iw: innerWidth }; });
      t.ok(pb.w >= 44 && pb.h >= 44 && pb.r <= pb.iw && pb.t >= 0, `the pause control is thumb-sized and on screen (${pb.w}x${pb.h})`);
      await tapSelector(page, cdp, '#pause-btn');
      await waitFor(page, () => window.__egg.state().ui === 'pause'); await settle(page);
      const fits = await page.evaluate(() => { const c = document.querySelector('[data-screen=pause] .card'); const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
      t.ok(fits, 'the pause card fits the screen');
      await shot(page, `game-${key}-pause`);
      t.ok(scrollIsZero(await scrollState(page)), 'no page scroll');
    } finally { await context.close(); }
  }
}

/* ───────────────────────────────── run ───────────────────────────────── */
const server = await startServer();
const browser = await chromium.launch();
let fails = 1;
try {
  await journey(browser, server);
  await legacy(browser, server);
  await mute(browser, server);
  await rotate(browser, server);
  await hidden(browser, server);
  await noScroll(browser, server);
  await crash(browser, server);
  if (!QUICK) await otherPhones(browser, server);
  const bad = errors.filter((e) => !/favicon/.test(e));
  t.ok(bad.length === 0, 'no console errors and no page errors anywhere in a normal run', bad.slice(0, 8));
  fails = t.done();
} catch (e) {
  console.error('\nUNCAUGHT:', e);
  console.error('console/page errors so far:', errors.slice(0, 10));
} finally { await browser.close(); server.stop(); }
process.exitCode = fails ? 1 : 0;
void path; void seedSave; void centerOf;
