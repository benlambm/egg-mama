/*
 * Egg Mama — the DOM menus (DESIGN.md §10).
 *
 *   const ui = createUI({ root, onAction(name, payload) });   // root = #ui (or #stage, which contains #ui)
 *   ui.show(screen, data)   ui.hide()   ui.setPauseButton(bool)   ui.setMuted(bool)
 *   ui.setSettings({ tapToJump, muted })   ui.current (screen name | null)   ui.insets()
 *
 * Screens (each a <section data-screen> + role=dialog): title, pause, dead, finish, rotate, journal, help,
 * reset-confirm. Menus are light cards on a translucent scrim so the live scene shows through; they are
 * sized in `--u` (~1 % of the viewport height) so they fit 640x300 and still look right on 915x412.
 *
 * ── data each screen understands (everything optional; missing numbers show as 0) ──────────────
 *   title          { save: Save|null, best?: {score, eggs} }   save present -> "Continue" + where; absent -> "Play"
 *   pause          { eggs, score, flock, circuit, chapter, progress (0..1 of the circuit), playSeconds }
 *   dead           { eggs, score, flock, circuit, chapter, newBest? }
 *   finish         { eggs, score, flock, circuit (the circuit just completed) }
 *   rotate         { phase: 'prompt' | 'ready' }
 *   journal        { circuit, chapter, reached:{circuit, chapter} }     (defaults come from the screen beneath it)
 *   help           {}
 *   reset-confirm  { save }                                             (defaults come from the title beneath it)
 * Numbers may also arrive as a `save` / `carry` object: { eggs, score, flock, circuit, chapter } is read from
 * data.save, data.carry or data directly.
 *
 * ── actions sent to onAction(name, payload) ─────────────────────────────────────────────────────
 *   play continue start-over confirm-start-over cancel-start-over resume pause title retry keep-going
 *   journal help sound tap-to-jump rotate-continue close fullscreen
 * The ui already handles its own navigation: `journal`, `help` and `start-over` open their sheet over the
 * current screen, and `close` / `cancel-start-over` (or Esc) return to the screen beneath. onAction is
 * still called for each, so main can play a sound; calling ui.show() again for the same screen is harmless.
 * `sound` and `tap-to-jump` flip their switch optimistically and report { muted } / { tapToJump }; main
 * persists the setting and may call setMuted()/setSettings() to confirm. `fullscreen` is main's to perform.
 * The ui calls onAction synchronously from the click, so main can unlock audio inside the user gesture.
 */
import { CHAPTERS, CIRCUIT_STORY, JOURNEY_SECONDS } from './chapters.mjs';
import { T } from './tuning.mjs';

const SCREENS = ['title', 'pause', 'dead', 'finish', 'rotate', 'journal', 'help', 'reset-confirm'];
const SHEETS = new Set(['journal', 'help', 'reset-confirm']);   // open over another screen; closing returns to it
const FADE_MS = 240;                                           // keep in sync with --fade in style.css
// "Oh no!" and "The beacon is lit!" pop up in the middle of play, while a child may be tapping like mad (tap-to-jump is
// on). Presses on their buttons in the first moments are those leftover taps, not a choice: ignore them.
const GUARDED = new Set(['dead', 'finish']);
const GUARD_MS = 320;
const DOUBLE_TAP_MS = 420, DOUBLE_TAP_PX = 56;                    // a second tap this soon and this close, on another button, after a screen change, is a double-tap

/* ───────────────────────── small helpers ───────────────────────── */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (n) => Math.max(0, Math.floor(num(n))).toLocaleString('en-US');
const NAMES = CHAPTERS.map((c) => c.name);

/** Seconds -> "just started" / "14 min" / "1 h 12 min". */
function playedLabel(seconds) {
  const m = Math.floor(num(seconds) / 60);
  if (m < 1) return 'just started';
  if (m < 60) return `${m} min played`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min played`;
}

/** Cumulative end of each landscape as a fraction of the whole circuit (by clean-run seconds). */
const CUM = (() => { let acc = 0; return CHAPTERS.map((c) => (acc += c.seconds) / JOURNEY_SECONDS); })();

/** Read the first defined value from several data objects, looking in data / data.save / data.carry. */
function pick(sources, key) {
  for (const s of sources) {
    if (!s) continue;
    for (const o of [s, s.save, s.carry]) if (o && o[key] !== undefined && o[key] !== null) return o[key];
  }
  return undefined;
}

/** Where is the player? Normalises the many places this can come from. */
function journeyInfo(...sources) {
  const circuit = clamp(Math.floor(num(pick(sources, 'circuit'), 1)), 1, 999);
  const chapter = clamp(Math.floor(num(pick(sources, 'chapter'), 0)), 0, CHAPTERS.length - 1);
  const r = pick(sources, 'reached');
  const reached = r && Number.isFinite(r.circuit) && Number.isFinite(r.chapter) ? { circuit: r.circuit, chapter: r.chapter } : { circuit, chapter };
  return { circuit, chapter, reached, name: NAMES[chapter] };
}
/** Has landscape i been reached on this journey? (Finishing circuit 1 unlocks them all.) */
const isUnlocked = (info, i) => info.reached.circuit > 1 || i <= Math.max(info.reached.chapter, info.chapter);
const totals = (...sources) => ({
  eggs: num(pick(sources, 'eggs')), score: num(pick(sources, 'score')),
  flock: clamp(Math.floor(num(pick(sources, 'flock'))), 0, T.maxFlock),
});

/* ───────────────────────── icons ───────────────────────── */
// One hidden sprite sheet; every icon below is <svg class="ico"><use href="#i-name"/></svg>.
// Colourful ones follow the game's look (warm upper-left light, outline = dark shade of its own colour);
// monochrome ones use currentColor so buttons can tint them.

const SPRITE = `
<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>
  <radialGradient id="g-egg" cx=".34" cy=".3" r=".85"><stop offset="0" stop-color="#fffdf3"/><stop offset=".45" stop-color="#fff0cb"/><stop offset="1" stop-color="#f0d29a"/></radialGradient>
  <radialGradient id="g-gold" cx=".34" cy=".3" r=".9"><stop offset="0" stop-color="#fff7b5"/><stop offset=".4" stop-color="#ffd73c"/><stop offset="1" stop-color="#ef9d17"/></radialGradient>
  <radialGradient id="g-chick" cx=".32" cy=".3" r=".9"><stop offset="0" stop-color="#fff39a"/><stop offset=".5" stop-color="#ffd93e"/><stop offset="1" stop-color="#f3ad1c"/></radialGradient>
  <radialGradient id="g-shield" cx=".34" cy=".3" r=".9"><stop offset="0" stop-color="#d7f1ff"/><stop offset=".5" stop-color="#63b5f2"/><stop offset="1" stop-color="#3478d0"/></radialGradient>
  <radialGradient id="g-cap" cx=".34" cy=".28" r=".95"><stop offset="0" stop-color="#ff9a86"/><stop offset=".5" stop-color="#ec4f43"/><stop offset="1" stop-color="#b92f35"/></radialGradient>
  <linearGradient id="g-stone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2bd94"/><stop offset="1" stop-color="#b98c68"/></linearGradient>
  <radialGradient id="g-face" cx=".36" cy=".28" r=".95"><stop offset="0" stop-color="#fffef6"/><stop offset=".5" stop-color="#fff3d2"/><stop offset="1" stop-color="#efcf95"/></radialGradient>
</defs>
<symbol id="i-egg" viewBox="0 0 32 32"><path d="M16 3.5c5.7 0 10 8.2 10 14.6 0 5.9-4.5 10.4-10 10.4S6 24 6 18.1C6 11.7 10.3 3.5 16 3.5z" fill="url(#g-egg)" stroke="#a97b45" stroke-width="1.8" stroke-linejoin="round"/><g fill="#d9a766"><circle cx="12.3" cy="18" r="1.2"/><circle cx="19.6" cy="21.4" r="1.1"/><circle cx="18.6" cy="13.2" r=".95"/><circle cx="13.6" cy="23.2" r=".8"/></g><path d="M11.2 10.4c.9-2.2 2.2-3.7 3.8-4.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity=".85"/></symbol>
<symbol id="i-gold" viewBox="0 0 32 32"><path d="M16 2.6c1.2 0 2.3 1.2 3.3 2.8 3.9 3.3 6.7 8.3 6.7 13.1 0 5.8-4.5 10-10 10S6 24.3 6 18.5c0-4.8 2.8-9.8 6.7-13.1 1-1.6 2.1-2.8 3.3-2.8z" fill="url(#g-gold)" stroke="#b8730c" stroke-width="2" stroke-linejoin="round"/><path d="M16 14.5l2.4 3.4-2.4 3.4-2.4-3.4z" fill="#fff6c4" opacity=".9"/><path d="M10.6 12.2c.8-2.4 2.3-4.1 4.1-5.1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".85"/><path d="M25.2 2.2l1.1 2.8 2.8 1.1-2.8 1.1-1.1 2.8-1.1-2.8-2.8-1.1 2.8-1.1z" fill="#fff" stroke="#f0b323" stroke-width=".9" stroke-linejoin="round"/></symbol>
<symbol id="i-duck" viewBox="0 0 32 32"><path d="M11.6 28.4v2M17.2 28.4v2" stroke="#e8801e" stroke-width="2.2" stroke-linecap="round"/><ellipse cx="14.8" cy="19" rx="10.6" ry="9.6" fill="url(#g-chick)" stroke="#b98a10" stroke-width="1.9"/><path d="M12.6 9.8c-.7-2.7 1.5-3.8 2.6-2.3.5-2.8 3.8-2.3 3.1.6" fill="none" stroke="#c28a10" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M23.6 17.2l5.6 2.2-5.6 2.4z" fill="#ff9a2e" stroke="#c4630d" stroke-width="1.5" stroke-linejoin="round"/><circle cx="19.8" cy="16" r="1.8" fill="#3a2618"/><circle cx="20.4" cy="15.3" r=".65" fill="#fff"/><path d="M6.8 20c2.6 3.9 8.2 4.3 10.6.8" fill="#ffd13a" stroke="#c28a10" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-duck-off" viewBox="0 0 32 32"><ellipse cx="14.8" cy="19" rx="10.6" ry="9.6" fill="rgba(80,50,20,.12)" stroke="rgba(110,76,40,.38)" stroke-width="1.9" stroke-dasharray="3 3"/><path d="M12.6 9.8c-.7-2.7 1.5-3.8 2.6-2.3.5-2.8 3.8-2.3 3.1.6" fill="none" stroke="rgba(110,76,40,.32)" stroke-width="1.9" stroke-linecap="round"/><path d="M23.6 17.2l5.6 2.2-5.6 2.4z" fill="rgba(110,76,40,.2)"/></symbol>
<symbol id="i-shield" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12.5" fill="url(#g-shield)" stroke="#1f5aa8" stroke-width="2"/><circle cx="16" cy="16" r="8.6" fill="none" stroke="#fff" stroke-width="1.8" opacity=".75"/><path d="M16 10.2l1.5 3.2 3.5.4-2.6 2.4.7 3.5-3.1-1.7-3.1 1.7.7-3.5-2.6-2.4 3.5-.4z" fill="#fff" opacity=".92"/><path d="M8.6 11.6c1.2-2.4 3.2-4 5.6-4.7" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7" fill="none"/></symbol>
<symbol id="i-magnet" viewBox="0 0 32 32"><path d="M7.5 6v10a8.5 8.5 0 0 0 17 0V6" fill="none" stroke="#7d2a22" stroke-width="8.6" stroke-linejoin="round"/><path d="M7.5 6v10a8.5 8.5 0 0 0 17 0V6" fill="none" stroke="#e5483b" stroke-width="5.4"/><path d="M6.2 12.5V16" stroke="#ff9d8e" stroke-width="1.6" stroke-linecap="round" opacity=".85"/><path d="M4.6 3.8h5.8v6.6H4.6zM21.6 3.8h5.8v6.6h-5.8z" fill="#eef2f7" stroke="#7b8795" stroke-width="1.6" stroke-linejoin="round"/></symbol>
<symbol id="i-spring" viewBox="0 0 32 32"><path d="M12 18h8v8.6c0 1.4-1.5 2.4-4 2.4s-4-1-4-2.4z" fill="#fff0cf" stroke="#a97b45" stroke-width="1.8" stroke-linejoin="round"/><path d="M3.5 18.6C3.5 10.8 9 5 16 5s12.5 5.8 12.5 13.6c0 .9-.7 1.4-1.6 1.4H5.1c-.9 0-1.6-.5-1.6-1.4z" fill="url(#g-cap)" stroke="#8d2a2a" stroke-width="2" stroke-linejoin="round"/><g fill="#fff"><circle cx="11" cy="13.2" r="2.4"/><circle cx="19.6" cy="10.6" r="2"/><circle cx="23" cy="15.6" r="1.7"/></g></symbol>
<symbol id="i-crumble" viewBox="0 0 32 32"><path d="M2.5 9.5h27v9l-3 1.2-2.2 3.2-3-1.9-2.8 3.6-2.6-3-3.2 2.3-2.4-3.4-3.4 1.5-2.6-1.3z" fill="url(#g-stone)" stroke="#6b4a37" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.2 9.5l2.6 4.2-3 3 3.4 3.6M22 9.5l-1.6 3.6 2.4 2.2" fill="none" stroke="#4a3125" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.8 11.2h22.4" stroke="#f3dcbc" stroke-width="1.6" stroke-linecap="round" opacity=".8"/><rect x="23.5" y="25" width="3.8" height="3.2" rx=".9" fill="#b58c6c" stroke="#6b4a37" stroke-width="1.3" transform="rotate(20 25.4 26.6)"/><rect x="9" y="26.2" width="2.8" height="2.4" rx=".7" fill="#b58c6c" stroke="#6b4a37" stroke-width="1.2" transform="rotate(-18 10.4 27.4)"/></symbol>
<symbol id="i-spikes" viewBox="0 0 32 32"><path d="M2.500 27.500l5.500-16 5.500 16zM11.500 27.500l5-20.500 5 20.500zM20.500 27.500l5-14 5 14z" fill="#cfc8e2" stroke="#574a78" stroke-width="1.900" stroke-linejoin="round"/><path d="M7 15.500l-2.500 8M16.500 11l-2.200 9M25 17.500l-2 7" stroke="#fff" stroke-width="1.700" stroke-linecap="round" opacity=".7"/><path d="M1.500 28.500h29" stroke="#574a78" stroke-width="2.200" stroke-linecap="round"/></symbol>
<symbol id="i-snail" viewBox="0 0 32 32"><path d="M2.6 27c0-2.2 1.3-3.8 3.1-3.8h19.8c2.1 0 3.3 1.2 3.3 2.6 0 1.2-1 2.2-2.4 2.2z" fill="#cfe58f" stroke="#6d8a2a" stroke-width="1.8" stroke-linejoin="round"/><circle cx="13.5" cy="15.6" r="8.3" fill="#ffb94b" stroke="#a8631a" stroke-width="1.8"/><path d="M13.5 15.6m-1.3 0a1.3 1.3 0 1 1 2.6 0 3.2 3.2 0 1 1-5.2-2.5 5.2 5.2 0 1 1 7 7.4" fill="none" stroke="#a8631a" stroke-width="1.5" stroke-linecap="round"/><path d="M27 23c.6-3 1.8-5 3-6M24.2 23.2c-.2-2.6.2-4.6 1-6" stroke="#6d8a2a" stroke-width="1.7" stroke-linecap="round" fill="none"/><circle cx="30" cy="16.2" r="1.5" fill="#3a2618"/><circle cx="25.3" cy="16.6" r="1.5" fill="#3a2618"/></symbol>
<symbol id="i-flag" viewBox="0 0 32 32"><path d="M8 4v25" stroke="#7a5638" stroke-width="2.6" stroke-linecap="round"/><path d="M9.4 5.2c4-1.6 7 1.4 11 0 1.6-.6 3-.7 3.8-.5v10.6c-.9.1-2.1.2-3.8.8-4 1.4-7-1.6-11 0z" fill="#ff6f4d" stroke="#a83320" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8" cy="3.6" r="2.1" fill="#ffd23a" stroke="#b8730c" stroke-width="1.2"/></symbol>
<symbol id="i-star" viewBox="0 0 32 32"><path d="M16 3l3.9 8.3 9 1.1-6.6 6.2 1.7 9L16 23.2 8 27.6l1.7-9-6.6-6.2 9-1.1z" fill="#ffc933" stroke="#c07a10" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 9.5l-2.4 4.2" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".75"/></symbol>
<symbol id="i-play" viewBox="0 0 32 32"><path d="M10 6.5v19l16-9.5z" fill="currentColor" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/></symbol>
<symbol id="i-pause" viewBox="0 0 32 32"><rect x="7.5" y="6" width="6.2" height="20" rx="2.2" fill="currentColor"/><rect x="18.3" y="6" width="6.2" height="20" rx="2.2" fill="currentColor"/></symbol>
<symbol id="i-book" viewBox="0 0 32 32"><path d="M16 8c-3-2.2-7.5-2.6-12-1.4v18.4c4.5-1.2 9-.8 12 1.4 3-2.2 7.5-2.6 12-1.4V6.6C23.5 5.4 19 5.8 16 8z" fill="#fff6dd" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M16 8v18.4" stroke="currentColor" stroke-width="2.2"/><path d="M7 11.5c2-.4 4-.2 6 .6M7 16c2-.4 4-.2 6 .6M19 12.1c2-.8 4-1 6-.6M19 16.6c2-.8 4-1 6-.6" stroke="currentColor" opacity=".55" stroke-width="1.7" stroke-linecap="round" fill="none"/></symbol>
<symbol id="i-help" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12.5" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M11.8 12.6c.2-2.6 2.2-4.2 4.5-4.2 2.5 0 4.3 1.6 4.3 3.7 0 3.4-4.2 3.2-4.2 6.6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16.3" cy="23.4" r="1.9" fill="currentColor"/></symbol>
<symbol id="i-sound" viewBox="0 0 32 32"><path d="M4.5 12.4h5.2L16.5 6.6v18.8l-6.8-5.8H4.5z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M20.6 11.2a6.4 6.4 0 0 1 0 9.6M24.2 7.8a11.2 11.2 0 0 1 0 16.4" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round"/></symbol>
<symbol id="i-mute" viewBox="0 0 32 32"><path d="M4.5 12.4h5.2L16.5 6.6v18.8l-6.8-5.8H4.5z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M21.6 12l6.8 8M28.4 12l-6.8 8" fill="none" stroke="currentColor" stroke-width="2.9" stroke-linecap="round"/></symbol>
<symbol id="i-full" viewBox="0 0 32 32"><path d="M5.5 12V5.5H12M20 5.5h6.5V12M26.5 20v6.5H20M12 26.5H5.5V20" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-retry" viewBox="0 0 32 32"><path d="M26.5 16a10.5 10.5 0 1 1-3.3-7.6" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/><path d="M25.8 3.2v7.8h-7.8z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
<symbol id="i-home" viewBox="0 0 32 32"><path d="M4.5 15.8L16 5.8l11.5 10M8 13.6V26.5h6.2v-7h3.6v7H24V13.6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-close" viewBox="0 0 32 32"><path d="M8 8l16 16M24 8L8 24" fill="none" stroke="currentColor" stroke-width="3.8" stroke-linecap="round"/></symbol>
<symbol id="i-lock" viewBox="0 0 32 32"><rect x="6.5" y="13.5" width="19" height="14" rx="3.4" fill="currentColor"/><path d="M10.5 13.5v-3a5.5 5.5 0 0 1 11 0v3" fill="none" stroke="currentColor" stroke-width="3.2"/><circle cx="16" cy="20" r="2.1" fill="rgba(0,0,0,.4)"/></symbol>
<symbol id="i-bulb" viewBox="0 0 32 32"><path d="M16 3.5a8.6 8.6 0 0 0-5 15.6c.9.7 1.4 1.6 1.4 2.6v.8h7.2v-.8c0-1 .5-1.9 1.4-2.6A8.6 8.6 0 0 0 16 3.5z" fill="#ffe27a" stroke="#c28a10" stroke-width="1.9" stroke-linejoin="round"/><path d="M12.6 25.6h6.8M13.6 28.6h4.8" stroke="#9a6a3a" stroke-width="2.2" stroke-linecap="round"/><path d="M12.2 11.4c.6-1.8 1.8-2.8 3.4-3.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity=".85"/></symbol>
<symbol id="i-swipe-up" viewBox="0 0 32 32"><circle cx="16" cy="26" r="3.8" fill="currentColor"/><path d="M16 20.5V7.5M9.5 13.5L16 7l6.5 6.5" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-swipe-left" viewBox="0 0 32 32"><circle cx="26" cy="16" r="3.8" fill="currentColor"/><path d="M20.5 16H7.5M13.5 9.5L7 16l6.5 6.5" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-swipe-right" viewBox="0 0 32 32"><circle cx="6" cy="16" r="3.8" fill="currentColor"/><path d="M11.5 16h13M18.5 9.5L25 16l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-tap" viewBox="0 0 32 32"><circle cx="16" cy="16" r="4.2" fill="currentColor"/><circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="2.5" opacity=".6"/><circle cx="16" cy="16" r="13.4" fill="none" stroke="currentColor" stroke-width="2" opacity=".28"/></symbol>
<symbol id="i-keys" viewBox="0 0 32 32"><rect x="2.5" y="7" width="27" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M7.5 12.5h2.2M12.7 12.5h2.2M17.9 12.5h2.2M23.1 12.5h1.6M9.5 20h13" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></symbol>
<symbol id="i-mama" viewBox="0 0 100 120"><ellipse cx="50" cy="113" rx="28" ry="5.5" fill="rgba(60,30,10,.22)"/><path d="M10.5 82q-9 3-7 15 9 2 17-6z" fill="#fff0c9" stroke="#b78445" stroke-width="3.6" stroke-linejoin="round"/><path d="M89.5 82q9 3 7 15-9 2-17-6z" fill="#fff0c9" stroke="#b78445" stroke-width="3.6" stroke-linejoin="round"/><path d="M50 9c22 0 40 38 40 66 0 23-17 37-40 37S10 98 10 75C10 47 28 9 50 9z" fill="url(#g-face)" stroke="#b78445" stroke-width="4" stroke-linejoin="round"/><path d="M41 14c-3-9 4-12 7-5 1-8 9-9 9-1 5-5 10-1 6 6" fill="#ffd25a" stroke="#c28a10" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/><ellipse cx="27" cy="77" rx="8.5" ry="5.6" fill="#ff8f82" opacity=".55"/><ellipse cx="73" cy="77" rx="8.5" ry="5.6" fill="#ff8f82" opacity=".55"/><g class="eyes-open"><ellipse cx="36" cy="62" rx="5.4" ry="7.4" fill="#3a2618"/><ellipse cx="64" cy="62" rx="5.4" ry="7.4" fill="#3a2618"/><circle cx="38" cy="59" r="2.3" fill="#fff"/><circle cx="66" cy="59" r="2.3" fill="#fff"/></g><path d="M42 73q8-5 16 0-8 11-16 0z" fill="#ff9a2e" stroke="#c4630d" stroke-width="3" stroke-linejoin="round"/><path d="M45.5 74.2q4.5-2 9 0" fill="none" stroke="#ffd08a" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-mama-oops" viewBox="0 0 100 120"><use href="#i-mama"/><path d="M27 52q9-3 16-8M73 52q-9-3-16-8" fill="none" stroke="#6b3d1f" stroke-width="3.4" stroke-linecap="round"/><path d="M80 52q4 7 0 11-4-4 0-11z" fill="#9fdcff" stroke="#4a96d8" stroke-width="1.8" stroke-linejoin="round"/></symbol>
<symbol id="i-mama-joy" viewBox="0 0 100 120"><ellipse cx="50" cy="113" rx="28" ry="5.5" fill="rgba(60,30,10,.22)"/><path d="M10.5 70q-14-3-10-17 11 0 17 9z" fill="#fff0c9" stroke="#b78445" stroke-width="3.6" stroke-linejoin="round"/><path d="M89.5 70q14-3 10-17-11 0-17 9z" fill="#fff0c9" stroke="#b78445" stroke-width="3.6" stroke-linejoin="round"/><path d="M50 9c22 0 40 38 40 66 0 23-17 37-40 37S10 98 10 75C10 47 28 9 50 9z" fill="url(#g-face)" stroke="#b78445" stroke-width="4" stroke-linejoin="round"/><path d="M41 14c-3-9 4-12 7-5 1-8 9-9 9-1 5-5 10-1 6 6" fill="#ffd25a" stroke="#c28a10" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/><ellipse cx="27" cy="77" rx="8.5" ry="5.6" fill="#ff8f82" opacity=".6"/><ellipse cx="73" cy="77" rx="8.5" ry="5.6" fill="#ff8f82" opacity=".6"/><path d="M28 64q8-12 16 0M56 64q8-12 16 0" fill="none" stroke="#3a2618" stroke-width="4.2" stroke-linecap="round"/><path d="M42 73q8-5 16 0-8 11-16 0z" fill="#ff9a2e" stroke="#c4630d" stroke-width="3" stroke-linejoin="round"/><path d="M45.5 74.2q4.5-2 9 0" fill="none" stroke="#ffd08a" stroke-width="2" stroke-linecap="round"/></symbol>
</svg>`;

const ico = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

/* ───────────────────────── reusable pieces ───────────────────────── */

const button = (action, label, { kind = 'soft', icon = '', sub = '', autofocus = false, hero = false } = {}) =>
  `<button type="button" class="btn btn-${kind}${hero ? ' btn-hero' : ''}" data-action="${action}"${autofocus ? ' data-autofocus' : ''}>${icon ? ico(icon, 'btn-ico') : ''}<span class="btn-text"><span class="btn-main">${esc(label)}</span>${sub ? `<span class="btn-sub">${esc(sub)}</span>` : ''}</span></button>`;

/** A switch-style setting button (role=switch). */
const toggle = (action, label, on, iconOn, iconOff) =>
  `<button type="button" class="btn btn-soft btn-toggle" role="switch" aria-checked="${on}" data-action="${action}">${ico(iconOn, 'when-on')}${iconOff ? ico(iconOff, 'when-off') : ''}<span class="btn-main">${esc(label)}</span><span class="sw" aria-hidden="true"><i></i></span></button>`;

const flockRow = (n) => {
  const have = clamp(Math.floor(num(n)), 0, T.maxFlock);
  let out = '';
  for (let i = 0; i < T.maxFlock; i++) out += ico(i < have ? 'duck' : 'duck-off', i < have ? 'has' : 'empty');
  return `<span class="flock" role="img" aria-label="${have} of ${T.maxFlock} ducklings">${out}</span>`;
};

const tally = (t) => `
  <ul class="tally">
    <li class="chip"><span class="chip-ico">${ico('egg')}</span><span class="chip-body"><b>${fmt(t.eggs)}</b><small>eggs</small></span></li>
    <li class="chip"><span class="chip-ico">${ico('star')}</span><span class="chip-body"><b>${fmt(t.score)}</b><small>score</small></span></li>
    <li class="chip chip-flock"><span class="chip-body">${flockRow(t.flock)}<small>flock ${t.flock}/${T.maxFlock}</small></span></li>
  </ul>`;

/** Journey progress bar: a track with a notch at each landscape boundary and the beacon flag at the end. */
function trackHTML(progress) {
  const pct = clamp(Math.round(num(progress) * 100), 0, 100);
  const notches = CUM.slice(0, -1).map((f) => `<i class="notch" style="left:${(f * 100).toFixed(2)}%"></i>`).join('');
  return `<div class="track" role="progressbar" aria-label="Journey progress to the beacon" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
    <span class="track-fill" style="width:${pct}%"></span>${notches}<span class="track-end">${ico('flag')}</span></div>`;
}

/** A little landscape swatch painted from a landscape's own palette (no image is loaded). */
function sceneSVG(index, locked) {
  const c = CHAPTERS[index], p = c.palette;
  const id = `sc${index}${locked ? 'x' : ''}`;
  const sky = locked ? ['#39406b', '#2b3157'] : [p.sky, p.light];
  const far = locked ? '#272c50' : p.fringe, near = locked ? '#1f2442' : p.top, soil = locked ? '#191d38' : p.soil;
  const orb = locked ? '#4a5285' : (c.dark ? '#f6f0d0' : p.accent);
  const extra = locked ? '' : (c.dark ? '<g fill="#fff" opacity=".8"><circle cx="20" cy="9" r=".9"/><circle cx="52" cy="6" r=".7"/><circle cx="118" cy="10" r=".9"/><circle cx="140" cy="5" r=".7"/><circle cx="86" cy="13" r=".6"/></g>' : '')
    + (c.fx === 'snow' ? '<g fill="#fff" opacity=".9"><circle cx="24" cy="16" r="1.2"/><circle cx="60" cy="10" r="1"/><circle cx="96" cy="19" r="1.2"/><circle cx="132" cy="12" r="1"/></g>' : '')
    + (c.water ? `<path d="M0 50c10-3 20 3 30 0s20 3 30 0 20 3 30 0 20 3 30 0 20 3 30 0v10H0z" fill="${p.water}" opacity=".85"/>` : '');
  return `<svg class="scene" viewBox="0 0 160 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
    <rect width="160" height="60" fill="url(#${id})"/><circle cx="124" cy="17" r="8" fill="${orb}" opacity="${locked ? 1 : .9}"/>${extra}
    <path d="M0 44c18-16 34-18 52-6 16-14 36-18 58-4 16-8 32-6 50 4v22H0z" fill="${far}"/>
    <path d="M0 50c22-10 44-10 66-1 24-9 54-10 94 1v10H0z" fill="${near}"/><rect y="55" width="160" height="5" fill="${soil}"/>
    ${locked ? '<text x="80" y="38" text-anchor="middle" font-size="22" font-weight="900" fill="#69719f" font-family="inherit">?</text>' : ''}</svg>`;
}

/* ───────────────────────── screen builders ───────────────────────── */

const SCREEN_LABEL = {
  title: 'Egg Mama', pause: 'Paused', dead: 'Oh no!', finish: 'The beacon is lit!', rotate: 'Turn your phone sideways',
  journal: 'Trail journal', help: 'How to play', 'reset-confirm': 'Start over?',
};

const logo = () => `<h1 class="logo" id="h-title" aria-label="Egg Mama">
  <span class="logo-line l1" aria-hidden="true"><span class="lg-ext">EGG</span><span class="lg-out">EGG</span><span class="lg-fill">EGG</span></span>
  <span class="logo-line l2" aria-hidden="true"><span class="lg-ext">MAMA</span><span class="lg-out">MAMA</span><span class="lg-fill">MAMA</span></span></h1>`;

const cardHead = (id, title, { closeBtn = false, kicker = '' } = {}) => `
  <header class="card-head">
    <h2 id="${id}">${esc(title)}</h2>${kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''}
    ${closeBtn ? `<button type="button" class="btn btn-round btn-close" data-action="close" aria-label="Close">${ico('close')}</button>` : ''}
  </header>`;

function buildTitle(ctx) {
  const { data } = ctx;
  const save = data.save || null;
  const info = journeyInfo(data);
  const best = data.best && (data.best.score > 0 || data.best.eggs > 0) ? data.best : null;
  const where = `Landscape ${info.chapter + 1} · ${info.name} · circuit ${info.circuit}`;
  const primary = save
    ? button('continue', 'Continue', { kind: 'primary', icon: 'play', sub: where, autofocus: true, hero: true })
    : button('play', 'Play', { kind: 'primary', icon: 'play', sub: 'A brand-new journey', autofocus: true, hero: true });
  return `
  <div class="title-hero">
    ${logo()}
    <p class="tagline">A storm scattered Mama’s eggs across the valley. Roll, jump, and bring the flock home!</p>
  </div>
  <div class="title-menu">
    ${primary}
    <div class="btn-grid">
      ${button('journal', 'Journal', { icon: 'book' })}
      ${button('help', 'How to play', { icon: 'help' })}
      ${toggle('sound', 'Sound', !ctx.muted, 'sound', 'mute')}
      ${ctx.canFullscreen ? button('fullscreen', 'Full screen', { icon: 'full' }) : ''}
    </div>
    ${save ? button('start-over', 'Start over', { kind: 'quiet', icon: 'retry' }) : ''}
    ${best ? `<p class="best-line">${ico('star')}<span>Best score <b>${fmt(best.score)}</b>${best.eggs ? ` · <b>${fmt(best.eggs)}</b> eggs` : ''}</span></p>` : ''}
  </div>`;
}

function buildPause(ctx) {
  const d = ctx.data;
  const info = journeyInfo(d);
  const t = totals(d);
  const progress = pickProgress(d, info);
  const pct = Math.round(progress * 100);
  return `<div class="card card-pause">
    ${cardHead('h-pause', 'Paused', { kicker: `Circuit ${info.circuit}` })}
    <div class="card-body pause-grid">
      <div class="pause-stats">
        <div class="place"><small>Landscape ${info.chapter + 1} of ${CHAPTERS.length}</small><strong>${esc(info.name)}</strong></div>
        <div class="journey">${trackHTML(progress)}<p class="journey-text"><b>${pct}%</b> to the beacon<span class="dot-sep" aria-hidden="true">·</span><span>${esc(playedLabel(d.playSeconds))}</span></p></div>
        ${tally(t)}
      </div>
      <div class="pause-actions">
        ${button('resume', 'Resume', { kind: 'primary', icon: 'play', autofocus: true })}
        <div class="btn-grid">
          ${button('journal', 'Journal', { icon: 'book' })}
          ${button('help', 'How to play', { icon: 'help' })}
          ${toggle('sound', 'Sound', !ctx.muted, 'sound', 'mute')}
          ${toggle('tap-to-jump', 'Tap to jump', ctx.tapToJump, 'tap')}
        </div>
        <div class="btn-row">
          ${button('title', 'Main title', { icon: 'home' })}
          ${ctx.canFullscreen ? button('fullscreen', 'Full screen', { icon: 'full' }) : ''}
        </div>
      </div>
    </div>
  </div>`;
}

/** Journey progress 0..1: given, or the start of the current landscape as a fallback. */
function pickProgress(d, info) {
  if (Number.isFinite(d.progress)) return clamp(d.progress, 0, 1);
  return info.chapter > 0 ? CUM[info.chapter - 1] : 0;
}

const DEAD_LINES = [
  'The ducklings are waiting at the flag. Try again!',
  'That was a tricky one. Mama will give it another go!',
  'No worries: your checkpoint is saved. Ready when you are!',
  'Eggs roll away, but Mama always finds them. Again?',
];
let deadLine = 0;

function buildDead(ctx) {
  const d = ctx.data, info = journeyInfo(d), t = totals(d);
  const line = DEAD_LINES[deadLine++ % DEAD_LINES.length];
  return `<div class="card card-dead">
    <div class="card-body dead-grid">
      <div class="mama-pic">${ico('mama-oops')}</div>
      <div class="dead-main">
        <h2 id="h-dead" class="big-head">Oh no!</h2>
        <p class="lede">${esc(line)}</p>
        ${d.newBest ? `<p class="badge">${ico('star')} New best score!</p>` : ''}
        ${tally(t)}
        <p class="where">Checkpoint: Landscape ${info.chapter + 1} · ${esc(info.name)}${info.circuit > 1 ? ` · circuit ${info.circuit}` : ''}</p>
        <div class="btn-row">
          ${button('retry', 'Retry checkpoint', { kind: 'primary', icon: 'retry', autofocus: true })}
          ${button('title', 'Main title', { icon: 'home' })}
        </div>
      </div>
    </div>
  </div>`;
}

const CONFETTI = ['#ff6f4d', '#ffd23a', '#5bc236', '#4aa8ee', '#ff8fb0', '#b784f0'];
function buildFinish(ctx) {
  const d = ctx.data, t = totals(d);
  const circuit = clamp(Math.floor(num(d.circuit, 1)), 1, 999);
  let bits = '';
  for (let i = 0; i < 22; i++) bits += `<i style="--x:${(i * 4.7 + (i % 3) * 1.3) % 100}%;--d:${((i * 0.37) % 2.6).toFixed(2)}s;--r:${(i * 47) % 360}deg;--c:${CONFETTI[i % CONFETTI.length]}"></i>`;
  return `<div class="confetti" aria-hidden="true">${bits}</div>
  <div class="card card-finish">
    <div class="card-body dead-grid">
      <div class="mama-pic">${ico('mama-joy')}</div>
      <div class="dead-main">
        <p class="kicker big">Circuit ${circuit} complete</p>
        <h2 id="h-finish" class="big-head">The beacon is lit!</h2>
        <p class="lede">Every egg Mama found is safe, and the whole flock can go home! The valley still has more eggs to find.</p>
        ${tally(t)}
        <div class="btn-row">
          ${button('keep-going', 'Keep going', { kind: 'primary', icon: 'play', autofocus: true })}
          ${button('title', 'Main title', { icon: 'home' })}
        </div>
      </div>
    </div>
  </div>`;
}

function buildRotate() {
  return `<div class="rotate-body">
    <div class="phone-stage" aria-hidden="true">
      <div class="phone"><div class="phone-screen"><span class="ps-scene"><span class="ps-hill"></span><span class="ps-egg"></span></span></div></div>
      <svg class="turn-arrow" viewBox="0 0 64 64"><path d="M10 40c3-18 20-28 40-22" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M52 6l2 16-16-3z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>
    </div>
    <div class="rotate-text">
      <h2 id="h-rotate" class="when-prompt">Turn your phone sideways</h2>
      <h2 class="when-ready">All set!</h2>
      <p class="when-prompt">Egg Mama is played in landscape. Your place is saved.</p>
      <button type="button" class="btn btn-primary btn-hero when-ready" data-action="rotate-continue" data-autofocus>${ico('play', 'btn-ico')}<span class="btn-text"><span class="btn-main">Tap to continue</span></span></button>
    </div>
  </div>`;
}

function buildHelp() {
  const swipe = (icon, cls, head, text) => `<li class="help-card ${cls}"><span class="help-ico">${ico(icon)}</span><span class="help-text"><b>${head}</b><span>${text}</span></span></li>`;
  const thing = (icon, head, text) => `<li class="help-card"><span class="help-ico pic">${ico(icon)}</span><span class="help-text"><b>${head}</b><span>${text}</span></span></li>`;
  return `<div class="card card-help">
    ${cardHead('h-help', 'How to play', { closeBtn: true })}
    <div class="tabs" role="tablist" aria-label="Help topics">
      <button type="button" class="tab" role="tab" id="tab-moves" aria-controls="pane-moves" aria-selected="true" data-tab="moves" data-autofocus>Moves</button>
      <button type="button" class="tab" role="tab" id="tab-eggs" aria-controls="pane-eggs" aria-selected="false" tabindex="-1" data-tab="eggs">Eggs &amp; flock</button>
      <button type="button" class="tab" role="tab" id="tab-helpers" aria-controls="pane-helpers" aria-selected="false" tabindex="-1" data-tab="helpers">Helpers &amp; hazards</button>
    </div>
    <div class="card-body help-body" data-scroll tabindex="0">
      <ul class="help-pane" role="tabpanel" id="pane-moves" aria-labelledby="tab-moves" data-pane="moves">
        ${swipe('swipe-up', 'tone-up', 'Swipe up', 'Jump! You can also just tap.')}
        ${swipe('swipe-left', 'tone-left', 'Swipe left', 'Brake and back up a little.')}
        ${swipe('swipe-right', 'tone-right', 'Swipe right', 'Push ahead for a moment.')}
        <li class="help-note">${ico('keys')}<span>Mama rolls on her own. On a keyboard: <kbd>←</kbd> <kbd>→</kbd> or <kbd>A</kbd> <kbd>D</kbd> steer, <kbd>Space</kbd> jumps, <kbd>P</kbd> pauses, <kbd>M</kbd> mutes.</span></li>
      </ul>
      <ul class="help-pane" role="tabpanel" id="pane-eggs" aria-labelledby="tab-eggs" data-pane="eggs" data-cols="2" hidden>
        ${thing('egg', 'Eggs', 'Every egg counts and earns points.')}
        ${thing('gold', 'Golden eggs', 'Hatch a duckling who follows Mama.')}
        ${thing('duck', 'Ducklings', `Extra lives. Up to ${T.maxFlock} can join the flock.`)}
        ${thing('flag', 'Flags', 'Save your place. A fall brings you back.')}
      </ul>
      <ul class="help-pane" role="tabpanel" id="pane-helpers" aria-labelledby="tab-helpers" data-pane="helpers" hidden>
        ${thing('shield', 'Shell shield', 'Blocks the next hit.')}
        ${thing('magnet', 'Magnet', 'Pulls nearby eggs to Mama.')}
        ${thing('spring', 'Springs', 'Bounce up to high ledges.')}
        ${thing('crumble', 'Cracked ledges', 'They crumble! Keep hopping.')}
        ${thing('snail', 'Critters', 'Land on top to bounce off them.')}
        ${thing('spikes', 'Spikes', 'Ouch! Jump right over them.')}
      </ul>
    </div>
  </div>`;
}

function buildConfirm(ctx) {
  const info = journeyInfo(ctx.data, ctx.baseData);
  const t = totals(ctx.data, ctx.baseData);
  const what = pick([ctx.data, ctx.baseData], 'eggs') !== undefined
    ? `Your saved journey (Landscape ${info.chapter + 1} · ${info.name}${info.circuit > 1 ? `, circuit ${info.circuit}` : ''}, ${fmt(t.eggs)} eggs, ${t.flock} ${t.flock === 1 ? 'duckling' : 'ducklings'}) will be replaced.`
    : 'Your saved journey will be replaced.';
  return `<div class="card card-confirm">
    <div class="card-body confirm-body">
      <div class="mama-pic small">${ico('mama-oops')}</div>
      <div class="confirm-main">
        <h2 id="h-confirm" class="big-head">Start over?</h2>
        <p class="lede">${esc(what)} Mama begins again in the Meadow with no eggs and no flock.</p>
        <div class="btn-row">
          ${button('cancel-start-over', 'Keep my journey', { kind: 'primary', icon: 'play', autofocus: true })}
          ${button('confirm-start-over', 'Yes, start over', { kind: 'danger', icon: 'retry' })}
        </div>
      </div>
    </div>
  </div>`;
}

function buildJournal(ctx, selected) {
  const info = journeyInfo(ctx.data, ctx.baseData);
  const sel = clamp(selected ?? info.chapter, 0, CHAPTERS.length - 1);
  const open = isUnlocked(info, sel);
  const found = info.reached.circuit > 1 ? CHAPTERS.length : Math.min(CHAPTERS.length, Math.max(info.reached.chapter, info.chapter) + 1);
  const chips = CHAPTERS.map((c, i) => {
    const ok = isUnlocked(info, i);
    return `<button type="button" class="chip-ch${ok ? '' : ' locked'}${i === sel ? ' is-sel' : ''}${i === info.chapter ? ' is-here' : ''}" data-pick="${i}" aria-pressed="${i === sel}" aria-label="Landscape ${i + 1}${ok ? ', ' + esc(c.name) : ', not found yet'}">
      ${sceneSVG(i, !ok)}<span class="ch-num">${i + 1}</span>${ok ? '' : `<span class="ch-lock">${ico('lock')}</span>`}${i === info.chapter ? `<span class="ch-here" title="You are here">${ico('egg')}</span>` : ''}</button>`;
  }).join('');
  return `<div class="card card-journal">
    ${cardHead('h-journal', 'Trail journal', { closeBtn: true, kicker: `Circuit ${info.circuit} · ${found} of ${CHAPTERS.length} found` })}
    <div class="card-body journal-grid">
      <div class="ch-grid" role="group" aria-label="Landscapes">${chips}</div>
      <div class="j-detail" data-scroll tabindex="0" role="region" aria-label="Landscape details" aria-live="polite">${journalDetail(info, sel, open)}</div>
    </div>
  </div>`;
}

function journalDetail(info, i, open) {
  const c = CHAPTERS[i];
  if (!open) {
    return `<div class="j-banner locked">${sceneSVG(i, true)}<div class="j-title"><small>Landscape ${i + 1} of ${CHAPTERS.length}</small><strong>???</strong></div></div>
      <p class="j-hint">${ico('lock')}<span>You haven’t found this place yet. Keep rolling and it will appear in your journal!</span></p>`;
  }
  return `<div class="j-banner">${sceneSVG(i, false)}<div class="j-title"><small>Landscape ${i + 1} of ${CHAPTERS.length}</small><strong>${esc(c.name)}</strong></div></div>
    <section class="j-sec"><h3>The story</h3><p>${esc(c.story)}</p></section>
    <section class="j-sec"><h3>On the trail</h3><ul>${c.trail.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul></section>
    <section class="j-sec learn"><h3>${ico('bulb')} What you learn</h3><p>${esc(c.learn)}</p></section>
    ${info.circuit > 1 && i === CHAPTERS.length - 1 ? `<p class="j-note">${esc(CIRCUIT_STORY)}</p>` : ''}`;
}

const BUILDERS = { title: buildTitle, pause: buildPause, dead: buildDead, finish: buildFinish, rotate: buildRotate, help: buildHelp, 'reset-confirm': buildConfirm, journal: buildJournal };

/* ───────────────────────── createUI ───────────────────────── */

export function createUI({ root, onAction = () => {} } = {}) {
  const doc = root.ownerDocument;
  const stage = (root.closest && root.closest('#stage')) || (root.id === 'ui' ? root.parentElement : root) || root;
  let uiRoot = root.id === 'ui' ? root : root.querySelector('#ui');
  if (!uiRoot) { uiRoot = doc.createElement('div'); uiRoot.id = 'ui'; root.appendChild(uiRoot); }
  let pauseBtn = stage.querySelector('#pause-btn');
  if (!pauseBtn) {
    pauseBtn = doc.createElement('button');
    Object.assign(pauseBtn, { id: 'pause-btn', type: 'button', hidden: true });
    pauseBtn.setAttribute('data-ui', ''); pauseBtn.setAttribute('data-action', 'pause'); pauseBtn.setAttribute('aria-label', 'Pause');
    stage.appendChild(pauseBtn);
  }
  pauseBtn.innerHTML = ico('pause');
  const safe = doc.getElementById('safe');
  const canFullscreen = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);

  // build the (initially hidden) screens once
  uiRoot.insertAdjacentHTML('afterbegin', SPRITE);
  const live = doc.createElement('div');
  live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  uiRoot.appendChild(live);
  const els = {};
  for (const name of SCREENS) {
    const el = doc.createElement('section');
    el.className = `screen s-${name}`;
    el.dataset.screen = name;
    el.setAttribute('data-ui', '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.hidden = true;
    uiRoot.appendChild(el);
    els[name] = el;
  }

  // state
  let current = null;                   // name of the screen on top
  let base = null;                      // screen beneath an open sheet: { name, data }
  let opener = null;                    // data-action of the button that opened the sheet (to refocus it)
  let pauseWanted = false;
  let muted = false, tapToJump = true;
  let journalPick = null;
  let openedAt = -1e9;                  // when the current screen came up (performance.now), for the GUARD_MS rule
  let readyArmed = false;               // a finger went down on the rotate screen AFTER it said "Tap to continue"
  let lastClick = { t: -1e9, x: 0, y: 0, action: '', moved: false };   // the last accepted button press (the double-tap rule in handleClick)
  const last = {};                      // last data each screen was shown with

  const ctx = (name, data) => ({ name, data, last, baseData: base ? base.data : null, muted, tapToJump, canFullscreen });

  /* ── fading ── */
  function openEl(el) {
    clearTimeout(el._t);
    el.hidden = false;
    el.classList.remove('is-closing');
    void el.offsetWidth;                                // restart the transition from opacity 0
    el.classList.add('is-open');
  }
  function closeEl(el) {
    el.classList.remove('is-open');
    if (el.hidden) return;
    el.classList.add('is-closing');
    clearTimeout(el._t);
    el._t = setTimeout(() => { if (!el.classList.contains('is-open')) { el.hidden = true; el.classList.remove('is-closing'); } }, FADE_MS + 30);
  }

  const updatePauseBtn = () => {
    const show = pauseWanted && !current;
    pauseBtn.hidden = !show;
    pauseBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
  };
  const announce = (text) => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); };

  function render(name, data) {
    const el = els[name];
    if (name === 'rotate') {
      if (!el.firstChild) el.innerHTML = buildRotate();
      const phase = data.phase === 'ready' ? 'ready' : 'prompt';
      if (el.dataset.phase !== phase) readyArmed = false;        // a touch that began under the other message does not count
      el.dataset.phase = phase;
      el.setAttribute('aria-labelledby', 'h-rotate');
      return;
    }
    if (name === 'journal') el.innerHTML = buildJournal(ctx(name, data), journalPick);
    else el.innerHTML = BUILDERS[name](ctx(name, data));
    const label = el.querySelector('h1, h2');
    if (label) el.setAttribute('aria-labelledby', label.id);
  }

  const focusable = (n) => !!n && n.offsetParent !== null && !n.disabled;
  /** Put the keyboard focus in a screen: the wanted button, else its primary one, else the dialog itself. */
  function focusFirst(el, preferAction) {
    const pick = (sel) => [...el.querySelectorAll(sel)].find(focusable);
    const want = (preferAction && pick(`[data-action="${preferAction}"]`)) || pick('[data-autofocus]') || pick('button');
    const target = want || el;
    if (target === el) el.tabIndex = -1;
    try { target.focus({ preventScroll: true }); } catch { /* element may be hidden */ }
  }

  function show(name, data = {}) {
    if (!els[name]) { console.warn('ui.show: unknown screen', name); return null; }
    const isSheet = SHEETS.has(name);
    const el = els[name];
    if (current && current !== name) {
      if (isSheet && !SHEETS.has(current)) base = { name: current, data: last[current] || {} };
      else if (!isSheet) base = null;
      closeEl(els[current]);
    } else if (!current && !isSheet) base = null;
    if (name === 'journal' && current !== 'journal') journalPick = null;
    last[name] = name === 'rotate' ? { ...(last[name] || {}), ...data } : data;
    const wasCurrent = current === name;
    // re-showing a screen that is already up re-renders it: keep the keyboard focus on the same control
    const held = wasCurrent && el.contains(doc.activeElement) ? (doc.activeElement.dataset && doc.activeElement.dataset.action) : null;
    const phaseBefore = name === 'rotate' ? el.dataset.phase : null;
    render(name, data);
    current = name;
    if (!wasCurrent) { openEl(el); openedAt = performance.now(); }
    updatePauseBtn();
    // the rotate screen changes its content in place (prompt -> "Tap to continue"): keyboard focus must follow to the new button
    const phaseChanged = wasCurrent && name === 'rotate' && phaseBefore !== el.dataset.phase;
    if (!wasCurrent || phaseChanged || !focusable(doc.activeElement) || !el.contains(doc.activeElement)) focusFirst(el, phaseChanged ? null : held);
    if (!wasCurrent) announce(SCREEN_LABEL[name]);
    return el;
  }

  function hide() {
    if (current) closeEl(els[current]);
    current = null; base = null; opener = null;
    updatePauseBtn();
    if (doc.activeElement && uiRoot.contains(doc.activeElement)) doc.activeElement.blur();
  }

  /** Close the open sheet and go back to the screen beneath (or hide). */
  function closeSheet() {
    const b = base; base = null;
    if (b) {
      const back = opener; opener = null;
      show(b.name, b.data);
      focusFirst(els[b.name], back);
    } else hide();
  }

  /* ── settings reflected into every switch on screen ── */
  function reflect() {
    for (const b of uiRoot.querySelectorAll('[data-action="sound"]')) b.setAttribute('aria-checked', String(!muted));
    for (const b of uiRoot.querySelectorAll('[data-action="tap-to-jump"]')) b.setAttribute('aria-checked', String(tapToJump));
  }

  /* ── events ── */
  function handleClick(e) {
    const t = e.target;
    const tabBtn = t.closest && t.closest('[data-tab]');
    if (tabBtn) { selectTab(tabBtn); return; }
    const pick = t.closest && t.closest('[data-pick]');
    if (pick) { selectLandscape(Number(pick.dataset.pick)); return; }
    const btn = t.closest && t.closest('[data-action]');
    if (!btn || btn.disabled || !stage.contains(btn)) return;
    const action = btn.dataset.action;
    if (action === 'rotate-continue' && !rotateTapOk(e)) return;
    if (GUARDED.has(current) && e.detail > 0 && performance.now() - openedAt < GUARD_MS) return;   // leftover play taps (keyboard clicks, detail 0, are deliberate)
    // The second tap of a double-tap lands on whatever the first tap just revealed: "Yes, start over" -> the title's Continue, the
    // X of How to play -> Continue. So: when the last press CHANGED the screen, a finger that comes down again on the same spot a
    // moment later, on a DIFFERENT action, is that double-tap and not a new choice. (Switches such as Sound change no screen and
    // stay instantly tappable; the same action again works; the keyboard, detail 0, is exempt.)
    const pressedAt = performance.now(), screenBefore = current;
    if (e.detail > 0 && lastClick.moved && action !== lastClick.action && pressedAt - lastClick.t < DOUBLE_TAP_MS
      && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < DOUBLE_TAP_PX) return;
    let payload;
    switch (action) {
      case 'sound': muted = !muted; reflect(); payload = { muted }; break;
      case 'tap-to-jump': tapToJump = !tapToJump; reflect(); payload = { tapToJump }; break;
      case 'journal': case 'help': opener = action; show(action, {}); break;
      case 'start-over': opener = action; show('reset-confirm', {}); break;
      case 'close': case 'cancel-start-over': closeSheet(); break;
      default: break;
    }
    if (btn === pauseBtn || (e.detail > 0 && action !== 'sound' && action !== 'tap-to-jump')) { try { btn.blur(); } catch { /* ignore */ } }
    onAction(action, payload);
    if (e.detail > 0) lastClick = { t: pressedAt, x: e.clientX, y: e.clientY, action, moved: current !== screenBefore };
  }

  function selectTab(btn) {
    const name = btn.dataset.tab, host = btn.closest('.screen');
    for (const t of host.querySelectorAll('[data-tab]')) { const on = t === btn; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
    for (const p of host.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
    const body = host.querySelector('.help-body'); if (body) body.scrollTop = 0;
  }

  function selectLandscape(i) {
    journalPick = i;
    const info = journeyInfo(last.journal, base && base.data);
    const host = els.journal;
    for (const c of host.querySelectorAll('[data-pick]')) {
      const on = Number(c.dataset.pick) === i;
      c.classList.toggle('is-sel', on); c.setAttribute('aria-pressed', String(on));
    }
    const detail = host.querySelector('.j-detail');
    detail.innerHTML = journalDetail(info, i, isUnlocked(info, i));
    detail.scrollTop = 0;
  }

  function onKeyDown(e) {
    // keyboard users see focus rings; pointer users don't
    if (e.key !== 'Escape' && !e.metaKey && !e.ctrlKey) stage.classList.remove('pointer-mode');
    if (!current) return;
    if (e.key === 'Escape' && SHEETS.has(current)) {
      e.preventDefault(); e.stopImmediatePropagation();
      const action = current === 'reset-confirm' ? 'cancel-start-over' : 'close';
      closeSheet();
      onAction(action);
      return;
    }
    if (e.key === 'Tab') trapFocus(e);
    else if (current === 'help' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && doc.activeElement && doc.activeElement.matches && doc.activeElement.matches('[data-tab]')) {
      const tabs = [...els.help.querySelectorAll('[data-tab]')];
      const next = tabs[(tabs.indexOf(doc.activeElement) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      e.preventDefault(); e.stopImmediatePropagation(); next.focus(); selectTab(next);
    }
  }

  function trapFocus(e) {
    const el = els[current];
    const items = [...el.querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter((n) => n.offsetParent !== null && n.tabIndex >= 0);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], lastItem = items[items.length - 1], a = doc.activeElement;
    if (!el.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); lastItem.focus(); }
    else if (!e.shiftKey && a === lastItem) { e.preventDefault(); first.focus(); }
  }

  // "Tap to continue" has to be a tap that STARTED after the screen said so. A thumb that was already on the glass
  // while the phone turned (children turn it with both hands on it) must not resume the run by simply lifting off.
  // Keyboard / programmatic clicks (detail 0) have no pointer-down and are always fine.
  const onRotateDown = () => { readyArmed = current === 'rotate' && els.rotate.dataset.phase === 'ready'; };
  function rotateTapOk(e) {
    if (current !== 'rotate' || els.rotate.dataset.phase !== 'ready') return false;
    if (e.detail === 0) return true;
    const ok = readyArmed; readyArmed = false;
    return ok;
  }

  // Tapping the dimmed rotate screen anywhere continues, once it says "Tap to continue".
  function onRotateTap(e) {
    if (current === 'rotate' && !(e.target.closest && e.target.closest('button')) && rotateTapOk(e)) {
      onAction('rotate-continue');
    }
  }

  const onPointer = () => stage.classList.add('pointer-mode');
  stage.classList.add('pointer-mode');
  stage.addEventListener('click', handleClick);
  els.rotate.addEventListener('click', onRotateTap);
  els.rotate.addEventListener('pointerdown', onRotateDown, true);
  stage.addEventListener('pointerdown', onPointer, true);
  (doc.defaultView || window).addEventListener('keydown', onKeyDown, true);   // capture: Esc closes a sheet before Input sees it

  const ui = {
    show, hide,
    get current() { return current; },
    setPauseButton(visible) { pauseWanted = !!visible; updatePauseBtn(); },
    setMuted(b) { muted = !!b; reflect(); },
    setSettings(s = {}) {
      if (typeof s.tapToJump === 'boolean') tapToJump = s.tapToJump;
      if (typeof s.muted === 'boolean') muted = s.muted;
      reflect();
    },
    /** Safe-area insets in CSS px, from the #safe probe. */
    insets() {
      const cs = safe && (doc.defaultView || window).getComputedStyle(safe);
      const px = (p) => (cs ? parseFloat(cs.getPropertyValue(p)) || 0 : 0);
      return { top: px('padding-top'), right: px('padding-right'), bottom: px('padding-bottom'), left: px('padding-left') };
    },
    announce,
    /** The <section> of a screen (tests, styling hooks). */
    el: (name) => els[name],
    get muted() { return muted; },
    get tapToJump() { return tapToJump; },
    destroy() {
      stage.removeEventListener('click', handleClick);
      els.rotate.removeEventListener('click', onRotateTap);
      els.rotate.removeEventListener('pointerdown', onRotateDown, true);
      stage.removeEventListener('pointerdown', onPointer, true);
      (doc.defaultView || window).removeEventListener('keydown', onKeyDown, true);
      for (const el of Object.values(els)) el.remove();
      live.remove();
    },
  };
  return ui;
}
