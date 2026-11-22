import assert from "node:assert/strict";
import test from "node:test";
import {
  SAVE_KEY, SETTINGS_KEY, LEGACY_SAVE_KEY, LEGACY_BEST_KEY, LEGACY_SOUND_KEY, LEGACY_DONE_KEY,
  memoryStorage, getStorage, randomSeed, normalizeSave, newJourney, saveAt, migrateLegacy,
  loadSave, writeSave, clearSave, resolveFlag, flagOf, loadSettings, writeSettings, normalizeSettings,
  recordBest, DEFAULT_SETTINGS,
} from "../docs/js/save.mjs";

const NOW = 1_795_000_000_000;
const seeded = (r) => () => r;

/* ───────── fixtures ───────── */

/** A save as the new game writes it. */
const v2 = (extra = {}) => ({
  v: 2, journeySeed: 123456789, circuit: 2, chapter: 3, flag: 1, eggs: 42, score: 1830, flock: 3, beacons: 1,
  reached: { circuit: 2, chapter: 3 }, playSeconds: 4321, savedAt: NOW, ...extra,
});

/** The previous release's save, shaped like the real thing (see git 32622cb docs/engine.mjs saveCheckpoint). */
function legacySave(state = {}, top = {}) {
  const platforms = [
    { x: 787, y: 292, w: 226, type: "ground", ox: 787, oy: 292, dx: 0, dy: 0, crumblesAt: 0, returnsAt: 0, biome: 2 },
    { x: 1040, y: 258, w: 81, type: "ledge", ox: 1040, oy: 258, dx: 0, dy: 0, crumblesAt: 0, returnsAt: 0, biome: 2 },
  ];
  const full = {
    seed: 2718281828, time: 913.4, tick: 54804, points: 5120, collected: 88, ducklings: 4, shield: false, magnet: 0,
    combo: 0, comboUntil: 0, furthest: 9210, camera: 9100, stage: 28, over: false,
    platforms,
    eggs: [{ x: 1075, y: 240, kind: "egg", taken: false }, { x: 1100, y: 238, kind: "gold", taken: false }],
    enemies: [{ x: 1200, y: 258, ox: 1200, oy: 258, kind: "beetle", roam: 23, face: -1, defeated: false, phase: 1.2 }],
    objects: [{ x: 823, y: 292, kind: "flag", stage: 28, active: true, taken: false }],
    chunks: 120, nextFlag: 9800, lastPattern: 4, generatedStage: 29, stageStart: 8900, placedBeacon: false, beaconsLit: 2,
    checkpoint: { x: 823, y: 292, tile: 787 }, lastGround: 787,
    ...state,
  };
  return JSON.stringify({ format: 1, state: full, ...top });
}

/* ───────── v2 saves ───────── */

test("newJourney starts in the Meadow with nothing", () => {
  const j = newJourney(77, NOW);
  assert.deepEqual(j, {
    v: 2, journeySeed: 77, circuit: 1, chapter: 0, flag: 0, eggs: 0, score: 0, flock: 0, beacons: 0,
    reached: { circuit: 1, chapter: 0 }, playSeconds: 0, savedAt: NOW,
  });
  assert.deepEqual(normalizeSave(j), j, "a fresh journey is a valid save");
});

test("writeSave / loadSave round-trip, and the stored text is plain JSON under the v2 key", () => {
  const st = memoryStorage();
  assert.equal(loadSave(st), null, "nothing saved yet");
  assert.equal(writeSave(st, v2()), true);
  assert.deepEqual(JSON.parse(st.getItem(SAVE_KEY)), v2());
  assert.deepEqual(loadSave(st), v2());
});

test("clearSave removes the journey", () => {
  const st = memoryStorage();
  writeSave(st, v2());
  clearSave(st);
  assert.equal(st.getItem(SAVE_KEY), null);
  assert.equal(loadSave(st), null);
});

test("saveAt moves the checkpoint, keeps the seed, and only ever advances `reached`", () => {
  const prev = v2({ circuit: 1, chapter: 4, flag: 0, reached: { circuit: 1, chapter: 6 }, beacons: 0, playSeconds: 100 });
  const s = saveAt(prev, { circuit: 1, chapter: 4, flag: 2, carry: { eggs: 50, score: 900, flock: 2 }, playSeconds: 160, now: NOW + 5 });
  assert.equal(s.journeySeed, prev.journeySeed);
  assert.deepEqual([s.circuit, s.chapter, s.flag], [1, 4, 2]);
  assert.deepEqual([s.eggs, s.score, s.flock, s.playSeconds, s.savedAt], [50, 900, 2, 160, NOW + 5]);
  assert.deepEqual(s.reached, { circuit: 1, chapter: 6 }, "retrying an earlier flag never un-reaches a landscape");
  const forward = saveAt(s, { circuit: 1, chapter: 7, flag: 0, carry: { eggs: 60, score: 1000, flock: 3 }, now: NOW });
  assert.deepEqual(forward.reached, { circuit: 1, chapter: 7 });
  assert.equal(forward.playSeconds, 160, "playSeconds is kept when not passed");
});

test("the beacon saves the start of the NEXT circuit and counts the lit beacon", () => {
  const atBeacon = v2({ circuit: 1, chapter: 12, flag: 3, beacons: 0, reached: { circuit: 1, chapter: 12 }, flock: 5 });
  const s = saveAt(atBeacon, { circuit: 2, chapter: 0, flag: 0, carry: { eggs: 300, score: 9000, flock: 5 }, playSeconds: 3600, beaconLit: true, now: NOW });
  assert.deepEqual([s.circuit, s.chapter, s.flag, s.beacons], [2, 0, 0, 1]);
  assert.deepEqual(s.reached, { circuit: 2, chapter: 0 });
  assert.equal(s.flock, 5);
  const again = saveAt(s, { circuit: 3, chapter: 0, flag: 0, beaconLit: true, now: NOW });
  assert.equal(again.beacons, 2);
  assert.equal(again.eggs, 300, "carry defaults to the previous totals");
});

test("saveAt never produces an invalid save (bad input falls back to the previous one)", () => {
  const prev = v2();
  const bad = saveAt(prev, { chapter: 99, carry: { eggs: NaN } });
  assert.deepEqual(normalizeSave(bad), bad);
  assert.equal(bad.chapter, prev.chapter);
  const from_nothing = saveAt(null, { circuit: 1, chapter: 2, flag: 0, carry: { eggs: 1, score: 10, flock: 0 }, now: NOW });
  assert.equal(from_nothing.chapter, 2);
});

test("a flock can never exceed five, even from a careless caller", () => {
  const s = saveAt(v2(), { carry: { eggs: 10, score: 100, flock: 9 } });
  assert.equal(s.flock, 5);
});

/* ───────── corrupt v2 data ───────── */

test("garbage in the v2 key is ignored, never thrown", () => {
  const junk = [
    "", "null", "[]", "42", "\"hello\"", "{", "{not json", "undefined", "{}", "{\"v\":1}", "{\"v\":3,\"journeySeed\":1}",
    JSON.stringify(v2({ chapter: 13 })), JSON.stringify(v2({ chapter: -1 })), JSON.stringify(v2({ chapter: 2.5 })),
    JSON.stringify(v2({ circuit: 0 })), JSON.stringify(v2({ circuit: "2" })), JSON.stringify(v2({ journeySeed: -5 })),
    JSON.stringify(v2({ journeySeed: 2 ** 32 })), JSON.stringify(v2({ eggs: null })), JSON.stringify(v2({ flock: "3" })),
    JSON.stringify(v2({ flag: -1 })), JSON.stringify(v2({ score: NaN })), "x".repeat(10_000),
  ];
  for (const text of junk) {
    const st = memoryStorage({ [SAVE_KEY]: text });
    assert.equal(loadSave(st), null, `should reject: ${text.slice(0, 40)}`);
  }
});

test("out-of-range totals are clamped, optional fields default, a bogus `reached` is repaired", () => {
  const s = normalizeSave({ v: 2, journeySeed: 5, circuit: 3, chapter: 9, flag: 0, eggs: 12.9, score: -50, flock: 17,
    reached: { circuit: 1, chapter: 2 }, playSeconds: "lots" });
  assert.equal(s.eggs, 12);
  assert.equal(s.score, 0);
  assert.equal(s.flock, 5);
  assert.deepEqual(s.reached, { circuit: 3, chapter: 9 }, "reached can't be behind where you are");
  assert.equal(s.playSeconds, 0);
  assert.equal(s.beacons, 0);
  assert.equal(s.savedAt, 0);
});

test("storage that throws never throws out of save.mjs", () => {
  const boom = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("denied"); } };
  assert.equal(loadSave(boom), null);
  assert.equal(writeSave(boom, v2()), false);
  assert.doesNotThrow(() => clearSave(boom));
  assert.deepEqual(loadSettings(boom), DEFAULT_SETTINGS);
  assert.equal(writeSettings(boom, DEFAULT_SETTINGS), false);
  assert.equal(loadSave(null), null);
  assert.deepEqual(loadSettings(undefined), DEFAULT_SETTINGS);
});

test("writeSave refuses an invalid save instead of storing junk", () => {
  const st = memoryStorage();
  assert.equal(writeSave(st, { v: 2, circuit: 1 }), false);
  assert.equal(st.getItem(SAVE_KEY), null);
});

test("getStorage falls back to memory when localStorage is blocked", () => {
  const blocked = { get localStorage() { throw new Error("SecurityError"); } };
  const st = getStorage(blocked);
  st.setItem("a", "1");
  assert.equal(st.getItem("a"), "1");
  assert.equal(st.getItem("b"), null);
  const works = memoryStorage();
  assert.equal(getStorage({ localStorage: works }), works);
});

test("randomSeed returns a uint32 for any random source", () => {
  assert.equal(randomSeed(seeded(0)), 0);
  assert.equal(randomSeed(seeded(0.5)), 2 ** 31);
  assert.equal(randomSeed(seeded(0.9999999999)), Math.floor(0.9999999999 * 2 ** 32));
  assert.equal(randomSeed(seeded(NaN)), 0);
  const r = randomSeed();
  assert.ok(Number.isInteger(r) && r >= 0 && r < 2 ** 32);
});

/* ───────── legacy migration (SAVE-2) ───────── */

test("legacy: stage 28 = circuit 3, chapter index 2 (Reedwater), counters carry over", () => {
  // stage 28 = floor(28/13)+1 = circuit 3; 28 % 13 = 2.
  const st = memoryStorage({ [LEGACY_SAVE_KEY]: legacySave() });
  const s = loadSave(st, { random: seeded(0.25), now: NOW });
  assert.deepEqual(s, {
    v: 2, journeySeed: 2 ** 30, circuit: 3, chapter: 2, flag: 0,
    eggs: 88, score: 5120, flock: 4, beacons: 2,
    reached: { circuit: 3, chapter: 2 }, playSeconds: 0, savedAt: NOW,
  });
});

test("legacy: stage 0 (a brand-new legacy journey) is Meadow, circuit 1", () => {
  const text = legacySave({ stage: 0, generatedStage: 0, ducklings: 0, collected: 0, points: 0, beaconsLit: 0 });
  const s = migrateLegacy(text, { random: seeded(0), now: NOW });
  assert.deepEqual([s.circuit, s.chapter, s.flag, s.eggs, s.score, s.flock], [1, 0, 0, 0, 0, 0]);
});

test("legacy: stage 12 = Beacon Summit circuit 1; stage 13 = Meadow circuit 2", () => {
  assert.deepEqual((s => [s.circuit, s.chapter])(migrateLegacy(legacySave({ stage: 12 }))), [1, 12]);
  assert.deepEqual((s => [s.circuit, s.chapter])(migrateLegacy(legacySave({ stage: 13 }))), [2, 0]);
  assert.deepEqual((s => [s.circuit, s.chapter])(migrateLegacy(legacySave({ stage: 25 }))), [2, 12]);
});

test("legacy: a flock above five is clamped (old caps were looser)", () => {
  assert.equal(migrateLegacy(legacySave({ ducklings: 8 })).flock, 5);
});

test("legacy: the old key is left untouched and the v2 key is written (so the world stays stable)", () => {
  const text = legacySave();
  const st = memoryStorage({ [LEGACY_SAVE_KEY]: text });
  const first = loadSave(st, { random: seeded(0.1), now: NOW });
  assert.equal(st.getItem(LEGACY_SAVE_KEY), text, "legacy key byte-for-byte untouched");
  assert.deepEqual(JSON.parse(st.getItem(SAVE_KEY)), first);
  // loading again must give the SAME journeySeed, not a fresh random one
  const second = loadSave(st, { random: seeded(0.9), now: NOW + 99 });
  assert.deepEqual(second, first);
});

test("legacy: once a v2 save exists it wins over the legacy one", () => {
  const st = memoryStorage({ [LEGACY_SAVE_KEY]: legacySave(), [SAVE_KEY]: JSON.stringify(v2({ chapter: 5, circuit: 1, flag: 0, reached: { circuit: 1, chapter: 5 } })) });
  assert.equal(loadSave(st).chapter, 5);
  assert.equal(loadSave(st).circuit, 1);
});

test("legacy: Start Over then clearSave cannot resurrect the old journey", () => {
  const st = memoryStorage({ [LEGACY_SAVE_KEY]: legacySave() });
  assert.ok(loadSave(st));
  clearSave(st);
  assert.equal(loadSave(st), null);
  assert.notEqual(st.getItem(LEGACY_SAVE_KEY), null, "still untouched");
  assert.equal(st.getItem(LEGACY_DONE_KEY), "1");
});

test("legacy: a damaged v2 key falls back to the legacy save rather than losing everything", () => {
  const st = memoryStorage({ [SAVE_KEY]: "{broken", [LEGACY_SAVE_KEY]: legacySave() });
  const s = loadSave(st, { random: seeded(0.5), now: NOW });
  assert.equal(s.circuit, 3);
});

test("legacy: tolerates a damaged world (the generator that wrote it is gone anyway)", () => {
  const s = migrateLegacy(legacySave({ platforms: "nope", eggs: null, checkpoint: null, lastGround: undefined, over: true }));
  assert.ok(s, "only the counters matter");
  assert.equal(s.eggs, 88);
});

test("legacy: corrupt / unknown saves are rejected, never half-imported", () => {
  const corrupt = [
    "", "{", "null", "[]", "123", "\"stage\"", "{}", "{\"format\":1}", "{\"format\":1,\"state\":null}",
    "{\"format\":1,\"state\":[]}", "{\"format\":2,\"state\":{\"stage\":3}}", "{\"state\":{\"stage\":3}}",
    legacySave({ stage: -1 }), legacySave({ stage: 2.5 }), legacySave({ stage: "7" }), legacySave({ stage: null }),
    legacySave({ stage: Number.MAX_SAFE_INTEGER }), legacySave({ stage: 1e9 }),
    legacySave({ collected: -3 }), legacySave({ points: "9000" }), legacySave({ ducklings: NaN }), legacySave({ ducklings: null }),
    legacySave({ beaconsLit: {} }), legacySave({}, { format: 99 }),
    JSON.stringify({ format: 1, state: { stage: 4, collected: 1e999 } }),
    "x".repeat(5000),
  ];
  for (const text of corrupt) {
    assert.equal(migrateLegacy(text), null, `should reject: ${text.slice(0, 50)}`);
    assert.equal(loadSave(memoryStorage({ [LEGACY_SAVE_KEY]: text })), null);
  }
});

test("legacy: missing counters count as zero, as long as the stage is readable", () => {
  const s = migrateLegacy(JSON.stringify({ format: 1, state: { stage: 14 } }), { random: seeded(0), now: NOW });
  assert.deepEqual([s.circuit, s.chapter, s.eggs, s.score, s.flock, s.beacons], [2, 1, 0, 0, 0, 0]);
});

test("legacy settings: egg-hero-sound 'off' mutes, egg-hero-best carries over, new key wins afterwards", () => {
  const st = memoryStorage({ [LEGACY_SOUND_KEY]: "off", [LEGACY_BEST_KEY]: "12840" });
  const s = loadSettings(st);
  assert.equal(s.muted, true);
  assert.deepEqual(s.best, { score: 12840, eggs: 0 });
  assert.equal(s.tapToJump, true);
  assert.equal(st.getItem(LEGACY_SOUND_KEY), "off", "legacy key untouched");
  writeSettings(st, { ...s, muted: false });
  assert.equal(loadSettings(st).muted, false, "the player un-muted in the new game: the new key wins");
  assert.equal(loadSettings(st).best.score, 12840);
});

test("legacy settings: 'on', junk and negative values are ignored", () => {
  assert.equal(loadSettings(memoryStorage({ [LEGACY_SOUND_KEY]: "on" })).muted, false);
  assert.equal(loadSettings(memoryStorage({ [LEGACY_SOUND_KEY]: "banana", [LEGACY_BEST_KEY]: "-9" })).best.score, 0);
  assert.equal(loadSettings(memoryStorage({ [LEGACY_BEST_KEY]: "abc" })).best.score, 0);
});

/* ───────── settings ───────── */

test("settings default: sound on, tap-to-jump on, no records, help unseen", () => {
  assert.deepEqual(loadSettings(memoryStorage()), { muted: false, tapToJump: true, best: { score: 0, eggs: 0 }, seenHelp: false });
});

test("settings round-trip and unknown / bad fields are dropped", () => {
  const st = memoryStorage();
  writeSettings(st, { muted: true, tapToJump: false, best: { score: 900.7, eggs: 31 }, seenHelp: true, extra: "x" });
  assert.deepEqual(JSON.parse(st.getItem(SETTINGS_KEY)), { muted: true, tapToJump: false, best: { score: 900, eggs: 31 }, seenHelp: true });
  assert.deepEqual(loadSettings(st), { muted: true, tapToJump: false, best: { score: 900, eggs: 31 }, seenHelp: true });
  const messy = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ muted: "yes", tapToJump: 0, best: { score: -4, eggs: "9" }, seenHelp: [] }) });
  assert.deepEqual(loadSettings(messy), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(42), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage({ [SETTINGS_KEY]: "{oops" })), DEFAULT_SETTINGS);
});

test("recordBest reports a new record only when beaten", () => {
  const base = { ...DEFAULT_SETTINGS, best: { score: 500, eggs: 20 } };
  const lower = recordBest(base, { score: 300, eggs: 25 });
  assert.deepEqual(lower.newBest, { score: false, eggs: true });
  assert.deepEqual(lower.settings.best, { score: 500, eggs: 25 });
  const higher = recordBest(base, { score: 800, eggs: 3 });
  assert.deepEqual(higher.newBest, { score: true, eggs: false });
  assert.equal(higher.settings.best.score, 800);
});

/* ───────── flags ↔ checkpoints ───────── */

/** A level shaped like levelgen's: 13 landscapes with a varying number of flags each. */
function fakeLevel(counts = [5, 8, 7, 9, 8, 6, 9, 10, 8, 9, 7, 10, 6]) {
  const chapters = [], checkpoints = [];
  counts.forEach((n, i) => {
    chapters.push({ index: i, x0: i * 30000, x1: (i + 1) * 30000, flag: checkpoints.length });
    for (let k = 0; k < n; k++) checkpoints.push({ id: checkpoints.length, x: i * 30000 + k * 3500, y: 292, platform: checkpoints.length, ch: i });
  });
  return { chapters, checkpoints };
}

test("resolveFlag / flagOf are inverses for every checkpoint of a circuit", () => {
  const level = fakeLevel();
  assert.equal(level.checkpoints.length, 102);
  for (let idx = 0; idx < level.checkpoints.length; idx++) {
    const { chapter, flag } = flagOf(level, idx);
    assert.equal(chapter, level.checkpoints[idx].ch);
    assert.equal(resolveFlag(level, { chapter, flag }), idx, `checkpoint ${idx}`);
  }
});

test("resolveFlag: flag 0 is the flag that opens the landscape", () => {
  const level = fakeLevel();
  for (const c of level.chapters) assert.equal(resolveFlag(level, { chapter: c.index, flag: 0 }), c.flag);
  assert.equal(resolveFlag(level, { chapter: 2, flag: 3 }), level.chapters[2].flag + 3);
});

test("resolveFlag clamps to the landscape's own flags", () => {
  const level = fakeLevel();
  assert.equal(resolveFlag(level, { chapter: 0, flag: 999 }), level.chapters[1].flag - 1, "never spills into the next landscape");
  assert.equal(resolveFlag(level, { chapter: 12, flag: 999 }), level.checkpoints.length - 1, "last landscape ends at the last flag");
  assert.equal(resolveFlag(level, { chapter: 5, flag: -4 }), level.chapters[5].flag);
  assert.equal(resolveFlag(level, { chapter: 99, flag: 0 }), level.chapters[12].flag, "unknown landscape -> last");
});

test("flagOf clamps out-of-range checkpoint indexes", () => {
  const level = fakeLevel();
  assert.deepEqual(flagOf(level, -3), { chapter: 0, flag: 0 });
  const last = flagOf(level, 10_000);
  assert.equal(last.chapter, 12);
  assert.equal(resolveFlag(level, last), level.checkpoints.length - 1);
  assert.deepEqual(flagOf(level, NaN), { chapter: 0, flag: 0 });
});

test("single-landscape levels (no `chapters`) use the flag number directly", () => {
  const level = { chapter: 4, checkpoints: [{ id: 0 }, { id: 1 }, { id: 2 }] };
  assert.equal(resolveFlag(level, { chapter: 4, flag: 2 }), 2);
  assert.equal(resolveFlag(level, { chapter: 4, flag: 50 }), 2);
  assert.deepEqual(flagOf(level, 1), { chapter: 4, flag: 1 });
  assert.equal(resolveFlag({ checkpoints: [] }, { chapter: 0, flag: 3 }), 0);
  assert.equal(resolveFlag({}, { chapter: 0, flag: 3 }), 0);
});

test("a landscape with a single flag still resolves", () => {
  const level = fakeLevel([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(resolveFlag(level, { chapter: 7, flag: 4 }), 7);
  assert.deepEqual(flagOf(level, 7), { chapter: 7, flag: 0 });
});

test("level.chapters entries are matched by `index`, not array position", () => {
  const level = fakeLevel();
  level.chapters = level.chapters.slice(3); // a partial level (e.g. a test world) starting at landscape 3
  assert.equal(resolveFlag(level, { chapter: 5, flag: 0 }), level.chapters[2].flag);
  assert.deepEqual(flagOf(level, level.chapters[2].flag + 1), { chapter: 5, flag: 1 });
});

test("full resume path: loadSave -> resolveFlag gives the flag the player saved at", () => {
  const level = fakeLevel();
  const st = memoryStorage();
  const checkpointIndex = level.chapters[6].flag + 4;
  const { chapter, flag } = flagOf(level, checkpointIndex);
  writeSave(st, saveAt(newJourney(9, NOW), { circuit: 1, chapter, flag, carry: { eggs: 31, score: 700, flock: 2 }, playSeconds: 1500, now: NOW }));
  const loaded = loadSave(st);
  assert.equal(resolveFlag(level, loaded), checkpointIndex);
  assert.deepEqual([loaded.eggs, loaded.score, loaded.flock], [31, 700, 2]);
});
