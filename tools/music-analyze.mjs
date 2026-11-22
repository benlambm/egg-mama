#!/usr/bin/env node
/*
 * Egg Mama — soundtrack analyser. Reads docs/js/music.mjs (plain data, no audio needed) and prints:
 *
 *   node tools/music-analyze.mjs                       summary table of every song + the Meadow theme as an ASCII piano roll
 *   node tools/music-analyze.mjs --map                 + a layer-activity map for every song (who plays when: the intensity waves)
 *   node tools/music-analyze.mjs --map meadow          the same for one song
 *   node tools/music-analyze.mjs --roll canyon         piano roll of a song (default layer 'lead', bars 0-8)
 *   node tools/music-analyze.mjs --roll canyon --layers lead,bass --bars 16-24
 *   node tools/music-analyze.mjs --theme               where the Meadow head (scale degrees 3 5 6 5 3 2) is found in every song
 *   node tools/music-analyze.mjs --json                the summary as JSON (for scripts)
 *
 * Summary columns: bpm, bars, loop seconds, key/mode, swing, layers, melodic notes, drum hits, hiMax (most onsets in one bar at
 * MIDI >= 72, where pickup sounds live), leadCov (share of the time the lead sounds; the rest is air), on/s (distinct onsets per
 * second over the whole loop: the intensity curve, relaxed Meadow -> busy summit -> the beacon), avg lay (layers sounding on average).
 */
import { SONGS } from '../docs/js/music.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const secondsOf = (s) => (s.bars * s.beatsPerBar * 60) / s.bpm;
const SPB = (s) => s.beatsPerBar * s.stepsPerBeat;
const isLead = (l) => /^(lead|melody)/.test(l.name);

/* ───────────────────────── summary ───────────────────────── */

/** Distinct (layer, step) onsets per second over the loop: a chord stab counts once. A proxy for how busy the music feels. */
function onsetsPerSecond(s) {
  let n = 0;
  for (const l of s.layers) n += new Set((l.notes || l.hits).map((e) => e[0])).size;
  return n / secondsOf(s);
}
function avgLayers(s) {
  let n = 0;
  for (const l of s.layers) n += (l.play || [[0, s.bars]]).reduce((a, [x, y]) => a + (y - x), 0);
  return n / s.bars;
}

export function summarize(id, s) {
  const pitched = s.layers.filter((l) => l.inst !== 'kit');
  const notes = pitched.reduce((n, l) => n + (l.notes || []).length, 0);
  const hits = s.layers.filter((l) => l.inst === 'kit').reduce((n, l) => n + (l.hits || []).length, 0);
  // onsets per bar at or above MIDI 72 (where pickup sounds live), busiest bar
  const perBar = new Array(s.bars).fill(0);
  for (const l of pitched) for (const [st, midi] of l.notes || []) if (midi >= 72) perBar[Math.floor(st / SPB(s))]++;
  const leadNotes = s.layers.filter(isLead).flatMap((l) => l.notes || []);
  let covered = 0, total = 0;
  for (const l of s.layers.filter(isLead)) {
    const steps = new Set();
    for (const [st, , len] of l.notes || []) for (let k = 0; k < len; k++) steps.add(st + k);
    covered += steps.size;
    const bars = (l.play || [[0, s.bars]]).reduce((n, [a, b]) => n + (b - a), 0);
    total += bars * SPB(s);
  }
  return {
    id, title: s.title, bpm: s.bpm, bars: s.bars, seconds: +secondsOf(s).toFixed(1), key: `${s.key} ${s.mode}`, swing: s.swing,
    layers: s.layers.length, notes, hits, instruments: [...new Set(s.layers.map((l) => l.inst))],
    busiestHigh: Math.max(...perBar), leadNotes: leadNotes.length, leadCoverage: total ? +(covered / total).toFixed(2) : 0,
    onsetsPerSecond: +onsetsPerSecond(s).toFixed(1), avgLayers: +avgLayers(s).toFixed(1),
  };
}

function printSummary(rows) {
  console.log(pad('id', 16) + rpad('bpm', 5) + rpad('bars', 6) + rpad('sec', 7) + '  ' + pad('key', 14) + rpad('swing', 6) + rpad('lay', 4) + rpad('notes', 7) + rpad('hits', 6) + rpad('hiMax', 6) + rpad('leadCov', 8) + rpad('on/s', 6) + rpad('avgLay', 7) + '  instruments');
  for (const r of rows) {
    console.log(pad(r.id, 16) + rpad(r.bpm, 5) + rpad(r.bars, 6) + rpad(r.seconds, 7) + '  ' + pad(r.key, 14) + rpad(r.swing, 6) + rpad(r.layers, 4) + rpad(r.notes, 7) + rpad(r.hits, 6) + rpad(r.busiestHigh, 6) + rpad(r.leadCoverage, 8) + rpad(r.onsetsPerSecond, 6) + rpad(r.avgLayers, 7) + '  ' + r.instruments.join(' '));
  }
  const chapters = rows.filter((r) => r.id !== 'title' && r.id !== 'beacon');
  const total = rows.reduce((n, r) => n + r.seconds, 0);
  console.log(`\n${rows.length} songs, ${(total / 60).toFixed(1)} minutes of music in all; chapter songs ${Math.min(...chapters.map((r) => r.seconds))}-${Math.max(...chapters.map((r) => r.seconds))} s per loop`);
}

/* ───────────────────────── piano roll ───────────────────────── */

/** ASCII piano roll of the given layers in bars [b0, b1). One column per step, '|' at every bar line. */
export function pianoRoll(s, layerNames, b0, b1) {
  const spb = SPB(s), lo = b0 * spb, hi = b1 * spb;
  const layers = s.layers.filter((l) => layerNames.includes(l.name) && l.inst !== 'kit');
  const events = [];
  layers.forEach((l, li) => {
    const mark = l.name[0].toUpperCase();
    const ranges = l.play || [[0, s.bars]];
    for (const [st, midi, len] of l.notes || []) {
      if (st < lo || st >= hi) continue;
      if (!ranges.some(([a, b]) => st >= a * spb && st < b * spb)) continue;
      events.push({ st, midi, len, mark, li });
    }
  });
  if (!events.length) return '  (no notes in this range)';
  const top = Math.max(...events.map((e) => e.midi)), bot = Math.min(...events.map((e) => e.midi));
  const grid = new Map();
  for (const e of events) {
    const row = grid.get(e.midi) || new Array(hi - lo).fill(' ');
    for (let k = 0; k < e.len && e.st - lo + k < hi - lo; k++) {
      const c = e.st - lo + k;
      row[c] = k === 0 ? e.mark : (row[c] === ' ' ? '=' : row[c]);
    }
    grid.set(e.midi, row);
  }
  const lines = [];
  // header: bar numbers and the chord of each bar
  let h1 = '        ', h2 = '        ';
  for (let b = b0; b < b1; b++) {
    const w = spb + s.beatsPerBar - 1;                              // a bar is `spb` cells plus a ':' before each later beat
    h1 += '|' + pad(String(b + 1), w);
    h2 += '|' + pad(s.harmony ? s.harmony[b] : '', w);
  }
  lines.push(h1 + '|', h2 + '|');
  for (let m = top; m >= bot; m--) {
    const row = grid.get(m);
    const isC = m % 12 === 0;
    if (!row && !(top - bot < 30)) continue;
    let line = pad(noteName(m), 5) + pad(m, 3);
    for (let c = 0; c < hi - lo; c++) line += (c % spb === 0 ? '|' : c % s.stepsPerBeat === 0 ? ':' : '') + (row ? row[c] : (isC ? '-' : '.'));
    lines.push(line + '|');
  }
  return lines.join('\n');
}

/* ───────────────────────── layer map ───────────────────────── */

export function layerMap(s) {
  const spb = SPB(s);
  const lines = [];
  // section ruler
  let ruler = '', names = '';
  for (let b = 0; b < s.bars; b++) {
    const sec = s.sections.find((x) => x.from === b);
    ruler += sec ? '|' : (b % 4 === 0 ? ':' : ' ');
  }
  lines.push(pad('', 9) + ruler + '|');
  const secLine = new Array(s.bars + 1).fill(' ');
  for (const sec of s.sections) { const t = sec.name.slice(0, Math.max(1, sec.to - sec.from - 0)); for (let i = 0; i < t.length && sec.from + i < s.bars; i++) secLine[sec.from + i] = t[i]; }
  lines.push(pad('', 9) + secLine.join(''));
  for (const l of s.layers) {
    const cnt = new Array(s.bars).fill(0);
    const ranges = l.play || [[0, s.bars]];
    for (const ev of l.notes || l.hits || []) {
      const b = Math.floor(ev[0] / spb);
      if (ranges.some(([a, z]) => b >= a && b < z)) cnt[b]++;
    }
    const mx = Math.max(1, ...cnt);
    let row = '';
    for (let b = 0; b < s.bars; b++) row += cnt[b] === 0 ? ' ' : cnt[b] <= mx * 0.25 ? '.' : cnt[b] <= mx * 0.55 ? 'o' : cnt[b] <= mx * 0.85 ? 'O' : '#';
    lines.push(pad(l.name, 8) + ' ' + row);
  }
  return lines.join('\n');
}

/* ───────────────────────── where is the head? ───────────────────────── */

/** Diatonic step of a MIDI note counted from the song's tonic (null if the pitch class is outside the scale). */
function degreeIndex(s, midi) {
  const ivs = s.scale.map((pc) => (((pc - s.tonic) % 12) + 12) % 12).sort((a, b) => a - b);
  const rel = midi - s.tonic;
  const k = ivs.indexOf(((rel % 12) + 12) % 12);
  return k < 0 ? null : k + 7 * Math.floor(rel / 12);
}

export const HEAD_STEPS = [2, 1, -1, -2, -1];          // diatonic intervals of 3 5 6 5 3 2
export const HEAD_IOI = [3, 3, 2, 3, 3];               // inter-onset steps of the head

/** All places where a lead-ish layer plays the head's contour. Returns [{ layer, step, bar, exactRhythm }]. */
export function findHead(s) {
  const found = [];
  for (const l of s.layers) {
    if (l.inst === 'kit' || !/^(lead|melody|counter|bell)/.test(l.name)) continue;
    const ns = (l.notes || []).slice().sort((a, b) => a[0] - b[0]);
    const ds = ns.map((n) => degreeIndex(s, n[1]));
    for (let i = 0; i + 5 < ns.length; i++) {
      let ok = true;
      for (let k = 0; k < 5 && ok; k++) ok = ds[i + k] !== null && ds[i + k + 1] !== null && ds[i + k + 1] - ds[i + k] === HEAD_STEPS[k];
      if (!ok) continue;
      const ioi = [0, 1, 2, 3, 4].map((k) => ns[i + k + 1][0] - ns[i + k][0]);
      const f = ioi[0] / HEAD_IOI[0];
      const exact = ioi.every((v, k) => Math.abs(v / f - HEAD_IOI[k]) < 0.01);
      found.push({ layer: l.name, step: ns[i][0], bar: Math.floor(ns[i][0] / SPB(s)), exact, scale: f });
    }
  }
  return found;
}

/* ───────────────────────── main ───────────────────────── */

function main() {
  const ids = Object.keys(SONGS);
  const rows = ids.map((id) => summarize(id, SONGS[id]));
  if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); return; }

  const rollId = opt('roll', null);
  if (rollId) {
    const s = SONGS[rollId];
    if (!s) { console.error('no such song: ' + rollId + ' (have ' + ids.join(', ') + ')'); process.exit(1); }
    const [b0, b1] = opt('bars', '0-8').split('-').map(Number);
    const layers = opt('layers', 'lead').split(',');
    console.log(`${s.id} (${s.title}) — ${s.key} ${s.mode}, ${s.bpm} bpm — layers ${layers.join('+')} — bars ${b0 + 1}..${b1}\n`);
    console.log(pianoRoll(s, layers, b0, Math.min(b1, s.bars)));
    return;
  }
  if (flag('theme')) {
    for (const id of ids) {
      const f = findHead(SONGS[id]);
      const exact = f.filter((x) => x.exact);
      console.log(pad(id, 16) + rpad(f.length, 3) + ' head statements (' + exact.length + ' with the original rhythm), first at bar ' + (f.length ? f[0].bar + 1 : '-') + (f.length ? ' by ' + [...new Set(f.map((x) => x.layer))].join(',') : ''));
    }
    return;
  }

  printSummary(rows);
  if (flag('map') || args.includes('--map')) {
    const only = opt('map', null);
    for (const id of ids) { if (only && only !== id) continue; console.log(`\n── ${id}: ${SONGS[id].title} (${SONGS[id].key} ${SONGS[id].mode}, ${SONGS[id].bpm} bpm, ${secondsOf(SONGS[id]).toFixed(0)} s)\n` + layerMap(SONGS[id])); }
  }
  const m = SONGS.meadow;
  if (m) {
    console.log('\n── The Meadow theme (lead layer, bars 5-12): the phrase every chapter song re-dresses\n');
    const lead = m.layers.find((l) => l.name === 'lead');
    const first = (lead.play || [[0, m.bars]])[0][0];
    console.log(pianoRoll(m, ['lead'], first, first + 8));
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
