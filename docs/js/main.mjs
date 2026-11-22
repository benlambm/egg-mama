/*
 * Egg Mama — the main loop (DESIGN.md §11). This file wires every module together; the pure parts (fixed timestep, the dpr
 * safety net, the save throttle, the song hysteresis) live in loop.mjs so Node can test them.
 *
 *   boot -> title <-> playing <-> paused | rotate -> dead | finish        (plus the brief 'starting' / 'transition' states)
 *
 * ── what runs when ─────────────────────────────────────────────────────────────────────────────────────────────────
 *   rAF frame:   resize if asked -> (playing | title) run the fixed-step accumulator (T.step) -> hand the drained sim events to the
 *                renderer (spawn), the audio (handle) and the save/music/state logic -> draw with the interpolation alpha.
 *   playing:     held keys + actions from Input reach the sim; checkpoint -> autosave; chapter-enter -> song crossfade; dead
 *                (after T.deadSeconds) -> dead screen; beacon (after FINISH_DELAY) -> finish screen.
 *   paused / rotate / hidden: no sim steps and no audio (audio.suspend()); the world stays drawn, frozen. Time spent away is
 *                never caught up (resetClock) and Resume eases Mama back in (easeIn).
 *   title:       the live world at the saved flag, Mama idle with her flock; the sim steps (status 'ready') so lifts and
 *                walkers move, but she does not.
 * The world is ONE level per circuit (generateLevel, a few ms to a few hundred on a phone): it is generated after the first
 * paint, kept in memory, and every Retry / Continue / Main Title rebuilds the *game* from it (createGame) without regenerating.
 *
 * ── saves ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *   `save` is the in-memory journey (what storage holds, or null before the first Play); Retry reads it, so it works even when
 *   storage is full or blocked. Checkpoint events replace it (saveAt) and SaveThrottle writes it; pause / hide / pagehide /
 *   Main Title flush. The beacon saves the NEXT circuit's Meadow with beacons+1 (so Main Title -> Continue opens it).
 *
 * ── test hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *   Only with ?debug in the URL: window.__egg (game, level, state(), teleport, fastForward, setSpeed, forceBeacon, forceDead,
 *   bench, perfStats ...) and window.__shell (the small surface tests/e2e/shell-*.mjs were written against). Never otherwise.
 */
import { createUI } from './ui.mjs';
import { Input } from './input.mjs';
import { getStorage, loadSave, writeSave, loadSettings, writeSettings, recordBest, newJourney, randomSeed, saveAt, resolveFlag, flagOf } from './save.mjs';
import { generateLevel, levelSeed } from './levelgen.mjs';
import { createGame, startRun, easeIn, act, step, drainEvents, snapshotCarry, chapterIndexAt, chapterSlotAt, cloneGame } from './sim.mjs';
import { Renderer } from './render.mjs';
import { GameAudio } from './audio.mjs';
import { SONGS, songFor } from './music.mjs';
import { CHAPTERS } from './chapters.mjs';
import { T, clamp } from './tuning.mjs';
import { FixedStepper, AdaptiveRes, SaveThrottle, SongTracker } from './loop.mjs';

/* ───────── cosmetic / UX numbers (game rules live in tuning.mjs) ───────── */
const FINISH_DELAY = 2.5;           // s of beacon celebration before the 'finish' screen
const FADE_OUT = 0.3, FADE_IN = 0.5;// s: Keep Going / Main Title canvas fades
const FADE_COLOR = '#10182a';
const SONG_FADE = 3.5;              // s: landscape-to-landscape crossfade
const SONG_HYST = T.blendHalf / 2;  // units past a landscape edge before a song change that did not come from the sim is believed
const PRELOAD_AHEAD = 5200;         // start baking the next landscape this far before its dissolve begins
const LAUNCH_WAIT = 1500;           // ms we will wait for a painting before starting to roll anyway
const WARM_DELAY = 15000;           // ms after play starts before the service worker is asked to fetch the other paintings
const MAX_FRAME_ERRORS = 6;         // consecutive frame exceptions before we stop and say so
const NOHELD = Object.freeze({});

const DEBUG = /[?&]debug\b/.test(location.search);
const noop = () => {};
const raf = (f) => requestAnimationFrame(f);
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => raf(() => r()));

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const storage = getStorage();

/* ───────── state ───────── */
let settings = loadSettings(storage);
let save = loadSave(storage);                  // the stored journey, or null until the first Play
let fresh = save ? null : newJourney(randomSeed());   // a brand-new journey that is stored the moment it is played
let playSeconds = (save || fresh).playSeconds;  // real seconds spent playing this journey (only counted while actually playing)

/** 'title' | 'starting' | 'playing' | 'paused' | 'rotate' | 'dead' | 'finish' | 'transition' (starting/transition are brief) */
let mode = 'title';
let rotateReturn = null;                       // { mode, screen } to go back to after a portrait interruption
let screenMem = null;                          // { name, data } of the main screen on top (title / pause / dead / finish)
let level = null, game = null;                 // the world and the game being played / shown
let worldReady = false;                        // the title world exists and its painting is decoded
let busy = false;                              // a fade/rebuild is under way (Keep Going, Main Title, Start Over)
let pendingStart = false;                      // Play / Continue was tapped while the world was still being made
let launchToken = 0;                           // invalidates a stale 'starting' wait
let forcedVisual = null;                       // renderer mode override while in a transition
let pageHiding = false;
let speed = 1;                                 // debug time multiplier
let lastNow = 0;                               // previous rAF timestamp (0 = start over: next dt is 0)
let needResize = true;
let resizedAt = 0;
let crashed = false, frameErrors = 0, consecutiveErrors = 0;
let reduced = false;
let titleWarm = false;                         // the current landscape's sprites are baked
let preloadedSlot = -1, preloadedNext = -1, preloadCheck = 0;
const levelCache = new Map();                  // 'seed:circuit' -> level (at most two: this circuit and the next)
const actionLog = [];                          // debug: every action Input classified

const stepper = new FixedStepper(T.step, T.maxFrame);
let adaptive = new AdaptiveRes({ deviceDpr: window.devicePixelRatio || 1 });
let adaptiveFor = window.devicePixelRatio || 1;
let songs = null;                              // SongTracker for the current level
const throttle = new SaveThrottle((s) => writeSave(storage, s), { minGap: 1500 });
const fade = { v: 0, to: 0, rate: 4, wait: null };
const drawOpts = { game: null, now: 0, alpha: 1, mode: 'play', reducedMotion: false, fade: 0, fadeColor: FADE_COLOR, paused: false };

const journey = () => save || fresh;

/* ───────── the pieces ───────── */
const renderer = new Renderer(canvas);
const audio = new GameAudio({ muted: settings.muted, songs: SONGS });

const ui = createUI({ root: document.getElementById('ui'), onAction: (name, payload) => guard(() => onAction(name, payload)) });
ui.setMuted(settings.muted);
ui.setSettings({ tapToJump: settings.tapToJump });

const input = new Input(stage, {
  onAction: (a) => guard(() => onGameAction(a)),
  onPause: () => guard(onPauseKey),
  onMute: () => guard(() => setMuted(!settings.muted)),
  isActive: () => mode === 'playing',
  onFirstGesture: tryLockLandscape,
});
input.tapToJump = settings.tapToJump;

/** Event handlers must never throw into the browser's console in a normal run. */
function guard(fn) {
  try { return fn(); } catch (e) { logError('handler', e); return undefined; }
}
const seen = new Set();
function logError(where, e) {
  frameErrors++;
  const key = where + String(e && e.message);
  if (!seen.has(key) && seen.size < 20) { seen.add(key); try { console.error(`[egg-mama] ${where}:`, e); } catch { /* console may be gone */ } }
}

/* ═════════════════════════════════════════ modes, screens, audio state ═════════════════════════════════════════ */

function setMode(m) {
  mode = m;
  stage.dataset.mode = m;
  syncAudio();
}
/** The audio engine runs only while the game is somewhere that makes sound (title, playing, dead, finish) and visible. */
function syncAudio() {
  const run = !document.hidden && !pageHiding && mode !== 'paused' && mode !== 'rotate';
  if (run) audio.resume(); else audio.suspend();
}
function showScreen(name, data) {
  screenMem = { name, data };
  ui.show(name, data);
}

function titleData() { return { save, best: settings.best }; }
function pauseData() {
  const m = game.mama, lvl = game.level;
  const a = lvl.start ? lvl.start.x : 0, b = lvl.beacon ? lvl.beacon.x : lvl.endX;
  return {
    eggs: game.eggs, score: game.score, flock: game.flock, circuit: lvl.circuit | 0 || 1, chapter: chapterIndexAt(lvl, m.x),
    progress: clamp((m.x - a) / Math.max(1, b - a), 0, 1), playSeconds, reached: journey().reached,
  };
}
function showTitle() {
  setMode('title');
  ui.setPauseButton(false);
  showScreen('title', titleData());
}

/* ═════════════════════════════════════════ the world ═════════════════════════════════════════ */

function getLevel(j) {
  const key = `${j.journeySeed}:${j.circuit}`;
  let lv = levelCache.get(key);
  if (!lv) {
    lv = generateLevel({ circuit: j.circuit, seed: levelSeed(j.journeySeed, j.circuit) });
    levelCache.set(key, lv);
    for (const k of levelCache.keys()) { if (levelCache.size <= 2) break; if (k !== key) levelCache.delete(k); }
  }
  return lv;
}

/** A game standing at the journey's saved flag (status 'ready': Mama idle with her flock). */
function makeGame(j) {
  const lv = getLevel(j);
  const g = createGame(lv, { eggs: j.eggs, score: j.score, flock: j.flock }, { checkpoint: resolveFlag(lv, j) });
  step(g, NOHELD);                           // settle the followers' trail
  drainEvents(g);
  return g;
}
/** Make `g` the game on screen. */
function adopt(g) {
  game = g; level = g.level;
  renderer.resetCamera(g);
  stepper.reset();
  songs = new SongTracker(level, SONG_HYST, g.mama.x);
  preloadedSlot = -1; preloadedNext = -1; preloadCheck = 0;
}
/** Wait (bounded) for the painting of Mama's landscape; sprites bake on their own in the frames that follow. */
async function worldReadyFor(g) {
  if (renderer.ready) return;
  await Promise.race([renderer.whenReady(), timeout(LAUNCH_WAIT)]);
}

async function buildTitleWorld() {
  await nextFrame();                         // let the title paint first
  await timeout(0);
  const g = makeGame(journey());
  adopt(g);
  await worldReadyFor(g);
  worldReady = true;
  warmCurrent();
  if (pendingStart) { pendingStart = false; startFromTitle(); }
}
function warmCurrent() {
  titleWarm = false;
  const cs = level.chapters, slot = game.slot;
  const i = cs && cs.length ? cs[slot].index : level.chapter | 0;
  renderer.preload(i).then(() => { titleWarm = true; }, () => { titleWarm = true; });
  preloadedSlot = slot;
}

/* ═════════════════════════════════════════ starting, retrying, continuing ═════════════════════════════════════════ */

function startFromTitle() {
  if (mode !== 'title') return;
  if (busy || !worldReady) { pendingStart = true; return; }
  if (!save) { save = fresh; fresh = null; writeSave(storage, save); }
  const announce = save.flag === 0 && save.chapter > 0;      // no chapter-enter event fires at a landscape's first flag
  ui.hide(); ui.setPauseButton(true);
  input.releaseAll();
  launch(game, { announce });
}

/**
 * Begin rolling on `g` (already adopted). Synchronous when its painting is decoded (Retry must feel instant); otherwise the
 * world is drawn idle for a moment (mode 'starting', input off) until it is.
 */
function launch(g, { announce = false, fadeIn = false } = {}) {
  const token = ++launchToken;
  const go = () => {
    if (token !== launchToken || game !== g) return;
    startRun(g);
    stepper.reset(); lastNow = 0;
    setMode('playing');
    ui.hide(); ui.setPauseButton(true);
    input.releaseAll();
    const idx = songs.reset(g.mama.x);
    audio.playSong(songFor(idx, level.circuit), { fade: 1.2 });
    if (announce) renderer.announceChapter(idx, true);
    if (fadeIn) fadeTo(0, FADE_IN);
    warmOfflineCache();
    tryLockLandscape();
    checkOrientation();
  };
  if (renderer.ready) go();
  else { setMode('starting'); worldReadyFor(g).then(go, go); }
}

function retry() {
  if (mode !== 'dead') return;
  ui.hide(); ui.setPauseButton(true);
  input.releaseAll();
  const g = makeGame(journey());               // the saved snapshot: same world, same flag, totals as of the last save
  adopt(g);
  launch(g);
}

/** Dead after T.deadSeconds; recordBest + the dead screen. */
function enterDead() {
  setMode('dead');
  input.releaseAll();
  throttle.flush();
  const r = recordBest(settings, { score: game.score, eggs: game.eggs });
  settings = r.settings; writeSettings(storage, settings);
  const j = journey();
  ui.setPauseButton(false);
  showScreen('dead', { eggs: game.eggs, score: game.score, flock: game.flock, circuit: j.circuit, chapter: j.chapter, newBest: r.newBest.score && game.score > 0 });
}

/** The beacon celebration has run its course. */
function enterFinish() {
  setMode('finish');
  input.releaseAll();
  const r = recordBest(settings, { score: game.score, eggs: game.eggs });
  settings = r.settings; writeSettings(storage, settings);
  ui.setPauseButton(false);
  showScreen('finish', { eggs: game.eggs, score: game.score, flock: game.flock, circuit: level.circuit });
  // make the next circuit while the child reads: Keep Going is then instant. One hitch, on a static screen.
  setTimeout(() => { if (mode === 'finish') guard(() => getLevel(journey())); }, 900);
}

async function keepGoing() {
  if (mode !== 'finish' || busy) return;
  busy = true;
  ui.hide();
  forcedVisual = 'finish';
  setMode('transition');
  input.releaseAll();
  try {
    await fadeTo(1, FADE_OUT);
    const g = makeGame(journey());              // circuit+1, Meadow, flock/eggs/score carried (saved when the beacon lit)
    adopt(g);
    await worldReadyFor(g);
    forcedVisual = null;
    fade.v = 1;                                 // stay black until she is rolling
    launch(g, { fadeIn: true });
  } catch (e) {
    logError('keep going', e);
    forcedVisual = null;
    fadeTo(0, FADE_IN);
    showTitle();
  } finally { busy = false; flushPending(); }
}

async function goTitle() {
  if (!(mode === 'paused' || mode === 'dead' || mode === 'finish') || busy) return;
  busy = true;
  const from = mode;
  if (from === 'paused') { const r = recordBest(settings, { score: game.score, eggs: game.eggs }); settings = r.settings; writeSettings(storage, settings); }
  throttle.flush();
  ui.hide();
  forcedVisual = from === 'paused' ? 'paused' : from;
  setMode('transition');
  try {
    await fadeTo(1, FADE_OUT);
    const g = makeGame(journey());
    adopt(g);
    await worldReadyFor(g);
    forcedVisual = null;
    showTitle();
    audio.playSong('title', { fade: 1.2 });
    warmCurrent();
    fadeTo(0, FADE_IN);
  } catch (e) {
    logError('main title', e);
    forcedVisual = null; fade.v = 0; fade.to = 0;
    showTitle();
  } finally { busy = false; flushPending(); }
}

async function startOver() {
  if (mode !== 'title' || busy) return;
  busy = true;
  save = newJourney(randomSeed()); fresh = null;
  writeSave(storage, save);
  playSeconds = 0;
  showScreen('title', titleData());
  try {
    await fadeTo(1, FADE_OUT * 0.7);
    const g = makeGame(save);
    adopt(g);
    await worldReadyFor(g);
    audio.playSong('title', { fade: 0.8 });
    warmCurrent();
    fadeTo(0, FADE_IN);
  } catch (e) { logError('start over', e); fade.v = 0; fade.to = 0; } finally { busy = false; flushPending(); }
}
function flushPending() { if (pendingStart && !busy && worldReady && mode === 'title') { pendingStart = false; startFromTitle(); } }

/** Canvas fade controller: tick() moves fade.v toward fade.to; the promise resolves when it gets there. */
function fadeTo(to, seconds) {
  if (fade.wait) { const w = fade.wait; fade.wait = null; w(); }
  fade.to = to;
  fade.rate = Math.abs(to - fade.v) / Math.max(0.01, seconds);
  if (fade.v === to) return Promise.resolve();
  return new Promise((res) => { fade.wait = res; });
}

/* ═════════════════════════════════════════ pause / resume / rotate ═════════════════════════════════════════ */

function pauseGame() {
  if (mode !== 'playing') return false;
  setMode('paused');
  input.releaseAll();
  throttle.flush();
  showScreen('pause', pauseData());
  return true;
}
function resumePlay() {
  const fromRotate = mode === 'rotate' && rotateReturn && rotateReturn.mode === 'playing';
  if (mode !== 'paused' && !fromRotate) return;
  if (isPortrait()) return;
  rotateReturn = null;
  ui.hide(); ui.setPauseButton(true);
  input.releaseAll();
  setMode('playing');                           // audio.resume() runs synchronously inside the tap
  easeIn(game);                                 // INPUT-1: ease back in, a moment of grace
  stepper.reset(); lastNow = 0; adaptive.reset();
}
function onPauseKey() {
  if (mode === 'playing') pauseGame();
  else if (mode === 'paused' && ui.current === 'pause') { audio.unlock(); resumePlay(); }
}

const isPortrait = () => stage.clientHeight > stage.clientWidth;

/** VIEW-4: upright phone -> pause + rotate prompt; landscape again -> "Tap to continue" (playing) or the screen that was up. */
function checkOrientation() {
  const portrait = isPortrait();
  if (portrait && mode !== 'rotate') {
    if (mode === 'transition' || mode === 'starting') return;         // over in a moment; checked again when it ends
    rotateReturn = { mode, screen: screenMem };
    throttle.flush();
    input.releaseAll();
    setMode('rotate');
    ui.show('rotate', { phase: 'prompt' });
  } else if (!portrait && mode === 'rotate') {
    const back = rotateReturn ? rotateReturn.mode : 'title';
    if (back === 'playing') ui.show('rotate', { phase: 'ready' });      // the player decides when the run resumes
    else {
      const s = rotateReturn && rotateReturn.screen;
      rotateReturn = null;
      setMode(back);
      if (back === 'paused') showScreen('pause', pauseData());
      else if (back === 'title') { ui.setPauseButton(false); showScreen('title', titleData()); }
      else if (s) showScreen(s.name, s.data);                          // dead / finish: put back exactly what was up
      else showTitle();
    }
  }
}

function onHide() {
  pauseGame();
  throttle.flush();
  syncAudio();
  lastNow = 0; stepper.reset(); adaptive.reset();
}
function onShow() {
  syncAudio();
  lastNow = 0; stepper.reset(); adaptive.reset();
  needResize = true;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) onHide(); else onShow(); });
window.addEventListener('pagehide', () => { pageHiding = true; onHide(); });
window.addEventListener('pageshow', () => { pageHiding = false; onShow(); });
window.addEventListener('blur', () => guard(pauseGame));

/* ═════════════════════════════════════════ input and ui actions ═════════════════════════════════════════ */

function onGameAction(a) {
  if (DEBUG) { actionLog.push(a); if (actionLog.length > 400) actionLog.splice(0, 200); }
  if (mode === 'playing') act(game, a);
}

function setMuted(m) {
  settings = { ...settings, muted: !!m };
  writeSettings(storage, settings);
  audio.unlock();
  audio.setMuted(settings.muted);              // synchronous, inside the tap
  syncAudio();
  ui.setMuted(settings.muted);
  if (!settings.muted) audio.sfx('ui');
}

function onAction(name, payload) {
  audio.unlock();                               // before any sfx, inside the gesture
  switch (name) {
    case 'play': case 'continue': audio.sfx('ui'); startFromTitle(); break;
    case 'retry': if (mode === 'dead') { audio.sfx('ui'); retry(); } break;
    case 'keep-going': if (mode === 'finish') { audio.sfx('ui'); keepGoing(); } break;
    case 'resume': case 'rotate-continue': if (mode === 'paused' || mode === 'rotate') { resumePlay(); audio.sfx('ui'); } break;
    case 'pause': pauseGame(); break;
    case 'title': audio.sfx('uiBack'); goTitle(); break;
    case 'confirm-start-over': audio.sfx('ui'); startOver(); break;
    case 'sound': setMuted(payload ? !!payload.muted : !settings.muted); break;
    case 'tap-to-jump': {
      settings = { ...settings, tapToJump: !!(payload && payload.tapToJump) };
      input.tapToJump = settings.tapToJump;
      writeSettings(storage, settings);
      audio.sfx('ui');
      break;
    }
    case 'fullscreen': toggleFullscreen(); break;
    case 'journal': case 'help': case 'start-over': audio.sfx('ui'); break;
    case 'close': case 'cancel-start-over': audio.sfx('uiBack'); break;
    default: break;
  }
}

// Browsers only let audio start from touchend / click / keydown-class gestures: unlock on every one (cheap, idempotent).
for (const type of ['pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(type, () => guard(() => audio.unlock()), { capture: true, passive: true });

function tryLockLandscape() {
  try {
    const p = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape');
    if (p && p.catch) p.catch(noop);
  } catch { /* best effort */ }
}
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  try {
    let p;
    if (d.fullscreenElement || d.webkitFullscreenElement) p = (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
    if (p && p.then) p.then(() => tryLockLandscape(), noop);
  } catch { /* not available on this browser */ }
}

/** After play starts, quietly ask the service worker to fetch the other paintings so a whole journey works offline. */
let warmed = false;
function warmOfflineCache() {
  if (warmed || !('serviceWorker' in navigator)) return;
  warmed = true;
  setTimeout(() => navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage({ type: 'warm' })).catch(noop), WARM_DELAY);
}

/* ═════════════════════════════════════════ sim events ═════════════════════════════════════════ */

/**
 * Everything the sim reported since the last frame. `quiet` (fastForward) skips the pure show: no particles, no sound.
 * Order: visuals and sound first, then the bookkeeping (saves, music, state).
 */
function processEvents(events, quiet = false) {
  if (!quiet) {
    renderer.spawn(events, game);
    for (let i = 0; i < events.length; i++) audio.handle(events[i]);
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'checkpoint') onCheckpoint(e);
    else if (e.type === 'chapter-enter') onChapterEnter(e);
    else if (e.type === 'beacon') onBeacon();
  }
}

function onCheckpoint(e) {
  const f = flagOf(level, e.index);
  save = saveAt(journey(), { circuit: level.circuit, chapter: f.chapter, flag: f.flag, carry: snapshotCarry(game), playSeconds });
  fresh = null;
  throttle.request(save);
}
function onChapterEnter(e) {
  if (songs.enter(e.slot)) audio.playSong(songFor(e.index, level.circuit), { fade: SONG_FADE });
}
function onBeacon() {
  audio.playSong('beacon', { fade: 0.8 });
  // the next circuit's Meadow is where Continue opens from now on (SAVE-1): saved at once, not throttled
  save = saveAt(journey(), { circuit: level.circuit + 1, chapter: 0, flag: 0, carry: snapshotCarry(game), playSeconds, beaconLit: true });
  fresh = null;
  throttle.request(save); throttle.flush();
}

/** Ask for the next landscape's painting, sprites and song a long way ahead, while she is standing on safe ground. */
function preloadAhead() {
  const cs = level.chapters, m = game.mama;
  if (!cs || !cs.length || !m.onGround) return;
  const slot = game.slot;
  if (preloadedSlot !== slot) { preloadedSlot = slot; renderer.preload(cs[slot].index).catch(noop); }
  const nx = cs[slot + 1];
  if (nx && preloadedNext !== slot + 1 && m.x > nx.x0 - T.blendHalf - PRELOAD_AHEAD) {
    preloadedNext = slot + 1;
    renderer.preload(nx.index).catch(noop);
    setTimeout(() => { void SONGS[songFor(nx.index, level.circuit)]; }, 60);       // build the song's data now, not at the crossfade
  }
  if (!nx && preloadedNext !== slot + 1 && level.beacon && m.x > level.beacon.x - 3000) {
    preloadedNext = slot + 1;
    setTimeout(() => { void SONGS.beacon; }, 60);
  }
}

/* ═════════════════════════════════════════ the frame ═════════════════════════════════════════ */

function rendererMode() {
  if (forcedVisual) return forcedVisual;
  switch (mode) {
    case 'title': case 'starting': return 'title';
    case 'paused': case 'rotate': return 'paused';
    case 'dead': return 'dead';
    case 'finish': return 'finish';
    default: return game.status === 'dead' ? 'dead' : game.status === 'beacon' || game.status === 'exit' ? 'finish' : 'play';
  }
}

function paintSky() {
  const ctx = renderer.ctx;
  if (!ctx) return;
  const j = journey();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = CHAPTERS[clamp(j.chapter | 0, 0, CHAPTERS.length - 1)].palette.sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function applyResize() {
  needResize = false;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  const dev = window.devicePixelRatio || 1;
  if (dev !== adaptiveFor) { adaptiveFor = dev; adaptive = new AdaptiveRes({ deviceDpr: dev }); }
  renderer.resize(w, h, Math.min(dev, 3, adaptive.dpr), ui.insets());
  adaptive.reset();
  resizedAt = performance.now();
  checkOrientation();
}

const perf = { busy: new Float32Array(900), gap: new Float32Array(900), n: 0 };

function tick(now) {
  if (needResize) applyResize();
  const rawDt = lastNow ? now - lastNow : 0;
  lastNow = now;
  const dt = Math.min(rawDt / 1000, T.maxFrame);

  if (!game || !worldReady) { paintSky(); return; }

  // ── simulate ──
  const stepping = mode === 'playing' || mode === 'title';
  if (stepping) {
    const n = stepper.advance(dt, speed);
    for (let i = 0; i < n; i++) step(game, mode === 'playing' ? input.held : NOHELD, T.step);
    const ev = drainEvents(game);
    if (ev.length) processEvents(ev);
    if (mode === 'playing') {
      playSeconds += Math.min(dt, 0.25);
      const st = game.status;
      if (st === 'running') {
        if (songs.update(game.mama.x)) audio.playSong(songFor(songs.index, level.circuit), { fade: SONG_FADE });
        if ((preloadCheck += dt) > 0.5) { preloadCheck = 0; preloadAhead(); }
      } else if (st === 'dead') { if (game.statusT >= T.deadSeconds) enterDead(); }
      else if (st === 'beacon' || st === 'exit') { if (game.statusT >= FINISH_DELAY) enterFinish(); }
    }
  }

  // ── resolution safety net: only frames that really draw the live world count ──
  if (stepping && rawDt > 0 && !document.hidden && performance.now() - resizedAt > 400) {
    const to = adaptive.sample(rawDt, now);
    if (to !== null) needResize = true;
  }

  // ── fades ──
  if (fade.v !== fade.to) {
    const d = fade.rate * dt;
    fade.v = fade.v < fade.to ? Math.min(fade.to, fade.v + d) : Math.max(fade.to, fade.v - d);
    if (fade.v === fade.to && fade.wait) { const w = fade.wait; fade.wait = null; w(); }
  }

  // ── draw ──
  const o = drawOpts;
  o.game = game; o.now = now; o.alpha = stepping ? stepper.alpha : 1;
  o.mode = rendererMode(); o.reducedMotion = reduced; o.fade = fade.v;
  o.paused = mode === 'paused' || mode === 'rotate' || forcedVisual === 'paused';
  renderer.draw(o);
}

function frame(now) {
  if (crashed) return;
  raf(frame);
  const t0 = DEBUG ? performance.now() : 0;
  try {
    tick(now);
    consecutiveErrors = 0;
  } catch (e) {
    consecutiveErrors++;
    logError('frame', e);
    if (consecutiveErrors >= MAX_FRAME_ERRORS) showCrash();
  }
  if (DEBUG) {
    const i = perf.n % perf.busy.length;
    perf.busy[i] = performance.now() - t0; perf.gap[i] = lastGap(now); perf.n++;
  }
}
let prevFrameAt = 0;
function lastGap(now) { const g = prevFrameAt ? now - prevFrameAt : 0; prevFrameAt = now; return g; }

/** One exception never freezes the screen silently: after MAX_FRAME_ERRORS in a row we stop and ask for a reload. */
function showCrash() {
  if (crashed) return;
  crashed = true;
  try { audio.suspend(); } catch { /* ignore */ }
  const box = document.createElement('div');
  box.id = 'crash';
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:absolute;inset:0;z-index:20;display:grid;place-items:center;text-align:center;padding:24px;'
    + 'background:rgba(16,24,42,.92);color:#fff;font:800 20px/1.3 system-ui,sans-serif;cursor:pointer;touch-action:manipulation';
  box.innerHTML = '<div><div style="font-size:34px;margin-bottom:8px">Oh no!</div>Something went wrong. Tap to reload.<div style="margin-top:10px;font:600 14px system-ui,sans-serif;opacity:.8">Your saved place is safe.</div></div>';
  box.addEventListener('click', () => location.reload());
  stage.appendChild(box);
}

/* ═════════════════════════════════════════ page plumbing ═════════════════════════════════════════ */

const requestResize = () => { needResize = true; };
if (typeof ResizeObserver === 'function') new ResizeObserver(requestResize).observe(stage);
window.addEventListener('resize', requestResize);
window.addEventListener('orientationchange', () => { requestResize(); setTimeout(requestResize, 120); setTimeout(requestResize, 400); });
if (window.visualViewport) { window.visualViewport.addEventListener('resize', requestResize); window.visualViewport.addEventListener('scroll', requestResize); }
try {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduced = mq.matches;
  const on = (e) => { reduced = e.matches; };
  if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
} catch { /* old browser: motion stays on */ }
window.addEventListener('error', (e) => { logError('window', e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { logError('promise', e.reason); e.preventDefault(); });

/** Offline play (a plain service worker). Skipped on localhost unless ?sw, so editing never serves stale files. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && !/[?&]sw\b/.test(location.search)) return;
  const register = () => navigator.serviceWorker.register('sw.js').catch(noop);     // offline play is a bonus, never an error
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
}

/* ═════════════════════════════════════════ debug hooks (?debug only) ═════════════════════════════════════════ */

/** A cheap deterministic autopilot for soak tests: jump at the end of the ground, over spikes and walkers. Not a player. */
function autopilot(g) {
  const m = g.mama;
  if (g.status !== 'running' || !m.onGround || !m.ground || m.buffer > 0) return;
  const gnd = m.ground, end = gnd.cx + gnd.w;
  if (end - m.x < 12 && !g.platforms.some((p) => p !== gnd && p.kind === 'ground' && p.x <= end + 2 && p.x + p.w > end + 4 && Math.abs(p.cy - gnd.cy) < 30)) { act(g, 'jump'); return; }
  for (const h of g.level.hazards) { const d = h.x - m.x; if (d > 18 && d < 46) { act(g, 'jump'); return; } if (d > 60) break; }
  for (const e of g.enemies) { if (e.defeated || e.kind !== 'walker') continue; const d = e.x - m.x; if (d > 20 && d < 66 && Math.abs(e.y - m.y) < 8) { act(g, 'jump'); return; } }
}

/** The look-ahead planner (jump when the plain roll would fail and a jump now would not). Slow: ~ms per decision. */
function plannerBot(g) {
  const m = g.mama;
  if (g.status !== 'running' || !m.onGround || m.buffer > 0) return false;
  const safe = (doJump) => {
    const c = cloneGame(g);
    if (doJump) act(c, 'jump');
    const f0 = c.stats.falls + c.stats.hits;
    for (let i = 0; i < 150; i++) { step(c, NOHELD, T.step); if (c.status !== 'running' || c.stats.falls + c.stats.hits > f0) return false; }
    return true;
  };
  if (safe(false)) return false;
  if (safe(true)) { act(g, 'jump'); return true; }
  return false;
}

function cpIndexAt(lvl, x) { let k = 0; for (let i = 0; i < lvl.checkpoints.length; i++) if (lvl.checkpoints[i].x <= x) k = i; else break; return k; }
function groundUnder(g, x) {
  let best = null;
  for (const p of g.platforms) if (p.kind === 'ground' && x >= p.x && x <= p.x + p.w && (!best || p.y < best.y)) best = p;
  return best;
}

function installDebug() {
  const clone = (o) => { try { return o == null ? o : JSON.parse(JSON.stringify(o)); } catch { return null; } };
  const stored = () => { try { return JSON.parse(storage.getItem('egg-mama-save-v2')); } catch { return null; } };
  const pct = (arr, n, p) => { const a = Array.from(arr.subarray(0, Math.min(n, arr.length))).filter((v) => v > 0).sort((x, y) => x - y); return a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : 0; };

  /** Put Mama on the ground at x (a fresh game from the checkpoint at or before x; `flag` overrides which). */
  function teleport(x, { flag, keepStatus = true } = {}) {
    const running = mode === 'playing' && game.status === 'running';
    const idx = flag !== undefined ? flag : cpIndexAt(level, x);
    const g = createGame(level, snapshotCarry(game), { checkpoint: idx });
    const p = groundUnder(g, x), m = g.mama;
    m.x = m.px = x; m.y = m.py = p ? p.cy : m.y; m.vx = T.cruise; m.vy = 0; m.onGround = true; if (p) m.ground = p; m.phase = x; m.rollIn = 99; m.face = 1;
    g.slot = chapterSlotAt(level, x);
    g.shield = game.shield; g.magnet = game.magnet;
    for (const q of g.pickups) if (q.x < x - 40) q.taken = true;
    for (const c of level.cues) if (c.x < x) g.cuesShown.add(c);
    g.hist.x.fill(x - 30); g.hist.y.fill(m.y); g.hist.n = 600;
    step(g, NOHELD); drainEvents(g);
    if (running && keepStatus) { startRun(g); m.vx = T.cruise; m.rollIn = 99; m.invuln = 0.5; }
    adopt(g);
    if (mode === 'playing') audio.playSong(songFor(songs.index, level.circuit), { fade: 0.4 });
    return { x: m.x, checkpoint: g.checkpoint };
  }

  /** Step the sim without drawing, through the same event handling as the real loop (saves, songs, state). */
  function fastForward(seconds, { bot = false, god = false, stopAtEvent = null } = {}) {
    const out = { steps: 0, events: {}, stuck: 0, dead: false, beacon: false, x0: game.mama.x, x1: 0, t: 0 };
    const n = Math.round(seconds / T.step);
    const useBot = bot === true || bot === 'edge' ? autopilot : bot === 'plan' ? plannerBot : null;
    let lastCp = game.checkpoint, respawns = 0;
    for (let i = 0; i < n; i++) {
      if (game.status !== 'running') break;
      const m = game.mama;
      if (god) { m.invuln = Math.max(m.invuln, 0.5); if (game.flock < 1) game.flock = 1; }
      if (useBot && i % 12 === 0) useBot(game);
      step(game, NOHELD, T.step);
      out.steps++;
      const ev = drainEvents(game);
      if (ev.length) {
        for (const e of ev) {
          out.events[e.type] = (out.events[e.type] || 0) + 1;
          if (e.type === 'respawn') respawns++;
        }
        processEvents(ev, true);
        if (stopAtEvent && ev.some((e) => e.type === stopAtEvent)) break;
      }
      if (game.checkpoint !== lastCp) { lastCp = game.checkpoint; respawns = 0; }
      if (god && respawns >= 3) { teleport(level.checkpoints[Math.min(level.checkpoints.length - 1, game.checkpoint + 1)].x + 5, { flag: Math.min(level.checkpoints.length - 1, game.checkpoint + 1) }); respawns = 0; out.stuck++; }
      playSeconds += T.step;
    }
    out.dead = game.status === 'dead'; out.beacon = game.status === 'beacon';
    out.x1 = game.mama.x; out.t = game.t;
    return out;
  }

  const egg = {
    renderer, audio, ui, input, adaptive: () => adaptive, SONGS,
    game: () => game, level: () => level,
    teleport, fastForward,
    setSpeed(m) { speed = clamp(+m || 1, 0.1, 16); return speed; },
    forceBeacon() {
      if (mode !== 'playing' || game.status !== 'running') return false;
      teleport(level.beacon.x - 70);
      return true;
    },
    forceDead() {
      if (mode !== 'playing' || game.status !== 'running') return false;
      game.flock = 0; game.shield = false; game.mama.invuln = 0; game.mama.y = T.killY + 5;
      return true;
    },
    /** Pause / hide / rotate helpers for tests that cannot do those things for real. */
    pause: () => pauseGame(),
    state() {
      const m = game && game.mama;
      return {
        mode, ui: ui.current, worldReady, busy, crashed, errors: frameErrors, speed,
        circuit: level ? level.circuit : null, status: game ? game.status : null, t: game ? game.t : 0,
        mama: m ? { x: m.x, y: m.y, vx: m.vx, vy: m.vy, onGround: m.onGround, face: m.face, invuln: m.invuln, steerDir: m.steerDir, buffer: m.buffer } : null,
        eggs: game ? game.eggs : 0, score: game ? game.score : 0, flock: game ? game.flock : 0, shield: game ? game.shield : false,
        checkpoint: game ? game.checkpoint : 0, slot: game ? game.slot : 0, chapter: level && m ? chapterIndexAt(level, m.x) : 0,
        followers: game ? game.followers.length : 0,
        save: clone(save), stored: stored(), settings: clone(settings), playSeconds,
        view: { ...renderer.view }, canvas: { w: canvas.width, h: canvas.height }, dpr: adaptive.dpr, adaptive: { ema: +adaptive.ema.toFixed(2), downs: adaptive.downs, ups: adaptive.ups, enabled: adaptive.enabled },
        audio: { muted: audio.muted, ...audio.stats, ctx: audio._ctx ? audio._ctx.state : null, song: audio._songId, suspended: audio._suspended, hidden: audio._hidden },
        reduced, portrait: isPortrait(), fade: fade.v, renderMode: game ? rendererMode() : null, actions: actionLog.length,
      };
    },
    actionLog,
    perfStats() {
      const n = Math.min(perf.n, perf.busy.length);
      return { frames: perf.n, busyP50: pct(perf.busy, n, 0.5), busyP95: pct(perf.busy, n, 0.95), gapP50: pct(perf.gap, n, 0.5), gapP95: pct(perf.gap, n, 0.95), render: { ...renderer.stats } };
    },
    resetPerf() { perf.n = 0; perf.busy.fill(0); perf.gap.fill(0); },
    /**
     * Cost of the whole loop for `frames` frames at 60 fps of game time: two sim steps + the real draw, then a 1-px read-back so the
     * software rasteriser's work is included. Returns ms/frame percentiles. Does not touch rAF (call with adaptive off).
     */
    bench(frames = 300, { advance = true } = {}) {
      const js = [], all = [];
      let t = performance.now();
      for (let f = 0; f < frames; f++) {
        const t0 = performance.now();
        if (advance && game.status === 'running') {
          for (let s = 0; s < 2; s++) { if (f % 8 === 0 && s === 0) autopilot(game); step(game, NOHELD, T.step); }
          const ev = drainEvents(game); if (ev.length) processEvents(ev);
        }
        t += 1000 / 60;
        const o = drawOpts; o.game = game; o.now = t; o.alpha = 1; o.mode = 'play'; o.reducedMotion = reduced; o.fade = 0; o.paused = false;
        renderer.draw(o);
        const t1 = performance.now();
        renderer.ctx.getImageData(0, 0, 1, 1);
        const t2 = performance.now();
        js.push(t1 - t0); all.push(t2 - t0);
      }
      const q = (a, p) => +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2);
      return { frames, js: { p50: q(js, 0.5), p95: q(js, 0.95) }, withRaster: { p50: q(all, 0.5), p95: q(all, 0.95), max: q(all, 1) }, stats: { ...renderer.stats }, view: { ...renderer.view } };
    },
    gc() { try { if (window.gc) window.gc(); } catch { /* not exposed */ } },
    heap() { try { return performance.memory ? performance.memory.usedJSHeapSize : 0; } catch { return 0; } },
    flushSave() { throttle.flush(); },
    crash() { showCrash(); },
    throwInFrame() { const was = renderer.draw; renderer.draw = () => { throw new Error('debug: draw failed'); }; return () => { renderer.draw = was; }; },
  };
  window.__egg = egg;

  // The surface tests/e2e/shell-*.mjs were written against (they drove a placeholder): ui, input, mode, save, settings, actionLog, run, ...
  window.__shell = {
    ui, input, actionLog,
    get mode() { return mode === 'playing' ? 'playing' : mode; },
    get save() { return save; },
    get settings() { return settings; },
    get view() { return renderer.view; },
    get run() { return { eggs: game ? game.eggs : 0, score: game ? game.score : 0, flock: game ? game.flock : 0, playSeconds }; },
    setMode(m) { setMode(m); },
    startRun() { if (mode === 'title') startFromTitle(); },
    showTitle, pauseGame,
  };
}

/* ═════════════════════════════════════════ go ═════════════════════════════════════════ */

function boot() {
  showTitle();                                   // the title is on screen immediately; the world follows after the first paint
  applyResize();                                 // may swap the title for the rotate prompt if the phone starts upright
  paintSky();
  raf(frame);
  registerServiceWorker();
  if (DEBUG) installDebug();
  audio.playSong('title');                       // remembered until the first gesture unlocks audio
  buildTitleWorld().catch((e) => { logError('boot', e); showCrash(); });
}

boot();
