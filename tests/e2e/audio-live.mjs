#!/usr/bin/env node
/*
 * Live audio lifecycle check in real Chromium (run manually: `node tests/e2e/audio-live.mjs`).
 *
 * The unit tests prove the logic against a fake AudioContext; this proves the same behaviour against the real one,
 * with a real user gesture, by measuring the master output with an AnalyserNode:
 *   - no AudioContext exists before the first gesture; the gesture creates it and it runs
 *   - music is actually audible; suspend() silences it and freezes the clock; resume() brings it back
 *   - mute silences it immediately, sfx while muted do nothing, unmute restores it
 *   - exactly ONE 25 ms scheduler timer exists after any number of suspend/resume/mute cycles
 *   - playSong crossfades (two players for the length of the fade, then one) and the same id is a no-op
 *   - sfx are audible over the music; a golden hatch dips the music
 *   - a 25 s soak with sim events keeps the voice count bounded
 * Nothing is served: Playwright answers the page's requests from docs/ (no port, no server left running).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { builtinSong, stressSong } from '../../tools/audio-render.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const { chromium } = require('playwright');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });   // default autoplay policy: audio may only start after a real gesture; gc() for the heap check
const context = await browser.newContext({ viewport: { width: 640, height: 300 } });
await context.route('http://egg.local/**', (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>audio live</title><button id="go" style="width:200px;height:100px">go</button>' });
  const file = path.join(DOCS, decodeURIComponent(url.pathname));
  if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nope' });
  return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file) });
});
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('  FAIL page error: ' + e.message); failed++; });

try {
  await page.goto('http://egg.local/');
  // instrument: count live AudioContexts and live 25 ms intervals (the engine's scheduler) before the engine loads
  await page.evaluate(() => {
    window.__ctxs = [];
    const AC = window.AudioContext;
    window.AudioContext = class extends AC { constructor(o) { super(o); window.__ctxs.push(this); } };
    window.__intervals = new Set();
    const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
    window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); if (ms === 25) window.__intervals.add(id); return id; };
    window.clearInterval = (id) => { window.__intervals.delete(id); return ci(id); };
  });
  await page.evaluate(async ({ song, stress }) => {
    const { GameAudio } = await import('/js/audio.mjs');
    const other = { ...song, id: 'other', bpm: 100 };
    window.audio = new GameAudio({ muted: false, songs: { builtin: song, other, stress } });
    document.getElementById('go').addEventListener('click', () => { window.audio.unlock(); window.audio.playSong('builtin', { fade: 0.4 }); });
    // a measuring tap on the master output (test-only peek at the engine's mixer)
    window.__tap = () => {
      const g = window.audio._g, an = g.ctx.createAnalyser();
      an.fftSize = 2048; g.out.connect(an);
      window.__an = an; window.__buf = new Float32Array(2048);
    };
    window.__level = () => { // rms and peak of the last 2048 samples (~43 ms)
      window.__an.getFloatTimeDomainData(window.__buf);
      let s = 0, p = 0; for (const v of window.__buf) { s += v * v; p = Math.max(p, Math.abs(v)); }
      return { rms: Math.sqrt(s / window.__buf.length), peak: p };
    };
    // the loudest 43 ms window seen over `ms` milliseconds
    window.__maxLevel = (ms) => new Promise((res) => { let m = { rms: 0, peak: 0 }; const t0 = performance.now(); const id = setInterval(() => { const l = window.__level(); m = { rms: Math.max(m.rms, l.rms), peak: Math.max(m.peak, l.peak) }; if (performance.now() - t0 > ms) { clearInterval(id); res(m); } }, 10); });
  }, { song: builtinSong(), stress: stressSong() });

  console.log('lifecycle');
  ok(await page.evaluate(() => window.__ctxs.length) === 0, 'no AudioContext exists before the first gesture');
  ok(await page.evaluate(() => window.audio.sfx('egg')) === false, 'sfx before unlock does nothing');
  await page.click('#go');                                                  // a real user gesture
  await sleep(300);
  await page.evaluate(() => window.__tap());
  const st = await page.evaluate(() => ({ n: window.__ctxs.length, state: window.__ctxs[0].state, t: window.__ctxs[0].currentTime, sr: window.__ctxs[0].sampleRate }));
  ok(st.n === 1 && st.state === 'running', `the gesture created one context and it is running (state ${st.state}, ${st.sr} Hz)`);
  await sleep(1200);
  const t1 = await page.evaluate(() => window.__ctxs[0].currentTime);
  ok(t1 > st.t + 0.5, `the audio clock advances (${st.t.toFixed(2)} -> ${t1.toFixed(2)} s)`);
  const music = await page.evaluate(() => window.__maxLevel(1000));
  ok(music.rms > 0.01, `the music is audible: rms ${music.rms.toFixed(3)}, peak ${music.peak.toFixed(3)}`);
  ok(music.peak < 0.98, 'and does not clip');
  const timers = () => page.evaluate(() => window.__intervals.size);
  ok(await timers() === 1, 'exactly one 25 ms scheduler timer is running');

  console.log('suspend / resume');
  await page.evaluate(() => window.audio.suspend());
  await sleep(500);
  const frozenA = await page.evaluate(() => window.__ctxs[0].currentTime); await sleep(400);
  const frozenB = await page.evaluate(() => window.__ctxs[0].currentTime);
  // (an AnalyserNode on a suspended context just keeps its last buffer, so silence is proven by the state and the frozen clock:
  //  a suspended AudioContext renders nothing)
  ok(await page.evaluate(() => window.__ctxs[0].state) === 'suspended', 'suspend() suspends the context');
  ok(frozenA === frozenB, `the clock is frozen while suspended, so nothing is rendered (${frozenA.toFixed(3)} = ${frozenB.toFixed(3)})`);
  ok(await timers() === 0, 'the scheduler timer is gone while suspended');
  ok(await page.evaluate(() => window.audio.sfx('goldHatch')) === false, 'sfx while suspended do nothing');
  for (let i = 0; i < 5; i++) await page.evaluate(() => { window.audio.resume(); window.audio.resume(); window.audio.suspend(); window.audio.suspend(); });
  ok(await timers() === 0, 'after five suspend/resume rounds ending suspended: still no timer');
  await page.evaluate(() => { window.audio.resume(); window.audio.resume(); window.audio.resume(); });
  await sleep(50);
  const resumedT = await page.evaluate(() => window.__ctxs[0].currentTime);
  await sleep(850);
  ok(await page.evaluate(() => window.__ctxs[0].state) === 'running', 'resume() runs the context again');
  ok(await timers() === 1, 'three resume() calls = exactly ONE scheduler timer');
  const back = await page.evaluate(() => window.__maxLevel(800));
  ok(back.rms > 0.01, `music is back after resume (rms ${back.rms.toFixed(3)})`);
  ok(resumedT - frozenB < 0.3, `the clock resumed where it froze, so the song continues from the same position (${frozenB.toFixed(2)} -> ${resumedT.toFixed(2)})`);

  console.log('mute');
  await page.evaluate(() => window.audio.setMuted(true));
  await sleep(150);
  const m1 = await page.evaluate(() => window.__ctxs[0].currentTime); await sleep(300);
  const m2 = await page.evaluate(() => window.__ctxs[0].currentTime);
  ok(await page.evaluate(() => window.__ctxs[0].state) === 'suspended' && m1 === m2, `mute stops the context within 150 ms (the clock is frozen at ${m2.toFixed(2)})`);
  ok(await page.evaluate(() => window.audio.sfx('goldHatch') || window.audio.sfx('egg')) === false, 'sfx while muted do nothing');
  ok(await timers() === 0, 'no scheduler while muted');
  await page.evaluate(() => window.audio.resume());
  ok(await timers() === 0, 'resume() while muted stays silent and timer-free');
  await page.evaluate(() => window.audio.setMuted(false));
  await sleep(700);
  const unmuted = await page.evaluate(() => window.__maxLevel(800));
  ok(unmuted.rms > 0.01 && await timers() === 1, `unmute restores the music (rms ${unmuted.rms.toFixed(3)}) with one timer`);

  console.log('songs and sfx');
  const players = () => page.evaluate(() => window.audio.stats.players);
  ok(await players() === 1, 'one song playing');
  await page.evaluate(() => window.audio.playSong('builtin', { fade: 3 }));
  ok(await players() === 1, 'playSong with the same id is a no-op');
  await page.evaluate(() => window.audio.playSong('other', { fade: 1.2 }));
  ok(await players() === 2, 'a different song crossfades: two players during the fade');
  await sleep(2200);
  ok(await players() === 1, 'and one again after the fade');
  const gold = await page.evaluate(async () => {
    const before = await window.__maxLevel(400);
    window.audio.sfx('goldHatch');
    const during = await window.__maxLevel(700);
    return { before, during };
  });
  ok(gold.during.peak > gold.before.peak * 1.2, `a golden hatch is audible over the music (peak ${gold.before.peak.toFixed(2)} -> ${gold.during.peak.toFixed(2)})`);
  ok(gold.during.peak < 0.98, 'and the mix does not clip');
  const beacon = await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 600)); window.audio.sfx('beacon'); return window.__maxLevel(1800); });
  ok(beacon.peak > 0.2 && beacon.peak < 0.98, `the beacon swell is loud and clean (peak ${beacon.peak.toFixed(2)})`);

  console.log('soak (25 s of play)');
  const soak = await page.evaluate(async () => {
    const evs = ['jump', 'land', 'egg', 'egg', 'egg', 'steer', 'spring', 'stomp', 'checkpoint', 'hit', 'duckling-lost', 'shield', 'magnet', 'crumble-start', 'gold', 'hatch'];
    let i = 0, maxVoices = 0, maxPlayers = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 25000) {
      window.audio.handle({ type: evs[i++ % evs.length], hatched: true });
      if (i % 40 === 0) window.audio.playSong(i % 80 === 0 ? 'builtin' : 'other', { fade: 1.5 });
      const s = window.audio.stats; maxVoices = Math.max(maxVoices, s.voices); maxPlayers = Math.max(maxPlayers, s.players);
      await new Promise((r) => setTimeout(r, 120));
    }
    return { maxVoices, maxPlayers, events: i, state: window.__ctxs[0].state, ctxs: window.__ctxs.length };
  });
  ok(soak.maxVoices < 150, `voice count stays bounded: max ${soak.maxVoices} live voices over ${soak.events} events`);
  ok(soak.maxPlayers <= 3, `at most the playing and fading songs: ${soak.maxPlayers}`);
  ok(soak.state === 'running' && soak.ctxs === 1 && await timers() === 1, 'still one context, running, one timer');

  console.log('cost of the scheduler (stress tune: 18 layers, everything at once, 8 sim events a second for 20 s)');
  const cost = await page.evaluate(async () => {
    const a = window.audio, orig = a._tick, times = [];
    a._tick = function (tok) { const t0 = performance.now(); orig.call(this, tok); times.push(performance.now() - t0); };
    a.playSong('stress', { fade: 0.3 });
    await new Promise((r) => setTimeout(r, 1500));
    times.length = 0;
    window.gc(); const heap0 = performance.memory.usedJSHeapSize;
    const evs = ['jump', 'land', 'egg', 'egg', 'steer', 'spring', 'stomp', 'egg', 'egg', 'checkpoint', 'hit', 'gold'];
    const t0 = performance.now(); let i = 0, maxVoices = 0;
    while (performance.now() - t0 < 20000) { a.handle({ type: evs[i++ % evs.length], hatched: true }); maxVoices = Math.max(maxVoices, a.stats.voices); await new Promise((r) => setTimeout(r, 125)); }
    window.gc(); const heap1 = performance.memory.usedJSHeapSize;
    a._tick = orig;
    const sorted = [...times].sort((x, y) => x - y), sum = times.reduce((x, y) => x + y, 0);
    return { n: times.length, mean: sum / times.length, p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted[sorted.length - 1], heapGrowthKB: (heap1 - heap0) / 1024, maxVoices };
  });
  console.log(`  ${cost.n} ticks: mean ${cost.mean.toFixed(3)} ms, p99 ${cost.p99.toFixed(2)} ms, max ${cost.max.toFixed(2)} ms; JS heap after gc ${cost.heapGrowthKB >= 0 ? '+' : ''}${cost.heapGrowthKB.toFixed(0)} KB; max live voices ${cost.maxVoices}`);
  ok(cost.mean < 1.5, `a scheduler tick averages ${cost.mean.toFixed(3)} ms (budget 1.5 ms here, a phone is ~3x slower)`);
  ok(cost.p99 < 12, `p99 ${cost.p99.toFixed(2)} ms: no long stalls from the scheduler`);
  ok(cost.heapGrowthKB < 2048, `no leak: JS heap grew ${cost.heapGrowthKB.toFixed(0)} KB over 20 s of the heaviest tune`);

  console.log('dispose');
  await page.evaluate(() => window.audio.dispose());
  await sleep(200);
  ok(await page.evaluate(() => window.__ctxs[0].state) === 'closed' && await timers() === 0, 'dispose closes the context and stops the scheduler');
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall live audio checks passed');
process.exit(failed ? 1 : 0);
