/*
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *  PLACEHOLDER — the INTEGRATOR REPLACES THIS FILE (DESIGN.md §11).
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * It exists only so the SHELL (page, menus, input, save, PWA) can be exercised in a browser before the
 * real game loop lands. It paints a test scene (the Meadow painting + a rocking egg) and a fake "run" with
 * a few counters, so every screen can be reached by clicking:
 *
 *   title -> Play/Continue -> playing -> pause button -> pause -> Journal / How to play / Main title
 *   debug keys while playing (PLACEHOLDER ONLY): K = dead screen, B = beacon/finish screen
 *   portrait -> rotate prompt; landscape again -> rotate "Tap to continue"
 *
 * What the integrator should KEEP from here (copy these bits into the real main.mjs):
 *   - registerServiceWorker()      (skips localhost unless ?sw is in the URL, so dev edits are never stale)
 *   - warmOfflineCache()           (after play starts, tell the worker to fetch the other 12 paintings)
 *   - the ui <-> save <-> input wiring in onAction(): which action does what
 *   - checkOrientation()           (portrait -> pause + rotate prompt; landscape -> rotate "ready"; tap resumes)
 *   - resize()                     (canvas == stage rect, dpr capped at 3 and ~3.6 M pixels)
 *   - best-effort screen.orientation.lock + fullscreen toggle
 */
import { createUI } from './ui.mjs';
import { Input } from './input.mjs';
import { getStorage, loadSave, writeSave, loadSettings, writeSettings, newJourney, randomSeed, saveAt } from './save.mjs';
import { CHAPTERS, JOURNEY_SECONDS } from './chapters.mjs';
import { T } from './tuning.mjs';
import { eggPath, volumeFill, outline, rgba } from './artkit.mjs';

const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const storage = getStorage();

let settings = loadSettings(storage);
let save = loadSave(storage);
let mode = 'title';                       // title | playing | paused | rotate | dead | finish
let rotateReturn = null;                  // what to go back to after a rotate interruption

/* ───────── a fake run, just to have something to show ───────── */
const run = { t: 0, eggs: 0, score: 0, flock: 0, playSeconds: 0, jumpY: 0, jumpV: 0, lastAction: '', lastActionT: -9, drift: 0 };
const actionLog = [];                     // read by the e2e tests: every action the input classified

function startRun() {
  if (!save) { save = newJourney(randomSeed()); writeSave(storage, save); }
  const s = save;
  Object.assign(run, { eggs: s.eggs, score: s.score, flock: s.flock, playSeconds: s.playSeconds, jumpY: 0, jumpV: 0 });
  mode = 'playing';
  ui.hide();
  ui.setPauseButton(true);
  input.releaseAll();
  tryLockLandscape();
  warmOfflineCache();
}

/** Ask the service worker to fetch the other landscape paintings quietly, so the whole journey works offline. */
let warmed = false;
function warmOfflineCache() {
  if (warmed || !('serviceWorker' in navigator)) return;
  warmed = true;
  setTimeout(() => navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage({ type: 'warm' })).catch(() => {}), 15000);
}

function onGameAction(a) {
  actionLog.push(a);
  run.lastAction = a; run.lastActionT = run.t;
  if (a === 'jump' && run.jumpY === 0) { run.jumpV = 560; run.eggs += 1; run.score += T.scoreEgg; }
}

/* ───────── ui ───────── */
const ui = createUI({
  root: document.getElementById('ui'),
  onAction(name, payload) {
    switch (name) {
      case 'play': case 'continue': case 'retry': startRun(); break;
      case 'resume': case 'rotate-continue': mode = 'playing'; ui.hide(); ui.setPauseButton(true); input.releaseAll(); break;
      case 'pause': pauseGame(); break;
      case 'title': showTitle(); break;
      case 'keep-going': save = saveAt(save, { circuit: (save?.circuit || 1) + 1, chapter: 0, flag: 0, carry: run, beaconLit: true }); writeSave(storage, save); startRun(); break;
      case 'confirm-start-over': save = newJourney(randomSeed()); writeSave(storage, save); showTitle(); break;
      case 'sound': settings = { ...settings, muted: payload.muted }; writeSettings(storage, settings); ui.setMuted(settings.muted); break;
      case 'tap-to-jump': settings = { ...settings, tapToJump: payload.tapToJump }; input.tapToJump = payload.tapToJump; writeSettings(storage, settings); break;
      case 'fullscreen': toggleFullscreen(); break;
      default: break;                      // journal, help, close, start-over, cancel-start-over: the ui handles its own navigation
    }
  },
});
ui.setMuted(settings.muted);
ui.setSettings({ tapToJump: settings.tapToJump });

function titleData() { return { save, best: settings.best }; }
function pauseData() {
  return { eggs: run.eggs, score: run.score, flock: run.flock, circuit: save?.circuit || 1, chapter: save?.chapter || 0, progress: run.playSeconds / JOURNEY_SECONDS, playSeconds: run.playSeconds };
}
function showTitle() { mode = 'title'; ui.setPauseButton(false); ui.show('title', titleData()); }
function pauseGame() { if (mode !== 'playing') return; mode = 'paused'; ui.show('pause', pauseData()); }

/* ───────── input ───────── */
const input = new Input(stage, {
  onAction: onGameAction,
  onPause: () => { if (mode === 'playing') pauseGame(); else if (mode === 'paused') { mode = 'playing'; ui.hide(); ui.setPauseButton(true); input.releaseAll(); } },
  onMute: () => { settings = { ...settings, muted: !settings.muted }; writeSettings(storage, settings); ui.setMuted(settings.muted); },
  isActive: () => mode === 'playing',
  onFirstGesture: tryLockLandscape,
});
input.tapToJump = settings.tapToJump;

// PLACEHOLDER-only debug keys to reach the dead / finish screens
window.addEventListener('keydown', (e) => {
  if (mode !== 'playing') return;
  if (e.key === 'k') { mode = 'dead'; ui.show('dead', { ...pauseData(), newBest: true }); }
  if (e.key === 'b') { mode = 'finish'; ui.show('finish', pauseData()); }
});

/* ───────── orientation (VIEW-4) ───────── */
function checkOrientation() {
  const portrait = stage.clientHeight > stage.clientWidth;
  if (portrait && mode !== 'rotate') {
    rotateReturn = { mode, screen: ui.current, data: ui.current ? undefined : null };
    mode = 'rotate';
    input.releaseAll();
    ui.show('rotate', { phase: 'prompt' });
  } else if (!portrait && mode === 'rotate') {
    if (rotateReturn && rotateReturn.mode === 'playing') {
      ui.show('rotate', { phase: 'ready' });          // the player decides when the run resumes
    } else {
      const back = rotateReturn ? rotateReturn.mode : 'title';
      if (back === 'paused') { mode = 'paused'; ui.show('pause', pauseData()); } else showTitle();
    }
  }
}

function tryLockLandscape() {
  try { const p = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch { /* best effort */ }
}
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
  } catch { /* not available on this browser */ }
}

/* ───────── canvas: always exactly the stage rectangle ───────── */
let view = { w: 0, h: 0, dpr: 1 };
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  while (w * h * dpr * dpr > 3.6e6 && dpr > 1) dpr -= 0.25;     // cap pixels so big phones stay smooth
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  view = { w, h, dpr };
  checkOrientation();
}
new ResizeObserver(resize).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(resize, 50));
window.visualViewport && window.visualViewport.addEventListener('resize', resize);

/* ───────── the test scene ───────── */
const bg = new Image();
bg.src = CHAPTERS[0].bg;

function paint(now) {
  const { w, h, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CHAPTERS[0].palette.sky;
  ctx.fillRect(0, 0, w, h);
  if (bg.complete && bg.naturalWidth) {
    // the pixel painting, cover-fitted, crisp, drifting very slowly (T.backgroundParallax)
    ctx.imageSmoothingEnabled = false;
    const s = Math.max(w / bg.naturalWidth, h / bg.naturalHeight) * 1.08;
    const iw = bg.naturalWidth * s, ih = bg.naturalHeight * s;
    const slack = iw - w;
    const x = -(slack * 0.5 + Math.sin(run.drift * T.backgroundParallax * 0.02) * slack * 0.5);
    ctx.drawImage(bg, x, h - ih, iw, ih);
  }
  // ground band and a rocking egg that stands in for Mama
  const k = h / T.viewH;
  const gy = T.groundY * k, mx = w * T.mamaScreenX;
  ctx.fillStyle = '#6fbf48'; ctx.fillRect(0, gy, w, h - gy);
  ctx.fillStyle = '#4c9a3a'; ctx.fillRect(0, gy, w, 3 * k);
  const rock = Math.sin(run.t * 5) * 0.08 * (mode === 'playing' ? 1 : 0.2);
  ctx.save();
  ctx.translate(mx, gy - run.jumpY * k);
  ctx.rotate(rock);
  ctx.scale(k, k);
  eggPath(ctx, 0, -22, 17, 22);
  volumeFill(ctx, '#fff1cd', -17, -44, 17, 0);
  ctx.lineWidth = 2; ctx.strokeStyle = outline('#e8c88a'); eggPath(ctx, 0, -22, 17, 22); ctx.stroke();
  ctx.fillStyle = '#3a2618'; ctx.beginPath(); ctx.ellipse(6, -26, 2.4, 3.4, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#ff9a2e'; ctx.beginPath(); ctx.moveTo(12, -20); ctx.lineTo(20, -17); ctx.lineTo(12, -14); ctx.fill();
  ctx.restore();
  // what the input just classified (PLACEHOLDER feedback)
  if (run.t - run.lastActionT < 0.6 && run.lastAction) {
    ctx.fillStyle = rgba('#ffffff', 1 - (run.t - run.lastActionT) / 0.6);
    ctx.font = `900 ${Math.round(26 * k)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(run.lastAction.toUpperCase(), w / 2, h * 0.3);
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(T.maxFrame, (now - last) / 1000);
  last = now;
  if (mode === 'playing') {
    run.t += dt; run.playSeconds += dt; run.drift += dt * T.cruise;
    if (run.jumpV !== 0 || run.jumpY > 0) {
      run.jumpV -= T.gravity * dt; run.jumpY += run.jumpV * dt;
      if (run.jumpY <= 0) { run.jumpY = 0; run.jumpV = 0; }
    }
  } else run.t += dt * 0.25;
  paint(now);
  requestAnimationFrame(frame);
}

// pause when the tab is hidden or the page loses the screen (DESIGN §11)
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
window.addEventListener('pagehide', pauseGame);

/* ───────── service worker (offline play) ───────── */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // On localhost the worker would serve stale files while someone is editing; opt in with ?sw
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && !/[?&]sw\b/.test(location.search)) return;
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => { /* offline play is a bonus, never an error */ });
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
}

/* ───────── go ───────── */
resize();
if (mode !== 'rotate') showTitle();
requestAnimationFrame(frame);
registerServiceWorker();

// test hooks for tests/e2e/shell-*.mjs (harmless in the real game; the integrator may drop them)
window.__shell = {
  ui, input, actionLog,
  get mode() { return mode; },
  get save() { return save; },
  get settings() { return settings; },
  get view() { return view; },
  run,
  setMode(m) { mode = m; },
  startRun, showTitle, pauseGame,
};
