/*
 * Egg Mama — saved journey + settings (DESIGN.md §7, revised for the one-hour continuous world).
 *
 * PURE: no browser globals are touched at import time, and storage is always passed in
 * (anything with getItem / setItem / removeItem — window.localStorage in the page, `memoryStorage()`
 * in tests). Every storage call is wrapped, so a Safari private window or a full disk degrades to
 * "no save" instead of an exception. Nothing in here ever throws.
 *
 * A Save says where the player will start from: which circuit, which landscape (chapter 0..12) and
 * which flag inside that landscape (0 = the flag that opens it), plus the totals carried along.
 * The world itself is NOT stored: it is regenerated from levelSeed(journeySeed, circuit).
 *
 *   Save = { v:2, journeySeed, circuit, chapter, flag, eggs, score, flock, beacons,
 *            reached:{circuit, chapter}, playSeconds, savedAt }
 *
 * Randomness and the clock are injectable (`{ random, now }`) so tests stay deterministic.
 */
import { CHAPTER_COUNT } from './chapters.mjs';
import { T } from './tuning.mjs';

export const SAVE_KEY = 'egg-mama-save-v2';
export const SETTINGS_KEY = 'egg-mama-settings-v1';

// The previous GitHub Pages release (SAVE-2: "a release upgrade must let returning players continue").
export const LEGACY_SAVE_KEY = 'egg-hero-journey-v1';
export const LEGACY_BEST_KEY = 'egg-hero-best';
export const LEGACY_SOUND_KEY = 'egg-hero-sound';
// Written once a legacy save has been imported (or the player cleared their journey), so the old
// key — which we never touch — is not imported a second time.
export const LEGACY_DONE_KEY = 'egg-mama-legacy-imported';
const LEGACY_FORMAT = 1;

// Sanity ceilings. They exist so corrupt numbers can't make a nonsense world, not as game rules.
const MAX_CIRCUIT = 999;
const MAX_FLAG = 999;
const MAX_TOTAL = 999_999_999;
const MAX_SECONDS = 3_600_000_000;      // ~114 years
const U32 = 0x100000000;

/* ───────── small helpers ───────── */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(v)));

function readKey(storage, key) {
  try { const v = storage && storage.getItem(key); return v === undefined ? null : v; } catch { return null; }
}
function writeKey(storage, key, value) {
  try { storage.setItem(key, value); return true; } catch { return false; }
}
function removeKey(storage, key) {
  try { storage.removeItem(key); return true; } catch { return false; }
}
function parseJSON(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8_000_000) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A uint32 journey seed from any 0..1 random source (default Math.random). */
export function randomSeed(random = Math.random) {
  const r = random();
  return (Number.isFinite(r) ? Math.floor(Math.abs(r % 1) * U32) : 0) >>> 0;
}

/** A tiny in-memory Storage stand-in: tests, and the fallback when localStorage is blocked. */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

/** window.localStorage if it really works (private windows can throw), else an in-memory stand-in. */
export function getStorage(scope = globalThis) {
  try {
    const s = scope.localStorage;
    if (!s) throw new Error('none');
    const probe = '__egg-mama-probe';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return memoryStorage(); }
}

/* ───────── the save ───────── */

/** Is (circuit, chapter) A at or beyond B in journey order? */
const beyond = (a, b) => a.circuit > b.circuit || (a.circuit === b.circuit && a.chapter >= b.chapter);

/**
 * Validate + normalise anything that claims to be a v2 Save. Returns a clean Save or null.
 * Wrong types / missing essentials -> null (never guess at a position). Out-of-range *totals* are
 * clamped instead (a flock of 9 is still a player who has a flock).
 */
export function normalizeSave(raw) {
  if (!isObj(raw) || raw.v !== 2) return null;
  const { journeySeed, circuit, chapter, flag, eggs, score, flock } = raw;
  if (![journeySeed, circuit, chapter, flag, eggs, score, flock].every(isNum)) return null;
  if (!Number.isInteger(journeySeed) || journeySeed < 0 || journeySeed >= U32) return null;
  if (!Number.isInteger(circuit) || circuit < 1 || circuit > MAX_CIRCUIT) return null;
  if (!Number.isInteger(chapter) || chapter < 0 || chapter >= CHAPTER_COUNT) return null;
  if (!Number.isInteger(flag) || flag < 0 || flag > MAX_FLAG) return null;
  const here = { circuit, chapter };
  let reached = here;
  if (isObj(raw.reached) && Number.isInteger(raw.reached.circuit) && Number.isInteger(raw.reached.chapter)
    && raw.reached.circuit >= 1 && raw.reached.circuit <= MAX_CIRCUIT
    && raw.reached.chapter >= 0 && raw.reached.chapter < CHAPTER_COUNT
    && beyond(raw.reached, here)) {
    reached = { circuit: raw.reached.circuit, chapter: raw.reached.chapter };
  }
  return {
    v: 2,
    journeySeed, circuit, chapter, flag,
    eggs: clampInt(eggs, 0, MAX_TOTAL),
    score: clampInt(score, 0, MAX_TOTAL),
    flock: clampInt(flock, 0, T.maxFlock),
    beacons: isNum(raw.beacons) ? clampInt(raw.beacons, 0, MAX_CIRCUIT) : 0,
    reached,
    playSeconds: isNum(raw.playSeconds) ? Math.min(MAX_SECONDS, Math.max(0, raw.playSeconds)) : 0,
    savedAt: isNum(raw.savedAt) ? Math.max(0, Math.floor(raw.savedAt)) : 0,
  };
}

/** A fresh journey: circuit 1, Meadow, its opening flag, no eggs, no flock. */
export function newJourney(seed, now = Date.now()) {
  return {
    v: 2,
    journeySeed: (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0,
    circuit: 1, chapter: 0, flag: 0,
    eggs: 0, score: 0, flock: 0, beacons: 0,
    reached: { circuit: 1, chapter: 0 },
    playSeconds: 0,
    savedAt: Number.isFinite(now) ? Math.floor(now) : 0,
  };
}

/**
 * The save after a checkpoint / landscape change / beacon. Everything not mentioned is kept from
 * `prev`. `beaconLit` adds one to `beacons` (the caller passes the NEXT circuit's chapter 0, flag 0).
 * `reached` only ever moves forward. The result always passes normalizeSave.
 */
export function saveAt(prev, { circuit, chapter, flag, carry, playSeconds, beaconLit = false, now = Date.now() } = {}) {
  const base = normalizeSave(prev) || newJourney(0, now);
  const c = carry || {};
  const next = {
    ...base,
    circuit: circuit ?? base.circuit,
    chapter: chapter ?? base.chapter,
    flag: flag ?? base.flag,
    eggs: c.eggs ?? base.eggs,
    score: c.score ?? base.score,
    flock: c.flock ?? base.flock,
    beacons: base.beacons + (beaconLit ? 1 : 0),
    playSeconds: playSeconds ?? base.playSeconds,
    savedAt: now,
  };
  const here = { circuit: next.circuit, chapter: next.chapter };
  next.reached = beyond(here, base.reached) ? here : base.reached;
  // A caller bug (chapter 14, NaN eggs…) must not poison the stored save: fall back to the old one.
  return normalizeSave(next) || base;
}

/**
 * Convert the previous release's save (egg-hero-journey-v1) or null when it is not one.
 * Legacy shape: { format:1, state:{ stage, generatedStage, ducklings, beaconsLit, collected, points, over,
 * platforms:[], eggs:[], enemies:[], objects:[], checkpoint:{x,y,tile}, lastGround } } where
 * chapter = stage % 13 and circuit ("loop") = floor(stage / 13) + 1.
 * The old world cannot be restored (it was a different generator), so the player resumes at the start
 * of that landscape with their totals. We only read the counters, so a damaged world array does not
 * cost anyone their journey; but anything we cannot read as a number means "unknown data" -> null.
 */
export function migrateLegacy(rawText, { random = Math.random, now = Date.now() } = {}) {
  const data = parseJSON(rawText);
  if (!isObj(data) || data.format !== LEGACY_FORMAT || !isObj(data.state)) return null;
  const s = data.state;
  const stage = s.stage;
  if (!Number.isSafeInteger(stage) || stage < 0 || stage >= CHAPTER_COUNT * MAX_CIRCUIT) return null;
  const counter = (v) => (v === undefined ? 0 : (isNum(v) && v >= 0 ? Math.floor(v) : NaN));
  const collected = counter(s.collected), points = counter(s.points);
  const ducklings = counter(s.ducklings), beaconsLit = counter(s.beaconsLit);
  if ([collected, points, ducklings, beaconsLit].some(Number.isNaN)) return null;
  const circuit = Math.floor(stage / CHAPTER_COUNT) + 1;
  const chapter = stage % CHAPTER_COUNT;
  return normalizeSave({
    v: 2,
    journeySeed: randomSeed(random),
    circuit, chapter, flag: 0,
    eggs: collected, score: points, flock: Math.min(ducklings, T.maxFlock),
    beacons: beaconsLit,
    reached: { circuit, chapter },
    playSeconds: 0,
    savedAt: now,
  });
}

/**
 * Load the saved journey, or null. Order: a valid v2 save wins; otherwise the legacy save is imported
 * once (and written as v2 right away, so its journeySeed — and therefore its world — stays stable).
 * A damaged v2 save falls through to the legacy import rather than losing the player everything.
 */
export function loadSave(storage, { random = Math.random, now = Date.now() } = {}) {
  const direct = normalizeSave(parseJSON(readKey(storage, SAVE_KEY)));
  if (direct) return direct;
  if (readKey(storage, LEGACY_DONE_KEY) !== null) return null;
  const legacy = readKey(storage, LEGACY_SAVE_KEY);
  if (legacy === null) return null;
  const migrated = migrateLegacy(legacy, { random, now });
  if (!migrated) return null;
  writeSave(storage, migrated);
  writeKey(storage, LEGACY_DONE_KEY, '1');
  return migrated;
}

/** Store a save. Returns true on success. */
export function writeSave(storage, save) {
  const clean = normalizeSave(save);
  if (!clean) return false;
  return writeKey(storage, SAVE_KEY, JSON.stringify(clean));
}

/**
 * Forget the journey. The legacy key stays untouched, but is marked as imported so it cannot
 * resurrect a journey the player just cleared.
 */
export function clearSave(storage) {
  const removed = removeKey(storage, SAVE_KEY);
  writeKey(storage, LEGACY_DONE_KEY, '1');
  return removed;
}

/* ───────── finding the flag ───────── */

const flagCount = (level) => (level.checkpoints ? level.checkpoints.length : 0);

/** Slot in level.chapters that holds landscape `chapter` (slots are in order, so this is usually the chapter itself). */
function slotOf(level, chapter) {
  const cs = level.chapters;
  if (!cs || !cs.length) return -1;
  const found = cs.findIndex((c) => c.index === chapter);
  if (found >= 0) return found;
  return Math.min(Math.max(0, chapter | 0), cs.length - 1);
}

/**
 * Global checkpoint index for a save: the landscape's opening flag + save.flag, clamped to that
 * landscape's own flags (so a stale save pointing past the end still lands inside the landscape).
 * Levels without `chapters` (single-landscape test levels) just use save.flag.
 */
export function resolveFlag(level, save) {
  const n = flagCount(level);
  if (n === 0) return 0;
  const want = Math.max(0, Math.floor(isNum(save && save.flag) ? save.flag : 0));
  const slot = slotOf(level, save ? save.chapter : 0);
  if (slot < 0) return Math.min(want, n - 1);
  const cs = level.chapters;
  const lo = Math.min(cs[slot].flag | 0, n - 1);
  const hi = Math.max(lo, (slot + 1 < cs.length ? (cs[slot + 1].flag | 0) : n) - 1);
  return Math.min(hi, lo + want);
}

/** Inverse of resolveFlag: which landscape and which flag-in-landscape does checkpoint `index` belong to? */
export function flagOf(level, checkpointIndex) {
  const n = flagCount(level);
  const idx = Math.min(Math.max(0, Math.floor(isNum(checkpointIndex) ? checkpointIndex : 0)), Math.max(0, n - 1));
  const cs = level.chapters;
  if (!cs || !cs.length) return { chapter: level.chapter | 0, flag: idx };
  let slot = 0;
  for (let k = 0; k < cs.length; k++) if ((cs[k].flag | 0) <= idx) slot = k; else break;
  return { chapter: cs[slot].index, flag: idx - (cs[slot].flag | 0) };
}

/* ───────── settings ───────── */

export const DEFAULT_SETTINGS = Object.freeze({
  muted: false,
  tapToJump: true,
  best: Object.freeze({ score: 0, eggs: 0 }),
  seenHelp: false,
});

const count = (v) => (isNum(v) && v >= 0 ? clampInt(v, 0, MAX_TOTAL) : 0);

/** Clean up anything that looks like settings; unknown fields are dropped, bad ones fall back to defaults. */
export function normalizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const best = isObj(r.best) ? r.best : {};
  return {
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    tapToJump: typeof r.tapToJump === 'boolean' ? r.tapToJump : DEFAULT_SETTINGS.tapToJump,
    best: { score: count(best.score), eggs: count(best.eggs) },
    seenHelp: typeof r.seenHelp === 'boolean' ? r.seenHelp : DEFAULT_SETTINGS.seenHelp,
  };
}

/**
 * Settings: { muted, tapToJump, best:{score,eggs}, seenHelp }. Until the new settings key exists the
 * previous release's mute ('egg-hero-sound' = 'off') and best score ('egg-hero-best') carry over.
 */
export function loadSettings(storage) {
  const stored = parseJSON(readKey(storage, SETTINGS_KEY));
  if (isObj(stored)) return normalizeSettings(stored);
  const legacy = {};
  if (readKey(storage, LEGACY_SOUND_KEY) === 'off') legacy.muted = true;
  const best = Number(readKey(storage, LEGACY_BEST_KEY));
  if (Number.isFinite(best) && best > 0) legacy.best = { score: best, eggs: 0 };
  return normalizeSettings(legacy);
}

export function writeSettings(storage, settings) {
  return writeKey(storage, SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

/** Fold a finished attempt's totals into the best records. -> { settings, newBest:{score,eggs} } */
export function recordBest(settings, { score = 0, eggs = 0 } = {}) {
  const s = normalizeSettings(settings);
  const newBest = { score: score > s.best.score, eggs: eggs > s.best.eggs };
  return {
    settings: { ...s, best: { score: Math.max(s.best.score, count(score)), eggs: Math.max(s.best.eggs, count(eggs)) } },
    newBest,
  };
}
