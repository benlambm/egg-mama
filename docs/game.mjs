import { advance, createRun, MAX_DUCKLINGS, restoreCheckpoint, runScore, saveCheckpoint, STEP, traveled } from "./engine.mjs";
import { CHAPTERS, chapterIndex, loopNumber } from "./chapters.mjs";
import { ArcadeView, paintIcon } from "./art.mjs";
import { ArcadeSound } from "./audio.mjs";
import { SWIPE_JUMP_SECONDS, SWIPE_STEER_SECONDS, swipeDirection } from "./gestures.mjs";

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "arcade", "viewport", "world", "score", "eggs", "best-score", "zone", "distance", "flock", "chapter-progress",
  "sound", "pause", "fullscreen", "play", "resume", "retry", "pause-home", "home", "intro", "paused",
  "game-over", "notice", "power-status", "result-score", "result-eggs", "result-distance", "new-record",
  "show-help", "close-help", "help", "show-journal", "close-journal", "journal", "journal-progress", "chapter-list",
  "start-over", "confirm-reset", "cancel-reset", "reset", "play-label", "save-label",
  "chapter-story", "story-kicker", "story-name", "story-text", "finish", "finish-story", "keep-going", "finish-home",
].map((id) => [id, byId(id)]));
const touchButtons = Array.from(document.querySelectorAll("[data-input]"));
const flockIcons = Array.from(elements.flock.querySelectorAll("canvas"));
document.querySelectorAll("[data-icon]").forEach((canvas) => paintIcon(canvas));
const view = new ArcadeView(elements.world, elements.viewport);

function readStore(key, fallback) {
  try { return localStorage.getItem(`egg-hero-${key}`) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(`egg-hero-${key}`, String(value)); } catch {}
}

const audio = new ArcadeSound(readStore("sound", "on") !== "off");
let best = Math.max(0, Number(readStore("best", 0)) || 0);
let bestAtStart = best;
let mode = "intro";
let run = null;
let panel = null;
let resumeAfterPanel = false;
let panelFocus = null;
let noticeUntil = 0;
let chapterUntil = 0;
let checkpointJson = readStore("journey-v1", null);
if (!readJourney()) checkpointJson = null;
let previous = performance.now();
let accumulator = 0;
let previousFlock = 0;
let lastStage = 0;
let previousScore = -1;
let previousEggs = -1;
let previousDistance = -1;

const keys = new Set();
const pointers = new Map();
const swipes = new Map();
let swipeSteer = null;
let swipeSteerUntil = 0;
let swipeJumpUntil = 0;
const bindings = new Map([
  ["KeyA", "left"], ["ArrowLeft", "left"], ["KeyD", "right"], ["ArrowRight", "right"],
  ["Space", "jump"], ["KeyW", "jump"], ["ArrowUp", "jump"],
  ["ShiftLeft", "sprint"], ["ShiftRight", "sprint"],
]);
const controls = { left: false, right: false, jump: false, sprint: false, jumpPressed: false, autoRoll: true };
elements.world.tabIndex = -1;

function updateInput() {
  const previousJump = controls.jump;
  controls.left = controls.right = controls.jump = controls.sprint = false;
  for (const key of keys) controls[bindings.get(key)] = true;
  for (const input of pointers.values()) controls[input] = true;
  if (swipeSteer && run?.time < swipeSteerUntil && !controls.left && !controls.right) controls[swipeSteer] = true;
  if (run?.time < swipeJumpUntil) controls.jump = true;
  if (controls.jump && !previousJump) controls.jumpPressed = true;
  for (const button of touchButtons) button.classList.toggle("pressed", Array.from(pointers.values()).includes(button.dataset.input));
}

function clearInput() {
  keys.clear();
  pointers.clear();
  swipes.clear();
  swipeSteer = null;
  swipeSteerUntil = 0;
  swipeJumpUntil = 0;
  controls.jumpPressed = false;
  updateInput();
}

function readJourney() {
  if (!checkpointJson) return null;
  try { return restoreCheckpoint(JSON.parse(checkpointJson)); } catch { return null; }
}

function saveJourney() {
  checkpointJson = JSON.stringify(saveCheckpoint(run));
  writeStore("journey-v1", checkpointJson);
}

function digit(value, n = 6) {
  return String(value).padStart(n, "0");
}

function refreshHud() {
  const score = run ? runScore(run) : 0;
  const eggs = run?.collected ?? 0;
  const meters = run ? traveled(run) : 0;
  const flock = run?.ducklings ?? 0;
  const stage = run?.stage ?? 0;
  if (score > best) best = score;
  if (score !== previousScore) {
    elements.score.textContent = digit(score);
    elements["best-score"].textContent = digit(best);
    previousScore = score;
  }
  if (eggs !== previousEggs) {
    elements.eggs.textContent = digit(eggs, 2);
    elements.eggs.setAttribute("aria-label", `${eggs} ${eggs === 1 ? "egg" : "eggs"}`);
    previousEggs = eggs;
  }
  if (meters !== previousDistance) {
    elements.distance.textContent = `${meters} m`;
    previousDistance = meters;
  }
  if (stage !== lastStage) {
    const index = chapterIndex(stage);
    elements.zone.textContent = CHAPTERS[index].name;
    elements["chapter-progress"].textContent = `${digit(index + 1, 2)}/${CHAPTERS.length}`;
    lastStage = stage;
  }
  if (flock !== previousFlock) {
    flockIcons.forEach((icon, i) => paintIcon(icon, i < flock ? "duckling" : "duckling-empty"));
    elements.flock.setAttribute("aria-label", `${flock} of ${MAX_DUCKLINGS} duckling extra lives`);
    previousFlock = flock;
  }
  elements.notice.hidden = !(mode === "playing" && !panel && noticeUntil > run?.time);
  elements["chapter-story"].hidden = !(mode === "playing" && !panel && chapterUntil > run?.time);
  const powers = [];
  if (run?.shield) powers.push("Shield");
  if (run?.magnet > 0) powers.push(`Magnet ${Math.ceil(run.magnet)}s`);
  const powerText = powers.join(" + ");
  elements["power-status"].hidden = mode !== "playing" || !powerText;
  if (elements["power-status"].textContent !== powerText) elements["power-status"].textContent = powerText;
}

function showNotice(label, duration = 1.65) {
  elements.notice.textContent = label;
  noticeUntil = run.time + duration;
}

function showChapter() {
  const index = chapterIndex(run.stage);
  const chapter = CHAPTERS[index];
  const loop = loopNumber(run.stage);
  elements["story-kicker"].textContent = loop > 1
    ? `Loop ${loop} · Chapter ${index + 1} of ${CHAPTERS.length}`
    : `Chapter ${index + 1} of ${CHAPTERS.length}`;
  elements["story-name"].textContent = chapter.name;
  elements["story-text"].textContent = loop > 1 && index === 0
    ? "The beacon is still shining. Take the flock back through the valley to look for more eggs."
    : chapter.story;
  chapterUntil = run.time + 5.5;
}

function syncTitle() {
  const saved = readJourney();
  elements["start-over"].hidden = !saved;
  elements["play-label"].textContent = saved ? "Continue" : "Start journey";
  elements["save-label"].hidden = !saved;
  if (saved) {
    const index = chapterIndex(saved.stage);
    const loop = loopNumber(saved.stage);
    const label = loop > 1 ? ` · Loop ${loop}` : "";
    elements["save-label"].textContent = `Saved at ${CHAPTERS[index].name} · Chapter ${index + 1} of ${CHAPTERS.length}${label}`;
  }
}

function showMode() {
  elements.intro.hidden = mode !== "intro" || Boolean(panel);
  elements.paused.hidden = mode !== "paused" || Boolean(panel);
  elements["game-over"].hidden = mode !== "over" || Boolean(panel);
  elements.finish.hidden = mode !== "finish" || Boolean(panel);
  for (const id of ["help", "journal", "reset"]) elements[id].hidden = panel !== id;
  elements["show-help"].setAttribute("aria-expanded", String(panel === "help"));
  elements["show-journal"].setAttribute("aria-expanded", String(panel === "journal"));
  elements.pause.disabled = Boolean(panel) || (mode !== "playing" && mode !== "paused");
  const pauseLabel = mode === "paused" ? "Resume" : "Pause";
  elements.pause.setAttribute("aria-label", pauseLabel);
  elements.pause.title = `${pauseLabel} (P or Esc)`;
  paintIcon(elements.pause.querySelector("canvas"), mode === "paused" ? "play" : "pause");
  touchButtons.forEach((button) => { button.disabled = mode !== "playing" || Boolean(panel); });
  if (mode === "intro") syncTitle();
  refreshHud();
}

function focus(element) {
  element.focus({ preventScroll: true });
}

function storeBest() {
  writeStore("best", best);
}

function startGame(reset = false) {
  storeBest();
  bestAtStart = best;
  clearInput();
  const continued = reset ? null : readJourney();
  run = continued ?? createRun();
  if (!continued) saveJourney();
  view.reset(chapterIndex(run.stage));
  noticeUntil = 0;
  if (run.beaconsLit === loopNumber(run.stage)) {
    showNotice("Beacon relit · Keep going for another circuit", 3);
    chapterUntil = 0;
  } else {
    showChapter();
  }
  accumulator = 0;
  mode = "playing";
  panel = null;
  audio.ready();
  audio.reset();
  audio.effect({ kind: "start" });
  showMode();
  focus(elements.world);
}

function goHome() {
  storeBest();
  clearInput();
  audio.pauseMusic();
  run = null;
  mode = "intro";
  view.reset();
  noticeUntil = 0;
  chapterUntil = 0;
  showMode();
  focus(elements.play);
}

function pauseGame(setFocus = true) {
  if (mode !== "playing") return;
  clearInput();
  audio.pauseMusic();
  mode = "paused";
  storeBest();
  showMode();
  if (setFocus) focus(elements.resume);
}

function resumeGame() {
  mode = "playing";
  accumulator = 0;
  audio.ready();
  showMode();
  focus(elements.world);
}

function endGame() {
  refreshHud();
  storeBest();
  clearInput();
  audio.pauseMusic();
  mode = "over";
  elements["new-record"].hidden = bestAtStart >= runScore(run);
  elements["result-score"].textContent = runScore(run).toLocaleString();
  elements["result-eggs"].textContent = run.collected.toLocaleString();
  elements["result-distance"].textContent = `${traveled(run).toLocaleString()} m`;
  showMode();
  focus(elements.retry);
}

function finishCircuit() {
  clearInput();
  audio.pauseMusic();
  storeBest();
  mode = "finish";
  chapterUntil = 0;
  const count = run.collected.toLocaleString();
  const eggs = run.collected === 1 ? "egg" : "eggs";
  elements["finish-story"].textContent = `The beacon lit the way home. You’ve recovered ${count} ${eggs} so far. Keep going for another circuit through all ${CHAPTERS.length} chapters.`;
  showMode();
  focus(elements["keep-going"]);
}

function renderJournal() {
  const journey = run ?? readJourney();
  const stage = journey?.stage ?? 0;
  const current = chapterIndex(stage);
  const visited = Math.min(stage + 1, CHAPTERS.length);
  const loop = loopNumber(stage);
  const lit = journey?.beaconsLit ?? 0;
  elements["journal-progress"].textContent = `${visited} of ${CHAPTERS.length} chapters reached${lit ? ` · Beacon relit ${lit}×` : ""}${loop > 1 ? ` · Loop ${loop}` : ""}`;
  const cards = CHAPTERS.map((chapter, index) => {
    const item = document.createElement("li");
    const number = document.createElement("span");
    number.className = "chapter-number";
    number.textContent = digit(index + 1, 2);
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = chapter.name;
    item.append(number);
    if (index < visited) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.src = new URL(`./assets/${chapter.asset}.webp`, import.meta.url);
      item.append(image);
      const text = document.createElement("p");
      text.textContent = chapter.story;
      detail.append(title, text);
      if (index === current) item.setAttribute("aria-current", "step");
    } else {
      item.classList.add("unvisited");
      detail.append(title);
    }
    item.append(detail);
    return item;
  });
  elements["chapter-list"].replaceChildren(...cards);
}

function closePanel() {
  if (!panel) return;
  panel = null;
  if (resumeAfterPanel && mode === "paused") resumeGame();
  else {
    showMode();
    focus(panelFocus instanceof HTMLElement ? panelFocus : elements.play);
  }
}

function openPanel(which, source) {
  if (panel === which) {
    closePanel();
    return;
  }
  if (!panel) {
    resumeAfterPanel = mode === "playing";
    panelFocus = source;
    pauseGame(false);
  }
  panel = which;
  if (which === "journal") renderJournal();
  showMode();
  const closeId = which === "reset" ? "cancel-reset" : `close-${which}`;
  focus(elements[closeId]);
}

function togglePause() {
  if (panel) closePanel();
  else if (mode === "playing") pauseGame();
  else if (mode === "paused") resumeGame();
}

function syncAudioButton() {
  const action = audio.enabled ? "Mute sound" : "Unmute sound";
  elements.sound.setAttribute("aria-label", action);
  elements.sound.setAttribute("aria-pressed", String(!audio.enabled));
  elements.sound.title = `${action} (M)`;
  paintIcon(elements.sound.querySelector("canvas"), audio.enabled ? "sound" : "sound-off");
}

function toggleSound() {
  audio.setEnabled(!audio.enabled);
  writeStore("sound", audio.enabled ? "on" : "off");
  syncAudioButton();
}

function isExpanded() {
  return document.fullscreenElement === elements.arcade || elements.arcade.classList.contains("theater");
}

function syncFullscreenButton() {
  const expanded = isExpanded();
  const label = expanded ? "Exit fullscreen" : "Fullscreen";
  elements.fullscreen.setAttribute("aria-label", label);
  elements.fullscreen.setAttribute("aria-pressed", String(expanded));
  elements.fullscreen.title = `${label} (F)`;
  paintIcon(elements.fullscreen.querySelector("canvas"), expanded ? "fullscreen-off" : "fullscreen");
}

function setTheater(enabled) {
  elements.arcade.classList.toggle("theater", enabled);
  document.body.classList.toggle("theater-open", enabled);
  syncFullscreenButton();
}

async function toggleFullscreen() {
  if (document.fullscreenElement === elements.arcade) {
    await document.exitFullscreen().catch(() => {});
  } else if (isExpanded()) {
    setTheater(false);
  } else if (elements.arcade.requestFullscreen && document.fullscreenEnabled) {
    try {
      await elements.arcade.requestFullscreen();
    } catch {
      setTheater(true);
    }
  } else {
    setTheater(true);
  }
  syncFullscreenButton();
}

elements.play.addEventListener("click", () => startGame());
elements.retry.addEventListener("click", () => startGame());
elements["pause-home"].addEventListener("click", goHome);
elements["start-over"].addEventListener("click", () => openPanel("reset", elements["start-over"]));
elements["cancel-reset"].addEventListener("click", closePanel);
elements["confirm-reset"].addEventListener("click", () => startGame(true));
elements.resume.addEventListener("click", resumeGame);
elements.home.addEventListener("click", goHome);
elements["finish-home"].addEventListener("click", goHome);
elements["keep-going"].addEventListener("click", resumeGame);
elements.pause.addEventListener("click", togglePause);
elements.sound.addEventListener("click", (event) => {
  toggleSound();
  if (event.detail && mode === "playing") focus(elements.world);
});
elements.fullscreen.addEventListener("click", async (event) => {
  await toggleFullscreen();
  if (event.detail && mode === "playing") focus(elements.world);
});
elements["show-help"].addEventListener("click", () => openPanel("help", elements["show-help"]));
elements["show-journal"].addEventListener("click", () => openPanel("journal", elements["show-journal"]));
elements["close-help"].addEventListener("click", closePanel);
elements["close-journal"].addEventListener("click", closePanel);
document.addEventListener("fullscreenchange", syncFullscreenButton);

for (const button of touchButtons) {
  button.addEventListener("pointerdown", (event) => {
    if (mode !== "playing" || panel || event.button > 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, button.dataset.input);
    updateInput();
  });
  const release = (event) => {
    if (pointers.delete(event.pointerId)) updateInput();
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

elements.world.addEventListener("pointerdown", (event) => {
  if (mode !== "playing" || panel || event.button !== 0) return;
  event.preventDefault();
  elements.world.setPointerCapture(event.pointerId);
  swipes.set(event.pointerId, { x: event.clientX, y: event.clientY });
});

elements.world.addEventListener("pointermove", (event) => {
  const start = swipes.get(event.pointerId);
  if (!start) return;
  const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y, elements.viewport.clientHeight);
  if (!direction) return;
  swipes.delete(event.pointerId);
  if (direction === "jump") {
    swipeJumpUntil = run.time + SWIPE_JUMP_SECONDS;
    controls.jumpPressed = true;
  } else {
    swipeSteer = direction;
    swipeSteerUntil = run.time + SWIPE_STEER_SECONDS;
  }
  updateInput();
});

for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  elements.world.addEventListener(type, (event) => swipes.delete(event.pointerId));
}

window.addEventListener("keydown", (event) => {
  const code = event.code;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const buttonFocus = event.target instanceof HTMLButtonElement;
  if (bindings.has(code) && mode === "playing" && !panel && !(buttonFocus && code === "Space")) {
    event.preventDefault();
    keys.add(code);
    updateInput();
    return;
  }
  if (event.repeat) return;
  if (code === "KeyP" || code === "Escape") {
    if (code === "Escape" && isExpanded() && document.fullscreenElement !== elements.arcade && !panel) setTheater(false);
    else togglePause();
    event.preventDefault();
  } else if (code === "KeyJ") {
    openPanel("journal", elements["show-journal"]);
  } else if (code === "KeyM") {
    toggleSound();
  } else if (code === "KeyF") {
    void toggleFullscreen();
  } else if (!buttonFocus && !panel && (code === "Enter" || code === "Space") && (mode === "intro" || mode === "over")) {
    event.preventDefault();
    startGame();
  }
});
window.addEventListener("keyup", (event) => {
  if (keys.delete(event.code)) updateInput();
});
window.addEventListener("blur", () => {
  clearInput();
  pauseGame(false);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInput();
    pauseGame(false);
    storeBest();
  }
});
window.addEventListener("pagehide", storeBest);

const notices = {
  shield: "Shell shield",
  "shield-break": "Shield used",
  magnet: "Egg magnet",
  "duckling-used": "One duckling went home",
  recover: "Back at checkpoint",
  checkpoint: "Checkpoint saved",
};
const compact = window.matchMedia("(max-width: 700px) and (orientation: portrait)");
function frame(now) {
  const elapsed = Math.min((now - previous) / 1000, 0.05);
  previous = now;
  if (mode === "playing") {
    if (swipeJumpUntil && run.time >= swipeJumpUntil) {
      swipeJumpUntil = 0;
      updateInput();
    }
    if (swipeSteer && run.time >= swipeSteerUntil) {
      swipeSteer = null;
      updateInput();
    }
    accumulator += elapsed;
    while (accumulator >= STEP && !run.over) {
      advance(run, controls, STEP, view.width);
      accumulator -= STEP;
    }
    let completed = false;
    for (const event of run.events) {
      view.effect(event);
      audio.effect(event);
      if (event.kind === "gate") showChapter();
      if (event.kind === "beacon") completed = true;
      if (event.kind === "gate" || event.kind === "beacon" || event.kind === "checkpoint") {
        if (!run.over) saveJourney();
      }
      if (notices[event.kind]) showNotice(notices[event.kind]);
    }
    run.events.length = 0;
    if (run.over) endGame();
    else if (completed) finishCircuit();
    else audio.music(run.stage);
    refreshHud();
  }
  if (mode === "intro") view.attract(now / 1000, compact.matches || view.width < 270);
  else view.play(run, mode === "playing" ? elapsed : 0);
  requestAnimationFrame(frame);
}

syncAudioButton();
syncFullscreenButton();
showMode();
requestAnimationFrame(frame);
