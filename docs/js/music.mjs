/*
 * Egg Mama — the original soundtrack (DESIGN.md §9, SPEC AUDIO-1).
 *
 *   import { SONGS, songFor } from './music.mjs';
 *   const audio = new GameAudio({ muted, songs: SONGS });      // SONGS = { id: song }, ids: title, the 13 chapter songs, beacon
 *   audio.playSong(songFor(chapterIndex, circuit), { fade: 3.5 });
 *
 * ── THE IDEA ──────────────────────────────────────────────────────────────────────────────────────────────
 * One four-bar tune — the MEADOW PHRASE — is the soul of the whole hour. Its head (6 notes, in scale degrees
 *
 *        3 5 6 5 3 2     long-long-short-long-long-short  (3+3+2 | 3+3+2 sixteenths, a bouncy tresillo)
 *
 * ) is audible in every chapter song, re-dressed: new key and mode, new tempo, new instruments, new harmony, new
 * rhythmic feel (straight, swung, floating at half speed, pulsing, ...). The beacon plays it as a full, triumphant
 * arrangement in C major. Because melodies and chords are written in SCALE DEGREES, the same notes re-appear in
 * every mode (the head is C major's E G A G E D, but E phrygian's G B C B G F, D minor's F A Bb A F E, ...).
 *
 * Each chapter song is a long developing piece (>= 100 s, most 125-160 s): intro / A / A' / B / bridge or
 * breakdown / build / A'' / coda / outro, with layers entering and leaving through `play` ranges (slow intensity
 * waves), so a child who stays in a landscape 3.5-5.3 minutes hears each song only two or three times.
 *
 * ── HOW THE DATA IS MADE ─────────────────────────────────────────────────────────────────────────────────
 * Songs are built at import time from tiny helpers (everything here is plain data in, plain data out):
 *   noteNum('F#3') / noteNums('C4 E4 G4')    note names -> MIDI
 *   phrase('3/3 5/3 6/2 | ...')              melody in scale degrees: <degree>[#|b][' up][, down]/<steps>; r = rest
 *   shiftDeg / octave / stretch / slice / concat / seq / follow / staccato / accents / only / grace    melody transforms
 *   chordFor('6' | 'b7' | '1:add9' | '5:sus4')  chords as scale degrees (diatonic triads of the mode, or a named type)
 *   BASS / COMP / ARP / FILLS                 pattern tables; grv('k:X...x... r:....') drum rows (X x m g = loud .. ghost)
 *   compose({...})                            section table -> a song in the §9 format
 * A section table says, for every section, how many bars, which chords (degrees) and which layer plays what; a layer
 * that is absent from a section is silent there (those become the layer's `play` ranges: entrances and exits).
 *
 * ── PHONE SPEAKERS ───────────────────────────────────────────────────────────────────────────────────────
 * Bass lines live in MIDI ~43-66 on bassTri / bassSaw / bassPulse (the engine adds harmonics); melodies mostly
 * 62-91; pads and chords 55-76; the lead keeps rests and rarely goes above MIDI 88, and no layer plays a
 * constant sixteenth wall in the 1-4 kHz range, so pickup sounds always have somewhere to sit.
 */
import { CHAPTERS } from './chapters.mjs';

/* ═══════════════════════════════════ 1. pitch ═══════════════════════════════════ */

const NAME_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' -> 60 (middle C), 'F#3' -> 54, 'Bb2' -> 46. */
export function noteNum(name) {
  const m = /^([A-Ga-g])([#b]*)(-?\d)$/.exec(String(name).trim());
  if (!m) throw new Error(`bad note name '${name}'`);
  let pc = NAME_PC[m[1].toUpperCase()];
  for (const c of m[2]) pc += c === '#' ? 1 : -1;
  return 12 * (+m[3] + 1) + pc;
}
/** 'C4 E4 - G4' -> [60, 64, null, 67]  ('-' is a rest). */
export function noteNums(text) {
  return String(text).trim().split(/\s+/).map((t) => (t === '-' ? null : noteNum(t)));
}
const keyPc = (k) => (noteNum(k + '4') % 12 + 12) % 12;

export const MODES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], minor: [0, 2, 3, 5, 7, 8, 10],
});
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const r2 = (v) => Math.round(v * 100) / 100;
/** Semitones above the tonic of diatonic index d (0 = tonic, 7 = octave up, -1 = the 7th below). */
const degOff = (sc, d) => sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);

/* ═══════════════════════════════════ 2. melody in scale degrees ═══════════════════════════════════ */

const TOK = /^(r|[#b]?[1-7])([',]*)(?:\/(\d+))?(?:\*(\d+))?$/;

/**
 * Parse a melody. Bars are separated by '|' and must add up to 16 steps (sixteenths). A token is
 * `<degree>[marks]/<len>[*vel%]`: degree 1-7 (optionally #/b), `'` = octave up, `,` = octave down, `r` = rest.
 * Degree 1 with no marks is the "home" tonic (the song's melody tonic, e.g. C5 in C major).
 * Returns { bars, notes: [{ s (step), d (diatonic index, 0 = home tonic), a (accidental), len, vel }] }.
 */
export function phrase(text) {
  const notes = [];
  let s = 0, bars = 0;
  for (const bar of String(text).split('|')) {
    const toks = bar.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const start = s;
    for (const t of toks) {
      const m = TOK.exec(t);
      if (!m) throw new Error(`bad melody token '${t}'`);
      const len = m[3] ? +m[3] : 2;
      if (m[1] !== 'r') {
        let ds = m[1], a = 0;
        if (ds[0] === '#' || ds[0] === 'b') { a = ds[0] === '#' ? 1 : -1; ds = ds[1]; }
        let oct = 0;
        for (const c of m[2]) oct += c === "'" ? 1 : -1;
        notes.push({ s, d: +ds - 1 + 7 * oct, a, len, vel: m[4] ? +m[4] / 100 : 1 });
      }
      s += len;
    }
    if (s - start !== 16) throw new Error(`melody bar ${bars + 1} of '${String(text).trim().slice(0, 24)}...' is ${s - start} steps, not 16`);
    bars++;
  }
  return { bars, notes };
}

const mapNotes = (ph, f) => ({ bars: ph.bars, notes: ph.notes.map(f).filter(Boolean) });
/** Move every note up (+) / down (-) k scale steps (a diatonic sequence: contour stays, intervals follow the mode). */
export const shiftDeg = (ph, k) => mapNotes(ph, (n) => ({ ...n, d: n.d + k }));
export const octave = (ph, k) => shiftDeg(ph, 7 * k);
/** Augmentation (f = 2: half speed) or any integer-friendly time scaling. */
export function stretch(ph, f) {
  return { bars: Math.ceil(ph.bars * f - 1e-9), notes: ph.notes.map((n) => ({ ...n, s: Math.round(n.s * f), len: Math.max(1, Math.round(n.len * f)) })) };
}
/** Bars [from, to) of a phrase, re-based to start at bar 0. */
export function slice(ph, from, to) {
  return { bars: to - from, notes: ph.notes.filter((n) => n.s >= from * 16 && n.s < to * 16).map((n) => ({ ...n, s: n.s - from * 16 })) };
}
export function concat(...phs) {
  const notes = []; let bars = 0;
  for (const p of phs) { for (const n of p.notes) notes.push({ ...n, s: n.s + bars * 16 }); bars += p.bars; }
  return { bars, notes };
}
/** The 'cell' repeated with each diatonic shift in `shifts` (a melodic sequence). */
export const seq = (cell, shifts) => concat(...shifts.map((k) => shiftDeg(cell, k)));
/**
 * A cell re-fitted to the chord root of every bar (`roots` = chord degrees 1-7): the cell is written for a chord on degree 1,
 * so its chord tones stay chord tones on every chord. Each shift is the smallest one (-3..+3 steps), so the line stays in one register.
 */
export const fit = (r) => (r - 1 <= 3 ? r - 1 : r - 8);                 // the smallest diatonic shift that lands on degree r: -3..+3
export function follow(cell, roots) {
  const first = cell.notes[0].d;
  const last = cell.notes.reduce((a, n) => (n.s >= a.s ? n : a), cell.notes[0]).d;
  // each bar may sit an octave higher or lower than its smallest shift: choose the placements that minimise the leaps
  // between bars (dynamic programming, at most 3 candidates per bar) while preferring to stay close to home
  const cands = roots.map((r) => [r - 8, r - 1, r + 6].filter((c) => Math.abs(c) <= 5));
  let costs = cands[0].map((c) => ({ c, cost: 0.15 * Math.abs(c), prev: null }));
  const table = [costs];
  for (let i = 1; i < roots.length; i++) {
    costs = cands[i].map((c) => {
      let best = null;
      for (const p of table[i - 1]) {
        const cost = p.cost + Math.abs(first + c - (last + p.c)) + 0.15 * Math.abs(c);
        if (!best || cost < best.cost) best = { c, cost, prev: p };
      }
      return best;
    });
    table.push(costs);
  }
  let node = table[table.length - 1].reduce((a, b) => (b.cost < a.cost ? b : a));
  const shifts = [];
  for (; node; node = node.prev) shifts.unshift(node.c);
  return concat(...shifts.map((c) => shiftDeg(cell, c)));
}
/** Short crisp notes (bouncy, marimba-ish). */
export const staccato = (ph, len = 1) => mapNotes(ph, (n) => ({ ...n, len: Math.min(n.len, len) }));
/** Only the structurally important notes: those that start on a half bar, or are long. Sparkle doubling. */
export const accents = (ph, minLen = 6) => mapNotes(ph, (n) => (n.s % 16 === 0 || n.s % 16 === 8 || n.len >= minLen ? n : null));
/** Notes whose start lands (mod 16) in `steps`. */
export const only = (ph, steps) => mapNotes(ph, (n) => (steps.includes(n.s % 16) ? n : null));
/** A one-step upper-neighbour grace note before every note that is at least `minLen` long and starts on a beat. */
export function grace(ph, minLen = 3) {
  const out = [];
  for (const n of ph.notes) {
    const prev = out[out.length - 1];
    if (n.len >= minLen && n.s % 4 === 0 && n.s > 0 && !(prev && prev.s >= n.s - 1)) {   // the step before the note must be free
      if (prev && prev.s + prev.len > n.s - 1) prev.len = Math.max(1, n.s - 1 - prev.s);
      out.push({ s: n.s - 1, d: n.d + 1, a: 0, len: 1, vel: 0.6 });
    }
    out.push({ ...n });
  }
  return { bars: ph.bars, notes: out };
}

/* ═══════════════════════════════════ 3. chords ═══════════════════════════════════ */

const TYPES = {
  M: [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], s2: [0, 2, 7], s4: [0, 5, 7],
  M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], M9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '5': [0, 7, 12],
};
/**
 * Chord token -> { root (semitones above the tonic), tones (ascending semitones above the tonic), deg, name }.
 *   '1'     diatonic triad of degree 1 in the song's mode     'b7' 'b6' '#4'   flat/sharp root, major triad
 *   '1:add9' diatonic triad + 9th    '5:D7' diatonic 7th chord    '2:s4' sus4 ... '4:M7' major 7th (see TYPES)
 */
export function chordFor(tok, sc) {
  const m = /^([#b]?)([1-7])(?::(\w+))?$/.exec(tok);
  if (!m) throw new Error(`bad chord token '${tok}'`);
  const idx = +m[2] - 1, acc = m[1] === '#' ? 1 : m[1] === 'b' ? -1 : 0, type = m[3];
  const dia = (k) => degOff(sc, idx + k);
  const root = dia(0) + acc;
  let tones;
  if (!type) tones = acc ? [root, root + 4, root + 7] : [dia(0), dia(2), dia(4)];
  else if (type === 'add9') tones = [dia(0), dia(2), dia(4), dia(8)];
  else if (type === 'D7') tones = [dia(0), dia(2), dia(4), dia(6)];
  else if (type === 'D9') tones = [dia(0), dia(2), dia(4), dia(6), dia(8)];
  else if (TYPES[type]) tones = TYPES[type].map((i) => root + i);
  else throw new Error(`bad chord type '${type}'`);
  return { root: ((root % 12) + 12) % 12, tones, deg: idx, name: tok };
}

/** Progression text from degrees, all with one chord type: typed([1, 6, '5_1'], 'D7') -> '1:D7 6:D7 5:D7_1:D7' ('_' = two chords in a bar). */
export const typed = (list, type) => list.map((d) => String(d).split('_').map((x) => x + ':' + type).join('_')).join(' ');

const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** 'C', 'Am', 'Bbmaj7', 'Dsus4' ... for display and tests (spelling follows the key signature of the mode's parent major scale). */
export function chordName(key, ch, flats) {
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  const iv = new Set(ch.tones.map((t) => (((t - ch.tones[0]) % 12) + 12) % 12));
  let q = iv.has(3) ? (iv.has(6) && !iv.has(7) ? 'dim' : 'm') : iv.has(4) ? '' : iv.has(5) ? 'sus4' : iv.has(2) ? 'sus2' : '5';
  if (iv.has(11)) q += iv.has(3) ? '(maj7)' : 'maj7';
  else if (iv.has(10) && ch.tones.length > 3) q += '7';
  else if (ch.tones.length > 3 && ch.tones.some((t) => t - ch.tones[0] >= 12 && ((t - ch.tones[0]) % 12) === 2)) q += 'add9';
  return names[(key + ch.root) % 12] + q;
}

/** Root of the chord as a bass pitch in [lo, lo+12). */
function bassRoot(ch, key, lo) {
  let p = key + ch.root;
  while (p < lo) p += 12;
  while (p >= lo + 12) p -= 12;
  return p;
}

/** A chord voicing (n tones) near `center`, as close as possible to the previous voicing (smooth voice leading). */
const VOICINGS = new Map();                                   // voicings are pure functions of their inputs: compute each once
function voice(ch, key, center, n, prev) {
  const memo = `${ch.tones.join(',')}|${key}|${center}|${n}|${prev ? prev.join(',') : ''}`;   // the chord's actual notes (not its name: '1' differs by mode)
  let v = VOICINGS.get(memo);
  if (!v) { v = voiceCalc(ch, key, center, n, prev); if (VOICINGS.size < 5000) VOICINGS.set(memo, v); }
  return v.slice();
}
function voiceCalc(ch, key, center, n, prev) {
  const base = key + 48;                                         // an anchor: the chord tones just above C3
  const tones = ch.tones.slice(0, Math.max(3, n)).map((t) => base + t);
  const want = tones.slice(0, n);
  let best = null, bestCost = Infinity;
  for (let inv = 0; inv < want.length; inv++) {
    const v = want.map((p, i) => (i < inv ? p + 12 : p)).sort((a, b) => a - b);
    const mean = v.reduce((s, p) => s + p, 0) / v.length;
    for (let k = -4; k <= 4; k++) {
      const cand = v.map((p) => p + 12 * k);
      const m = mean + 12 * k;
      if (Math.abs(m - center) > 6) continue;                   // a voicing never wanders more than half an octave from its register
      let cost;
      if (prev && prev.length === cand.length) cost = cand.reduce((s, p, i) => s + Math.abs(p - prev[i]), 0) + Math.abs(m - center) * 0.35;
      else cost = Math.abs(m - center);
      if (cost < bestCost) { bestCost = cost; best = cand; }
    }
  }
  return best;
}
/** The chord stacked upward from the first root at or above `lo`: [root, 3rd, 5th, ...] ascending (for arpeggios). */
function stack(ch, key, lo, n) {
  let r = key + ch.root;
  while (r < lo) r += 12;
  while (r >= lo + 12) r -= 12;
  const out = [];
  for (const t of ch.tones.slice(0, n)) { let p = key + ((t % 12) + 12) % 12; while (p < r) p += 12; out.push(p); }
  out.sort((a, b) => a - b);
  return out;
}

/* ═══════════════════════════════════ 4. pattern tables ═══════════════════════════════════ */

/**
 * BASS: [step, symbol, len, vel]   r root, o octave up, f fifth, F fifth below the root, t third, s seventh,
 * u octave below, a approach tone into the next chord's root (a scale step from the side the line is coming from).
 */
export const BASS = {
  bounce:  [[0, 'r', 2, 1], [2, 'o', 2, 0.7], [4, 'r', 2, 0.88], [6, 'o', 2, 0.7], [8, 'r', 2, 0.95], [10, 'o', 2, 0.7], [12, 'r', 2, 0.88], [14, 'a', 2, 0.72]],
  bounceS: [[0, 'r', 3, 1], [3, 'o', 1, 0.7], [4, 'r', 2, 0.85], [8, 'r', 3, 0.95], [11, 'o', 1, 0.7], [12, 'f', 2, 0.8], [14, 'a', 2, 0.72]],
  rf:      [[0, 'r', 4, 1], [4, 'f', 4, 0.8], [8, 'r', 4, 0.95], [12, 'f', 3, 0.8]],
  walk:    [[0, 'r', 4, 1], [4, 't', 4, 0.8], [8, 'f', 4, 0.9], [12, 'a', 4, 0.8]],
  pump8:   [[0, 'r', 2, 1], [2, 'r', 2, 0.65], [4, 'r', 2, 0.8], [6, 'r', 2, 0.65], [8, 'r', 2, 0.92], [10, 'r', 2, 0.65], [12, 'r', 2, 0.8], [14, 'r', 2, 0.65]],
  pump8a:  [[0, 'r', 2, 1], [2, 'r', 2, 0.65], [4, 'r', 2, 0.8], [6, 'r', 2, 0.65], [8, 'r', 2, 0.92], [10, 'r', 2, 0.65], [12, 'r', 2, 0.8], [14, 'o', 2, 0.7]],
  half:    [[0, 'r', 8, 1], [8, 'f', 8, 0.85]],
  whole:   [[0, 'r', 16, 1]],
  trese:   [[0, 'r', 3, 1], [3, 'r', 3, 0.8], [6, 'r', 2, 0.75], [8, 'r', 3, 0.95], [11, 'f', 3, 0.8], [14, 'a', 2, 0.72]],
  sparse:  [[0, 'r', 6, 1], [8, 'f', 3, 0.8], [12, 'r', 3, 0.85]],
  gallop:  [[0, 'r', 3, 1], [3, 'r', 1, 0.6], [4, 'r', 3, 0.85], [7, 'r', 1, 0.6], [8, 'r', 3, 0.95], [11, 'r', 1, 0.6], [12, 'r', 3, 0.85], [14, 'o', 1, 0.7], [15, 'a', 1, 0.7]],
  drive16: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((s) => [s, s % 8 === 7 ? 'o' : 'r', 1, s % 4 === 0 ? 1 : s % 2 === 0 ? 0.7 : 0.5]),
  boing:   [[0, 'r', 2, 1], [3, 'o', 1, 0.75], [4, 'r', 1, 0.6], [6, 'f', 2, 0.8], [8, 'r', 2, 0.95], [11, 'o', 1, 0.75], [12, 'r', 1, 0.6], [14, 'a', 2, 0.75]],
  swingWalk: [[0, 'r', 3, 1], [4, 't', 3, 0.8], [8, 'f', 3, 0.9], [12, 'a', 3, 0.8], [14, 'a', 1, 0.5]],
  lilt:    [[0, 'r', 3, 1], [4, 'f', 2, 0.7], [6, 'o', 2, 0.8], [8, 'r', 3, 0.95], [12, 'f', 2, 0.7], [14, 'a', 2, 0.75]],
};

/** COMP (chord stabs): [step, len, vel, strumDelayPerNote]. */
export const COMP = {
  off8:    [[2, 1, 0.8, 0], [6, 1, 0.65, 0], [10, 1, 0.8, 0], [14, 1, 0.65, 0]],
  backbeat: [[4, 2, 0.8, 0], [12, 2, 0.8, 0]],
  skank:   [[2, 2, 0.8, 0], [6, 2, 0.7, 0], [10, 2, 0.8, 0], [14, 2, 0.7, 0]],
  push:    [[3, 2, 0.8, 0], [6, 2, 0.65, 0], [11, 2, 0.8, 0], [14, 2, 0.65, 0]],
  half:    [[0, 7, 0.75, 0], [8, 7, 0.65, 0]],
  whole:   [[0, 15, 0.7, 0]],
  pulse8:  [0, 2, 4, 6, 8, 10, 12, 14].map((s) => [s, 2, s % 4 === 0 ? 0.8 : 0.55, 0]),
  trese:   [[0, 2, 0.8, 0], [3, 2, 0.7, 0], [6, 2, 0.6, 0], [8, 2, 0.8, 0], [11, 2, 0.7, 0], [14, 2, 0.6, 0]],
  sparse:  [[0, 6, 0.7, 1], [10, 3, 0.55, 0]],
  tick:    [[4, 1, 0.7, 0], [12, 1, 0.7, 0]],
};

/** ARP: [step, index into the stacked chord tones (wraps up an octave every n tones), len, vel]. */
export const ARP = {
  roll8:   [[0, 0, 2, 0.9], [2, 2, 2, 0.6], [4, 1, 2, 0.75], [6, 2, 2, 0.6], [8, 0, 2, 0.85], [10, 2, 2, 0.6], [12, 1, 2, 0.75], [14, 2, 2, 0.6]],
  up8:     [[0, 0, 2, 0.9], [2, 1, 2, 0.65], [4, 2, 2, 0.75], [6, 3, 2, 0.65], [8, 4, 2, 0.85], [10, 3, 2, 0.6], [12, 2, 2, 0.7], [14, 1, 2, 0.6]],
  wave8:   [[0, 0, 2, 0.9], [2, 1, 2, 0.6], [4, 2, 2, 0.7], [6, 4, 2, 0.6], [8, 3, 2, 0.8], [10, 2, 2, 0.6], [12, 1, 2, 0.65], [14, 2, 2, 0.55]],
  tres:    [[0, 0, 3, 0.9], [3, 2, 3, 0.7], [6, 1, 2, 0.65], [8, 3, 3, 0.85], [11, 2, 3, 0.7], [14, 1, 2, 0.6]],
  sparse:  [[0, 0, 3, 0.85], [6, 2, 3, 0.6], [10, 1, 3, 0.65]],
  drops:   [[0, 2, 4, 0.8], [5, 1, 4, 0.55], [9, 3, 4, 0.7], [13, 0, 3, 0.5]],
  pulse8:  [0, 2, 4, 6, 8, 10, 12, 14].map((s) => [s, [0, 2, 1, 2, 0, 2, 1, 2][s / 2], 2, s % 4 === 0 ? 0.85 : 0.55]),
  syn:     [[0, 0, 2, 0.9], [3, 1, 2, 0.65], [6, 2, 2, 0.7], [8, 1, 2, 0.8], [11, 2, 2, 0.65], [14, 3, 2, 0.6]],
};

/** FILLS: drum fills that replace the end of a bar. */
export const FILLS = {
  tom:    [[12, 't', 0.8], [13, 't', 0.6], [14, 't', 0.9], [15, 't', 1]],
  snare:  [[12, 's', 0.45], [13, 's', 0.5], [14, 's', 0.7], [15, 's', 0.95]],
  roll:   [[8, 's', 0.35], [10, 's', 0.45], [12, 's', 0.55], [13, 's', 0.65], [14, 's', 0.8], [15, 's', 1]],
  hat:    [[12, 'h', 0.6], [14, 'h', 0.7], [15, 'o', 0.8]],
  tick:   [[14, 'r', 0.7], [15, 'r', 0.9]],
  shake:  [[12, 'sh', 0.5], [13, 'sh', 0.55], [14, 'sh', 0.65], [15, 'sh', 0.8]],
};

const VELCH = { X: 1, x: 0.82, m: 0.58, g: 0.34, '.': 0 };
/** Drum rows: 'k:X...x... s:....X... h:x.m.x.m.' (16 chars per row; X x m g = accent normal medium ghost). */
export function grv(text) {
  const out = {};
  for (const tok of String(text).trim().split(/\s+/)) {
    const i = tok.indexOf(':');
    const row = tok.slice(i + 1);
    if (i < 1 || row.length !== 16) throw new Error(`groove row '${tok}' has ${row.length} chars, not 16`);
    out[tok.slice(0, i)] = row;
  }
  return out;
}

/* ═══════════════════════════════════ 5. generators ═══════════════════════════════════ */

/** Tiny deterministic generator for the sparkle layers (so the data is the same on every device). */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const hashStr = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };

/** Layer argument: 'name1 name2 +flag *0.8 ^0.3-1' -> { names, flags, scale, swell }. */
function parseArg(spec) {
  const a = { names: [], flags: [], scale: 1, swell: null };
  for (const t of String(spec).trim().split(/\s+/)) {
    if (!t) continue;
    if (t[0] === '+') a.flags.push(t.slice(1));
    else if (t[0] === '*') a.scale = +t.slice(1);
    else if (t[0] === '^') { const [x, y] = t.slice(1).split('-'); a.swell = [+x, +y]; }
    else a.names.push(t);
  }
  return a;
}

const sym = (sy, ch, rootAbs, nextAbs, pcs) => {
  const third = ch.tones[1] - ch.tones[0], fifth = ch.tones[2] - ch.tones[0];
  switch (sy) {
    case 'r': return rootAbs;
    case 'o': return rootAbs + 12;
    case 'u': return rootAbs - 12 < 40 ? rootAbs : rootAbs - 12;
    case 'f': return rootAbs + fifth;
    case 'F': return rootAbs + fifth - 12;
    case 't': return rootAbs + third;
    case 's': return rootAbs + (ch.tones[3] !== undefined ? ch.tones[3] - ch.tones[0] : 10);
    case 'a': {
      const dirDown = rootAbs > nextAbs;                         // coming from above: approach from above
      const cands = dirDown ? [nextAbs + 1, nextAbs + 2] : [nextAbs - 1, nextAbs - 2];
      for (const c of cands) if (pcs.has(((c % 12) + 12) % 12)) return c;
      return cands[0];
    }
    default: throw new Error(`bad bass symbol '${sy}'`);
  }
};

/**
 * A harmony voice under melody note n: a chord tone 3-12 semitones below it (never a clash with the chord), not below MIDI 62,
 * and as close as possible to its own previous note so the line is smooth. Returns null when there is no room (the voice rests).
 */
function harmonyBelow(cx, base, bar, n) {
  const ch = cx.chordAt(bar, n.s % 16);
  const pcs = new Set(ch.tones.map((t) => (((cx.key + t) % 12) + 12) % 12));
  const mp = base + degOff(cx.sc, n.d) + n.a, prev = cx.state.harm;
  let best = null, bestCost = Infinity;
  for (let p = mp - 3; p >= Math.max(62, mp - 12); p--) {
    if (!pcs.has(((p % 12) + 12) % 12)) continue;
    const cost = prev === undefined ? mp - p : Math.abs(p - prev) + (mp - p) * 0.05;
    if (cost < bestCost) { bestCost = cost; best = p; }
  }
  if (best !== null) cx.state.harm = best;
  return best;
}

const GEN = {
  bass(cx, a, L) {
    const out = [];
    const pat = (cx.S.bass && cx.S.bass[a.names[0]]) || BASS[a.names[0]];
    if (!pat) throw new Error(`no bass pattern '${a.names[0]}'`);
    const lo = L.lo ?? cx.S.bassLo ?? 43;
    for (let b = 0; b < cx.sec.bars; b++) {
      const gb = cx.sec.gb0 + b;
      for (const [st, sy, len, v] of pat) {
        const ch = cx.chordAt(gb, st), nx = cx.nextChordAfter(gb, st);
        const rootAbs = bassRoot(ch, cx.key, lo), nextAbs = bassRoot(nx, cx.key, lo);
        out.push([gb * 16 + st, sym(sy, ch, rootAbs, nextAbs, cx.pcs), len, v]);
      }
    }
    return out;
  },

  comp(cx, a, L) {
    const out = [];
    const pat = COMP[a.names[0]];
    if (!pat) throw new Error(`no comp pattern '${a.names[0]}'`);
    const n = L.n || 3, center = L.center ?? 66;
    for (let b = 0; b < cx.sec.bars; b++) {
      const gb = cx.sec.gb0 + b;
      for (const [st, len, v, strum] of pat) {
        const ch = cx.chordAt(gb, st);
        cx.state.prev = voice(ch, cx.key, center, n, cx.state.prev);
        cx.state.prev.forEach((p, i) => out.push([gb * 16 + st + (strum ? i * strum : 0), p, len, v]));
      }
    }
    return out;
  },

  arp(cx, a, L) {
    const out = [];
    const pat = ARP[a.names[0]];
    if (!pat) throw new Error(`no arp pattern '${a.names[0]}'`);
    const n = L.n || 3, lo = L.lo ?? 60;
    for (let b = 0; b < cx.sec.bars; b++) {
      const gb = cx.sec.gb0 + b;
      for (const [st, idx, len, v] of pat) {
        const ch = cx.chordAt(gb, st);
        const tones = stack(ch, cx.key, lo, n);
        const q = Math.floor(idx / tones.length), r = idx % tones.length;
        out.push([gb * 16 + st, tones[r] + 12 * q + 12 * (L.oct || 0), len, v]);
      }
    }
    return out;
  },

  pad(cx, a, L) {
    const out = [];
    const center = L.center ?? 62, n = L.n || 3;
    let b = 0;
    while (b < cx.sec.bars) {
      const gb = cx.sec.gb0 + b;
      const [c1, c2] = cx.chords[gb];
      if (c2) {                                                    // two chords in a bar: a half bar each
        for (const [c, st] of [[c1, 0], [c2, 8]]) { cx.state.prev = voice(c, cx.key, center, n, cx.state.prev); cx.state.prev.forEach((p) => out.push([gb * 16 + st, p, 8, 0.85])); }
        b++;
        continue;
      }
      let k = 1;                                                   // merge identical chords on following bars into one long note
      while (b + k < cx.sec.bars && !cx.chords[gb + k][1] && cx.chords[gb + k][0].name === c1.name && (a.flags.includes('hold') || k < (L.maxHold || 2))) k++;
      cx.state.prev = voice(c1, cx.key, center, n, cx.state.prev);
      cx.state.prev.forEach((p) => out.push([gb * 16, p, 16 * k, 0.85]));
      b += k;
    }
    return out;
  },

  drone(cx, a, L) {
    const out = [];
    const lo = L.lo ?? 43;
    let b = 0;
    while (b < cx.sec.bars) {
      const gb = cx.sec.gb0 + b, ch = cx.chordAt(gb, 0);
      let k = 1;
      while (b + k < cx.sec.bars && cx.chordAt(gb + k, 0).root === ch.root) k++;
      const r = bassRoot(ch, cx.key, lo);
      out.push([gb * 16, r, 16 * k, 0.9]);
      if (a.flags.includes('fifth')) out.push([gb * 16, r + 7, 16 * k, 0.6]);
      b += k;
    }
    return out;
  },

  mel(cx, a, L) {
    const out = [];
    const sc = cx.sc, base = cx.melTonic + 12 * (L.oct || 0), dd = L.dd || 0;
    const endStep = (cx.sec.gb0 + cx.sec.bars) * 16;
    let gb = cx.sec.gb0, i = 0;
    while (gb < cx.sec.gb0 + cx.sec.bars) {
      const nm = a.names[i % a.names.length];
      const ph = cx.S.mel[nm];
      if (!ph) throw new Error(`no melody '${nm}' in song '${cx.S.id}'`);
      for (const n of ph.notes) {
        const st = gb * 16 + n.s;
        if (st >= endStep) continue;
        let pitch = base + degOff(sc, n.d + dd) + n.a;
        if (L.harm) { pitch = harmonyBelow(cx, base, gb + Math.floor(n.s / 16), n); if (pitch === null) continue; }
        const beat = n.s % 16;
        const dyn = beat === 0 ? 1 : beat % 4 === 0 ? 0.92 : 0.82;
        let len = n.len;
        if (L.art && len >= 3) len -= Math.max(1, Math.round(len / (L.art === true ? 4 : L.art)));   // articulation: a breath after every held note (room for pickup sounds)
        if (L.maxLen) len = Math.min(len, L.maxLen);
        out.push([st, pitch, len, n.vel * dyn]);
      }
      gb += ph.bars; i++;
    }
    return out;
  },

  kit(cx, a, L) {
    const out = [];
    const grooveName = a.names[0];
    let g = cx.S.kits[grooveName];
    if (!g) throw new Error(`no groove '${grooveName}' in song '${cx.S.id}'`);
    if (!Array.isArray(g)) g = [g];
    const fillName = a.flags.find((f) => FILLS[f]);
    const fill4 = a.flags.includes('fill4');
    for (let b = 0; b < cx.sec.bars; b++) {
      const gb = cx.sec.gb0 + b;
      const bar = g[b % g.length];
      let hits = [];
      for (const [name, row] of Object.entries(bar)) {
        for (let s = 0; s < 16; s++) {
          const c = row[s];
          const v = VELCH[c] ?? (/\d/.test(c) ? +c / 9 : 0);
          if (v > 0) hits.push([s, name, v]);
        }
      }
      const last = b === cx.sec.bars - 1;
      const f = last && fillName ? FILLS[fillName] : fill4 && (b % 4 === 3) ? FILLS[fillName || 'tick'] : null;
      if (f) { const from = f[0][0]; hits = hits.filter((h) => h[0] < from); hits.push(...f); }
      if (b === 0 && a.flags.includes('crash')) hits.push([0, 'c', 0.65]);
      for (const [s, name, v] of hits) out.push([gb * 16 + s, name, v]);
    }
    return out;
  },

  /** Deterministic glitter: sparse notes from the chord (+ 9th) in [lo, hi]. dens = notes per bar. */
  sparkle(cx, a, L) {
    const out = [];
    const lo = L.lo ?? 76, hi = L.hi ?? 93, dens = (L.dens ?? 3) * (a.scale || 1), len = L.len ?? 3;
    const rnd = lcg(hashStr(cx.S.id + ':' + L.name + ':' + cx.sec.gb0));
    for (let b = 0; b < cx.sec.bars; b++) {
      const gb = cx.sec.gb0 + b;
      const slots = L.slots || [0, 2, 3, 5, 6, 8, 10, 11, 13, 14];
      let n = Math.floor(dens) + (rnd() < dens - Math.floor(dens) ? 1 : 0);
      const used = new Set();
      while (n-- > 0) {
        const st = slots[Math.floor(rnd() * slots.length)];
        if (used.has(st)) continue;
        used.add(st);
        const ch = cx.chordAt(gb, st);
        const pool = [...ch.tones, ch.tones[0] + 14, ch.tones[0] + 9].map((t) => cx.key + ((t % 12) + 12) % 12);
        const cands = [];
        for (const pc of pool) for (let p = pc % 12 + 12 * Math.ceil((lo - (pc % 12)) / 12); p <= hi; p += 12) if (p >= lo) cands.push(p);
        if (!cands.length) continue;
        out.push([gb * 16 + st, cands[Math.floor(rnd() * cands.length)], len, 0.5 + rnd() * 0.45]);
      }
    }
    return out;
  },

  /** A rising (or `+down`) scale run in 16ths over the last `n` steps of a section's last bar: the 'build'. */
  run(cx, a, L) {
    const out = [];
    const gb = cx.sec.gb0 + cx.sec.bars - 1, n = L.n || 8;
    const ch = cx.chordAt(gb, 15);
    let cur = L.lo ?? 62;
    while (((cur - cx.key) % 12 + 12) % 12 !== ch.root) cur++;     // start on the chord's root, then climb the scale
    const dir = a.flags.includes('down') ? -1 : 1;
    for (let i = 0; i < n; i++) {
      out.push([gb * 16 + 16 - n + i, cur, 1, 0.4 + 0.6 * (i / (n - 1))]);
      do cur += dir; while (!cx.pcs.has(((cur % 12) + 12) % 12));
    }
    return out;
  },
};

/* ═══════════════════════════════════ 6. the composer ═══════════════════════════════════ */

/**
 * S = { id, title, bpm, swing, gain, leadMix, key:'C', mode:'major', melOct, bassLo,
 *       mel: { name: phrase }, kits: { name: groove | [groove...] }, bass: { custom patterns },
 *       layers: [{ name, inst, vol, pan, fx, gen, oct, dd, n, center, lo, hi, dens, ... }],
 *       sections: [{ name, bars, prog: '1 6 4 5', l: { layerName: 'argument string' } }] }
 */
/**
 * `leadMix` scales the volume of the tune-carrying layers (lead*, counter, descant) of one song: a MIXING knob, measured not guessed.
 * Through a phone-speaker model (250 Hz-9 kHz) the tune of several songs sat 5-8 dB under the accompaniment (the bass keeps most of
 * its energy through its harmonics), so the hummable phrase was hard to follow; `gain` is re-trimmed with it to keep loudness constant.
 */
const LEAD_LAYER = /^(lead|counter|descant)/;
const byStepThenPitch = (x, y) => x[0] - y[0] || x[1] - y[1];
const byStepThenDrum = (x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
export function compose(S) {
  const sc = MODES[S.mode];
  if (!sc) throw new Error(`unknown mode '${S.mode}'`);
  const key = keyPc(S.key);
  const pcs = new Set(sc.map((x) => (key + x) % 12));
  const melTonic = (key >= 5 ? 60 : 72) + key + 12 * (S.melOct || 0);
  // the parent major scale of the mode decides how chords are spelled (flats or sharps)
  const have = sc.map((x) => (key + x) % 12);
  let parent = 0;
  for (let p = 0; p < 12; p++) if (have.every((pc) => MODES.major.some((x) => (x + p) % 12 === pc))) { parent = p; break; }
  const flats = [5, 10, 3, 8, 1].includes(parent);

  let gbEnd = 0;
  const secs = S.sections.map((sec) => { const o = { ...sec, gb0: gbEnd }; gbEnd += sec.bars; return o; });
  const bars = gbEnd;

  const chords = [];                                               // chords[globalBar] = [first, second|null]
  const parsed = new Map();
  const chordOf = (tok) => { let c = parsed.get(tok); if (!c) parsed.set(tok, (c = chordFor(tok, sc))); return c; };
  for (const sec of secs) {
    const toks = sec.prog.trim().split(/\s+/);
    for (let i = 0; i < sec.bars; i++) {
      const [x, y] = toks[i % toks.length].split('_');
      chords.push([chordOf(x), y ? chordOf(y) : null]);
    }
  }
  const chordAt = (gb, st) => { const c = chords[((gb % bars) + bars) % bars]; return st >= 8 && c[1] ? c[1] : c[0]; };
  const nextChordAfter = (gb, st) => { const c = chords[((gb % bars) + bars) % bars]; if (st < 8 && c[1]) return c[1]; return chords[(gb + 1) % bars][0]; };

  const layers = S.layers.map((L) => {
    const events = [];
    const present = new Array(bars).fill(false);
    const state = {};
    for (const sec of secs) {
      const spec = sec.l && sec.l[L.name];
      if (spec === undefined || spec === null || spec === false) continue;
      const a = parseArg(spec);
      const cx = { S, sec, key, sc, pcs, melTonic, chords, bars, state, chordAt, nextChordAfter };
      const evs = GEN[L.gen](cx, a, L);
      const base = L.vel ?? 0.8, kit = L.gen === 'kit', vi = kit ? 2 : 3;
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];                                           // events are rewritten in place (no second array per note)
        let v = (e[vi] ?? 1) * base * a.scale;
        if (a.swell) { const pos = clamp((e[0] / 16 - sec.gb0) / Math.max(1, sec.bars), 0, 1); v *= a.swell[0] + (a.swell[1] - a.swell[0]) * pos; }
        e[vi] = r2(clamp(v, 0.05, 1));
        if (!kit) { e[1] = Math.round(e[1]); e[2] = Math.max(1, Math.round(e[2])); }
        events.push(e);
      }
      for (let b = 0; b < sec.bars; b++) present[sec.gb0 + b] = true;
    }
    // sort, drop duplicates (same step + pitch/drum) and anything outside the loop
    events.sort(L.gen === 'kit' ? byStepThenDrum : byStepThenPitch);
    const uniq = events;
    let w = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e[0] < 0 || e[0] >= bars * 16) continue;
      const p = w ? uniq[w - 1] : null;
      if (p && p[0] === e[0] && p[1] === e[1]) { if (e[e.length - 1] > p[p.length - 1]) p[p.length - 1] = e[e.length - 1]; continue; }
      uniq[w++] = e;
    }
    uniq.length = w;
    const play = [];
    for (let b = 0; b < bars; b++) { if (!present[b]) continue; let e = b; while (e < bars && present[e]) e++; play.push([b, e]); b = e; }
    const layer = { name: L.name, inst: L.inst, vol: r2((L.vol ?? 0.6) * (S.leadMix && LEAD_LAYER.test(L.name) ? S.leadMix : 1)), pan: L.pan ?? 0 };
    if (L.fx) layer.fx = L.fx;
    if (!(play.length === 1 && play[0][0] === 0 && play[0][1] === bars)) layer.play = play;
    if (L.gen === 'kit') layer.hits = uniq; else layer.notes = uniq;
    return layer;
  });

  const song = {
    id: S.id, title: S.title, bpm: S.bpm, beatsPerBar: 4, stepsPerBeat: 4, bars, swing: S.swing ?? 0,
    key: S.key, mode: S.mode, tonic: key, scale: [...pcs].sort((x, y) => x - y),
    sections: secs.map((s) => ({ name: s.name, from: s.gb0, to: s.gb0 + s.bars, prog: s.prog })),
    harmony: chords.map(([a, b]) => chordName(key, a, flats) + (b ? '_' + chordName(key, b, flats) : '')),
    layers,
  };
  if (S.gain) song.gain = S.gain;
  return song;
}

/* ═══════════════════════════════════ 7. the Meadow phrase and its building blocks ═══════════════════════════════════ */

/**
 * THE PHRASE. Four bars over I - vi - IV - V (question), then the same with an answer that comes home (T2).
 * Written in scale degrees around the home tonic (C5 in C major). Stepwise, one small drop of a fourth (G -> D), singable.
 */
const T1 = phrase(`3/3 5/3 6/2 5/3 3/3 2/2 | 1/6 r/2 2/2 1/2 6,/4 | 2/3 4/3 5/2 4/3 2/3 1/2 | 5/3 2/3 7,/2 r/4 2/2 3/2`);
const T2 = phrase(`3/3 5/3 6/2 5/3 3/3 2/2 | 1/6 r/2 2/2 3/2 5/4 | 4/3 6/3 5/2 4/3 2/3 1/2 | 7,/3 2/3 1/2 1/8`);
export const THEME = concat(T1, T2);
/** The six-note head that every song must carry: scale degrees 3 5 6 5 3 2, onsets 0 3 6 8 11 14. */
export const HEAD = slice(T1, 0, 1);
const rest = (n) => ({ bars: n, notes: [] });
/** The head re-fitted to the chord on degree r (so its 3rd/5th/6th/5th/3rd/2nd always sit on that chord). */
const headOn = (r) => shiftDeg(HEAD, fit(r));

/* the gentle default fx */
const VIB = { vibrato: { rate: 5.2, depth: 12, delaySteps: 4 } };
const ECHO = (beats = 0.75, feedback = 0.3, mix = 0.22) => ({ delay: { beats, feedback, mix } });

/* ═══════════════════════════════════ 8. the songs ═══════════════════════════════════ */

/** 1 · MEADOW — C major, 120 bpm, 64 bars = 128 s. Relaxed, spacious, buoyant: the first minutes of a small child's journey. */
function meadow() {
  const cell = phrase(`5/4 3/2 5/2 6/4 5/2 r/2`);                                              // the B tune: a little cell, sequenced down the scale, a breath at every bar end
  const B = concat(seq(cell, [0, -1, -2, -3]), seq(cell, [0, -1, -3]), phrase(`5/4 3/4 1/8`));
  const C1 = phrase(`3,/8 2,/8 | 1,/8 6,,/8 | 6,,/8 1,/8 | 7,,/8 2,/8`);                   // a slow inner line below the tune
  const DEV = concat(octave(concat(seq(HEAD, [0, 1, 2, 3, 4]), phrase(`4/3 6/3 5/2 4/3 2/3 1/2 | 5/3 2/3 7,/2 r/4 2/2 3/2`)), -1), phrase(`3/16`));
  DEV.notes.splice(DEV.notes.length - 1, 1);                                                  // (the held ending is written again below)
  const bridge = concat(shiftDeg(HEAD, -4), rest(1), headOn(1), rest(1), shiftDeg(HEAD, -2), rest(1), shiftDeg(HEAD, -4), rest(1));
  const pick = phrase(`r/12 3/2 5/2`);
  return compose({
    id: 'meadow', title: 'Meadow Morning', bpm: 120, swing: 0.04, key: 'C', mode: 'major', gain: 0.81, leadMix: 1.37,
    mel: { T: THEME, T1, B, C1, DEV: concat(DEV, phrase(`3/12 r/4`)), bridge, pick, bellT: accents(THEME) },
    kits: {
      intro: grv('k:X.......X....... h:x.m.x.m.x.m.x.m.'),
      main: grv('k:X.....m.X.m..... r:....X.......X... h:x.m.x.m.x.m.x.mo'),
      full: [grv('k:X.....m.X.m..... r:....X.......X... h:x.m.x.m.x.m.x.m. o:..............g.'), grv('k:X.....m.X..m..m. r:....X.......X..g h:x.m.x.m.x.mgx.m.')],
      light: grv('k:X.......X....... sh:..x...x...x...x. r:........X.......'),
      sparse: grv('k:X............... sh:..x...x...x...x. r:....m.......m...'),
      build: [grv('k:X.......X....... h:x.m.x.m.x.m.x.m. s:........x.......'), grv('k:X...X...X...X... s:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.8, vel: 0.9 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.75, vel: 0.9 },
      { name: 'comp', inst: 'marimba', gen: 'comp', vol: 0.5, pan: -0.25, center: 67, vel: 0.75 },
      { name: 'lead', inst: 'pulse25', gen: 'mel', art: true, vol: 0.5, pan: 0.08, fx: VIB, vel: 0.85 },
      { name: 'leadB', inst: 'tri', gen: 'mel', art: true, vol: 0.62, pan: 0.05, fx: VIB, vel: 0.85 },
      { name: 'lead2', inst: 'pulse50', gen: 'mel', art: true, harm: true, vol: 0.3, pan: -0.12, vel: 0.75 },
      { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.34, pan: -0.2, fx: VIB, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.4, pan: 0.3, fx: ECHO(), vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, vol: 0.8, vel: 0.6 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 60, vol: 0.42, pan: 0.35, fx: ECHO(), vel: 0.75 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 66, n: 8, vol: 0.3, pan: 0.25, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 2, prog: '1', l: { bass: 'bounce *0.7', kit: 'intro' } },
      { name: 'intro2', bars: 2, prog: '4 5', l: { bass: 'bounce', kit: 'intro +tick', comp: 'backbeat *0.7', bell: 'pick' } },
      { name: 'A', bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', bass: 'bounce', kit: 'main +tom', comp: 'backbeat' } },
      { name: "A'", bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', bass: 'bounce', kit: 'main +tom', comp: 'backbeat', pad: 'whole ^0.5-0.9', bell: 'bellT' } },
      { name: 'B', bars: 8, prog: '6 4 1 5 6 2 5 1', l: { leadB: 'B', bass: 'rf', kit: 'light +shake', comp: 'backbeat *0.8', pad: 'whole' } },
      { name: 'bridge', bars: 8, prog: '4 4 1 1 6 6 4_5 5', l: { bell: 'bridge', bass: 'whole *0.8', kit: 'sparse', pad: 'whole', arp: 'sparse *0.8' } },
      { name: 'build', bars: 4, prog: '4 4 5 5', l: { bass: 'pump8', kit: 'build +roll', comp: 'backbeat ^0.6-1', arp: 'up8', run: '' } },
      { name: "A''", bars: 12, prog: '1 6 4 5 1 6 4 5_1 1 6 4 5', l: { lead: 'T T1', lead2: 'T T1 *0.8', counter: 'C1', bell: 'bellT', bass: 'bounceS', kit: 'full +crash +tom', comp: 'backbeat', pad: 'whole' } },
      { name: 'C', bars: 8, prog: '1 2 3 4 5 4 5 1', l: { leadB: 'DEV', bass: 'walk', kit: 'main +snare', comp: 'backbeat' } },
      { name: 'outro', bars: 4, prog: '1 6 4 5', l: { bass: 'bounce *0.8', kit: 'intro +tick', pad: 'whole ^1-0.4', bell: 'bellT' } },
    ],
  });
}

/** 2 · CLOVER MILL — G major, 124 bpm, 64 bars = 124 s. Folk oom-pah and a ticking clockwork; the head turns round like a mill wheel. */
function cloverMill() {
  const wheelCell = phrase(`3/2 3/2 5/4 3/2 2/2 1/2 r/2`);
  const B = concat(follow(wheelCell, [1, 4, 5, 1, 6, 4, 5]), phrase(`5/4 3/4 1/8`));
  const wheel = concat(headOn(1), rest(1), headOn(4), rest(1), headOn(5), rest(1), headOn(1), rest(1));   // the mill wheel: one turn of the head, a bar of ticking, the next turn
  const bridge = concat(headOn(6), rest(1), headOn(4), rest(1), headOn(2), rest(1), headOn(5), rest(1));
  return compose({
    id: 'clover-mill', title: 'Clover Mill Clockwork', bpm: 124, swing: 0.06, key: 'G', mode: 'major', gain: 1.22,
    mel: { T: THEME, T1, Tg: grace(THEME), B, wheel, bridge, bellT: accents(THEME) },
    kits: {
      tick: grv('k:X.......X....... r:m.g.m.g.m.g.m.g.'),
      main: grv('k:X.......X..m.... s:....x.......x... r:m.g.m.g.m.g.m.g. h:..x...x...x...x.'),
      full: [grv('k:X.......X..m.... s:....X.......X... r:m.g.m.g.m.g.m.g. h:x.x.x.x.x.x.x.x.'), grv('k:X.....m.X.....m. s:....X.......X..g r:m.g.m.g.m.g.m.g. o:..............x.')],
      sparse: grv('k:X............... r:m.g.m.g.m.g.m.g.'),
      build: [grv('k:X.......X....... r:m.g.m.g.m.g.m.g.'), grv('k:X...X...X...X... s:....x.......x... r:m.g.m.g.m.g.m.g.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. r:m.g.m.g.m.g.m.g.')],
    },
    layers: [
      { name: 'bass', inst: 'bassPulse', gen: 'bass', vol: 0.66, vel: 0.9 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.72, vel: 0.9 },
      { name: 'comp', inst: 'pluck', gen: 'comp', vol: 0.42, pan: -0.3, center: 64, vel: 0.75 },
      { name: 'lead', inst: 'pulse50', gen: 'mel', art: true, vol: 0.5, pan: 0.1, fx: VIB, vel: 0.85 },
      { name: 'leadM', inst: 'marimba', gen: 'mel', art: true, vol: 0.55, pan: -0.1, vel: 0.85 },
      { name: 'lead2', inst: 'pulse25', gen: 'mel', art: true, harm: true, vol: 0.26, pan: 0.2, vel: 0.7 },
      { name: 'arp', inst: 'marimba', gen: 'arp', lo: 55, vol: 0.4, pan: 0.3, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.36, pan: 0.35, fx: ECHO(), vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, vol: 0.75, vel: 0.55 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 67, n: 8, vol: 0.28, pan: 0.2, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: '1 1 4 5', l: { bass: 'rf *0.8', kit: 'tick', comp: 'tick *0.8' } },
      { name: 'A', bars: 8, prog: '1 6 4 5 1 6 2 5_1', l: { lead: 'T', bass: 'rf', kit: 'main +tick', comp: 'backbeat' } },
      { name: 'B', bars: 8, prog: '1 4 5 1 6 4 5 1', l: { leadM: 'B', lead: 'B *0.45', bass: 'lilt', kit: 'main +hat', comp: 'backbeat', arp: 'sparse *0.7' } },
      { name: "A'", bars: 8, prog: '1 6 4 5 1 6 2 5_1', l: { lead: 'T *0.85', leadM: 'Tg', bass: 'lilt', kit: 'main +tom', comp: 'backbeat', pad: 'whole ^0.5-0.9' } },
      { name: 'bridge', bars: 8, prog: '6 6 4 4 2 2 5 5', l: { bell: 'bridge', bass: 'half *0.8', kit: 'sparse +shake', pad: 'whole', arp: 'sparse' } },
      { name: 'build', bars: 4, prog: '4 4 5 5', l: { bass: 'pump8', kit: 'build +roll', comp: 'backbeat ^0.6-1', run: '' } },
      { name: "A''", bars: 12, prog: '1 6 4 5 1 6 2 5_1 1 6 4 5', l: { lead: 'T T1', leadM: 'T T1 *0.8', lead2: 'T T1', bell: 'bellT', bass: 'lilt', kit: 'full +crash +tom', comp: 'backbeat', pad: 'whole' } },
      { name: 'wheel', bars: 8, prog: '1 1 4 4 5 5 1 1', l: { leadM: 'wheel', lead: 'wheel *0.7', arp: 'tres *0.7', bass: 'bounceS', kit: 'full +snare', comp: 'backbeat' } },
      { name: 'outro', bars: 4, prog: '1 6 4 5', l: { bass: 'rf *0.8', kit: 'tick +tom', pad: 'whole ^1-0.4', bell: 'bellT', comp: 'tick' } },
    ],
  });
}

/** 3 · REEDWATER — D major, 108 bpm, 64 bars = 142 s. The tune floats at half speed over rolling seventh-chord ripples; droplets fall. */
function reedwater() {
  const T2x = stretch(THEME, 2);
  const drift = phrase(`5/6 6/2 5/4 3/2 r/2`);
  const B = concat(follow(drift, [4, 1, 5, 6, 4, 1, 5]), phrase(`5/8 3/8`));
  const D7 = (list) => typed(list, 'D7');
  return compose({
    id: 'reedwater', title: 'Reedwater Drift', bpm: 108, swing: 0.1, key: 'D', mode: 'major', gain: 1.0,
    mel: { T2x, T2a: slice(T2x, 0, 8), T2b: slice(T2x, 8, 16), B, drops: only(HEAD, [0, 6, 11]), head: HEAD },
    kits: {
      brush: grv('k:X............... sh:..x...x...x...x. r:........m.......'),
      brush2: [grv('k:X.......m....... sh:x.x.x.x.x.x.x.x. r:....m.......m...'), grv('k:X.......m..m.... sh:x.x.x.x.x.x.x.x. r:....m.......m..g')],
      build: [grv('k:X............... sh:..x...x...x...x.'), grv('k:X.......X....... sh:x.x.x.x.x.x.x.x. t:............m...'), grv('k:X...X...X...X... sh:x.x.x.x.x.x.x.x. t:........m...m.m.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.72, vel: 0.85 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.6, vel: 0.85 },
      { name: 'lead', inst: 'tri', gen: 'mel', art: 6, vol: 0.62, pan: 0.05, fx: { vibrato: { rate: 4.8, depth: 14, delaySteps: 6 } }, vel: 0.85 },
      { name: 'leadB', inst: 'pulse50', gen: 'mel', art: 6, vol: 0.42, pan: 0.1, fx: VIB, vel: 0.8 },
      { name: 'lead2', inst: 'tri', gen: 'mel', art: 6, harm: true, vol: 0.34, pan: -0.2, fx: VIB, vel: 0.7 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 57, n: 4, vol: 0.4, pan: 0.3, fx: ECHO(0.75, 0.35, 0.28), vel: 0.7 },
      { name: 'arp2', inst: 'marimba', gen: 'arp', lo: 64, n: 4, vol: 0.36, pan: -0.3, vel: 0.65 },
      { name: 'bell', inst: 'bell', gen: 'sparkle', lo: 79, hi: 93, dens: 1.2, len: 4, vol: 0.4, pan: 0.35, fx: ECHO(1.5, 0.4, 0.3), vel: 0.7 },
      { name: 'bell2', inst: 'bell', gen: 'mel', oct: 1, vol: 0.36, pan: 0.3, fx: ECHO(1.5, 0.4, 0.3), vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, n: 4, vol: 0.85, vel: 0.6 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 69, n: 8, vol: 0.24, pan: 0.2, vel: 0.7 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: D7([1, 1, 6, 5]), l: { pad: 'whole ^0.5-1', arp: 'roll8 *0.7', bass: 'whole *0.8', bell: 'x *0.7', kit: 'brush *0.7' } },
      { name: 'A', bars: 16, prog: D7([1, 1, 6, 6, 4, 4, 5, '5_1', 1, 1, 6, 6, 4, 4, '5_1', 1]), l: { lead: 'T2x', arp: 'tres *0.8', pad: 'whole', bass: 'half', kit: 'brush', bell: 'x *0.5' } },
      { name: 'B', bars: 8, prog: D7([4, 1, 5, 6, 4, 1, 5, 1]), l: { leadB: 'B', lead2: 'B *0.8', arp2: 'wave8', bass: 'rf', kit: 'brush2', pad: 'whole', bell: 'x' } },
      { name: 'bridge', bars: 8, prog: '2:M 2:M 1:D7 1:D7 2:M 2:M 5:D7 5:D7', l: { bell: 'x', bell2: 'drops', pad: 'whole ^0.6-1', arp: 'drops', bass: 'whole *0.8', kit: 'brush *0.7' } },
      { name: 'build', bars: 4, prog: D7([4, 4, 5, 5]), l: { bass: 'half', kit: 'build', arp2: 'up8 ^0.5-1', pad: 'whole', run: '' } },
      { name: "A'", bars: 8, prog: D7([1, 1, 6, 6, 4, 4, 5, '5_1']), l: { lead: 'T2a', lead2: 'T2a *0.8', arp: 'wave8 *0.8', pad: 'whole', bass: 'rf', kit: 'brush2 +crash', bell: 'x', bell2: 'drops *0.7' } },
      { name: "A''", bars: 8, prog: D7([1, 1, 6, 6, 4, 4, '5_1', 1]), l: { lead: 'T2b', lead2: 'T2b *0.8', arp: 'wave8 *0.8', arp2: 'roll8 *0.7', pad: 'whole', bass: 'rf', kit: 'brush2', bell: 'x', bell2: 'drops *0.7' } },
      { name: 'outro', bars: 8, prog: D7([1, 1, 6, 6, 4, 4, 5, 5]), l: { pad: 'whole ^1-0.4', arp: 'sparse *0.8', bass: 'whole *0.8', bell: 'x *0.7', bell2: 'head', kit: 'brush *0.6' } },
    ],
  });
}

/** 4 · ORCHARD HEIGHTS — A major, 126 bpm, 64 bars = 122 s. Springy: staccato tune, octave-boing bass, petals drifting down from the branches. */
function orchard() {
  const springCell = phrase(`1/2 1'/2 5/2 3/2 r/2 3/2 2/4`);
  const B = concat(follow(springCell, [1, 4, 5, 1, 6, 4, 5]), phrase(`5/4 3/4 1/8`));
  const petals = phrase(`5'/4 4'/4 3'/4 2'/4 | 1'/4 7/4 6/4 5/4 | 3'/4 2'/4 1'/4 7/4 | 6/4 5/4 4/4 3/4`);
  const Ts = staccato(THEME, 2);
  return compose({
    id: 'orchard', title: 'Orchard Springs', bpm: 126, swing: 0.05, key: 'A', mode: 'major', gain: 1.11,
    mel: { Ts, T1s: staccato(T1, 2), B, petals, bellT: accents(THEME), wheel: concat(headOn(1), rest(1), headOn(4), rest(1), headOn(5), rest(1), headOn(1), rest(1)) },
    kits: {
      intro: grv('k:X.....m.X....... h:x.m.x.m.x.m.x.m.'),
      main: grv('k:X.....m.X..m.... s:....x.......x... h:x.m.x.m.x.m.x.m. o:..m...m...m...m.'),
      full: [grv('k:X.....m.X..m.m.. s:....X.......X... h:x.m.x.m.x.m.x.m. o:..x...x...x...x.'), grv('k:X.....m.X.....m. s:....X.......X..g h:x.xgx.xgx.xgx.xg o:..x...x...x...x.')],
      sparse: grv('k:X............... sh:..x...x...x...x. r:....m.......m...'),
      build: [grv('k:X.......X....... h:x.m.x.m.x.m.x.m.'), grv('k:X...X...X...X... s:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassPulse', gen: 'bass', vol: 0.66, vel: 0.9 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.75, vel: 0.9 },
      { name: 'comp', inst: 'marimba', gen: 'comp', vol: 0.5, pan: -0.3, center: 68, vel: 0.75 },
      { name: 'lead', inst: 'pulse25', gen: 'mel', art: true, vol: 0.5, pan: 0.08, fx: { vibrato: { rate: 5.5, depth: 10, delaySteps: 4 } }, vel: 0.85 },
      { name: 'leadM', inst: 'marimba', gen: 'mel', art: true, vol: 0.55, pan: -0.12, vel: 0.85 },
      { name: 'lead2', inst: 'pulse12', gen: 'mel', art: true, harm: true, vol: 0.26, pan: 0.2, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.4, pan: 0.3, fx: ECHO(), vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, vol: 0.8, vel: 0.6 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 61, vol: 0.4, pan: 0.35, fx: ECHO(), vel: 0.7 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 69, n: 8, vol: 0.28, pan: 0.25, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: '1 1 4 5', l: { bass: 'boing *0.8', kit: 'intro', comp: 'push *0.7' } },
      { name: 'A', bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'Ts', bass: 'boing', kit: 'main +tom', comp: 'backbeat' } },
      { name: "A'", bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'Ts', bell: 'bellT', bass: 'boing', kit: 'main +tom', comp: 'backbeat', pad: 'whole ^0.5-0.9' } },
      { name: 'B', bars: 8, prog: '1 4 5 1 6 4 5 1', l: { leadM: 'B', lead: 'B *0.5', bass: 'bounceS', kit: 'main +hat', comp: 'backbeat' } },
      { name: 'bridge', bars: 8, prog: '4 4 1 1 6 6 5 5', l: { bell: 'petals', bass: 'whole *0.8', kit: 'sparse', pad: 'whole', arp: 'drops', comp: 'half *0.6' } },
      { name: 'build', bars: 4, prog: '4 4 5 5', l: { bass: 'pump8', kit: 'build +roll', comp: 'pulse8 ^0.5-1', arp: 'up8', run: '' } },
      { name: "A''", bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'Ts', leadM: 'Ts', lead2: 'Ts *0.8', bell: 'bellT', bass: 'bounceS', kit: 'full +crash +tom', comp: 'backbeat', pad: 'whole' } },
      { name: "B'", bars: 8, prog: '1 4 5 1 6 4 5 1', l: { leadM: 'B', lead: 'B', lead2: 'B *0.8', bell: 'bellT', bass: 'boing', kit: 'full +snare', comp: 'push', pad: 'whole' } },
      { name: 'tag', bars: 4, prog: '1 6 4 5', l: { lead: 'T1s', leadM: 'T1s', bell: 'bellT', bass: 'boing', kit: 'main +tom', comp: 'off8' } },
      { name: 'outro', bars: 4, prog: '1 6 4 5', l: { bass: 'boing *0.7', kit: 'intro +tom', pad: 'whole ^1-0.4', bell: 'bellT', comp: 'off8 *0.5' } },
    ],
  });
}

/** 5 · AMBER QUARRY — A minor, 132 bpm, 72 bars = 131 s. Driving but sparse: stone taps, a pumping pulse bass, the tune in the minor, a hammering riff. */
function amberQuarry() {
  const hA = phrase(`1/2 1/2 r/2 3/2 r/2 1/2 7,/2 r/2`), hB = phrase(`1/2 1/2 r/2 3/2 r/2 4/2 3/2 r/2`);
  const riff = concat(hA, hB, shiftDeg(hA, -1), shiftDeg(hB, -1), shiftDeg(hA, -2), shiftDeg(hB, -2), shiftDeg(hA, -3), shiftDeg(hB, -3));
  const bridge = concat(headOn(6), rest(1), headOn(4), rest(1), headOn(6), rest(1), headOn(5), rest(1));
  return compose({
    id: 'amber-quarry', title: 'Amber Quarry Taps', bpm: 132, swing: 0.02, key: 'A', mode: 'minor', gain: 1.29,
    mel: { T: THEME, T1, riff, bridge, bellT: accents(THEME) },
    kits: {
      taps: [grv('k:X............... r:x..x..x.x..x..x.'), grv('k:X............... r:x..x..x.x..x..x. cl:............m...')],
      main: grv('k:X...x...X...x... s:....X.......X... h:x.x.x.x.x.x.x.x. r:..m..m....m..m..'),
      drive: [grv('k:X...X...X...X... cl:....x.......x... h:x.x.x.x.x.x.x.x. r:..m..m....m..m..'), grv('k:X...X...X...X... cl:....x.......x... h:x.x.x.x.x.x.x.x. r:..m..m....m.mm.m')],
      break: [grv('t:X.......m....... r:x..x..x.x..x..x. sh:..m...m...m...m.'), grv('t:X.......m.....m. r:x..x..x.x..x..x. sh:..m...m...m...m.')],
      build: [grv('k:X.......X....... r:x..x..x.x..x..x.'), grv('k:X.......X....... r:x..x..x.x..x..x. s:..............g.'), grv('k:X...x...X...x... r:x..x..x.x..x..x. s:....x.......x...'), grv('k:X...x...X...x... r:x..x..x.x..x..x. s:....x.......x.x.'),
        grv('k:X...X...X...X... s:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:....x...x...x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:xxxxxxxxxxxxxxxx')],
    },
    layers: [
      { name: 'bass', inst: 'bassPulse', gen: 'bass', vol: 0.68, vel: 0.9 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.74, vel: 0.9 },
      { name: 'lead', inst: 'pulse50', gen: 'mel', art: true, vol: 0.5, pan: 0.08, fx: VIB, vel: 0.85 },
      { name: 'leadB', inst: 'sawLead', gen: 'mel', art: true, vol: 0.44, pan: -0.06, fx: { vibrato: { rate: 5.4, depth: 14, delaySteps: 4 } }, vel: 0.85 },
      { name: 'lead2', inst: 'pulse25', gen: 'mel', art: true, harm: true, vol: 0.26, pan: 0.2, vel: 0.7 },
      { name: 'comp', inst: 'saw', gen: 'comp', vol: 0.5, pan: -0.3, center: 62, vel: 0.75 },
      { name: 'drone', inst: 'bassTri', gen: 'drone', vol: 0.5, vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 60, vol: 0.8, vel: 0.6 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.38, pan: 0.3, fx: ECHO(0.75, 0.35, 0.25), vel: 0.7 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 60, vol: 0.36, pan: 0.3, fx: ECHO(), vel: 0.7 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 64, n: 8, vol: 0.26, pan: 0.2, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: '1 1 6 5', l: { kit: 'taps', drone: 'x', bass: 'sparse *0.7' } },
      { name: 'A', bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', bass: 'pump8a', kit: 'main +tom' } },
      { name: "A'", bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', leadB: 'T *0.55', comp: 'push *0.8', bass: 'pump8a', kit: 'drive +tom', bell: 'bellT' } },
      { name: 'B', bars: 8, prog: '1 1 7 7 6 6 5 5', l: { leadB: 'riff', lead: 'riff *0.5', bass: 'pump8', kit: 'drive +snare', comp: 'push' } },
      { name: 'bridge', bars: 8, prog: '6 6 4 4 6 6 5 5', l: { bell: 'bridge', bass: 'half *0.7', kit: 'break', pad: 'whole', drone: 'x *0.8' } },
      { name: 'build', bars: 8, prog: '4 4 5 5 4 4 5 5', l: { bass: 'pump8 ^0.6-1', kit: 'build', arp: 'pulse8 ^0.4-1', comp: 'pulse8 ^0.4-1', pad: 'whole', run: '' } },
      { name: "A''", bars: 16, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T T', leadB: 'T T *0.7', lead2: 'T T', comp: 'push', bass: 'pump8a', kit: 'drive +crash +tom', bell: 'bellT', pad: 'whole' } },
      { name: 'C', bars: 8, prog: '1 1 7 7 6 6 5 5', l: { leadB: 'riff', lead2: 'riff *0.7', bass: 'pump8', kit: 'drive +tom', comp: 'push', bell: 'bellT', pad: 'whole' } },
      { name: 'outro', bars: 4, prog: '1 6 4 5', l: { drone: 'x', kit: 'taps +tom', pad: 'whole ^1-0.4', bell: 'bellT', bass: 'sparse *0.7' } },
    ],
  });
}

/** 6 · FOGWOOD — E minor, 100 bpm, 64 bars = 154 s. Floaty and mysterious: the tune at half speed in the mist, suspended chords, lantern bells with long echoes. */
function fogwood() {
  const T2x = stretch(THEME, 2);
  const floatCell = phrase(`3/6 5/4 3/2 2/2 r/2`);
  const B = follow(floatCell, [3, 4, 1, 5, 3, 4, 5, 1]);
  const mist = concat(headOn(1), rest(1), headOn(6), rest(1), headOn(4), rest(1), headOn(5), rest(1));
  const ad9 = (list) => typed(list, 'add9');
  return compose({
    id: 'fogwood', title: 'Fogwood Lanterns', bpm: 100, swing: 0, key: 'E', mode: 'minor', gain: 0.9,
    mel: { T2x, B, mist, bellT: accents(T2x), drops: only(HEAD, [0, 6, 11]) },
    kits: {
      heart: grv('t:X.......m....... sh:..m...m...m...m. r:........g.......'),
      heart2: [grv('t:X.......m....... sh:..m...m...m...m. r:........g.......'), grv('t:X.......m.....m. sh:..m...m...m...m. r:........g...g...')],
      swell: [grv('t:X.......m.......'), grv('t:X.......m.....m. sh:..m...m...m...m.'), grv('t:X...m...X...m... sh:x.x.x.x.x.x.x.x.'), grv('t:X...m...X...m.m. sh:x.x.x.x.x.x.x.x. s:..............x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.72, vel: 0.85 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.62, vel: 0.85 },
      { name: 'lead', inst: 'tri', gen: 'mel', art: 6, vol: 0.64, pan: 0.05, fx: { vibrato: { rate: 4.6, depth: 16, delaySteps: 6 } }, vel: 0.85 },
      { name: 'lead2', inst: 'pulse50', gen: 'mel', art: 6, harm: true, vol: 0.28, pan: -0.2, fx: VIB, vel: 0.65 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 64, n: 4, vol: 0.4, pan: 0.3, fx: ECHO(1.5, 0.45, 0.35), vel: 0.7 },
      { name: 'arp2', inst: 'marimba', gen: 'arp', lo: 57, n: 4, vol: 0.34, pan: -0.3, vel: 0.65 },
      { name: 'bell', inst: 'bell', gen: 'sparkle', lo: 79, hi: 93, dens: 1.2, len: 4, vol: 0.4, pan: 0.35, fx: ECHO(1.5, 0.45, 0.32), vel: 0.7 },
      { name: 'bell2', inst: 'bell', gen: 'mel', oct: 1, vol: 0.36, pan: 0.3, fx: ECHO(1.5, 0.45, 0.32), vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 60, n: 4, vol: 0.9, vel: 0.62 },
      { name: 'pad2', inst: 'pad', gen: 'pad', center: 70, n: 3, vol: 0.6, pan: 0.2, vel: 0.5 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 71, n: 8, vol: 0.22, pan: 0.2, vel: 0.7 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: ad9([1, 1, 6, 5]), l: { pad: 'whole ^0.4-1', bell: 'x *0.7', bass: 'whole *0.7' } },
      { name: 'A', bars: 16, prog: ad9([1, 1, 6, 6, 4, 4, 5, '5_1', 1, 1, 6, 6, 4, 4, '5_1', 1]), l: { lead: 'T2x', pad: 'whole', bass: 'half', arp: 'wave8 *0.7', arp2: 'sparse *0.7', kit: 'heart2', bell: 'x *0.8' } },
      { name: 'B', bars: 8, prog: ad9([3, 4, 1, 5, 3, 4, 5, 1]), l: { lead: 'B', lead2: 'B', arp: 'wave8 *0.7', arp2: 'tres *0.7', pad: 'whole', pad2: 'whole', bass: 'rf', kit: 'heart2', bell: 'x' } },
      { name: 'bridge', bars: 8, prog: ad9([6, 6, 4, 4, 6, 6, 5, 5]), l: { lead: 'mist', bell2: 'mist', bell: 'x *1.6', pad: 'whole', arp: 'drops *0.7', bass: 'whole *0.8', kit: 'heart *0.7' } },
      { name: 'swell', bars: 4, prog: ad9([4, 4, 5, 5]), l: { pad: 'whole ^0.5-1', pad2: 'whole ^0.3-1', bass: 'half', kit: 'swell', arp2: 'up8 ^0.4-1', run: '' } },
      { name: "A'", bars: 16, prog: ad9([1, 1, 6, 6, 4, 4, 5, '5_1', 1, 1, 6, 6, 4, 4, '5_1', 1]), l: { lead: 'T2x', lead2: 'T2x *0.8', bell2: 'bellT', arp: 'wave8 *0.8', arp2: 'roll8 *0.7', pad: 'whole', pad2: 'whole', bass: 'rf', kit: 'heart2 +crash', bell: 'x' } },
      { name: 'outro', bars: 8, prog: ad9([1, 1, 6, 6, 4, 4, 5, 5]), l: { pad: 'whole ^1-0.4', bell: 'x *0.7', bass: 'whole *0.8', bell2: 'drops *0.8', kit: 'heart *0.5', arp: 'sparse *0.7' } },
    ],
  });
}

/** 7 · EMBER CANYON — E phrygian, 138 bpm, 72 bars = 125 s. Pulsing: sawtooth bass, four on the floor with toms, the tune with Phrygian bite (the flat 2nd, F against E). */
function canyon() {
  const r1 = phrase(`1/2 2/2 1/2 r/2 3/2 2/2 1/4`), r2 = phrase(`1/2 2/2 1/2 r/2 5/2 4/2 3/4`);
  const riff = concat(r1, r2, r1, r2, r1, r2, r1, r2);
  const C = concat(seq(HEAD, [0, -1, -2, -3, 0, -1, -3]), phrase(`1/16`));
  const bridge = concat(headOn(6), rest(1), headOn(7), rest(1), headOn(2), rest(1), headOn(5), rest(1));
  return compose({
    id: 'canyon', title: 'Ember Canyon Run', bpm: 138, swing: 0, key: 'E', mode: 'phrygian', gain: 1.31, leadMix: 1.88,
    mel: { T: THEME, T1, riff, C, bridge, bellT: accents(THEME) },
    kits: {
      toms: [grv('k:X.......X....... t:..........m...m.'), grv('k:X.......X.......  t:..m.........m.m.'.replace('  ', ' '))],
      drive: [grv('k:X...X...X...X... cl:....x.......x... h:x.x.x.x.x.x.x.x. t:..............m.'), grv('k:X...X...X..mX... cl:....x.......x... h:x.x.x.x.x.x.x.x.')],
      heart: grv('k:X.......m....... t:....m.......m... r:x..x..x.x..x..x.'),
      build: [grv('k:X.......X....... t:..m.....m.......'), grv('k:X...X...X...X... t:..m.....m...m...'), grv('k:X...X...X...X... cl:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:....x.......x... h:x.x.x.x.x.x.x.x.'),
        grv('k:X...X...X...X... s:..x...x...x...x. h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:xxxxxxxxxxxxxxxx'), grv('k:X.X.X.X.X.X.X.X. s:xxxxxxxxxxxxxxxx t:..............x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassSaw', gen: 'bass', vol: 0.62, vel: 0.9, lo: 41 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.78, vel: 0.92 },
      { name: 'lead', inst: 'sawLead', gen: 'mel', art: true, vol: 0.5, pan: 0.06, fx: { vibrato: { rate: 5.8, depth: 14, delaySteps: 4 } }, vel: 0.85 },
      { name: 'lead2', inst: 'pulse25', gen: 'mel', art: true, harm: true, vol: 0.26, pan: 0.2, vel: 0.7 },
      { name: 'comp', inst: 'saw', gen: 'comp', vol: 0.5, pan: -0.3, center: 62, vel: 0.75 },
      { name: 'drone', inst: 'bassTri', gen: 'drone', vol: 0.45, vel: 0.7, lo: 52 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 60, vol: 0.8, vel: 0.6 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.38, pan: 0.3, fx: ECHO(0.75, 0.35, 0.25), vel: 0.7 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 60, vol: 0.36, pan: 0.3, fx: ECHO(), vel: 0.7 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 64, n: 8, vol: 0.26, pan: 0.2, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: '1 1 2 1', l: { bass: 'pump8 *0.7', kit: 'toms', drone: 'x' } },
      { name: 'A', bars: 8, prog: '1 2 7 5 1 2 7 5_1', l: { lead: 'T', bass: 'pump8a', kit: 'drive +tom', comp: 'trese *0.6' } },
      { name: "A'", bars: 8, prog: '1 2 7 5 1 2 7 5_1', l: { lead: 'T', lead2: 'T *0.8', comp: 'push', bass: 'pump8a', kit: 'drive +tom', bell: 'bellT' } },
      { name: 'B', bars: 8, prog: '1 1 2 2 1 1 7 5', l: { lead: 'riff', bass: 'gallop', kit: 'drive +snare', comp: 'push', pad: 'whole' } },
      { name: 'bridge', bars: 8, prog: '6 6 7 7 2 2 5 5', l: { bell: 'bridge', drone: 'x', pad: 'whole ^0.5-1', kit: 'heart', bass: 'half *0.7' } },
      { name: 'build', bars: 8, prog: '2 2 5 5 2 2 5 5', l: { bass: 'drive16 ^0.5-1', kit: 'build', arp: 'pulse8 ^0.4-1', comp: 'pulse8 ^0.4-1', pad: 'whole', run: '' } },
      { name: "A''", bars: 16, prog: '1 2 7 5 1 2 7 5_1', l: { lead: 'T T', lead2: 'T T *0.8', comp: 'push', bass: 'pump8a', kit: 'drive +crash +tom', bell: 'bellT', pad: 'whole' } },
      { name: 'C', bars: 8, prog: '1 7 6 5 1 7 5 1', l: { lead: 'C', lead2: 'C *0.8', bass: 'gallop', kit: 'drive +snare', comp: 'push', bell: 'bellT', pad: 'whole' } },
      { name: 'outro', bars: 4, prog: '1 2 7 5', l: { drone: 'x', kit: 'heart', pad: 'whole ^1-0.4', bell: 'bellT', bass: 'pump8 *0.6' } },
    ],
  });
}

/** 8 · GLASS COAST — F major, 104 bpm, swing, 64 bars = 148 s. Sunny shuffle: steel-drum marimba, walking bass, skanking chops, glassy bell pings. */
function glassCoast() {
  const waveCell = phrase(`5/2 6/2 5/2 3/2 r/2 3/2 2/2 1/2`);
  const B = follow(waveCell, [4, 1, 5, 1, 6, 4, 5, 1]);
  const wheel = concat(headOn(1), rest(1), headOn(4), rest(1), headOn(5), rest(1), headOn(1), rest(1));
  const D7 = (list) => typed(list, 'D7');
  return compose({
    id: 'glass-coast', title: 'Glass Coast Shuffle', bpm: 104, swing: 0.4, key: 'F', mode: 'major', gain: 0.91, leadMix: 1.18,
    mel: { T: THEME, T1, B, wheel, bellT: accents(THEME), pings: only(HEAD, [0, 3, 8, 11]) },
    kits: {
      intro: grv('k:X.......X....... h:x.xgx.xgx.xgx.xg'),
      main: grv('k:X.......X...m... s:....x.......x... h:x.mgx.mgx.mgx.mg o:..............m.'),
      full: [grv('k:X.....m.X...m... s:....X.......X..g h:x.mgx.mgx.mgx.mg o:..m...m...m...m.'), grv('k:X.......X..m.m.. s:....X.......X... h:x.mgx.mgx.mgx.mg o:..m...m...m...x.')],
      sparse: grv('k:X............... sh:..x...x...x...x. r:....m.......m...'),
      build: [grv('k:X.......X....... h:x.mgx.mgx.mgx.mg'), grv('k:X...X...X...X... s:....x.......x... h:x.mgx.mgx.mgx.mg'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.8, vel: 0.9 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.72, vel: 0.9 },
      { name: 'comp', inst: 'pluck', gen: 'comp', vol: 0.42, pan: -0.3, center: 66, n: 4, vel: 0.75 },
      { name: 'leadM', inst: 'marimba', gen: 'mel', art: true, vol: 0.6, pan: 0.05, vel: 0.85 },
      { name: 'lead', inst: 'pulse50', gen: 'mel', art: true, vol: 0.4, pan: 0.15, fx: VIB, vel: 0.8 },
      { name: 'lead2', inst: 'pulse25', gen: 'mel', art: true, harm: true, vol: 0.26, pan: -0.15, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.38, pan: 0.3, fx: ECHO(0.75, 0.35, 0.28), vel: 0.7 },
      { name: 'ping', inst: 'bell', gen: 'sparkle', lo: 79, hi: 96, dens: 1.5, len: 3, vol: 0.34, pan: 0.4, fx: ECHO(0.75, 0.35, 0.28), vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, n: 4, vol: 0.8, vel: 0.6 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 60, n: 4, vol: 0.38, pan: 0.35, fx: ECHO(), vel: 0.7 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 65, n: 8, vol: 0.26, pan: 0.2, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: D7([1, 1, 4, 5]), l: { bass: 'lilt *0.8', kit: 'intro', comp: 'push *0.7', ping: 'x *0.7' } },
      { name: 'A', bars: 8, prog: D7([1, 6, 4, 5, 1, 6, 4, '5_1']), l: { leadM: 'T', bass: 'swingWalk', kit: 'main +tom', comp: 'push' } },
      { name: "A'", bars: 8, prog: D7([1, 6, 4, 5, 1, 6, 4, '5_1']), l: { leadM: 'T', lead2: 'T *0.8', bell: 'bellT', bass: 'swingWalk', kit: 'main +tom', comp: 'push', pad: 'whole ^0.5-0.9' } },
      { name: 'B', bars: 8, prog: D7([4, 1, 5, 1, 6, 4, 5, 1]), l: { lead: 'B', leadM: 'B *0.7', bass: 'lilt', kit: 'full', comp: 'skank', ping: 'x', arp: 'syn *0.6' } },
      { name: 'bridge', bars: 8, prog: '2:M 2:M 1:D7 1:D7 4:D7 4:D7 5:D7 5:D7', l: { ping: 'x *1.6', bell: 'pings', pad: 'whole', bass: 'whole *0.8', kit: 'sparse', arp: 'drops' } },
      { name: 'build', bars: 4, prog: D7([4, 4, 5, 5]), l: { bass: 'pump8', kit: 'build +roll', comp: 'pulse8 ^0.5-1', arp: 'up8', run: '' } },
      { name: "A''", bars: 12, prog: D7([1, 6, 4, 5, 1, 6, 4, '5_1', 1, 6, 4, 5]), l: { leadM: 'T T1', lead2: 'T T1', lead: 'T T1 *0.7', bell: 'bellT', bass: 'swingWalk', kit: 'full +crash +tom', comp: 'push', pad: 'whole', ping: 'x' } },
      { name: 'C', bars: 8, prog: D7([1, 1, 4, 4, 5, 5, 1, 1]), l: { leadM: 'wheel', bell: 'wheel *0.7', bass: 'lilt', kit: 'full +snare', comp: 'skank', arp: 'syn' } },
      { name: 'outro', bars: 4, prog: D7([1, 6, 4, 5]), l: { bass: 'lilt *0.8', kit: 'intro', pad: 'whole ^1-0.4', bell: 'bellT', ping: 'x *0.7' } },
    ],
  });
}

/** 9 · LANTERN CAVERNS — D dorian, 92 bpm, 60 bars = 157 s. Echoing and crystalline: plucked tune with long dotted echoes, falling bell cascades, a low drone. Mysterious, never scary. */
function lanternCaverns() {
  const T2x = stretch(THEME, 2);
  const cell = phrase(`5/2 3/2 5/4 6/2 5/2 3/4`);
  const B = follow(cell, [1, 4, 7, 5, 1, 4, 5, 1]);
  const cascade = phrase(`r/16 | 5/2 4/2 3/2 2/2 1/2 7,/2 6,/2 5,/2 | r/16 | 3/2 2/2 1/2 7,/2 6,/2 5,/2 4,/2 3,/2`);
  const mist = concat(headOn(4), rest(1), headOn(7), rest(1), headOn(1), rest(1), headOn(5), rest(1));
  const long = ECHO(1.5, 0.45, 0.35);
  return compose({
    id: 'lantern-caverns', title: 'Lantern Caverns Echo', bpm: 92, swing: 0, key: 'D', mode: 'dorian', gain: 1.22, leadMix: 1.3,
    mel: { T2x, B, cascade, mist, bellT: accents(T2x), drops: only(HEAD, [0, 6, 11]), C1: phrase(`3,/8 2,/8 | 1,/8 6,,/8 | 6,,/8 1,/8 | 7,,/8 2,/8`) },
    kits: {
      soft: grv('k:X............... r:........g....... sh:..g...g...g...g.'),
      soft2: [grv('k:X.......m....... r:........g.......'), grv('k:X.......m..m.... r:........g...g... sh:..g...g...g...g.')],
      swell: [grv('k:X...............'), grv('k:X.......m....... sh:..m...m...m...m.'), grv('k:X...m...X...m... sh:x.x.x.x.x.x.x.x.'), grv('k:X...m...X...m.m. sh:x.x.x.x.x.x.x.x. t:..............x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.58, vel: 0.85 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.58, vel: 0.85 },
      { name: 'lead', inst: 'pluck', gen: 'mel', art: 6, vol: 0.56, pan: 0.05, fx: long, vel: 0.85 },
      { name: 'bell2', inst: 'bell', gen: 'mel', oct: 1, vol: 0.34, pan: 0.3, fx: long, vel: 0.7 },
      { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.3, pan: -0.2, fx: { vibrato: { rate: 4.6, depth: 14, delaySteps: 6 } }, vel: 0.7 },
      { name: 'arp', inst: 'bell', gen: 'arp', lo: 67, n: 4, vol: 0.34, pan: -0.3, fx: long, vel: 0.65 },
      { name: 'arp2', inst: 'pluck', gen: 'arp', lo: 60, n: 4, vol: 0.34, pan: 0.3, fx: ECHO(0.75, 0.4, 0.3), vel: 0.65 },
      { name: 'bell', inst: 'bell', gen: 'sparkle', lo: 79, hi: 93, dens: 1.4, len: 4, vol: 0.4, pan: 0.35, fx: long, vel: 0.7 },
      { name: 'drone', inst: 'bassTri', gen: 'drone', vol: 0.4, vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 60, n: 4, vol: 0.72, vel: 0.6 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: typed([1, 1, 4, 7], 'add9').replace('7:add9', '7:D7'), l: { pad: 'whole ^0.4-1', drone: 'x', bell: 'x *0.7', arp: 'drops *0.7' } },
      { name: 'A', bars: 16, prog: '1:add9 1:add9 4:add9 4:add9 7:D7 7:D7 5:D7 5:D7_1:add9 1:add9 1:add9 4:add9 4:add9 7:D7 7:D7 5:D7_1:add9 1:add9', l: { lead: 'T2x', pad: 'whole', drone: 'x', arp: 'wave8 *0.7', arp2: 'sparse *0.7', bell: 'x *0.8', kit: 'soft2' } },
      { name: 'bridge', bars: 8, prog: '4:add9 4:add9 7:D7 7:D7 1:add9 1:add9 5:D7 5:D7', l: { lead: 'mist', bell2: 'cascade', arp: 'sparse *0.8', arp2: 'drops *0.8', pad: 'whole', bass: 'whole *0.8', bell: 'x *1.4', kit: 'soft *0.7' } },
      { name: 'B', bars: 8, prog: '1:add9 4:add9 7:D7 5:D7 1:add9 4:add9 5:D7 1:add9', l: { lead: 'B', bell2: 'B *0.8', arp: 'wave8 *0.7', arp2: 'tres *0.7', pad: 'whole', bass: 'rf', kit: 'soft2', bell: 'x' } },
      { name: 'swell', bars: 4, prog: '4:add9 4:add9 5:D7 5:D7', l: { pad: 'whole ^0.5-1', drone: 'x', bass: 'half', arp: 'up8 ^0.4-1', kit: 'swell', bell: 'x ^0.5-1.6' } },
      { name: "A'", bars: 16, prog: '1:add9 1:add9 4:add9 4:add9 7:D7 7:D7 5:D7 5:D7_1:add9 1:add9 1:add9 4:add9 4:add9 7:D7 7:D7 5:D7_1:add9 1:add9', l: { lead: 'T2x', bell2: 'bellT', counter: 'C1', arp: 'wave8 *0.8', arp2: 'sparse', pad: 'whole', bass: 'rf', kit: 'soft2 +crash', bell: 'x' } },
      { name: 'outro', bars: 8, prog: '1:add9 1:add9 4:add9 4:add9 7:D7 7:D7 5:D7 5:D7', l: { pad: 'whole ^1-0.4', drone: 'x', bell: 'x *0.8', bell2: 'drops', kit: 'soft *0.6', arp: 'sparse *0.7' } },
    ],
  });
}

/** 10 · FROSTLINE — B-flat lydian, 112 bpm, 64 bars = 137 s. Glittering and cool: high plucks and bells, a gentle pulse underneath, falling glitter. */
function frostline() {
  const icicle = phrase(`1/2 3/2 5/2 3/2 r/2 6/2 5/2 3/2`);
  const B = follow(icicle, [1, 6, 2, 5, 1, 6, 2, 5]);
  const D7 = (list) => typed(list, 'D7');
  const bridge = concat(headOn(1), rest(1), headOn(6), rest(1), headOn(2), rest(1), headOn(5), rest(1));
  const climb = concat(seq(HEAD, [0, 1, 2, 3, 4, 5]), phrase(`1'/8 5/8`), phrase(`3'/16`));
  return compose({
    id: 'frostline', title: 'Frostline Glitter', bpm: 112, swing: 0.03, key: 'Bb', mode: 'lydian', gain: 1.2,
    mel: { T: THEME, T1, B, bridge, climb, bellT: accents(THEME), Ts: staccato(THEME, 3) },
    kits: {
      pulse: grv('k:X............... h:x.m.x.m.x.m.x.m. r:....g.......g...'),
      main: grv('k:X.......X....... r:....x.......x... h:x.m.x.m.x.m.x.m. sh:.g.g.g.g.g.g.g.g'),
      full: [grv('k:X.....m.X....... r:....x.......x... h:x.m.x.m.x.m.x.m. o:..m...m...m...m.'), grv('k:X.......X...m.m. r:....x.......x..g h:x.m.x.m.x.m.x.m. o:..m...m...m...x.')],
      sparse: grv('k:X............... sh:..m...m...m...m.'),
      build: [grv('k:X.......X....... h:x.m.x.m.x.m.x.m.'), grv('k:X...X...X...X... r:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... r:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.7, vel: 0.85 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.62, vel: 0.85 },
      { name: 'lead', inst: 'pluck', gen: 'mel', art: true, vol: 0.46, pan: 0.05, fx: ECHO(0.75, 0.35, 0.28), vel: 0.85 },
      { name: 'leadB', inst: 'pulse50', gen: 'mel', art: true, vol: 0.34, pan: -0.1, fx: VIB, vel: 0.8 },
      { name: 'spark', inst: 'pulse12', gen: 'mel', oct: 1, harm: true, vol: 0.2, pan: 0.2, vel: 0.65 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.36, pan: 0.3, fx: ECHO(0.75, 0.35, 0.28), vel: 0.7 },
      { name: 'glitter', inst: 'bell', gen: 'sparkle', lo: 79, hi: 96, dens: 1.6, len: 3, vol: 0.32, pan: 0.4, fx: ECHO(0.75, 0.4, 0.3), vel: 0.7 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 62, n: 4, vol: 0.34, pan: -0.3, fx: ECHO(0.75, 0.35, 0.25), vel: 0.65 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 64, n: 4, vol: 0.85, vel: 0.58 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 72, n: 8, vol: 0.22, pan: 0.2, vel: 0.7 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: D7([1, 1, 6, 5]), l: { pad: 'whole ^0.4-1', glitter: 'x *0.8', bass: 'pump8 *0.45', kit: 'sparse' } },
      { name: 'A', bars: 8, prog: D7([1, 6, 2, 5, 1, 6, 2, '5_1']), l: { lead: 'Ts', bass: 'pump8 *0.6', kit: 'pulse', glitter: 'x *0.7', pad: 'whole *0.8', arp: 'wave8 *0.5' } },
      { name: "A'", bars: 8, prog: D7([1, 6, 2, 5, 1, 6, 2, '5_1']), l: { lead: 'Ts', spark: 'Ts *0.8', bell: 'bellT', bass: 'pump8 *0.7', kit: 'main', glitter: 'x', pad: 'whole', arp: 'up8 *0.5' } },
      { name: 'B', bars: 8, prog: D7([1, 6, 2, 5, 1, 6, 2, 5]), l: { leadB: 'B', lead: 'B *0.7', arp: 'wave8', bass: 'rf *0.9', kit: 'main', pad: 'whole', glitter: 'x *0.8' } },
      { name: 'bridge', bars: 8, prog: D7([2, 2, 1, 1, 6, 6, 5, 5]), l: { bell: 'bridge', glitter: 'x *2', pad: 'whole ^0.6-1', arp: 'drops', bass: 'whole *0.8', kit: 'sparse' } },
      { name: 'build', bars: 4, prog: D7([6, 6, 5, 5]), l: { bass: 'pump8 ^0.5-1', kit: 'build +roll', arp: 'up8 ^0.4-1', pad: 'whole', run: '' } },
      { name: "A''", bars: 12, prog: D7([1, 6, 2, 5, 1, 6, 2, '5_1', 1, 6, 2, 5]), l: { lead: 'T T1', spark: 'T T1 *0.9', bell: 'bellT', leadB: 'T T1 *0.6', bass: 'pump8a *0.8', kit: 'full +crash +tom', glitter: 'x', pad: 'whole', arp: 'wave8 *0.7', comp: 'push *0.6' } },
      { name: 'C', bars: 8, prog: D7([1, 6, 2, 5, 1, 6, 2, 1]), l: { bell: 'climb', spark: 'climb *0.6', bass: 'rf', kit: 'main', pad: 'whole', glitter: 'x *1.2', arp: 'up8 *0.6' } },
      { name: 'outro', bars: 4, prog: D7([1, 6, 2, 5]), l: { pad: 'whole ^1-0.4', glitter: 'x *0.8', bass: 'pump8 *0.45', kit: 'sparse +tom', bell: 'bellT *0.8' } },
    ],
  });
}

/** 11 · MOONRIDGE — C minor, 104 bpm, 64 bars = 148 s. A nocturne over a steady pulse: the tune sings slowly, then surges at its true speed. */
function ridge() {
  const T2x = stretch(THEME, 2);
  const soarCell = phrase(`5/8 6/4 5/2 r/2`);
  const B = follow(soarCell, [1, 6, 4, 5, 3, 6, 4, 5]);
  const moon = concat(headOn(1), rest(1), headOn(4), rest(1), headOn(6), rest(1), headOn(5), rest(1));
  const ad9 = (l) => typed(l, 'add9');
  return compose({
    id: 'ridge', title: 'Moonridge Nocturne', bpm: 104, swing: 0, key: 'C', mode: 'minor', gain: 0.95,
    mel: { T: THEME, T1, T2x, B, moon, bellT: accents(T2x), drops: only(HEAD, [0, 6, 11]), C1: phrase(`3,/8 2,/8 | 1,/8 6,,/8 | 6,,/8 1,/8 | 7,,/8 2,/8`) },
    kits: {
      beat: grv('k:X.......m....... sh:x.g.x.g.x.g.x.g.'),
      beat2: [grv('k:X.......m....... sh:x.g.x.g.x.g.x.g. r:........g.......'), grv('k:X.......m.....m. sh:x.g.x.g.x.g.x.g. r:........g...g...')],
      surge: [grv('k:X.....m.X....... s:....x.......x... h:x.m.x.m.x.m.x.m.'), grv('k:X.......X..m.... s:....x.......x..g h:x.m.x.m.x.m.x.m. o:..............m.')],
      build: [grv('k:X.......m.......'), grv('k:X.......m.....m. sh:..m...m...m...m.'), grv('k:X...m...X...m... sh:x.x.x.x.x.x.x.x.'), grv('k:X...m...X...m.m. sh:x.x.x.x.x.x.x.x. s:..............x.')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.74, vel: 0.85 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.6, vel: 0.85 },
      { name: 'lead', inst: 'tri', gen: 'mel', art: 6, vol: 0.66, pan: 0.05, fx: { vibrato: { rate: 5, depth: 16, delaySteps: 5 } }, vel: 0.85 },
      { name: 'leadB', inst: 'pulse50', gen: 'mel', art: 6, vol: 0.4, pan: 0.12, fx: VIB, vel: 0.8 },
      { name: 'leadS', inst: 'sawLead', gen: 'mel', art: 6, vol: 0.34, pan: -0.1, fx: { vibrato: { rate: 5.4, depth: 14, delaySteps: 4 } }, vel: 0.8 },
      { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.3, pan: -0.2, fx: VIB, vel: 0.7 },
      { name: 'pulse', inst: 'marimba', gen: 'arp', lo: 55, n: 3, vol: 0.4, pan: -0.25, vel: 0.7 },
      { name: 'pulse2', inst: 'pluck', gen: 'arp', lo: 62, n: 3, vol: 0.3, pan: 0.3, fx: ECHO(0.75, 0.35, 0.25), vel: 0.65 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.38, pan: 0.3, fx: ECHO(1.5, 0.4, 0.3), vel: 0.7 },
      { name: 'moonlight', inst: 'bell', gen: 'sparkle', lo: 79, hi: 93, dens: 1, len: 4, vol: 0.36, pan: 0.35, fx: ECHO(1.5, 0.4, 0.3), vel: 0.7 },
      { name: 'comp', inst: 'saw', gen: 'comp', vol: 0.4, pan: -0.3, center: 62, vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 60, n: 4, vol: 0.85, vel: 0.6 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 67, n: 8, vol: 0.22, pan: 0.2, vel: 0.7 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: ad9([1, 1, 6, 5]), l: { pulse: 'pulse8 *0.6', pad: 'whole ^0.4-1', bass: 'whole *0.8', moonlight: 'x *0.7' } },
      { name: 'A', bars: 16, prog: '1 1:add9 1 1:add9 4 4 5 5_1 1 1:add9 1 1:add9 4 4 5_1 1', l: { lead: 'T2x', pulse: 'pulse8', pulse2: 'syn *0.7', pad: 'whole', bass: 'pump8 *0.6', kit: 'beat2', moonlight: 'x *0.8' } },
      { name: 'B', bars: 8, prog: '1 6 4 5 3 6 4 5', l: { lead: 'B', leadB: 'B *0.7', pulse: 'pulse8', pulse2: 'syn', pad: 'whole', bass: 'pump8 *0.7', comp: 'half *0.7', kit: 'beat2', bell: 'bellT', moonlight: 'x' } },
      { name: 'bridge', bars: 8, prog: '6 6 4 4 1 1 5 5', l: { bell: 'moon', moonlight: 'x *1.8', pulse: 'pulse8 *0.45', pulse2: 'drops', pad: 'whole ^0.6-1', bass: 'whole *0.8', kit: 'beat *0.7' } },
      { name: 'build', bars: 4, prog: '4 4 5 5', l: { pulse: 'pulse8 ^0.6-1', pulse2: 'up8 ^0.3-1', bass: 'half', kit: 'build', pad: 'whole ^0.6-1', run: '' } },
      { name: "A'", bars: 12, prog: '1 1:add9 4 5 1 1:add9 4 5_1 1 1:add9 4 5', l: { lead: 'T T1', leadS: 'T T1 *0.8', counter: 'C1', bell: 'bellT', pulse: 'pulse8', pulse2: 'syn *0.8', comp: 'push *0.8', pad: 'whole', bass: 'pump8a', kit: 'surge +crash +tom' } },
      { name: 'C', bars: 8, prog: '1 6 4 5 1 4 5 1', l: { lead: 'T', bell: 'moon', pulse: 'pulse8 ^1-0.5', pulse2: 'syn', pad: 'whole', bass: 'pump8 *0.5', kit: 'beat2', moonlight: 'x', comp: 'half *0.7' } },
      { name: 'outro', bars: 4, prog: '1 6 4 5', l: { pulse: 'pulse8 ^0.8-0.4', pad: 'whole ^1-0.4', bass: 'whole *0.8', moonlight: 'x *0.8', kit: 'beat *0.6' } },
    ],
  });
}

/** 12 · DAWNBRIDGE — E-flat major, 100 bpm, 64 bars = 154 s. A warm pad swells under a stately tune, then the sun clears the ridge and the tune walks at its true speed. */
function dawnbridge() {
  const T2x = stretch(THEME, 2);
  const riseCell = phrase(`1/4 3/4 5/6 r/2`);
  const B = follow(riseCell, [1, 5, 6, 3, 4, 1, 4, 5]);
  const D7 = (l) => typed(l, 'D7');
  return compose({
    id: 'dawnbridge', title: 'Dawnbridge Swell', bpm: 100, swing: 0, key: 'Eb', mode: 'major', gain: 0.85,
    mel: { T: THEME, T1, T2x, B, bellT: accents(T2x), C1: phrase(`3,/8 2,/8 | 1,/8 6,,/8 | 6,,/8 1,/8 | 7,,/8 2,/8`), wheel: concat(headOn(1), rest(1), headOn(4), rest(1), headOn(5), rest(1), headOn(1), rest(1)) },
    kits: {
      soft: grv('t:X.......m....... sh:..g...g...g...g.'),
      beat: [grv('k:X.......m....... t:........m....... sh:x.g.x.g.x.g.x.g.'), grv('k:X.......m.....m. t:........m...m... sh:x.g.x.g.x.g.x.g.')],
      beat2: [grv('k:X.......m....... t:........m....... sh:x.m.x.m.x.m.x.m. r:....g.......g...'), grv('k:X.......m.....m. t:........m...m... sh:x.m.x.m.x.m.x.m. r:....g.......g..g')],
      big: [grv('k:X.....m.X....... s:....x.......x... h:x.m.x.m.x.m.x.m. t:..............m.'), grv('k:X.......X..m.m.. s:....x.......x..g h:x.m.x.m.x.m.x.m. o:..m...m...m...x.')],
      build: [grv('t:X.......m.......'), grv('t:X.......m.....m. sh:..m...m...m...m.'), grv('k:X...m...X...m... sh:x.x.x.x.x.x.x.x. t:..............m.'), grv('k:X...m...X...m.m. sh:x.x.x.x.x.x.x.x. s:..............x. t:............m...')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.76, vel: 0.85 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.66, vel: 0.88 },
      { name: 'lead', inst: 'tri', gen: 'mel', art: 6, vol: 0.66, pan: 0.05, fx: { vibrato: { rate: 4.8, depth: 15, delaySteps: 6 } }, vel: 0.85 },
      { name: 'leadS', inst: 'sawLead', gen: 'mel', art: 6, vol: 0.26, pan: -0.1, fx: { vibrato: { rate: 5, depth: 14, delaySteps: 6 } }, vel: 0.75 },
      { name: 'lead2', inst: 'pulse50', gen: 'mel', art: 6, harm: true, vol: 0.3, pan: 0.2, fx: VIB, vel: 0.7 },
      { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.32, pan: -0.2, fx: VIB, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.34, pan: 0.3, fx: ECHO(0.75, 0.35, 0.28), vel: 0.7 },
      { name: 'arp', inst: 'marimba', gen: 'arp', lo: 58, n: 4, vol: 0.4, pan: -0.25, vel: 0.65 },
      { name: 'arp2', inst: 'pluck', gen: 'arp', lo: 65, n: 4, vol: 0.32, pan: 0.3, fx: ECHO(), vel: 0.65 },
      { name: 'comp', inst: 'marimba', gen: 'comp', vol: 0.46, pan: -0.3, center: 66, n: 4, vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 58, n: 4, vol: 0.95, vel: 0.6 },
      { name: 'pad2', inst: 'pad', gen: 'pad', center: 70, n: 3, vol: 0.6, pan: 0.2, vel: 0.5 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: D7([1, 1, 4, 5]), l: { pad: 'whole ^0.2-1', bass: 'whole *0.8' } },
      { name: 'A', bars: 16, prog: D7([1, 1, 6, 6, 4, 4, 5, '5_1', 1, 1, 6, 6, 4, 4, '5_1', 1]), l: { lead: 'T2x', pad: 'whole ^0.6-1', bass: 'half', arp: 'roll8 *0.7', arp2: 'tres *0.5', kit: 'beat' } },
      { name: 'B', bars: 8, prog: D7([1, 5, 6, 3, 4, 1, 4, 5]), l: { lead: 'B', lead2: 'B *0.9', pad: 'whole', pad2: 'whole ^0.3-1', bass: 'lilt', arp: 'roll8 *0.8', arp2: 'tres *0.7', comp: 'half', kit: 'beat2' } },
      { name: 'bridge', bars: 4, prog: D7([4, 4, 5, 5]), l: { bell: 'bellT', pad: 'whole ^0.4-1', pad2: 'whole ^0.2-1', arp: 'wave8', arp2: 'drops', bass: 'half', kit: 'beat2' } },
      { name: 'swell', bars: 4, prog: D7([6, 6, 5, 5]), l: { pad: 'whole ^0.5-1', pad2: 'whole ^0.4-1', arp: 'wave8 ^0.6-1', arp2: 'tres ^0.5-1', bass: 'half', kit: 'build', comp: 'half ^0.5-1' } },
      { name: "A'", bars: 16, prog: D7([1, 1, 6, 6, 4, 4, 5, '5_1', 1, 1, 6, 6, 4, 4, '5_1', 1]), l: { lead: 'T2x', leadS: 'T2x', counter: 'C1', pad: 'whole', pad2: 'whole', bass: 'lilt', arp: 'roll8', arp2: 'sparse', comp: 'half', kit: 'big +crash', bell: 'bellT *0.8' } },
      { name: 'C', bars: 8, prog: D7([1, 6, 4, 5, 1, 6, 4, '5_1']), l: { lead: 'T', leadS: 'T *0.9', lead2: 'T', bell: 'bellT', comp: 'off8', pad: 'whole', pad2: 'whole', bass: 'bounce', kit: 'big +crash +tom', arp2: 'up8 *0.7' } },
      { name: 'outro', bars: 4, prog: D7([1, 6, 4, 5]), l: { pad: 'whole ^1-0.4', pad2: 'whole ^0.8-0.3', bass: 'whole *0.8', arp: 'sparse *0.8', kit: 'soft', bell: 'bellT *0.7' } },
    ],
  });
}

/** 13 · BEACON SUMMIT — G major, 128 bpm, 72 bars = 135 s. The ascent: it starts thin, the head of the tune climbs a step at a time, the pulse quickens, and the full tune breaks through at the top. */
function beaconSummit() {
  const climbCell = phrase(`1/4 3/4 5/4 3/4`);
  const B = follow(climbCell, [4, 5, 6, 3, 4, 5, 1, 5]);
  const upHead = concat(HEAD, rest(1), shiftDeg(HEAD, 1), rest(1), shiftDeg(HEAD, 2), rest(1), shiftDeg(HEAD, 3), rest(1));
  const DEV = concat(seq(HEAD, [0, 1, 2, 3, 4]), phrase(`4/3 6/3 5/2 4/3 2/3 1/2 | 5/3 2/3 7,/2 r/4 2/2 3/2`), phrase(`3/16`));
  return compose({
    id: 'beacon-summit', title: 'Beacon Summit Ascent', bpm: 128, swing: 0.02, key: 'G', mode: 'major', gain: 0.86, leadMix: 2.2,
    mel: { T: THEME, T1, B, upHead, DEV, bellT: accents(THEME), drops: only(HEAD, [0, 6, 11]) },
    kits: {
      light: grv('k:X.......X....... h:..m...m...m...m.'),
      main: grv('k:X.....m.X..m.... s:....x.......x... h:x.m.x.m.x.m.x.m.'),
      full: [grv('k:X.....m.X..m.m.. s:....X.......X... h:x.xgx.xgx.xgx.xg o:..m...m...m...m.'), grv('k:X.....m.X.....m. s:....X.......X..g h:x.xgx.xgx.xgx.xg o:..x...x...x...x.')],
      climax: [grv('k:X...X...X...X... s:....X.......X... h:x.xgx.xgx.xgx.xg o:..x...x...x...x. t:..............m.'), grv('k:X...X...X..mX... s:....X.......X..g h:xxxxxxxxxxxxxxxx t:............m.m.')],
      sparse: grv('k:X............... sh:..m...m...m...m.'),
      build: [grv('k:X.......X....... h:x.m.x.m.x.m.x.m.'), grv('k:X.......X....... s:..............g. h:x.m.x.m.x.m.x.m.'), grv('k:X...x...X...x... s:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...x...X...x... s:....x.......x.x. h:x.x.x.x.x.x.x.x.'),
        grv('k:X...X...X...X... s:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:..x...x...x...x. h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.'), grv('k:X.X.X.X.X.X.X.X. s:xxxxxxxxxxxxxxxx t:............x.xx')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.78, vel: 0.88 },
      { name: 'bass2', inst: 'bassPulse', gen: 'bass', vol: 0.4, vel: 0.8 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.76, vel: 0.9 },
      { name: 'lead', inst: 'pulse25', gen: 'mel', art: true, vol: 0.5, pan: 0.08, fx: VIB, vel: 0.85 },
      { name: 'leadS', inst: 'sawLead', gen: 'mel', art: true, vol: 0.44, pan: -0.06, fx: { vibrato: { rate: 5.6, depth: 14, delaySteps: 4 } }, vel: 0.85 },
      { name: 'lead2', inst: 'pulse50', gen: 'mel', art: true, harm: true, vol: 0.28, pan: 0.2, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.4, pan: 0.3, fx: ECHO(0.75, 0.35, 0.28), vel: 0.7 },
      { name: 'comp', inst: 'saw', gen: 'comp', vol: 0.4, pan: -0.3, center: 64, vel: 0.75 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 62, vol: 0.38, pan: 0.3, fx: ECHO(), vel: 0.7 },
      { name: 'arp2', inst: 'marimba', gen: 'arp', lo: 55, vol: 0.4, pan: -0.25, vel: 0.7 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, vol: 0.85, vel: 0.6 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 66, n: 8, vol: 0.28, pan: 0.2, vel: 0.8 },
    ],
    sections: [
      { name: 'intro', bars: 8, prog: '1 5 6 4 1 5 4 5', l: { pad: 'whole ^0.2-1', arp: 'up8 *0.6', bass: 'half *0.7' } },
      { name: 'rise', bars: 8, prog: '1 1 2 2 3 3 4 4', l: { bell: 'upHead', lead: 'upHead *0.7', pad: 'whole', arp2: 'roll8 *0.7', bass: 'walk', kit: 'light' } },
      { name: 'tune', bars: 8, prog: '1 6 4 5 1 6 2 5_1', l: { lead: 'T', bell: 'bellT', bass: 'walk', kit: 'main +tom', arp: 'tres *0.7', pad: 'whole' } },
      { name: 'climb', bars: 8, prog: '1 2 3 4 5 4 5 1', l: { leadS: 'DEV', lead: 'DEV *0.6', bass: 'pump8a', bass2: 'pump8 *0.7', kit: 'full +snare', comp: 'push', arp2: 'pulse8 *0.8', pad: 'whole' } },
      { name: 'thin', bars: 4, prog: '6 4 1 5', l: { pad: 'whole', bell: 'drops', arp: 'sparse', bass: 'whole *0.8', kit: 'sparse' } },
      { name: 'ascent', bars: 8, prog: '4 5 6 3 4 5 1 5', l: { lead: 'B', lead2: 'B *0.9', bell: 'B *0.6', bass: 'rf', kit: 'main', comp: 'backbeat', arp2: 'wave8 *0.8', pad: 'whole' } },
      { name: 'build', bars: 8, prog: '4 4 5 5 6 6 5 5', l: { bass: 'drive16 ^0.5-1', kit: 'build', arp: 'pulse8 ^0.4-1', comp: 'pulse8 ^0.4-1', pad: 'whole', run: '' } },
      { name: 'summit', bars: 16, prog: '1 6 4 5 1 6 2 5_1 1 6 4 5 1 6 2 5_1', l: { leadS: 'T T', lead: 'T T', lead2: 'T T *0.9', bell: 'bellT', bass: 'pump8a', bass2: 'bounceS', kit: 'climax +crash +tom', comp: 'push', arp2: 'tres', pad: 'whole' } },
      { name: 'outro', bars: 4, prog: '4 4 5 5', l: { pad: 'whole ^1-0.5', bell: 'drops', arp: 'sparse', bass: 'half *0.7', kit: 'sparse', arp2: 'roll8 ^0.8-0.3' } },
    ],
  });
}

/** BEACON — C major, 126 bpm, 40 bars = 76 s. The lit beacon: a fanfare, then the Meadow tune in full — everyone, countermelody, big drums. Loops on the finish screen. */
function beacon() {
  const fan = phrase(`1/3 1/3 1/2 3/4 5/4 | 4/3 4/3 4/2 6/4 1'/4 | 5/3 5/3 5/2 7/4 2'/4 | 1'/12 r/4`);
  const cell = phrase(`5/4 3/2 5/2 6/4 5/2 r/2`);
  const B = concat(seq(cell, [0, -1, -2, -3]), seq(cell, [0, -1, -3]), phrase(`5/4 3/4 1/8`));
  const C1 = phrase(`3,/8 2,/8 | 1,/8 6,,/8 | 6,,/8 1,/8 | 7,,/8 2,/8`);
  const desc = phrase(`1'/8 7/4 6/4 | 5/8 3/4 1/4 | 4/8 6/4 1'/4 | 2'/8 7/4 5/4`);
  return compose({
    id: 'beacon', title: 'The Beacon Is Lit', bpm: 126, swing: 0.03, key: 'C', mode: 'major', gain: 0.77, leadMix: 2.2,
    mel: { fan, T: THEME, T1, B, C1, desc, bellT: accents(THEME), Tg: grace(THEME), wheel: concat(headOn(1), rest(1), headOn(4), rest(1), headOn(5), rest(1), headOn(1), rest(1)) },
    kits: {
      fanfare: [grv('k:X..xX..xX..xX..x c:X............... t:..............m.'), grv('k:X..xX..xX..xX..x s:....x.......x... t:..............m.'), grv('k:X..xX..xX..xX..x s:..x...x...x...x. t:............m.m.'), grv('k:X.......X.......  t:........m.m.mxxx'.replace('  ', ' '))],
      full: [grv('k:X...X...X...X... s:....X.......X... h:x.x.x.x.x.x.x.x. o:..x...x...x...x.'), grv('k:X...X...X..mX... s:....X.......X..g h:x.xgx.xgx.xgx.xg o:..x...x...x...x. t:..............m.')],
      big: [grv('k:X...X...X...X... s:....X.......X... h:xxxxxxxxxxxxxxxx o:..x...x...x...x.'), grv('k:X...X...X..mX..m s:....X.......X..g h:xxxxxxxxxxxxxxxx o:..x...x...x...x. t:............m.m.')],
      coda: [grv('k:X...X...X...X... s:....x.......x... h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:..x...x...x...x. h:x.x.x.x.x.x.x.x.'), grv('k:X...X...X...X... s:x.x.x.x.x.x.x.x. h:x.x.x.x.x.x.x.x.'), grv('k:X.X.X.X.X.X.X.X. s:xxxxxxxxxxxxxxxx t:............x.xx')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.8, vel: 0.92 },
      { name: 'bass2', inst: 'bassPulse', gen: 'bass', vol: 0.36, vel: 0.8 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.8, vel: 0.92 },
      { name: 'lead', inst: 'sawLead', gen: 'mel', art: true, vol: 0.5, pan: 0.06, fx: { vibrato: { rate: 5.6, depth: 14, delaySteps: 4 } }, vel: 0.9 },
      { name: 'lead2', inst: 'pulse25', gen: 'mel', art: true, vol: 0.34, pan: -0.1, fx: VIB, vel: 0.8 },
      { name: 'lead3', inst: 'pulse50', gen: 'mel', art: true, harm: true, vol: 0.28, pan: 0.2, vel: 0.7 },
      { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.34, pan: -0.25, fx: VIB, vel: 0.75 },
      { name: 'descant', inst: 'pulse12', gen: 'mel', oct: 1, vol: 0.18, pan: 0.3, vel: 0.7 },
      { name: 'bell', inst: 'bell', gen: 'mel', oct: 1, vol: 0.42, pan: 0.3, fx: ECHO(), vel: 0.75 },
      { name: 'comp', inst: 'saw', gen: 'comp', vol: 0.46, pan: -0.3, center: 62, n: 3, vel: 0.8 },
      { name: 'arp', inst: 'marimba', gen: 'arp', lo: 60, vol: 0.42, pan: 0.3, vel: 0.75 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 62, vol: 0.9, vel: 0.65 },
      { name: 'run', inst: 'pulse12', gen: 'run', lo: 67, n: 8, vol: 0.3, pan: 0.2, vel: 0.9 },
    ],
    sections: [
      { name: 'fanfare', bars: 4, prog: '1 4 5 1', l: { lead: 'fan', lead2: 'fan *0.8', comp: 'trese', bass: 'half', bass2: 'half *0.8', kit: 'fanfare', bell: 'fan *0.7', pad: 'whole' } },
      { name: 'A', bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', lead2: 'T *0.8', lead3: 'T', counter: 'C1', bell: 'bellT', bass: 'bounceS', bass2: 'pump8 *0.7', kit: 'full +tom', comp: 'off8', pad: 'whole', arp: 'tres *0.6' } },
      { name: "A'", bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', lead2: 'Tg', lead3: 'T', counter: 'C1', descant: 'desc', bell: 'bellT', bass: 'bounceS', bass2: 'pump8a', kit: 'big +snare', comp: 'push', pad: 'whole', arp: 'pulse8 *0.7' } },
      { name: 'B', bars: 8, prog: '6 4 1 5 6 2 5 1', l: { lead: 'B', lead2: 'B *0.8', lead3: 'B', bell: 'B *0.6', bass: 'rf', bass2: 'pump8 *0.7', kit: 'full', comp: 'backbeat', pad: 'whole', arp: 'wave8 *0.8' } },
      { name: "A''", bars: 8, prog: '1 6 4 5 1 6 4 5_1', l: { lead: 'T', lead2: 'T', lead3: 'T', counter: 'C1', descant: 'desc', bell: 'bellT', bass: 'pump8a', bass2: 'bounceS', kit: 'big +tom', comp: 'push', pad: 'whole', arp: 'pulse8' } },
      { name: 'coda', bars: 4, prog: '1 6 4 5', l: { lead2: 'wheel', bell: 'wheel *0.7', bass: 'pump8 ^0.6-1', kit: 'coda', comp: 'pulse8 ^0.4-1', pad: 'whole', run: '', arp: 'pulse8 ^0.4-1' } },
    ],
  });
}

/** TITLE — C major, 96 bpm, 20 bars = 50 s. A gentle, welcoming statement of the tune on bells and marimba: the question, the question again with the inner voice, the answer, the head fading away. */
function title() {
  const T2 = slice(THEME, 4, 8);
  return compose({
    id: 'title', title: 'Egg Mama', bpm: 96, swing: 0.03, key: 'C', mode: 'major', gain: 1.05,
    mel: { T1, T2, head: HEAD, C1: phrase(`3,/8 2,/8 | 1,/8 6,,/8 | 6,,/8 1,/8 | 7,,/8 2,/8`), echo: concat(HEAD, rest(3)) },
    kits: {
      shake: grv('k:X............... sh:..g...g...g...g. r:........g.......'),
      shake2: [grv('k:X.......g....... sh:..g...g...g...g. r:........g.......'), grv('k:X.......g.....g. sh:..g...g...g...g. r:........g...g...')],
    },
    layers: [
      { name: 'bass', inst: 'bassTri', gen: 'bass', vol: 0.7, vel: 0.8 },
      { name: 'kit', inst: 'kit', gen: 'kit', vol: 0.5, vel: 0.8 },
      { name: 'lead', inst: 'bell', gen: 'mel', art: true, vol: 0.5, pan: 0.05, fx: ECHO(0.75, 0.35, 0.28), vel: 0.8 },
      { name: 'lead2', inst: 'marimba', gen: 'mel', art: true, vol: 0.5, pan: -0.1, vel: 0.75 },
      { name: 'leadB', inst: 'tri', gen: 'mel', art: true, vol: 0.6, pan: 0.08, fx: { vibrato: { rate: 5, depth: 12, delaySteps: 5 } }, vel: 0.8 },
      { name: 'counter', inst: 'tri', gen: 'mel', vol: 0.3, pan: -0.2, fx: VIB, vel: 0.65 },
      { name: 'arp', inst: 'pluck', gen: 'arp', lo: 60, vol: 0.38, pan: 0.3, fx: ECHO(), vel: 0.65 },
      { name: 'pad', inst: 'pad', gen: 'pad', center: 60, vol: 0.8, vel: 0.58 },
      { name: 'bellEcho', inst: 'bell', gen: 'mel', oct: 1, vol: 0.34, pan: 0.3, fx: ECHO(1.5, 0.4, 0.3), vel: 0.65 },
    ],
    sections: [
      { name: 'intro', bars: 4, prog: '1 6 4 5', l: { pad: 'whole ^0.3-1', arp: 'roll8 *0.7', bass: 'whole *0.8' } },
      { name: 'A', bars: 4, prog: '1 6 4 5', l: { lead: 'T1', arp: 'roll8 *0.8', bass: 'half', pad: 'whole', kit: 'shake' } },
      { name: "A'", bars: 4, prog: '1 6 4 5', l: { lead: 'T1', lead2: 'T1 *0.8', counter: 'C1', arp: 'roll8', bass: 'rf *0.9', pad: 'whole', kit: 'shake2' } },
      { name: 'B', bars: 4, prog: '1 6 4 5_1', l: { lead: 'T2', lead2: 'T2 *0.8', leadB: 'T2 *0.8', counter: 'C1', arp: 'wave8 *0.8', bass: 'half', pad: 'whole', kit: 'shake' } },
      { name: 'outro', bars: 4, prog: '1 6 4 5', l: { bellEcho: 'echo', arp: 'sparse', pad: 'whole ^1-0.5', bass: 'whole *0.7' } },
    ],
  });
}

/* ═══════════════════════════════════ 9. exports ═══════════════════════════════════ */

const BUILDERS = {
  title, meadow, 'clover-mill': cloverMill, reedwater, orchard, 'amber-quarry': amberQuarry, fogwood, canyon, 'glass-coast': glassCoast,
  'lantern-caverns': lanternCaverns, frostline, ridge, dawnbridge, 'beacon-summit': beaconSummit, beacon,
};
/**
 * SONGS = { title, meadow, ..., beacon }. Each song is built the first time it is read (about 5-10 ms) and then kept, so importing this
 * module is instant even on a slow phone and a song the child never reaches is never built. The properties are enumerable:
 * Object.keys / entries / JSON.stringify behave as if SONGS were a plain object. A builder that throws yields `null`
 * (the audio engine ignores an unknown song) instead of taking the game down; tests/music.test.mjs fails loudly in that case.
 */
export const SONGS = {};
for (const [id, build] of Object.entries(BUILDERS)) {
  let song;
  Object.defineProperty(SONGS, id, {
    enumerable: true,
    get() {
      if (song === undefined) { try { song = build(); } catch (e) { song = null; } }
      return song;
    },
  });
}

/**
 * The song id for a landscape (0-12; any integer wraps around, anything else counts as 0). Later circuits replay the same songs:
 * the difficulty rises with each circuit, the music keeps its character (`circuit` is accepted so a remix could be added without
 * changing callers).
 */
export function songFor(chapterIndex, circuit = 1) {
  void circuit;
  const n = CHAPTERS.length, x = Math.floor(Number(chapterIndex));
  // NaN, +-Infinity and anything past 2^53 (where `%` stops being meaningful) all count as 0: this must never throw into the game loop
  const i = Number.isSafeInteger(x) ? x : 0;
  return CHAPTERS[((i % n) + n) % n].song;
}
