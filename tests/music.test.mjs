/*
 * Tests for the soundtrack data (docs/js/music.mjs). Pure data checks: no audio, no DOM. `node --test tests/music.test.mjs`
 *
 * What is verified (AUDIO-1 in SPEC.md and the brief in DESIGN.md §9):
 *   format         every song is valid §9 data: ids, steps inside the loop, MIDI 24..108, drum names, velocities, instruments
 *                  from the closed list, play ranges inside the bars, fx shapes; the audio engine's own lintSong() is clean
 *   durations      chapter loops >= 100 s (these are 122-167 s), title 40-60 s, beacon 60-90 s
 *   the phrase     the Meadow phrase is exact in C major; its six-note head (scale degrees 3 5 6 5 3 2, rhythm 3+3+2+3+3) and
 *                  its two-bar opening are found, by contour measured in each song's OWN scale, in the lead layers of every song,
 *                  in several sections each, with the original rhythm at least twice
 *   key            pitch classes of every pitched layer sit in the declared scale (>= 90 %), the best-fitting diatonic collection
 *                  is the declared one, and every song starts on its tonic chord
 *   lead lines     no leap over an octave, mostly MIDI 62-93, sparse above 88, rests, no sixteenth walls, pickup-sound space
 *   loop           the seam has no hanging gap, no note rings more than a bar past the end, both ends have a full texture
 *   drums          every song has a kit; Meadow has kick on the beat, backbeat rim/snare and 8th hats
 *   variety        not a short loop: distinct layer sets, layers entering and leaving, bars that do not repeat, sections that differ
 *   phone speakers bass in MIDI 40-66 (not sub-bass), voices per second bounded (engine cap 150)
 *   hour           relaxed Meadow, rising intensity from the valley to the summit, the beacon busiest, keys and tempi vary
 *   code           deterministic whatever the build order, builds fast, small, the helper functions (phrase, chordFor, follow...)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as music from '../docs/js/music.mjs';
import { CHAPTERS } from '../docs/js/chapters.mjs';

const { SONGS, songFor } = music;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const MUSIC_URL = new URL('../docs/js/music.mjs', import.meta.url).href;

/* ───────────────────────── independent knowledge (deliberately NOT imported from music.mjs) ───────────────────────── */

const CHAPTER_IDS = CHAPTERS.map((c) => c.song);
const ALL_IDS = ['title', ...CHAPTER_IDS, 'beacon'];
const INSTRUMENTS = ['pulse12', 'pulse25', 'pulse50', 'tri', 'saw', 'sawLead', 'bell', 'marimba', 'pluck', 'pad', 'bassTri', 'bassPulse', 'bassSaw', 'kit'];
const KIT_HITS = ['k', 's', 'h', 'o', 't', 'c', 'r', 'sh', 'cl'];
const MODE_STEPS = { major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], minor: [0, 2, 3, 5, 7, 8, 10] };
const PC_OF = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (name) => { let pc = PC_OF[name[0]]; for (const c of name.slice(1)) pc += c === '#' ? 1 : -1; return ((pc % 12) + 12) % 12; };

const stepsPerBar = (s) => s.beatsPerBar * s.stepsPerBeat;
const loopSteps = (s) => s.bars * stepsPerBar(s);
const seconds = (s) => (s.bars * s.beatsPerBar * 60) / s.bpm;
const isKit = (l) => l.inst === 'kit';
const isBass = (l) => /^bass/.test(l.inst);
const isLead = (l) => /^lead/.test(l.name);
const isMelodic = (l) => /^(lead|counter|descant)/.test(l.name);
const pitched = (s) => s.layers.filter((l) => !isKit(l));
const barOf = (s, step) => Math.floor(step / stepsPerBar(s));
const sectionAt = (s, bar) => s.sections.find((x) => bar >= x.from && bar < x.to);
const sorted = (l) => l.notes.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);

/** Ring time after a note's written length (seconds), per instrument: how long the engine's voice keeps sounding. */
const TAIL = { pulse12: 0.28, pulse25: 0.28, pulse50: 0.28, tri: 0.35, saw: 0.56, sawLead: 0.42, bell: 2.0, marimba: 1.2, pluck: 1.3, pad: 1.3, bassTri: 0.35, bassPulse: 0.35, bassSaw: 0.35 };
const HIT_LEN = { k: 0.26, s: 0.17, h: 0.05, o: 0.26, t: 0.3, c: 1.3, r: 0.05, sh: 0.07, cl: 0.2 };

/** Diatonic step of a MIDI note counted from the song's tonic, in the song's declared scale (null if outside the scale). */
function degreeIndex(song, midi) {
  const ivs = song.scale.map((pc) => (((pc - song.tonic) % 12) + 12) % 12).sort((a, b) => a - b);
  const rel = midi - song.tonic;
  const k = ivs.indexOf(((rel % 12) + 12) % 12);
  return k < 0 ? null : k + 7 * Math.floor(rel / 12);
}

/** The Meadow phrase's six-note head, in diatonic steps and onset gaps (sixteenths): scale degrees 3 5 6 5 3 2. */
const HEAD_STEPS = [2, 1, -1, -2, -1];
const HEAD_IOI = [3, 3, 2, 3, 3];
/** ...and the head plus the first notes of bar two (C D C A, below): 10 notes. */
const OPENING_STEPS = [2, 1, -1, -2, -1, -1, 1, -1, -2];

/** Occurrences of an interval pattern in the given layers. exact = the onset gaps equal `ioi` up to one uniform time scale. */
function findPattern(song, layers, steps, ioi) {
  const found = [];
  for (const l of layers) {
    const ns = sorted(l);
    const ds = ns.map((n) => degreeIndex(song, n[1]));
    for (let i = 0; i + steps.length < ns.length; i++) {
      let ok = true;
      for (let k = 0; k < steps.length && ok; k++) ok = ds[i + k] !== null && ds[i + k + 1] !== null && ds[i + k + 1] - ds[i + k] === steps[k];
      if (!ok) continue;
      const gaps = steps.map((_, k) => ns[i + k + 1][0] - ns[i + k][0]);
      const f = gaps[0] / ioi[0];
      found.push({ layer: l.name, step: ns[i][0], bar: barOf(song, ns[i][0]), exact: ioi.every((v, k) => Math.abs(gaps[k] / f - v) < 1e-9) });
    }
  }
  return found;
}

/** Chord name from song.harmony ('Am', 'Fmaj7', 'Bdim', 'Dsus4', 'C7', 'Emadd9', 'Cm(maj7)') -> its pitch classes. */
function chordPcs(name) {
  const m = /^([A-G][#b]?)(.*)$/.exec(name);
  const root = pcOf(m[1]), q = m[2];
  let iv;
  if (q.startsWith('dim')) iv = [0, 3, 6];
  else if (q.startsWith('sus4')) iv = [0, 5, 7];
  else if (q.startsWith('sus2')) iv = [0, 2, 7];
  else if (q.startsWith('5')) iv = [0, 7];
  else if (q.startsWith('m') && !q.startsWith('maj')) iv = [0, 3, 7];
  else iv = [0, 4, 7];
  if (q.includes('maj7')) iv.push(11);
  else if (q.includes('7')) iv.push(10);
  if (q.includes('add9')) iv.push(2);
  return { root, set: new Set(iv.map((i) => (root + i) % 12)) };
}

/* ───────────────────────── ids ───────────────────────── */

test('exactly the 15 songs the game asks for exist, with the right ids', () => {
  assert.deepEqual(Object.keys(SONGS).sort(), ALL_IDS.slice().sort(), 'SONGS has title, the 13 chapter songs from chapters.mjs, and beacon, nothing else');
  assert.equal(CHAPTER_IDS.length, 13);
  for (const id of ALL_IDS) {
    assert.ok(SONGS[id] && typeof SONGS[id] === 'object', `${id} builds (a builder that throws yields null)`);
    assert.equal(SONGS[id].id, id);
    assert.ok(typeof SONGS[id].title === 'string' && SONGS[id].title.length > 2, `${id} has a title`);
  }
  assert.ok(Object.keys(SONGS)[0] === 'title' && Object.keys(SONGS).pop() === 'beacon', 'listed in game order');
});

test('songFor(chapter, circuit) names the chapter song and wraps around', () => {
  for (let c = 1; c <= 4; c++) {
    for (let i = 0; i < 13; i++) {
      assert.equal(songFor(i, c), CHAPTERS[i].song);
      assert.ok(SONGS[songFor(i, c)], `songFor(${i}, ${c}) is a real song`);
    }
  }
  assert.equal(songFor(13), songFor(0), 'after the beacon the world rotates back to Meadow');
  assert.equal(songFor(-1), songFor(12));
  assert.equal(songFor(0), 'meadow');
  assert.equal(songFor(NaN), 'meadow'); assert.equal(songFor(undefined), 'meadow'); assert.equal(songFor(2.7), songFor(2)); assert.equal(songFor(26), 'meadow');
  assert.equal(songFor(12), 'beacon-summit');
  // garbage in, Meadow out: this is called from the game loop and must never throw
  for (const bad of [Infinity, -Infinity, 2 ** 60, -(2 ** 60), null, 'abc', {}, [], () => 1]) assert.equal(songFor(bad), 'meadow', `songFor(${String(bad)})`);
  assert.equal(songFor('3'), songFor(3)); assert.equal(songFor(-26), 'meadow'); assert.equal(songFor(-13 + 1), songFor(1));
});

/* ───────────────────────── format ───────────────────────── */

function formatProblems(s) {
  const out = [];
  const bad = (msg) => out.push(msg);
  if (!(Number.isFinite(s.bpm) && s.bpm >= 60 && s.bpm <= 200)) bad(`bpm ${s.bpm}`);
  if (s.beatsPerBar !== 4 || s.stepsPerBeat !== 4) bad('beatsPerBar and stepsPerBeat must be 4 (the 16th grid of DESIGN §9)');
  if (!Number.isInteger(s.bars) || s.bars < 1) bad(`bars ${s.bars}`);
  if (!(s.swing >= 0 && s.swing <= 0.5)) bad(`swing ${s.swing}`);
  if (s.gain !== undefined && !(s.gain > 0 && s.gain <= 2)) bad(`gain ${s.gain}`);
  if (!Array.isArray(s.layers) || s.layers.length < 3) { bad('fewer than 3 layers'); return out; }
  const steps = loopSteps(s), names = new Set();
  for (const l of s.layers) {
    const w = `layer '${l.name}'`;
    if (typeof l.name !== 'string' || !l.name) bad('a layer has no name');
    if (names.has(l.name)) bad(`${w} is duplicated`);
    names.add(l.name);
    if (!INSTRUMENTS.includes(l.inst)) bad(`${w}: instrument '${l.inst}' is not in the closed list`);
    if (!(l.vol >= 0 && l.vol <= 1.5)) bad(`${w}: vol ${l.vol}`);
    if (!(l.pan >= -1 && l.pan <= 1)) bad(`${w}: pan ${l.pan}`);
    if (l.fx) {
      const { delay, vibrato, filter, ...extra } = l.fx;
      if (Object.keys(extra).length) bad(`${w}: unknown fx ${Object.keys(extra)}`);
      if (delay && !(delay.beats > 0 && delay.beats <= 3.9 && delay.feedback >= 0 && delay.feedback <= 0.85 && delay.mix >= 0 && delay.mix <= 1)) bad(`${w}: delay ${JSON.stringify(delay)}`);
      if (vibrato && !(vibrato.rate > 0 && vibrato.depth >= 0 && vibrato.delaySteps >= 0)) bad(`${w}: vibrato ${JSON.stringify(vibrato)}`);
      if (filter && !(['lowpass', 'highpass', 'bandpass'].includes(filter.type) && filter.freq > 0)) bad(`${w}: filter ${JSON.stringify(filter)}`);
    }
    let prevEnd = -1;
    if (l.play !== undefined) {
      if (!Array.isArray(l.play) || !l.play.length) bad(`${w}: empty play`);
      for (const r of l.play || []) {
        if (!(Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0] && r[1] <= s.bars)) bad(`${w}: play range ${JSON.stringify(r)} outside 0..${s.bars}`);
        else if (r[0] < prevEnd) bad(`${w}: play ranges overlap or are unsorted`);
        else prevEnd = r[1];
      }
    }
    const ranges = l.play || [[0, s.bars]];
    const inRange = (st) => ranges.some(([a, b]) => barOf(s, st) >= a && barOf(s, st) < b);
    if (isKit(l)) {
      if (l.notes && l.notes.length) bad(`${w}: the kit plays hits, not notes`);
      if (!Array.isArray(l.hits) || !l.hits.length) bad(`${w}: no hits`);
      let last = -1;
      for (const h of l.hits || []) {
        if (!(Number.isInteger(h[0]) && h[0] >= 0 && h[0] < steps)) bad(`${w}: hit step ${h[0]} outside 0..${steps - 1}`);
        if (!KIT_HITS.includes(h[1])) bad(`${w}: drum '${h[1]}'`);
        if (!(h[2] >= 0 && h[2] <= 1)) bad(`${w}: hit vel ${h[2]}`);
        if (h[0] < last) bad(`${w}: hits not sorted`);
        last = h[0];
        if (!inRange(h[0])) bad(`${w}: hit at step ${h[0]} lies outside its play ranges`);
      }
    } else {
      if (l.hits && l.hits.length) bad(`${w}: only the kit plays hits`);
      if (!Array.isArray(l.notes) || !l.notes.length) bad(`${w}: no notes`);
      let last = -1;
      for (const n of l.notes || []) {
        if (!(Number.isInteger(n[0]) && n[0] >= 0 && n[0] < steps)) bad(`${w}: note step ${n[0]} outside 0..${steps - 1}`);
        if (!(Number.isInteger(n[1]) && n[1] >= 24 && n[1] <= 108)) bad(`${w}: midi ${n[1]} outside 24..108`);
        if (!(Number.isInteger(n[2]) && n[2] >= 1)) bad(`${w}: length ${n[2]}`);
        if (!(n[3] >= 0 && n[3] <= 1)) bad(`${w}: vel ${n[3]}`);
        if (n[0] < last) bad(`${w}: notes not sorted`);
        last = n[0];
        if (!inRange(n[0])) bad(`${w}: note at step ${n[0]} lies outside its play ranges`);
      }
    }
  }
  // sections metadata and harmony are consistent with the loop
  let at = 0;
  for (const x of s.sections || []) { if (x.from !== at || !(x.to > x.from)) bad(`section ${x.name} is not contiguous`); at = x.to; }
  if (at !== s.bars) bad(`sections cover ${at} of ${s.bars} bars`);
  if (!Array.isArray(s.harmony) || s.harmony.length !== s.bars) bad('harmony has one entry per bar');
  return out;
}

test('every song is valid §9 data', () => {
  for (const id of ALL_IDS) assert.deepEqual(formatProblems(SONGS[id]), [], `${id} has format problems`);
});

test("the audio engine's own lintSong finds nothing to say about any song", async (t) => {
  let audio;
  try { audio = await import('../docs/js/audio.mjs'); } catch (e) { if (e && e.code === 'ERR_MODULE_NOT_FOUND') return t.skip('audio.mjs does not exist yet'); throw e; }
  for (const id of ALL_IDS) assert.deepEqual(audio.lintSong(SONGS[id]), [], `${id}`);
});

/* ───────────────────────── durations ───────────────────────── */

test('chapter songs are long developing loops; title and beacon have their own lengths', () => {
  for (const id of CHAPTER_IDS) {
    const sec = seconds(SONGS[id]);
    assert.ok(sec >= 100, `${id} loops in ${sec.toFixed(1)} s, brief: >= 100 s`);
    assert.ok(sec >= 120 && sec <= 170, `${id} loops in ${sec.toFixed(1)} s, brief aims at 120-170 s`);
    assert.ok(SONGS[id].bars >= 56, `${id} has ${SONGS[id].bars} bars`);
  }
  const title = seconds(SONGS.title), beacon = seconds(SONGS.beacon);
  assert.ok(title >= 40 && title <= 60, `title ${title.toFixed(1)} s`);
  assert.ok(beacon >= 60 && beacon <= 90, `beacon ${beacon.toFixed(1)} s`);
  // each landscape lasts 3.5-5.3 minutes, so a child hears a song 2-3 times
  for (let i = 0; i < 13; i++) {
    const plays = CHAPTERS[i].seconds / seconds(SONGS[CHAPTERS[i].song]);
    assert.ok(plays >= 1.4 && plays <= 3.2, `${CHAPTERS[i].song}: heard ${plays.toFixed(1)} times in its landscape`);
  }
});

/* ───────────────────────── the Meadow phrase ───────────────────────── */

test('Meadow plays the phrase exactly: four bars in C major, stepwise with a few small leaps, with rests', () => {
  const m = SONGS.meadow;
  assert.equal(m.key, 'C'); assert.equal(m.mode, 'major');
  assert.ok(m.bpm >= 118 && m.bpm <= 128, `bpm ${m.bpm}`);
  const lead = m.layers.find((l) => l.name === 'lead');
  const bar0 = lead.play[0][0] * 16;
  const T1 = [76, 79, 81, 79, 76, 74, /* bar 2 */ 72, 74, 72, 69, /* bar 3 */ 74, 77, 79, 77, 74, 72, /* bar 4 */ 79, 74, 71, 74, 76];
  const got = sorted(lead).filter((n) => n[0] >= bar0 && n[0] < bar0 + 64).map((n) => n[1]);
  assert.deepEqual(got, T1, 'the hummable phrase, notes E G A G E D | C D C A | D F G F D C | G D B D E');
  const first = sorted(lead).filter((n) => n[0] >= bar0 && n[0] < bar0 + 16);
  assert.deepEqual(first.map((n) => n[0] - bar0), [0, 3, 6, 8, 11, 14], 'the tresillo head rhythm 3+3+2+3+3');
  // singable: mostly steps and skips (<= 3 semitones), nothing bigger than a fifth
  const iv = T1.slice(1).map((p, i) => Math.abs(p - T1[i]));
  assert.ok(iv.filter((d) => d <= 3).length / iv.length >= 0.8, 'at least 80% of the intervals are steps or skips');
  assert.ok(Math.max(...iv) <= 7, 'no leap larger than a fifth');
  assert.ok(iv.filter((d) => d >= 5).length <= 3, 'only a few leaps');
  // rests: the phrase breathes (bar 2 step 6-8, bar 4 step 8-12)
  const starts = new Set(sorted(lead).filter((n) => n[0] >= bar0 && n[0] < bar0 + 64).map((n) => n[0] - bar0));
  const ends = sorted(lead).filter((n) => n[0] >= bar0 && n[0] < bar0 + 64).map((n) => n[0] - bar0 + n[2]);
  const gaps = [...starts].sort((a, b) => a - b).map((st, i, arr) => (i ? st - Math.max(...ends.filter((e) => e <= st)) : 0)).filter((g) => g >= 2);
  assert.ok(gaps.length >= 2, 'the melody leaves at least two rests of an 8th or more in four bars');
});

test('the phrase head returns, in its own scale, in every song (contour and original rhythm), in several sections', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    const heads = findPattern(s, s.layers.filter(isLead), HEAD_STEPS, HEAD_IOI);
    const sections = new Set(heads.map((h) => sectionAt(s, h.bar).name));
    assert.ok(heads.length >= 4, `${id}: only ${heads.length} head statements in its lead layers`);
    assert.ok(heads.filter((h) => h.exact).length >= 2, `${id}: the head keeps its rhythm (3+3+2+3+3, at any one tempo scale) fewer than 2 times`);
    assert.ok(sections.size >= (id === 'title' ? 2 : 3), `${id}: the head appears in only ${sections.size} section(s): ${[...sections]}`);
    const opening = findPattern(s, s.layers.filter(isLead), OPENING_STEPS, [3, 3, 2, 3, 3, 3, 3, 2, 2]);
    assert.ok(opening.length >= 2, `${id}: the two-bar opening (E G A G E D | C D C A as degrees 3 5 6 5 3 2 | 1 2 1 6) appears ${opening.length} times`);
  }
});

test('the phrase is dressed differently every time: keys, modes, tempi and tunes vary across the hour', () => {
  const keys = new Set(CHAPTER_IDS.map((id) => `${SONGS[id].key} ${SONGS[id].mode}`));
  assert.ok(keys.size >= 11, `${keys.size} distinct key/mode pairs among 13 chapter songs`);
  const modes = new Set(CHAPTER_IDS.map((id) => SONGS[id].mode));
  assert.ok(['major', 'minor', 'dorian', 'phrygian', 'lydian'].every((m) => modes.has(m)), `modes used: ${[...modes]}`);
  for (let i = 1; i < 13; i++) {
    const a = SONGS[CHAPTER_IDS[i - 1]], b = SONGS[CHAPTER_IDS[i]];
    assert.notEqual(`${a.key} ${a.mode}`, `${b.key} ${b.mode}`, `${a.id} -> ${b.id}: neighbouring landscapes must differ in key or mode`);
    assert.notEqual(a.bpm, b.bpm, `${a.id} -> ${b.id}: and in tempo`);
  }
  const bpms = CHAPTER_IDS.map((id) => SONGS[id].bpm);
  assert.ok(Math.max(...bpms) - Math.min(...bpms) >= 40, `tempo range ${Math.min(...bpms)}-${Math.max(...bpms)}`);
  const leadInst = new Set(CHAPTER_IDS.map((id) => SONGS[id].layers.find((l) => l.name === 'lead').inst));
  assert.ok(leadInst.size >= 5, `main lead instruments: ${[...leadInst]}`);
  // the same notes at the same pitches are NOT just copied: the head's absolute pitches differ between songs
  const headPitches = CHAPTER_IDS.map((id) => {
    const s = SONGS[id], h = findPattern(s, s.layers.filter(isLead), HEAD_STEPS, HEAD_IOI).find((x) => x.exact);
    const l = s.layers.find((x) => x.name === h.layer);
    return sorted(l).find((n) => n[0] === h.step)[1] % 12;
  });
  assert.ok(new Set(headPitches).size >= 8, `the head starts on ${new Set(headPitches).size} different pitch classes`);
  // theme in every arrangement: the beacon plays it in C major, in full
  const b = SONGS.beacon;
  assert.equal(b.key, 'C'); assert.equal(b.mode, 'major');
  assert.ok(findPattern(b, b.layers.filter(isLead), HEAD_STEPS, HEAD_IOI).filter((h) => h.exact).length >= 8, 'the beacon states the head many times');
  assert.ok(b.layers.filter((l) => !isKit(l)).length >= 11 && b.layers.length >= 12, 'the beacon is a full arrangement');
});

/* ───────────────────────── key analysis ───────────────────────── */

test('every song is in its declared key: >= 90% of the notes in the scale, the best-fitting scale is the declared one, it starts on the tonic', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    assert.ok(MODE_STEPS[s.mode], `${id}: mode ${s.mode}`);
    const tonic = pcOf(s.key);
    assert.equal(s.tonic, tonic, `${id}: tonic metadata`);
    const declared = new Set(MODE_STEPS[s.mode].map((x) => (tonic + x) % 12));
    assert.deepEqual([...declared].sort((a, b) => a - b), s.scale, `${id}: scale metadata`);
    // all pitched layers, weighted by the notes themselves
    const hist = new Array(12).fill(0);
    let n = 0;
    for (const l of pitched(s)) for (const nt of l.notes) { hist[nt[1] % 12]++; n++; }
    const inScale = [...declared].reduce((a, pc) => a + hist[pc], 0) / n;
    assert.ok(inScale >= 0.9, `${id}: only ${(inScale * 100).toFixed(1)}% of the notes are in ${s.key} ${s.mode}`);
    // best-fitting diatonic collection (the 12 rotations of the major scale) is the declared one
    let best = -1, bestCov = -1;
    for (let p = 0; p < 12; p++) {
      const set = new Set(MODE_STEPS.major.map((x) => (p + x) % 12));
      const cov = [...set].reduce((a, pc) => a + hist[pc], 0);
      if (cov > bestCov) { bestCov = cov; best = p; }
    }
    const bestSet = new Set(MODE_STEPS.major.map((x) => (best + x) % 12));
    assert.deepEqual([...bestSet].sort((a, b) => a - b), [...declared].sort((a, b) => a - b), `${id}: the best-fitting diatonic collection is not the declared ${s.key} ${s.mode}`);
    // tonality: it starts on its tonic chord, and the tonic is among the three most-used bass pitch classes
    assert.equal(chordPcs(s.harmony[0]).root, tonic, `${id}: first chord ${s.harmony[0]}`);
    const bassHist = new Array(12).fill(0);
    for (const l of s.layers.filter(isBass)) for (const nt of l.notes) bassHist[nt[1] % 12] += nt[2];
    const top3 = bassHist.map((v, pc) => [v, pc]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]);
    assert.ok(top3.includes(tonic), `${id}: bass favours ${top3}, not the tonic ${tonic}`);
  }
});

test('the harmony metadata agrees with the notes: bass roots and a sparing use of clashes under the lead', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    // bass note on the first step of a bar is the chord root (or its fifth below/above, never a stray tone)
    let checked = 0, rootHits = 0;
    for (const l of s.layers.filter(isBass)) for (const n of l.notes) {
      if (n[0] % 16 !== 0) continue;
      const ch = chordPcs(s.harmony[barOf(s, n[0])].split('_')[0]);
      checked++;
      if (n[1] % 12 === ch.root) rootHits++;
    }
    assert.ok(checked >= 16, `${id}: ${checked} downbeat bass notes`);
    assert.ok(rootHits / checked >= 0.95, `${id}: only ${rootHits}/${checked} downbeat bass notes are the chord root`);
    // a sustained lead note a semitone ABOVE a chord tone is a clash (an appoggiatura in minor keys is allowed a little)
    let n = 0, clash = 0;
    for (const l of s.layers.filter(isMelodic)) for (const nt of l.notes) {
      n++;
      if (nt[2] < 3) continue;
      const parts = s.harmony[barOf(s, nt[0])].split('_');
      const ch = chordPcs(nt[0] % 16 >= 8 && parts[1] ? parts[1] : parts[0]);
      if (!ch.set.has(nt[1] % 12) && [...ch.set].some((c) => (((nt[1] % 12) - c) % 12 + 12) % 12 === 1)) clash++;
    }
    assert.ok(clash / n <= 0.07, `${id}: ${(100 * clash / n).toFixed(1)}% of lead notes clash with the chord`);
  }
});

/* ───────────────────────── lead lines ───────────────────────── */

test('lead lines never leap more than an octave', () => {
  for (const id of ALL_IDS) {
    for (const l of SONGS[id].layers.filter(isMelodic)) {
      const ns = sorted(l);
      for (let i = 1; i < ns.length; i++) {
        const d = Math.abs(ns[i][1] - ns[i - 1][1]);
        assert.ok(d <= 12, `${id}/${l.name}: leap of ${d} semitones at bar ${barOf(SONGS[id], ns[i][0]) + 1}`);
      }
    }
  }
});

test('lead lines live in the phone-speaker melody range and stay sparse up high', () => {
  for (const id of ALL_IDS) {
    for (const l of SONGS[id].layers.filter(isLead)) {
      const ns = l.notes;
      const inside = ns.filter((n) => n[1] >= 62 && n[1] <= 93).length / ns.length;
      const high = ns.filter((n) => n[1] >= 88).length / ns.length;
      assert.ok(inside >= 0.9, `${id}/${l.name}: only ${(inside * 100).toFixed(0)}% of the notes are in MIDI 62-93`);
      assert.ok(high <= 0.1, `${id}/${l.name}: ${(high * 100).toFixed(0)}% of the notes are above MIDI 88`);
      assert.ok(Math.min(...ns.map((n) => n[1])) >= 55 && Math.max(...ns.map((n) => n[1])) <= 100, `${id}/${l.name}: outliers`);
    }
  }
});

test('lead lines leave rests and are never a wall of sixteenths', () => {
  const STRUCK = new Set(['bell', 'marimba', 'pluck']);        // these decay by themselves: a written length beyond ~3 steps is not audible sustain
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    for (const l of s.layers.filter(isLead)) {
      const perBar = new Map(), cover = new Set();
      for (const n of l.notes) {
        perBar.set(barOf(s, n[0]), (perBar.get(barOf(s, n[0])) || 0) + 1);
        for (let k = 0; k < (STRUCK.has(l.inst) ? Math.min(n[2], 3) : n[2]); k++) cover.add(n[0] + k);
      }
      assert.ok(Math.max(...perBar.values()) <= 9, `${id}/${l.name}: ${Math.max(...perBar.values())} notes in one bar`);
      // the line is silent at least 15% of the time in the bars where it plays: it breathes
      const silence = 1 - cover.size / (perBar.size * 16);
      assert.ok(silence >= 0.15, `${id}/${l.name}: only ${(silence * 100).toFixed(0)}% silence in the bars where it plays`);
      // and at least a third of its bars contain a rest of an eighth or more
      let breathing = 0;
      for (const [b] of perBar) {
        let gap = 0, ok = false;
        for (let st = b * 16; st < b * 16 + 16; st++) { if (cover.has(st)) gap = 0; else if (++gap >= 2) ok = true; }
        if (ok) breathing++;
      }
      assert.ok(breathing / perBar.size >= 0.25, `${id}/${l.name}: only ${(100 * breathing / perBar.size).toFixed(0)}% of its bars contain a rest of an eighth or more`);
    }
    // no layer plays a run of consecutive sixteenths longer than 3 (the 'run' riser may fill the last half bar of a build)
    for (const l of pitched(s).filter((x) => !isBass(x))) {
      const steps = [...new Set(l.notes.map((n) => n[0]))].sort((a, b) => a - b);
      let run = 1, longest = 1;
      for (let i = 1; i < steps.length; i++) { run = steps[i] - steps[i - 1] === 1 ? run + 1 : 1; longest = Math.max(longest, run); }
      assert.ok(longest <= (l.name === 'run' ? 8 : 3), `${id}/${l.name}: a run of ${longest} consecutive sixteenths`);
    }
  }
});

test('the 1-4 kHz pickup band is never walled in: free steps in every bar, and every run layer is a short riser', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    let sum = 0, worst = 0;
    for (let b = 0; b < s.bars; b++) {
      const steps = new Set();
      for (const l of pitched(s).filter((x) => !isBass(x) && x.name !== 'run')) for (const n of l.notes) if (barOf(s, n[0]) === b && n[1] >= 72) steps.add(n[0] % 16);
      sum += steps.size; worst = Math.max(worst, steps.size);
    }
    assert.ok(sum / s.bars <= 9, `${id}: on average ${(sum / s.bars).toFixed(1)} of 16 steps per bar start a note at MIDI >= 72`);
    assert.ok(worst <= 12, `${id}: a bar with ${worst} of 16 steps starting notes at MIDI >= 72`);
    const run = s.layers.find((l) => l.name === 'run');
    if (run) assert.ok(run.notes.length <= 8 * (run.play || [[0, 1]]).reduce((n, [a, z]) => n + (z - a), 0), `${id}: the run riser is one short gesture per build`);
  }
});

/* ───────────────────────── phone speakers ───────────────────────── */

test('bass lines sit in the range phone speakers can use (the engine adds harmonics); chords and pads in the middle', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    for (const l of s.layers.filter(isBass)) {
      const lo = Math.min(...l.notes.map((n) => n[1])), hi = Math.max(...l.notes.map((n) => n[1]));
      const inside = l.notes.filter((n) => n[1] >= 40 && n[1] <= 66).length / l.notes.length;
      assert.ok(lo >= 40 && hi <= 72 && inside >= 0.95, `${id}/${l.name}: bass range ${lo}-${hi}, ${(inside * 100).toFixed(0)}% in 40-66`);
    }
    for (const l of pitched(s).filter((x) => !isBass(x) && !isLead(x) && x.inst !== 'bell')) {
      const lo = Math.min(...l.notes.map((n) => n[1]));
      assert.ok(lo >= 48, `${id}/${l.name} (${l.inst}) plays as low as MIDI ${lo}`);
    }
  }
});

test('voices stay far below the engine cap (150): estimated live voices per song', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id], sd = 60 / s.bpm / 4;
    const ev = [];
    for (const l of s.layers) for (const e of isKit(l) ? l.hits : l.notes) ev.push(isKit(l) ? [e[0] * sd, e[0] * sd + HIT_LEN[e[1]]] : [e[0] * sd, e[0] * sd + e[2] * sd + TAIL[l.inst]]);
    ev.sort((a, b) => a[0] - b[0]);
    let live = [], max = 0;
    for (const [st, en] of ev) { live = live.filter((e) => e > st); live.push(en); max = Math.max(max, live.length); }
    assert.ok(max <= 90, `${id}: up to ~${max} voices at once`);
  }
});

/* ───────────────────────── the loop seam ───────────────────────── */

test('every loop wraps around without a hanging gap, and starts and ends with a real texture', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id], steps = loopSteps(s), sd = 60 / s.bpm / 4;
    const cover = new Uint8Array(steps);
    let overhang = 0;
    for (const l of s.layers) {
      for (const e of isKit(l) ? l.hits : l.notes) {
        const len = isKit(l) ? Math.ceil(HIT_LEN[e[1]] / sd) : e[2] + Math.round(Math.min(TAIL[l.inst], 1) / sd);
        for (let k = 0; k < len; k++) cover[(e[0] + k) % steps] = 1;
        if (!isKit(l)) overhang = Math.max(overhang, e[0] + e[2] - steps);
      }
    }
    let gap = 0, worst = 0;
    for (let i = 0; i < steps * 2; i++) { if (!cover[i % steps]) { gap++; worst = Math.max(worst, gap); } else gap = 0; }
    assert.ok(worst <= 4, `${id}: a gap of ${worst} sixteenths somewhere around the loop (including across the seam)`);
    assert.ok(overhang <= 16, `${id}: a note rings ${overhang} steps past the loop end`);
    const bars = (b) => new Set(s.layers.filter((l) => (isKit(l) ? l.hits : l.notes).some((e) => barOf(s, e[0]) === b)).map((l) => l.name)).size;
    assert.ok(bars(0) >= 2 && bars(s.bars - 1) >= 3, `${id}: first bar has ${bars(0)} layers, last bar ${bars(s.bars - 1)}`);
    // the first note of the loop is where the music starts: no leading silence
    const firstStep = Math.min(...s.layers.map((l) => (isKit(l) ? l.hits : l.notes)[0][0]));
    assert.equal(firstStep, 0, `${id}: nothing sounds at step 0`);
  }
});

/* ───────────────────────── drums ───────────────────────── */

test('every song has a drum part with pulse; Meadow has kick on the beat, backbeat and eighth-note hats', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id], kit = s.layers.filter(isKit);
    assert.ok(kit.length >= 1, `${id}: no kit`);
    const hits = kit.flatMap((l) => l.hits);
    const play = kit[0].play || [[0, s.bars]];
    const playingBars = play.reduce((n, [a, b]) => n + (b - a), 0);
    assert.ok(hits.length / playingBars >= 4, `${id}: ${(hits.length / playingBars).toFixed(1)} hits per playing bar`);
    assert.ok(hits.some((h) => h[1] === 'k') || id === 'fogwood' || id === 'dawnbridge', `${id}: no kick drum`);
    if (id === 'fogwood') assert.ok(hits.filter((h) => h[1] === 't').length >= 40, 'fogwood keeps a heartbeat of soft toms');
    const kicks = new Set(hits.filter((h) => h[1] === 'k').map((h) => barOf(s, h[0])));
    assert.ok(kicks.size / playingBars >= (id === 'fogwood' ? 0 : 0.5), `${id}: kick in only ${kicks.size}/${playingBars} bars`);
    assert.ok(hits.every((h) => h[2] > 0), `${id}: silent hit`);
  }
  const m = SONGS.meadow, kit = m.layers.find(isKit);
  const aBars = m.sections.filter((x) => /^A/.test(x.name)).flatMap((x) => Array.from({ length: x.to - x.from }, (_, i) => x.from + i));
  const at = (b, names) => kit.hits.filter((h) => barOf(m, h[0]) === b && names.includes(h[1])).map((h) => h[0] % 16);
  const share = (pred) => aBars.filter(pred).length / aBars.length;
  assert.ok(share((b) => at(b, ['k']).includes(0)) >= 0.95, 'kick on beat 1');
  assert.ok(share((b) => at(b, ['k']).includes(8)) >= 0.9, 'kick on beat 3');
  assert.ok(share((b) => at(b, ['r', 's', 'cl']).includes(4)) >= 0.95, 'backbeat on beat 2');
  assert.ok(share((b) => at(b, ['r', 's', 'cl']).includes(12) || at(b, ['t']).includes(12)) >= 0.9, 'backbeat on beat 4 (or a fill)');
  assert.ok(share((b) => [0, 2, 4, 6, 8, 10, 12].filter((st) => at(b, ['h']).includes(st)).length >= 6) >= 0.8, 'eighth-note hats');
  // ...and the bass is the buoyant octave bounce: in most bars of the A sections an octave pair appears
  const bass = m.layers.find((l) => l.name === 'bass');
  const bounce = share((b) => { const ps = bass.notes.filter((n) => barOf(m, n[0]) === b).map((n) => n[1]); return ps.some((p) => ps.includes(p + 12)); });
  assert.ok(bounce >= 0.9, `octave bounce in ${(bounce * 100).toFixed(0)}% of the A bars`);
});

/* ───────────────────────── variety: not a short loop ───────────────────────── */

test('no song is a short loop repeated: distinct textures, layers that come and go, bars that do not repeat', () => {
  for (const id of ALL_IDS) {
    const s = SONGS[id];
    // 1. distinct sets of sounding layers over 4-bar windows
    const active = (b) => s.layers.filter((l) => (l.play || [[0, s.bars]]).some(([a, z]) => b >= a && b < z)).map((l) => l.name);
    const windows = new Set();
    for (let b = 0; b < s.bars; b += 4) windows.add(active(b).sort().join('+'));
    assert.ok(windows.size >= (id === 'title' ? 4 : id === 'beacon' ? 5 : 6), `${id}: ${windows.size} distinct layer sets among its 4-bar windows`);
    // 2. layers enter and leave (play ranges that are not the whole song) and the number of sounding layers swings
    const partial = s.layers.filter((l) => l.play && !(l.play.length === 1 && l.play[0][0] === 0 && l.play[0][1] === s.bars));
    assert.ok(partial.length >= (id === 'title' ? 5 : 6), `${id}: ${partial.length} layers enter or leave`);
    const counts = Array.from({ length: s.bars }, (_, b) => active(b).length);
    assert.ok(new Set(counts).size >= (id === 'title' ? 3 : id === 'beacon' ? 4 : 5), `${id}: layer count takes ${new Set(counts).size} values`);
    assert.ok(Math.max(...counts) - Math.min(...counts) >= (id === 'title' ? 3 : 4), `${id}: layer count swings ${Math.min(...counts)}..${Math.max(...counts)}`);
    // 3. whole-bar repeats: a bar whose every layer is exactly the same as the bar 1, 2, 4 or 8 bars on
    const key = (b) => { const k = []; for (const l of s.layers) for (const e of isKit(l) ? l.hits : l.notes) if (barOf(s, e[0]) === b) k.push(`${l.name}:${e[0] - b * 16}:${e[1]}:${e[2]}`); return k.sort().join('|'); };
    const keys = Array.from({ length: s.bars }, (_, b) => key(b));
    for (const lag of [1, 2, 4, 8, 16]) {
      const same = keys.filter((k, b) => k && k === keys[(b + lag) % s.bars]).length / s.bars;
      assert.ok(same <= 0.35, `${id}: ${(same * 100).toFixed(0)}% of the bars are exact repeats of the bar ${lag} on`);
    }
    // 4. neighbouring sections differ in who plays
    let same = 0;
    for (let i = 1; i < s.sections.length; i++) {
      const a = active(s.sections[i - 1].from).join(), b = active(s.sections[i].from).join();
      if (a === b) same++;
    }
    assert.ok(same <= 1, `${id}: ${same} neighbouring section pairs have identical layer sets`);
    assert.ok(s.sections.length >= (id === 'title' ? 5 : 6), `${id}: ${s.sections.length} sections`);
    // 5. the song names its forms: it has a bridge or breakdown and a build (chapter songs)
    if (CHAPTER_IDS.includes(id)) assert.ok(s.sections.some((x) => /bridge|thin|swell|mist/i.test(x.name)) && s.sections.some((x) => /build|swell|climb|ascent|rise/i.test(x.name)), `${id}: sections ${s.sections.map((x) => x.name)}`);
  }
});

test('the sections of a song differ from one another in notes, not only in who plays', () => {
  for (const id of CHAPTER_IDS) {
    const s = SONGS[id];
    const profile = (sec) => {
      const h = new Array(12).fill(0), d = { notes: 0, drums: 0 };
      for (const l of s.layers) for (const e of isKit(l) ? l.hits : l.notes) {
        if (e[0] < sec.from * 16 || e[0] >= sec.to * 16) continue;
        if (isKit(l)) d.drums++; else { h[e[1] % 12]++; d.notes++; }
      }
      const n = Math.max(1, d.notes);
      return { pcs: h.map((v) => v / n), dens: d.notes / (sec.to - sec.from), drums: d.drums / (sec.to - sec.from) };
    };
    const ps = s.sections.map(profile);
    let different = 0, pairs = 0;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      pairs++;
      const pcs = ps[i].pcs.reduce((a, v, k) => a + Math.abs(v - ps[j].pcs[k]), 0);
      const dens = Math.abs(ps[i].dens - ps[j].dens) / Math.max(1, ps[i].dens, ps[j].dens);
      if (pcs >= 0.15 || dens >= 0.25 || Math.abs(ps[i].drums - ps[j].drums) >= 4) different++;
    }
    assert.ok(different / pairs >= 0.8, `${id}: only ${(100 * different / pairs).toFixed(0)}% of its section pairs differ in harmony colour, density or drums`);
  }
});

/* ───────────────────────── the hour ───────────────────────── */

/** Distinct onset steps per second (a chord stab counts once), over the whole loop and over its busiest 16 bars. */
function density(s) {
  const barSec = (16 * 60) / s.bpm / 4, perBar = new Array(s.bars).fill(0);
  for (const l of s.layers) for (const st of new Set((isKit(l) ? l.hits : l.notes).map((e) => e[0]))) perBar[barOf(s, st)]++;
  const avg = perBar.reduce((a, b) => a + b, 0) / s.bars / barSec;
  const layers = s.layers.map((l) => (l.play || [[0, s.bars]]).reduce((n, [a, z]) => n + (z - a), 0)).reduce((a, b) => a + b, 0) / s.bars;
  return { avg, layers };
}

test('Meadow is relaxed and spacious, intensity rises from the valley to the summit, and the beacon is the busiest', () => {
  const d = Object.fromEntries(ALL_IDS.map((id) => [id, density(SONGS[id])]));
  const mean = (ids) => ids.reduce((a, id) => a + d[id].avg, 0) / ids.length;
  assert.ok(d.meadow.avg <= 13 && d.meadow.layers <= 6, `Meadow: ${d.meadow.avg.toFixed(1)} onsets/s, ${d.meadow.layers.toFixed(1)} layers on average`);
  const valley = mean(CHAPTER_IDS.slice(0, 4)), mid = mean(CHAPTER_IDS.slice(4, 9)), late = mean(CHAPTER_IDS.slice(9, 13));
  assert.ok(late >= valley * 1.15, `valley ${valley.toFixed(1)}, middle ${mid.toFixed(1)}, late ${late.toFixed(1)} onsets per second: the journey should build`);
  assert.ok(mid >= valley, `the middle (${mid.toFixed(1)}) is at least as busy as the valley (${valley.toFixed(1)})`);
  assert.ok(d['beacon-summit'].avg >= d.meadow.avg * 1.4, 'the summit is much busier than Meadow');
  assert.ok(d['beacon-summit'].avg >= Math.max(...CHAPTER_IDS.slice(0, 12).map((id) => d[id].avg)) - 0.5, 'the summit is the busiest chapter song');
  for (const id of CHAPTER_IDS) assert.ok(d.beacon.avg >= d[id].avg * 1.4 && d.beacon.layers >= d[id].layers, `the beacon outdoes ${id}`);
  assert.ok(d.beacon.layers >= 9, 'the beacon plays nearly everything at once');
  // the moods the owner asked for: fogwood/caverns/reedwater calm, canyon pulsing and fast, coast swung, summit fast
  assert.ok(SONGS['glass-coast'].swing >= 0.3, 'glass coast shuffles');
  assert.ok(SONGS.canyon.bpm >= 130 && SONGS.canyon.mode === 'phrygian', 'canyon pulses with Phrygian bite');
  assert.ok(SONGS.fogwood.bpm <= 105 && SONGS['lantern-caverns'].bpm <= 100, 'fogwood and the caverns float');
  assert.ok(SONGS['lantern-caverns'].layers.some((l) => l.inst === 'bell' && l.fx && l.fx.delay && l.fx.delay.beats >= 1 && l.fx.delay.mix >= 0.3), 'the caverns echo (long delay on the bells)');
  assert.ok(SONGS.frostline.layers.some((l) => l.inst === 'bell') && SONGS.frostline.layers.some((l) => l.inst === 'pluck'), 'frostline glitters on bells and plucks');
  assert.ok(SONGS.ridge.layers.some((l) => l.name === 'pulse' && l.play === undefined), 'moonridge keeps its steady pulse (arpeggios in every section)');
  assert.ok(SONGS.dawnbridge.layers.filter((l) => l.inst === 'pad').length >= 2 && SONGS.dawnbridge.layers.some((l) => l.inst === 'pad' && l.notes.some((n) => n[2] >= 32)), 'dawnbridge swells on long pads');
  assert.ok(SONGS.ridge.mode === 'minor' && SONGS['beacon-summit'].bpm >= 120, 'moonridge in the minor, the summit climbing at pace');
});

/* ───────────────────────── code quality ───────────────────────── */

test('the data is deterministic whatever order the songs are built in, small, and quick to build', async () => {
  const forward = await import(`${MUSIC_URL}?order=forward`);
  const a = {};
  for (const id of ALL_IDS) a[id] = JSON.stringify(forward.SONGS[id]);
  const backward = await import(`${MUSIC_URL}?order=backward`);
  const b = {};
  for (const id of ALL_IDS.slice().reverse()) b[id] = JSON.stringify(backward.SONGS[id]);
  for (const id of ALL_IDS) assert.equal(a[id], b[id], `${id} differs when built in a different order (some cache is keyed too coarsely)`);
  assert.equal(a.meadow, JSON.stringify(SONGS.meadow));
  const total = ALL_IDS.reduce((n, id) => n + a[id].length, 0);
  assert.ok(total < 2_000_000, `songs are ${(total / 1e6).toFixed(2)} MB of JSON`);
  assert.equal(JSON.stringify(SONGS).length, total + 2 + ALL_IDS.reduce((n, id) => n + id.length + 3, 0) + ALL_IDS.length - 1, 'SONGS serialises like a plain object');
});

test('importing is instant and building every song takes well under 150 ms', async () => {
  // Other engineers' test files and browsers share this machine, so wall time alone is a poor witness: every sample is the
  // SMALLER of wall time and this process's own CPU time (CPU time does not grow when another process steals the core), and the
  // result is the best of three cold imports. (Measured on a quiet dev machine: import ~4 ms, all 15 songs ~55-70 ms.)
  const sample = async (i) => {
    const c0 = process.cpuUsage(), w0 = performance.now();
    const fresh = await import(`${MUSIC_URL}?timing=${i}-${Math.random()}`);
    const w1 = performance.now(), c1 = process.cpuUsage(c0);
    for (const id of ALL_IDS) assert.ok(fresh.SONGS[id]);
    const w2 = performance.now(), c2 = process.cpuUsage(c0);
    return { fresh, importMs: Math.min(w1 - w0, (c1.user + c1.system) / 1000), buildMs: Math.min(w2 - w0, (c2.user + c2.system) / 1000) };
  };
  let importMs = Infinity, buildMs = Infinity;
  for (let i = 0; i < 3; i++) {
    const r = await sample(i);
    importMs = Math.min(importMs, r.importMs); buildMs = Math.min(buildMs, r.buildMs);
    const again = performance.now(), cpu = process.cpuUsage();
    for (const id of ALL_IDS) r.fresh.SONGS[id];
    const usage = process.cpuUsage(cpu);
    assert.ok(Math.min(performance.now() - again, (usage.user + usage.system) / 1000) < 3, 'a built song is kept, not rebuilt');
    assert.equal(r.fresh.SONGS.meadow, r.fresh.SONGS.meadow, 'the same object every time (the engine caches compiled songs per object)');
  }
  // On a busy machine (load average above 3/4 of the cores) keep a 2x guard against gross regressions only.
  const busy = os.loadavg()[0] > os.cpus().length * 0.75, scale = busy ? 2 : 1;
  assert.ok(importMs < 40 * scale, `import took ${importMs.toFixed(1)} ms (songs are built lazily, on first use)${busy ? ' [machine busy]' : ''}`);
  assert.ok(buildMs < 150 * scale, `import + building all 15 songs took ${buildMs.toFixed(1)} ms (the brief: < 150 ms)${busy ? ' [machine busy, budget x2]' : ''}`);
});

test('helpers: note names, melody notation, transforms, chords, drum rows', () => {
  const { noteNum, noteNums, phrase, shiftDeg, octave, stretch, slice, concat, seq, follow, fit, accents, chordFor, typed, grv, compose, MODES } = music;
  assert.equal(noteNum('C4'), 60); assert.equal(noteNum('A4'), 69); assert.equal(noteNum('F#3'), 54); assert.equal(noteNum('Bb2'), 46); assert.equal(noteNum('C-1'), 0);
  assert.deepEqual(noteNums('C4 E4 - G4'), [60, 64, null, 67]);
  assert.throws(() => noteNum('H4')); assert.throws(() => noteNum('C'));
  for (const [name, steps] of Object.entries(MODE_STEPS)) assert.deepEqual(MODES[name], steps, `mode ${name}`);

  const p = phrase("3/3 5/3 6/2 5/3 3/3 2/2 | 1/6 r/2 2/2 1/2 6,/4");
  assert.equal(p.bars, 2); assert.equal(p.notes.length, 10);
  assert.deepEqual(p.notes.slice(0, 3).map((n) => [n.s, n.d, n.len]), [[0, 2, 3], [3, 4, 3], [6, 5, 2]], 'degrees are zero-based diatonic indices');
  assert.equal(p.notes[9].d, -2, "a comma is an octave down: 6, is the 6th below the home 1");
  assert.equal(phrase("1'/16").notes[0].d, 7); assert.equal(phrase('b7/16').notes[0].a, -1); assert.equal(phrase('#4/16').notes[0].a, 1);
  assert.throws(() => phrase('1/15'), /not 16/); assert.throws(() => phrase('9/16'), /bad melody token/);

  assert.deepEqual(shiftDeg(p, 2).notes.map((n) => n.d), p.notes.map((n) => n.d + 2));
  assert.deepEqual(octave(p, -1).notes.map((n) => n.d), p.notes.map((n) => n.d - 7));
  const st = stretch(p, 2);
  assert.equal(st.bars, 4); assert.deepEqual(st.notes.map((n) => n.s), p.notes.map((n) => n.s * 2)); assert.deepEqual(st.notes.map((n) => n.len), p.notes.map((n) => n.len * 2));
  assert.equal(slice(p, 1, 2).notes[0].s, 0); assert.equal(slice(p, 1, 2).bars, 1);
  assert.equal(concat(p, p).bars, 4); assert.equal(concat(p, p).notes[10].s, 32);
  assert.equal(seq(phrase('1/16'), [0, 1, 2]).notes.map((n) => n.d).join(), '0,1,2');
  assert.equal(accents(music.THEME).notes.every((n) => n.s % 16 === 0 || n.s % 16 === 8 || n.len >= 6), true);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(fit), [0, 1, 2, 3, -3, -2, -1], 'smallest shift to land on a chord degree');
  // follow: every bar is the cell shifted so that it starts on the chord's own scale step, and the bars join without big leaps
  const cell = phrase('1/4 3/4 5/4 3/4'), f = follow(cell, [1, 4, 5, 6, 3, 2, 7]);
  assert.equal(f.bars, 7);
  for (let b = 0; b < 7; b++) assert.equal(((f.notes[b * 4].d % 7) + 7) % 7, [0, 3, 4, 5, 2, 1, 6][b], `bar ${b + 1} starts on the chord root's degree`);
  for (let i = 1; i < f.notes.length; i++) assert.ok(Math.abs(f.notes[i].d - f.notes[i - 1].d) <= 7, 'smooth joins');

  const major = MODE_STEPS.major, minor = MODE_STEPS.minor;
  assert.deepEqual(chordFor('1', major).tones, [0, 4, 7]); assert.deepEqual(chordFor('6', major).tones, [9, 12, 16]); assert.deepEqual(chordFor('6', minor).tones, [8, 12, 15]);
  assert.equal(chordFor('5', major).root, 7); assert.deepEqual(chordFor('b7', major).tones, [10, 14, 17]); assert.deepEqual(chordFor('1:add9', major).tones, [0, 4, 7, 14]);
  assert.deepEqual(chordFor('5:D7', major).tones, [7, 11, 14, 17]); assert.deepEqual(chordFor('2:M', major).tones, [2, 6, 9]); assert.deepEqual(chordFor('4:s4', major).tones, [5, 10, 12]);
  assert.throws(() => chordFor('8', major)); assert.throws(() => chordFor('1:nope', major));
  assert.equal(typed([1, 6, '5_1'], 'D7'), '1:D7 6:D7 5:D7_1:D7');

  const g = grv('k:X...x...X...x... h:x.m.x.m.x.m.x.m.');
  assert.equal(g.k.length, 16); assert.throws(() => grv('k:X...'), /not 16/);

  // compose: a tiny song, in and out
  const tiny = compose({
    id: 'tiny', title: 'Tiny', bpm: 100, key: 'D', mode: 'dorian', mel: { M: phrase('1/8 3/8') }, kits: { a: grv('k:X...............') },
    layers: [{ name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.8 }, { name: 'lead', inst: 'tri', gen: 'mel', vol: 0.5 }, { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.6 }],
    sections: [{ name: 'a', bars: 2, prog: '1 4', l: { bass: 'half', kit: 'a' } }, { name: 'b', bars: 2, prog: '5 1', l: { bass: 'whole', lead: 'M', kit: 'a +crash' } }],
  });
  assert.equal(tiny.bars, 4); assert.equal(tiny.key, 'D'); assert.deepEqual(tiny.harmony, ['Dm', 'G', 'Am', 'Dm']);
  assert.deepEqual(tiny.layers.find((l) => l.name === 'lead').play, [[2, 4]]); assert.equal(tiny.layers.find((l) => l.name === 'bass').play, undefined);
  assert.deepEqual(tiny.layers.find((l) => l.name === 'lead').notes.map((n) => n[1]), [74, 77, 74, 77], 'D dorian degrees 1 and 3 above the home tonic D5, the one-bar phrase tiled over two bars');
  assert.deepEqual(formatProblems(tiny), []);
  assert.throws(() => compose({ ...{ id: 'x', bpm: 100, key: 'C', mode: 'nope', layers: [], sections: [] } }), /unknown mode/);
  // leadMix: the mixing knob scales the tune-carrying layers (lead*, counter, descant) and nothing else
  const mixed = compose({
    id: 'mixed', title: 'Mixed', bpm: 100, key: 'C', mode: 'major', leadMix: 1.5, mel: { M: phrase('1/8 3/8') },
    layers: [{ name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.8 }, { name: 'lead', inst: 'tri', gen: 'mel', vol: 0.4 }, { name: 'leadB', inst: 'tri', gen: 'mel', vol: 0.4 }, { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.2 }, { name: 'bell', inst: 'bell', gen: 'mel', vol: 0.4 }],
    sections: [{ name: 'a', bars: 2, prog: '1 4', l: { bass: 'half', lead: 'M', leadB: 'M', counter: 'M', bell: 'M' } }],
  });
  assert.deepEqual(mixed.layers.map((l) => [l.name, l.vol]), [['bass', 0.8], ['lead', 0.6], ['leadB', 0.6], ['counter', 0.3], ['bell', 0.4]]);
});

test('the tune is mixed to be heard: every lead layer is audible, no layer is out of the engine range, song gains stay sane', () => {
  for (const id of ALL_IDS) {
    const song = SONGS[id];
    const leads = song.layers.filter((l) => /^(lead|counter|descant)/.test(l.name));
    assert.ok(leads.length >= 1, `${id} has a lead layer`);
    for (const l of song.layers) assert.ok(l.vol > 0 && l.vol <= 1.5, `${id}/${l.name}: vol ${l.vol} must be inside the engine's 0-1.5 range`);
    assert.ok((song.gain ?? 1) >= 0.6 && (song.gain ?? 1) <= 1.6, `${id}: gain ${song.gain} (a trim, not a second volume knob)`);
    // the main lead is never quieter than half the bass layer: the melody must be able to compete with the low end on a phone speaker
    const bass = song.layers.find((l) => l.name === 'bass'), main = song.layers.find((l) => l.name === 'lead' || l.name === 'leadM' || l.name === 'leadB');
    if (bass && main) assert.ok(main.vol >= bass.vol * 0.4, `${id}: lead vol ${main.vol} vs bass vol ${bass.vol}`);
  }
});

test('tools/music-analyze.mjs prints the summary table, the layer map and the head statements', () => {
  const run = (...args) => execFileSync(process.execPath, [`${HERE}../tools/music-analyze.mjs`, ...args], { encoding: 'utf8' });
  const out = run();
  for (const id of ALL_IDS) assert.ok(out.includes(id), `summary lists ${id}`);
  assert.match(out, /Meadow theme/); assert.match(out, /instruments/); assert.match(out, /15 songs/);
  assert.match(run('--map', 'canyon'), /canyon: Ember Canyon Run/);
  assert.match(run('--theme'), /head statements/);
  assert.match(run('--roll', 'meadow', '--layers', 'lead,bass', '--bars', '4-6'), /Am/);
  assert.equal(JSON.parse(run('--json')).length, 15);
});
