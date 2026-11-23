#!/usr/bin/env node
/*
 * Egg Mama — the audio lifecycle in the INTEGRATED build (run by hand; NOT `node --test`). There are no ears here: everything is
 * measured from the real AudioContext, the engine's own bookkeeping and the DevTools-visible state, with real touch taps for the gestures.
 *
 *   node tests/e2e/soak-audio.mjs [--quick]
 *
 * (tests/e2e/audio-live.mjs tests the ENGINE on its own with a synthetic song; run it as well: `node tests/e2e/audio-live.mjs`.)
 *
 * CHECKS, in the real page at 844x390 @3 with a Chromium whose autoplay policy is the default (audio only after a real gesture):
 *   1. before the first gesture no AudioContext exists; the first tap creates exactly ONE and it runs; the title song was waiting;
 *   2. the song id sequence across a landscape crossing at 1x in the real loop: meadow -> clover-mill, ONE start, a 3.5 s crossfade
 *      (two players while it lasts, one after), no duplicate restart, and none when Mama is moved back and forth over the edge inside
 *      the hysteresis band (nor by real left swipes); a real retreat does restart the old song once;
 *   3. a golden egg collected in the real loop sounds the hatch ONCE ('gold' + 'hatch' pair) and ducks the music by 8-10 dB, which swells
 *      back; the beacon, checkpoint and lost-duckling cues duck too; a plain egg does not;
 *   4. mute from the pause menu with a real tap: the engine stops within 150 ms (context suspended, clock frozen, no scheduler timer),
 *      the choice is stored, survives a reload (the engine stays silent after Continue), and un-muting resumes the SAME song;
 *   5. suspend: tab hidden, pagehide, window blur, and rotating to portrait each pause the game and suspend the context with no scheduler
 *      timer; coming back keeps it silent until a gesture; the Resume / "Tap to continue" tap resumes it synchronously with exactly ONE
 *      scheduler timer and one song player; after a storm of 40 hide/show cycles there is still exactly one timer and one context;
 *   6. the AudioContext state transitions the whole time are listed; nothing else ever creates a second context.
 */
import { chromium, startRepoServer, soakBoot, startPlaying, parseArgs, reporter, tapSelector, sleep, f1, memSample } from './soak-lib.mjs';

const args = parseArgs();
const QUICK = !!args.quick;   // (the audio run is short anyway: --quick is accepted and changes nothing)
void QUICK;
const SEED = 20261123;
const t = reporter('audio in the integrated build (real taps, real AudioContext)');
const errors = [];

const INSTRUMENT = `
  window.__ctxs = []; window.__ctxLog = [];
  const AC = window.AudioContext;
  if (AC) window.AudioContext = class extends AC {
    constructor(o) {
      super(o);
      const i = window.__ctxs.length; window.__ctxs.push(this);
      window.__ctxLog.push({ i, state: this.state, at: Math.round(performance.now()) });
      this.addEventListener('statechange', () => window.__ctxLog.push({ i, state: this.state, at: Math.round(performance.now()) }));
    }
  };
  window.__intervals = new Set();
  const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); if (ms === 25) window.__intervals.add(id); return id; };
  window.clearInterval = (id) => { window.__intervals.delete(id); return ci(id); };
`;

const server = await startRepoServer();
const browser = await chromium.launch();          // default autoplay policy on purpose
let failures = 1;
try {
  const { context, page, cdp } = await soakBoot(browser, server, { journeySeed: SEED, circuit: 1, errors, device: 'iphone13', init: INSTRUMENT, driver: false });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  const A = {
    ctx: () => page.evaluate(() => { const c = window.__ctxs[0]; return c ? { state: c.state, t: c.currentTime, n: window.__ctxs.length } : { state: null, t: 0, n: window.__ctxs.length }; }),
    timers: () => page.evaluate(() => window.__intervals.size),
    st: () => page.evaluate(() => window.__egg.state()),
    stats: () => page.evaluate(() => ({ ...window.__egg.audio.stats, song: window.__egg.audio._songId, muted: window.__egg.audio.muted, suspended: window.__egg.audio._suspended })),
    frozen: async () => { const a = (await A.ctx()).t; await sleep(350); const b = (await A.ctx()).t; return a === b; },
  };

  const alive = async (where) => { const q = await A.st(); if (q.mode !== 'playing') console.log(`       (mode ${q.mode}, status ${q.status}, x ${Math.round(q.mama.x)} after ${where})`); return q.mode === 'playing'; };

  /* ── 1. first gesture ── */
  console.log('\n-- 1. the first gesture');
  t.ok((await A.ctx()).n === 0, 'no AudioContext exists before the first gesture');
  const pre = await A.stats();
  t.ok(pre.song === 'title', `the title song is waiting for the gesture (requested: ${pre.song})`);
  await page.evaluate(() => {
    const a = window.__egg.audio, op = a.playSong.bind(a), os = a.sfx.bind(a);
    window.__songLog = []; window.__sfxLog = [];
    a.playSong = (id, o) => { window.__songLog.push({ id, fade: o && o.fade, prev: a._songId, at: Math.round(performance.now()) }); return op(id, o); };
    a.sfx = (n, o) => { const r = os(n, o); window.__sfxLog.push({ n, r, at: Math.round(performance.now()) }); return r; };
  });
  await startPlaying(page, cdp);
  await sleep(600);
  let c = await A.ctx();
  t.ok(c.n === 1 && c.state === 'running', `the first tap created exactly one AudioContext and it is running (${c.state})`);
  t.ok((await A.timers()) === 1, 'with exactly one scheduler timer');
  let s = await A.stats();
  t.ok(s.song === 'meadow' && s.players >= 1, `Play starts the Meadow song (${s.song}, ${s.players} player${s.players === 1 ? '' : 's'})`);
  const c0 = await A.ctx(); await sleep(500); const c1 = await A.ctx();
  t.ok(c1.t > c0.t + 0.3, `the audio clock runs (${c0.t.toFixed(2)} -> ${c1.t.toFixed(2)} s)`);

  /* ── 2. the crossing, at 1x in the real loop ── */
  console.log('\n-- 2. Meadow -> Clover Mill at 1x');
  const x0 = await page.evaluate(() => window.__egg.level().chapters[1].x0);
  await page.evaluate((x) => { window.__songLog.length = 0; window.__egg.teleport(x - 300); }, x0);
  await sleep(300);
  s = await A.stats();
  t.ok(s.song === 'meadow', `300 u before the edge it is still the Meadow song (${s.song})`);
  const mark = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => window.__egg.state().chapter === 1, null, { timeout: 15000, polling: 50 });
  await sleep(250);
  let log = await page.evaluate(() => window.__songLog.slice());
  const starts = log.filter((l) => l.id !== l.prev);
  t.ok(starts.length === 1 && starts[0].id === 'clover-mill' && starts[0].prev === 'meadow' && starts[0].fade >= 3 && starts[0].fade <= 4, `the crossing started the Clover Mill song once with a ${starts[0] && starts[0].fade} s crossfade (${JSON.stringify(starts.map((l) => [l.prev, l.id, l.fade]))})`, log);
  const during = (await A.stats()).players;
  t.ok(during === 2, `two players while the crossfade lasts (${during})`);
  await sleep(4200);
  s = await A.stats();
  t.ok(s.players === 1 && s.song === 'clover-mill', `one player again after the fade (${s.players}, ${s.song})`);
  await alive('the crossfade');
  // hysteresis: move her back and forth over the edge, inside the band
  const set = (x) => page.evaluate((v) => { const m = window.__egg.game().mama; m.x = m.px = v; m.vx = 110; }, x);
  await page.evaluate(() => { window.__songLog.length = 0; });
  for (const dx of [-140, 60, -200, 120, -90, 200]) { await set(x0 + dx); await sleep(200); }
  log = await page.evaluate(() => window.__songLog.slice());
  t.ok(log.filter((l) => l.id !== l.prev).length === 0, `six crossings back and forth inside the hysteresis band restarted nothing (${log.length} playSong calls, 0 restarts)`);
  await alive('six moves');
  // real left swipes (brake / back up) right at the edge
  await set(x0 + 40);
  await page.evaluate(() => { window.__songLog.length = 0; });
  for (let i = 0; i < 4; i++) { await realSwipe(cdp, 'left'); await sleep(900); }
  log = await page.evaluate(() => window.__songLog.slice());
  t.ok(log.filter((l) => l.id !== l.prev).length === 0, `four real brake swipes at the edge did not thrash the music (x ${Math.round((await A.st()).mama.x)}, edge ${Math.round(x0)})`);
  await alive('four brakes');
  // a real retreat
  await set(x0 - 450); await sleep(300);
  log = await page.evaluate(() => window.__songLog.slice());
  t.ok(log.filter((l) => l.id !== l.prev).length === 1 && (await A.stats()).song === 'meadow', 'a real retreat of 450 u restarts the Meadow song once');
  await alive('the retreat');
  await set(x0 + 450); await sleep(300);
  s = await A.stats();
  t.ok(s.song === 'clover-mill' && s.players <= 3, `and rolling on commits Clover Mill again (players ${s.players})`);
  await page.evaluate(() => window.__egg.teleport(window.__egg.level().chapters[1].x0 + 100));
  await sleep(4500);
  // the rest of the run is long: from here the debug autopilot (god mode + edge jumps) keeps her alive while the lifecycle is tested
  await page.evaluate(() => window.__egg.autoplay(true));

  /* ── 3. ducking ── */
  console.log('\n-- 3. ducking');
  const duckProbe = (fn, ms = 1100) => page.evaluate(([f, span]) => new Promise((res) => {
    const a = window.__egg.audio, g = a._g, samples = [];
    const t0 = performance.now(); let min = 1, minAt = 0;
    f === 'real' ? 0 : (f.startsWith('handle:') ? a.handle({ type: f.slice(7), hatched: true }) : a.sfx(f));
    const id = setInterval(() => { const v = g.duck.gain.value; samples.push(v); if (v < min) { min = v; minAt = performance.now() - t0; } if (performance.now() - t0 > span) { clearInterval(id); res({ min, minAt, end: g.duck.gain.value }); } }, 8);
  }), [fn, ms]);
  const db = (v) => -20 * Math.log10(Math.max(1e-6, v));
  await sleep(500);
  const egg = await duckProbe('egg', 600);
  t.ok(db(egg.min) < 1, `a plain egg does not duck the music (${f1(db(egg.min))} dB)`);
  await sleep(800);
  const hatch = await duckProbe('handle:gold', 2200);
  t.ok(db(hatch.min) >= 6 && db(hatch.min) <= 13 && hatch.end > 0.92, `a golden hatch dips the music by ${f1(db(hatch.min))} dB (8-10 expected) at ${Math.round(hatch.minAt)} ms and it swells back (${f1(hatch.end * 100)}% of full level after 2.2 s)`);
  for (const [name, lo] of [['beacon', 6], ['checkpoint', 4], ['ducklingLost', 4]]) {
    await sleep(2800);
    const r = await duckProbe(name, 1500);
    t.ok(db(r.min) >= lo && db(r.min) <= 13, `${name} dips the music by ${f1(db(r.min))} dB`);
  }
  // a real golden egg in the real loop: the hatch sounds once and ducks
  // a golden egg on plain ground with nothing dangerous around it: she rolls through it on her own
  const goldX = await page.evaluate(() => {
    const l = window.__egg.level();
    for (const p of l.pickups) {
      if (p.kind !== 'gold' || p.x < 1500 || p.x > 20000) continue;
      const g = l.platforms.find((q) => q.kind === 'ground' && q.x <= p.x - 230 && q.x + q.w >= p.x + 300 && q.y - p.y > 8 && q.y - p.y < 42);
      const bad = l.hazards.some((h) => h.x > p.x - 230 && h.x < p.x + 300) || l.enemies.some((e) => { const a = e.x0 ?? e.cx - e.ax, b = e.x1 ?? e.cx + e.ax; return b > p.x - 260 && a < p.x + 320; }) || l.springs.some((q) => q.x > p.x - 230 && q.x < p.x + 300);
      if (g && !bad) return p.x;
    }
    return null;
  });
  t.ok(goldX !== null, `found a golden egg on plain ground (x ${goldX})`);
  await sleep(2500);
  await page.evaluate((x) => { window.__sfxLog.length = 0; window.__egg.teleport(x - 150); window.__egg.game().flock = 2; }, goldX);
  let minReal = 1;
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) { const v = await page.evaluate(() => window.__egg.audio._g.duck.gain.value); minReal = Math.min(minReal, v); await sleep(10); }
  const sf = await page.evaluate(() => window.__sfxLog.filter((l) => l.n === 'goldHatch'));
  const fl = await page.evaluate(() => window.__egg.game().flock);
  t.ok(fl === 3 && sf.length === 1 && sf[0].r === true, `a golden egg collected in the real loop hatched a duckling (flock 2 -> ${fl}) and sounded the hatch exactly once (${sf.length} goldHatch cue)`);
  t.ok(db(minReal) >= 6, `...and the music ducked by ${f1(db(minReal))} dB under it`);
  if (sf.length !== 1) console.log('       debug:', JSON.stringify(await A.st().then((q) => ({ mode: q.mode, status: q.status, x: q.mama && q.mama.x, goldX, flock: q.flock, eggs: q.eggs }))));
  await page.evaluate((x) => window.__egg.teleport(x), (await page.evaluate(() => window.__egg.level().chapters[1].x0)) + 700);

  /* ── 4. mute ── */
  console.log('\n-- 4. mute');
  await tapSelector(page, cdp, '#pause-btn');
  await page.waitForFunction(() => window.__egg.state().ui === 'pause', null, { timeout: 5000, polling: 50 });
  await sleep(450);
  s = await A.stats(); c = await A.ctx();
  t.ok(s.suspended && c.state === 'suspended' && (await A.timers()) === 0, `pausing suspends the audio (context ${c.state}, no scheduler timer)`);
  const songBefore = s.song;
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=sound]');
  await sleep(200);
  s = await A.stats();
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('egg-mama-settings-v1')));
  t.ok(s.muted === true && stored.muted === true, 'the Sound switch mutes the engine at once and stores the choice');
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
  await page.waitForFunction(() => window.__egg.state().mode === 'playing', null, { timeout: 5000, polling: 50 });
  await sleep(300);
  c = await A.ctx(); s = await A.stats();
  t.ok(c.state === 'suspended' && (await A.timers()) === 0 && s.running === false && (await A.frozen()), `muted and playing: the context stays suspended with its clock frozen and no scheduler (${c.state})`);
  const sfxMuted = await page.evaluate(() => [window.__egg.audio.sfx('goldHatch'), window.__egg.audio.sfx('egg')]);
  t.ok(sfxMuted.every((r) => r === false), 'sfx while muted do nothing');
  await page.reload();
  await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 45000 });
  await sleep(500);
  s = await A.stats();
  t.ok(s.muted === true && (await page.evaluate(() => window.__egg.state().settings.muted)) === true, 'after a reload the game is still muted');
  t.ok((await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked'))) === 'false', 'and the Sound switch on the title shows off');
  await startPlaying(page, cdp);
  await sleep(700);
  c = await A.ctx(); s = await A.stats();
  t.ok(c.state !== 'running' && s.running === false && (await A.timers()) === 0, `Continue while muted starts no sound (context ${c.state || 'none'}, scheduler timers ${await A.timers()})`);
  // unmute by the M key
  await page.keyboard.press('m');
  await sleep(500);
  c = await A.ctx(); s = await A.stats();
  const wasSong = s.song;
  t.ok(c.state === 'running' && (await A.timers()) === 1 && s.muted === false && s.players === 1, `unmuting (M key) resumes: context running, one timer, one player, song ${wasSong}`);

  /* ── 5. suspend / resume ── */
  console.log('\n-- 5. hidden, pagehide, blur, rotate');
  const setHidden = (h) => page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  const silent = async (label) => {
    await sleep(300);
    const cc = await A.ctx(), ss = await A.stats(), tm = await A.timers();
    return t.ok(cc.state === 'suspended' && tm === 0 && ss.running === false && (await A.frozen()), `${label}: the context is suspended, its clock frozen, no scheduler timer (${cc.state}, timers ${tm})`);
  };
  const resumeByTap = async (selector, label) => {
    await tapSelector(page, cdp, selector);
    await sleep(150);
    const cc = await A.ctx(), ss = await A.stats(), tm = await A.timers();
    t.ok(cc.state === 'running' && tm === 1 && ss.players === 1 && cc.n === 1, `${label}: one tap and it plays again: context ${cc.state}, ${tm} timer, ${ss.players} player, ${cc.n} context ever made`);
  };
  // hidden
  await page.evaluate(() => window.__egg.audio.resume());
  await setHidden(true);
  await page.waitForFunction(() => window.__egg.state().mode === 'paused', null, { timeout: 4000, polling: 50 });
  await silent('tab hidden');
  await setHidden(false);
  await silent('shown again (the game is still paused)');
  await page.waitForFunction(() => window.__egg.state().ui === 'pause', null, { timeout: 4000, polling: 50 });
  await sleep(450);
  await resumeByTap('[data-screen=pause] [data-action=resume]', 'Resume');
  // pagehide
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await silent('pagehide');
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await sleep(450);
  await page.waitForFunction(() => window.__egg.state().ui === 'pause', null, { timeout: 4000, polling: 50 });
  await resumeByTap('[data-screen=pause] [data-action=resume]', 'Resume after pagehide');
  // blur
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await silent('window blur');
  await sleep(450);
  await resumeByTap('[data-screen=pause] [data-action=resume]', 'Resume after blur');
  // rotate to portrait and back
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.__egg.state().mode === 'rotate', null, { timeout: 4000, polling: 50 });
  await silent('rotated to portrait');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => { const s = window.__egg.state(); return s.mode === 'rotate' && !s.portrait; }, null, { timeout: 4000, polling: 50 });
  await silent('back in landscape, before anyone taps');
  await sleep(450);
  await resumeByTap('[data-screen=rotate] [data-action=rotate-continue]', 'Tap to continue');
  // keyboard pause
  await page.keyboard.press('p');
  await silent('P key pause');
  await page.keyboard.press('p');
  await sleep(250);
  c = await A.ctx();
  t.ok(c.state === 'running' && (await A.timers()) === 1, `P again resumes (${c.state}, ${await A.timers()} timer)`);
  // a storm
  await page.evaluate(async () => {
    const hid = (h) => { Object.defineProperty(document, 'hidden', { value: h, configurable: true }); Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
    for (let i = 0; i < 40; i++) { hid(true); hid(false); }
    hid(true); await new Promise((r) => setTimeout(r, 120)); hid(false);
  });
  await silent('after 40 hide/show cycles');
  await sleep(450);
  await page.waitForFunction(() => window.__egg.state().ui === 'pause', null, { timeout: 4000, polling: 50 });
  await resumeByTap('[data-screen=pause] [data-action=resume]', 'Resume after the storm');
  s = await A.stats();
  t.ok(s.song === wasSong, `the song is still ${wasSong} (it was not restarted by any of it): ${s.song}`);

  /* ── 7 (before the list): what the songs weigh. Through circuit 1 the soak's heap climbs ~0.5 MB a landscape: is that the songs? ── */
  {
    await page.evaluate(() => window.__egg.autoplay(false));
    const idList = await page.evaluate(() => Object.keys(window.__egg.SONGS));
    const m0 = await memSample(cdp);
    await page.evaluate((ids) => { for (const id of ids) void window.__egg.SONGS[id]; }, idList);
    const m1 = await memSample(cdp);
    for (const id of idList) { await page.evaluate((i) => window.__egg.audio.playSong(i, { fade: 0.02 }), id); await sleep(120); }
    const m2 = await memSample(cdp);
    await page.evaluate(() => window.__egg.audio.playSong('meadow', { fade: 0.02 }));
    await sleep(2500);                                                    // the quick crossfades finish
    console.log(`\n-- 7. the weight of the music: JS heap after GC ${m0.heapMB} MB -> ${m1.heapMB} MB with all ${idList.length} songs' data built -> ${m2.heapMB} MB with every song compiled by the engine (+${f1(m2.heapMB - m0.heapMB)} MB in all)`);
    t.ok(m2.heapMB - m0.heapMB < 12, `all the music together is bounded (${f1(m2.heapMB - m0.heapMB)} MB for ${idList.length} songs, built once)`);
  }

  /* ── 6. the whole transition list ── */
  const logAll = await page.evaluate(() => window.__ctxLog);
  const seq = logAll.map((l) => l.state).join(' > ');
  console.log(`\n-- 6. AudioContext states over the whole run (one context, ${logAll.length} entries): ${seq.length > 400 ? seq.slice(0, 400) + ' ...' : seq}`);
  const counts = logAll.reduce((m, l) => (m[l.state] = (m[l.state] || 0) + 1, m), {});
  console.log(`   ${JSON.stringify(counts)}`);
  t.ok(new Set(logAll.map((l) => l.i)).size === 1, 'exactly one AudioContext was created in the whole run, however many pauses, mutes and reloads of state (the reload made a new page, which made one more)'.replace(', however many pauses, mutes and reloads of state (the reload made a new page, which made one more)', ' on this page after the reload'));
  t.ok((await A.stats()).players === 1 && (await A.stats()).voices < 150, 'one song player and a bounded voice count at the end');
  const e = await A.st();
  t.ok(e.errors === 0 && errors.length === 0, 'no console, page or game errors', errors.slice(0, 3));
  failures = t.done();
  await context.close();

  async function realSwipe(cdp2, dir) {
    const { swipe } = await import('./shell-lib.mjs');
    const P = { left: [{ x: 520, y: 250 }, { x: 380, y: 250 }], up: [{ x: 300, y: 330 }, { x: 300, y: 220 }], right: [{ x: 180, y: 250 }, { x: 320, y: 250 }] }[dir];
    await swipe(cdp2, P[0], P[1], { steps: 6, stepMs: 8 });
  }
} catch (e) {
  console.error('\nUNCAUGHT:', e);
} finally {
  await browser.close();
  server.stop();
}
process.exitCode = failures ? 1 : 0;
