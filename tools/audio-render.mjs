#!/usr/bin/env node
/*
 * Egg Mama — offline audio renderer + analyser.
 *
 *   node tools/audio-render.mjs                 # built-in test song + every sfx (+ every real song if docs/js/music.mjs exists)
 *   node tools/audio-render.mjs --builtin-only  # skip the real songs
 *   node tools/audio-render.mjs --songs meadow,fogwood
 *   node tools/audio-render.mjs --music path/to/other-music.mjs   # use a different SONGS module instead of docs/js/music.mjs
 *   node tools/audio-render.mjs --out DIR --sr 32000 --seam-full
 *
 * It drives headless Chromium (Playwright, already installed globally), loads docs/js/audio.mjs the same way the
 * game does, and renders with OfflineAudioContext through the SAME SongPlayer / mixer code as live play. Samples are
 * pulled back into Node, written as 16-bit WAV files, and analysed here:
 *
 *   songs   peak / RMS / DC / silence, band energy (1-4 kHz etc.), loop-seam continuity (click, level step,
 *           repeat consistency), and the goldHatch-vs-music loudness comparison at the song's loudest 1-4 kHz moment
 *   sfx     peak / RMS / DC / length / 800-5 kHz share / pitch contour / onsets, the five key cues compared
 *
 * The comparison uses a 6-channel stem render (renderOffline opts.stems): [mix | music after the duck | sfx before the
 * master], so "how loud is the cue against the music underneath it" is measured directly, ducking included.
 * The process exits non-zero if a hard check fails. Nothing is served over the network: Playwright answers the
 * page's requests straight from docs/ (no server, no port, nothing left running).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..', 'docs');

/* ───────────────────────── a built-in test song (every instrument, a loud tutti section) ───────────────────────── */

/** 16 bars, C major, 124 bpm: intro (0-3), groove (4-7), TUTTI everything (8-11), breakdown (12-15). */
export function builtinSong() {
  const chords = [[48, 48, 52, 55], [45, 45, 48, 52], [41, 53, 57, 60], [43, 55, 59, 62]]; // C Am F G: [bass root (>= 82 Hz: phones), triad...]
  const bar = (i) => i * 16;
  const per = (fn, from = 0, to = 16) => { const out = []; for (let b = from; b < to; b++) out.push(...fn(b, chords[b % 4]).map((n) => [bar(b) + n[0], ...n.slice(1)])); return out; };

  const bassTri = per((b, c) => [[0, c[0], 2], [4, c[0] + 12, 2], [6, c[0], 2], [8, c[0], 2], [10, c[0] + 7, 2], [12, c[0] + 12, 2], [14, c[0] + 7, 1]]);
  const bassSaw = per((b, c) => [[0, c[0] + 12, 3], [6, c[0] + 12, 2], [8, c[0] + 12, 3], [14, c[0] + 19, 1]], 8, 12);
  const bassPulse = per((b, c) => [[0, c[0], 1, 0.9], [3, c[0], 1], [6, c[0] + 12, 1], [8, c[0], 1], [11, c[0], 1], [14, c[0] + 12, 1]], 4, 8);
  const pad = per((b, c) => c.slice(1).map((m) => [0, m, 16, 0.8]));
  // the hummable phrase (4 bars, repeated): over C, Am, F, G
  const phrase = [[0, 76, 2], [2, 79, 2], [4, 81, 4], [8, 79, 2], [10, 76, 2], [12, 74, 4],
    [16, 72, 2], [18, 74, 2], [20, 76, 6], [28, 74, 2],
    [32, 81, 2], [34, 84, 2], [36, 81, 4], [40, 79, 2], [42, 77, 2], [44, 76, 4],
    [48, 74, 2], [50, 76, 2], [52, 79, 8], [60, 76, 2], [62, 74, 2]];
  const rep = (notes, from, to, dy = 0, vel) => { const out = []; for (let b = from; b < to; b += 4) for (const n of notes) out.push([bar(b) + n[0], n[1] + dy, n[2], vel ?? n[3]]); return out; };
  const lead = rep(phrase, 4, 8).concat(rep(phrase, 12, 16));
  const sawLead = rep(phrase, 8, 12, 0);
  const tri = rep(phrase, 0, 4, -12).concat(rep(phrase, 12, 16, -12, 0.6));
  const bell = per((b, c) => [[0, c[3] + 24, 4], [3, c[2] + 24, 4], [6, c[1] + 24, 4], [9, c[3] + 24, 4], [12, c[2] + 24, 4]], 8, 16);
  const marimba = per((b, c) => [[2, c[1] + 12, 2], [5, c[2] + 12, 2], [10, c[1] + 12, 2], [13, c[3] + 12, 2]], 0, 8);
  const pluck = per((b, c) => [[0, c[1] + 12, 1], [2, c[2] + 12, 1], [4, c[3] + 12, 1], [6, c[2] + 12, 1], [8, c[1] + 12, 1], [10, c[2] + 12, 1], [12, c[3] + 12, 1], [14, c[2] + 24, 1]], 2, 4)
    .concat(per((b, c) => [[0, c[1] + 12, 1], [3, c[2] + 12, 1], [6, c[3] + 12, 1], [9, c[2] + 12, 1], [12, c[1] + 24, 1]], 8, 12));
  const saw = per((b, c) => [[0, c[1], 3, 0.8], [3, c[2], 3, 0.8], [6, c[3], 2, 0.8], [8, c[1], 3, 0.8], [11, c[2], 3, 0.8], [14, c[3], 2, 0.8]], 8, 12);
  const pulse12 = per((b, c) => [[1, c[3] + 24, 1], [5, c[2] + 24, 1], [9, c[3] + 24, 1], [13, c[1] + 24, 1]], 10, 12);
  const pulse50 = per((b, c) => [[0, c[1] + 12, 2, 0.7], [8, c[2] + 12, 2, 0.7]], 4, 8);
  // drums
  const hits = (fn, from, to) => { const out = []; for (let b = from; b < to; b++) out.push(...fn(b).map((h) => [bar(b) + h[0], ...h.slice(1)])); return out; };
  const kit = hits((b) => {
    const o = [[0, 'k'], [6, 'k', 0.8], [8, 'k'], [14, 'k', 0.7], [4, 's'], [12, 's'], [2, 'h', 0.6], [6, 'h', 0.6], [10, 'h', 0.6], [14, 'o', 0.6], [0, 'h', 0.8], [4, 'h', 0.8], [8, 'h', 0.8], [12, 'h', 0.8]];
    if (b === 8) o.push([0, 'c']);
    if (b >= 8 && b < 12) o.push([4, 'cl', 0.9], [12, 'cl', 0.9], ...[1, 3, 5, 7, 9, 11, 13, 15].map((s) => [s, 'sh', 0.6]), [2, 'r', 0.7], [10, 'r', 0.7]);
    if (b === 7 || b === 11) o.push([12, 't', 0.9], [13, 't', 0.8], [14, 't', 0.9], [15, 't', 1]);
    if (b >= 12) return o.filter((h) => h[1] === 'h' || h[1] === 'k' && h[0] === 0);
    return o;
  }, 4, 16);
  const layer = (name, inst, vol, notes, play, extra = {}) => ({ name, inst, vol, notes, play, ...extra });
  return {
    id: 'builtin', title: 'Built-in test tune', bpm: 124, beatsPerBar: 4, stepsPerBeat: 4, bars: 16, swing: 0.08,
    layers: [
      layer('pad', 'pad', 0.55, pad, [[0, 16]], { pan: 0 }),
      layer('bass', 'bassTri', 0.8, bassTri, [[0, 16]]),
      layer('bass2', 'bassSaw', 0.35, bassSaw, [[8, 12]]),
      layer('bass3', 'bassPulse', 0.5, bassPulse, [[4, 8]]),
      layer('lead', 'pulse25', 0.55, lead, [[4, 8], [12, 16]], { pan: -0.15, fx: { vibrato: { rate: 5.5, depth: 14, delaySteps: 3 } } }),
      layer('lead2', 'sawLead', 0.5, sawLead, [[8, 12]], { pan: 0.15, fx: { vibrato: { rate: 5.5, depth: 18, delaySteps: 3 }, delay: { beats: 0.75, feedback: 0.3, mix: 0.2 } } }),
      layer('tri', 'tri', 0.55, tri, [[0, 4], [12, 16]], { pan: 0.2 }),
      layer('bell', 'bell', 0.6, bell, [[8, 16]], { pan: 0.3, fx: { delay: { beats: 1.5, feedback: 0.4, mix: 0.3 } } }),
      layer('marimba', 'marimba', 0.7, marimba, [[0, 8]], { pan: -0.25 }),
      layer('pluck', 'pluck', 0.6, pluck, [[2, 4], [8, 12]], { pan: 0.35, fx: { delay: { beats: 0.75, feedback: 0.35, mix: 0.25 } } }),
      layer('stab', 'saw', 0.5, saw, [[8, 12]], { pan: -0.3 }),
      layer('spark', 'pulse12', 0.4, pulse12, [[10, 12]], { pan: 0.4 }),
      layer('ping', 'pulse50', 0.35, pulse50, [[4, 8]], { pan: -0.4 }),
      { name: 'drums', inst: 'kit', vol: 0.85, hits: kit, play: [[4, 16]] },
    ],
  };
}

/**
 * The worst music we can imagine: the same tune with every layer boosted to the top of the allowed range and four extra bright
 * layers (1-4 kHz leads, bells, plucks) doubling the melody in the tutti. If the limiter holds and goldHatch still stands out
 * over THIS, it will over any real arrangement.
 */
export function stressSong() {
  const b = builtinSong();
  const boost = b.layers.map((l) => ({ ...l, vol: Math.min(1.5, (l.vol || 0.5) * 2.2) }));
  const phrase = b.layers.find((l) => l.name === 'lead2').notes;                 // the sawLead melody (bars 8-11)
  const up = (notes, dy) => notes.map((n) => [n[0], n[1] + dy, n[2], 1]);
  boost.push(
    { name: 'x-pulse', inst: 'pulse50', vol: 1.5, pan: -0.5, play: [[8, 12]], notes: up(phrase, 12) },
    { name: 'x-pulse2', inst: 'pulse25', vol: 1.5, pan: 0.5, play: [[8, 12]], notes: up(phrase, 19) },
    { name: 'x-bell', inst: 'bell', vol: 1.5, pan: 0, play: [[8, 12]], notes: up(phrase, 24) },
    { name: 'x-pluck', inst: 'pluck', vol: 1.5, pan: 0.2, play: [[8, 12]], notes: up(phrase, 12) },
  );
  return { ...b, id: 'builtin-stress', title: 'Stress test: everything at once, as loud as allowed', layers: boost };
}

/* ───────────────────────── DSP (Node side) ───────────────────────── */

const FFT_CACHE = new Map();
function fftPlan(n) {
  let p = FFT_CACHE.get(n);
  if (p) return p;
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  const hann = new Float64Array(n); let w2 = 0;
  for (let i = 0; i < n; i++) { hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); w2 += hann[i] * hann[i]; }
  p = { rev, cos, sin, hann, w2 };
  FFT_CACHE.set(n, p);
  return p;
}
function fft(re, im) {
  const n = re.length, { rev, cos, sin } = fftPlan(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
/** Hann-windowed one-sided power spectrum of x[start..start+n): mean-square per bin so that sum over bins = mean-square of the frame. */
function powerSpectrum(x, start, n, re, im) {
  const { hann, w2 } = fftPlan(n);
  for (let i = 0; i < n; i++) { const v = start + i < x.length ? x[start + i] : 0; re[i] = v * hann[i]; im[i] = 0; }
  fft(re, im);
  const out = new Float64Array(n / 2 + 1), norm = 1 / (n * w2);
  for (let k = 0; k <= n / 2; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) * norm * (k === 0 || k === n / 2 ? 1 : 2);
  return out;
}
const pow2Near = (v) => 2 ** Math.round(Math.log2(v));
const db = (lin) => 20 * Math.log10(Math.max(lin, 1e-12));
const dbp = (p) => 10 * Math.log10(Math.max(p, 1e-24));

/** Band RMS (linear) per window. Window ~0.1 s, hop 0.05 s. Returns { t: [], v: [] } (t = window centre, s). */
function bandSeries(x, sr, lo, hi, win = 0.1, hop = 0.05) {
  const n = pow2Near(win * sr), re = new Float64Array(n), im = new Float64Array(n), step = Math.round(hop * sr);
  const k0 = Math.ceil(lo * n / sr), k1 = Math.floor(hi * n / sr), t = [], v = [];
  for (let s = 0; s + n <= x.length; s += step) {
    const ps = powerSpectrum(x, s, n, re, im);
    let sum = 0; for (let k = k0; k <= k1; k++) sum += ps[k];
    t.push((s + n / 2) / sr); v.push(Math.sqrt(sum));
  }
  return { t, v, n };
}
/** Welch-averaged power spectrum of the whole signal. */
function avgSpectrum(x, sr, n = 4096) {
  if (x.length < n) { const p = new Float32Array(n); p.set(x); x = p; }   // a short cue: one zero-padded frame
  const re = new Float64Array(n), im = new Float64Array(n), acc = new Float64Array(n / 2 + 1);
  let frames = 0;
  for (let s = 0; s + n <= x.length; s += n / 2) { const ps = powerSpectrum(x, s, n, re, im); for (let k = 0; k < acc.length; k++) acc[k] += ps[k]; frames++; }
  for (let k = 0; k < acc.length; k++) acc[k] /= Math.max(1, frames);
  return { spec: acc, n, sr };
}
const bandPower = (sp, lo, hi) => { let s = 0; for (let k = Math.ceil(lo * sp.n / sp.sr); k <= Math.min(sp.spec.length - 1, Math.floor(hi * sp.n / sp.sr)); k++) s += sp.spec[k]; return s; };
const BANDS = [['<90', 0, 90], ['90-250', 90, 250], ['250-800', 250, 800], ['0.8-1k', 800, 1000], ['1-4k', 1000, 4000], ['4-8k', 4000, 8000], ['>8k', 8000, 1e5]];
function bandShares(x, sr) {
  const sp = avgSpectrum(x, sr), total = bandPower(sp, 0, 1e5) || 1e-24, o = {};
  for (const [name, lo, hi] of BANDS) o[name] = bandPower(sp, lo, hi) / total;
  o['0.8-5k'] = bandPower(sp, 800, 5000) / total;
  return o;
}

const mono = (l, r) => { const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i] + (r ? r[i] : l[i])) * 0.5; return m; };
function rms(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }
function mean(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i]; return s / Math.max(1, b - a); }
function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; }

/** Silence: windows of 50 ms below -60 dBFS. */
function silence(x, sr, floorDb = -60) {
  const w = Math.round(sr * 0.05); let n = 0, silent = 0, run = 0, maxRun = 0, lead = 0, leading = true;
  for (let s = 0; s + w <= x.length; s += w) {
    const quiet = db(rms(x, s, s + w)) < floorDb; n++;
    if (quiet) { silent++; run++; maxRun = Math.max(maxRun, run); if (leading) lead++; } else { run = 0; leading = false; }
  }
  return { fraction: silent / Math.max(1, n), longestRunS: maxRun * 0.05, leadingS: lead * 0.05 };
}

/** Time-frequency fingerprint: log band energies per frame (for comparing two stretches of audio). */
function fingerprint(x, sr, startS, durS, frame = 0.05) {
  const n = pow2Near(frame * sr * 2), re = new Float64Array(n), im = new Float64Array(n), edges = [100, 200, 400, 800, 1200, 1800, 2600, 3600, 5000, 7000, 10000];
  const out = [];
  for (let s = Math.round(startS * sr); s + n <= Math.round((startS + durS) * sr) && s + n <= x.length; s += Math.round(frame * sr)) {
    const ps = powerSpectrum(x, s, n, re, im), row = [];
    for (let b = 0; b + 1 < edges.length; b++) { let e = 0; for (let k = Math.ceil(edges[b] * n / sr); k < Math.floor(edges[b + 1] * n / sr); k++) e += ps[k]; row.push(dbp(e)); }
    out.push(row);
  }
  return out;
}
/** Mean absolute dB difference between two fingerprints, over cells that are not near-silent. */
function fpDiff(a, b) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) for (let j = 0; j < a[i].length; j++) {
    if (Math.max(a[i][j], b[i][j]) < -75) continue;
    sum += Math.abs(a[i][j] - b[i][j]); cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/**
 * Loop-seam continuity. `m` is a mono render of loop + tail; the loop length L is exact. Checks:
 *   click        biggest sample-to-sample step within +-1.5 ms of the seam, against the 99.9th percentile of steps in the file
 *   levelStepDb  RMS in the 250 ms after the seam against the 250 ms before it
 *   repeatDiffDb how different the 2nd pass of the opening 4 s sounds from the 1st (band-energy fingerprint, noise-phase
 *                independent); `controlDiffDb` is the same measure between two UNRELATED 4 s stretches, for scale
 */
function seamMetrics(m, sr, loopS) {
  const seam = Math.round(loopS * sr), d = new Float32Array(m.length - 1);
  for (let i = 1; i < m.length; i++) d[i - 1] = Math.abs(m[i] - m[i - 1]);
  const sorted = Float32Array.from(d).sort(); const p999 = sorted[Math.floor(sorted.length * 0.999)] || 1e-9;
  let local = 0; for (let i = seam - Math.round(0.0015 * sr); i <= seam + Math.round(0.0015 * sr); i++) local = Math.max(local, d[i] || 0);
  const w = Math.round(0.25 * sr);
  const levelStepDb = db(rms(m, seam, seam + w)) - db(rms(m, seam - w, seam));
  const span = Math.min(4, (m.length - seam) / sr - 0.2);
  const first = fingerprint(m, sr, 0, span), second = fingerprint(m, sr, loopS, span), ctl = fingerprint(m, sr, Math.min(loopS - span - 1, span + 3), span);
  return { clickRatio: local / p999, levelStepDb, repeatDiffDb: fpDiff(first, second), controlDiffDb: fpDiff(first, ctl), spanS: span };
}

/** Dominant-frequency contour of a short cue: slope in semitones/s over frames above -45 dBFS, plus onset count and attack time. */
function cueShape(x, sr, startS = 0) {
  const n = 1024, hop = 256, re = new Float64Array(n), im = new Float64Array(n);
  const pts = [];
  for (let s = 0; s + n <= x.length; s += hop) {
    const e = rms(x, s, s + n); if (db(e) < -45) continue;
    const ps = powerSpectrum(x, s, n, re, im); let best = 0, bk = 0;
    for (let k = Math.ceil(300 * n / sr); k < Math.floor(8000 * n / sr); k++) if (ps[k] > best) { best = ps[k]; bk = k; }
    if (bk) pts.push([(s + n / 2) / sr, 12 * Math.log2(bk * sr / n / 440)]);
  }
  let slope = 0;
  if (pts.length > 3) {
    const mt = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let num = 0, den = 0; for (const p of pts) { num += (p[0] - mt) * (p[1] - my); den += (p[0] - mt) ** 2; }
    slope = den ? num / den : 0;
  }
  // onsets: rises in the 5 ms RMS envelope of more than 9 dB over the previous 25 ms, at least 60 ms apart
  const w = Math.round(sr * 0.005), env = []; for (let s = 0; s + w <= x.length; s += w) env.push(db(rms(x, s, s + w)));
  let onsets = 0, last = -1e9;
  for (let i = 5; i < env.length; i++) {
    const prev = Math.max(...env.slice(i - 5, i));
    if (env[i] > -40 && env[i] - prev > 9 && (i - last) * 0.005 > 0.06) { onsets++; last = i; }
  }
  const pk = peakOf(x); let att = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= pk * 0.9) { att = i / sr - startS; break; }
  return { slopeStPerS: slope, onsets, attackS: Math.max(0, att) };
}

/** Active length: first to last 5 ms window above -50 dBFS (relative to full scale). */
function activeLength(x, sr, floorDb = -50) {
  const w = Math.round(sr * 0.005); let first = -1, last = -1;
  for (let s = 0, i = 0; s + w <= x.length; s += w, i++) if (db(rms(x, s, s + w)) > floorDb) { if (first < 0) first = i; last = i; }
  return first < 0 ? { startS: 0, endS: 0, lengthS: 0 } : { startS: first * 0.005, endS: (last + 1) * 0.005, lengthS: (last + 1 - first) * 0.005 };
}


/** Spectrogram of a cue for comparison: 24 log bands 300 Hz-6 kHz, 20 ms hop, dB relative to the cue's peak, floored at -50. */
function cueSpectrogram(x, sr) {
  const n = 2048, hop = Math.round(sr * 0.02), re = new Float64Array(n), im = new Float64Array(n), bands = 24, rows = [];
  const edges = Array.from({ length: bands + 1 }, (_, i) => 300 * Math.pow(20, i / bands));
  let maxDb = -200;
  for (let s = 0; s + n <= x.length; s += hop) {
    const ps = powerSpectrum(x, s, n, re, im), row = [];
    for (let b = 0; b < bands; b++) { let e = 0; for (let k = Math.ceil(edges[b] * n / sr); k < Math.max(Math.ceil(edges[b] * n / sr) + 1, Math.floor(edges[b + 1] * n / sr)); k++) e += ps[k]; row.push(dbp(e)); maxDb = Math.max(maxDb, row[b]); }
    rows.push(row);
  }
  let active = 0;
  const norm = rows.map((r, i) => { const q = r.map((v) => Math.max(0, 50 + Math.min(0, v - maxDb))); if (Math.max(...q) > 5) active = i; return q; });
  return { rows: norm, bands, active, empty: new Array(bands).fill(0) };
}

/** A minimal PNG writer (zlib is built in). rgb: Uint8Array w*h*3. */
function writePng(file, w, h, rgb) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const HEAT = (v) => { // 0..1 -> dark blue, purple, orange, yellow, white
  const stops = [[0, [8, 8, 32]], [0.25, [60, 20, 120]], [0.5, [200, 50, 90]], [0.75, [250, 170, 40]], [1, [255, 255, 220]]];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a); return ca.map((c, k) => Math.round(c + (cb[k] - c) * t)); }
  return stops[stops.length - 1][1];
};
/** Stack one spectrogram row per signal: x axis = seconds (0..seconds), y axis = 0..maxHz (low at the bottom), 60 dB range. */
function writeSpectrogramPng(file, signals, sr, seconds, maxHz, W = Math.round(seconds / 0.008)) {
  const n = 1024, hop = Math.max(1, Math.floor(seconds * sr / W)), rowH = Math.round(maxHz / (sr / n)), gap = 4;
  const H = signals.length * (rowH + gap), rgb = new Uint8Array(W * H * 3).fill(0);
  const re = new Float64Array(n), im = new Float64Array(n);
  signals.forEach((x, r) => {
    for (let px = 0; px < W; px++) {
      const ps = powerSpectrum(x, px * hop, n, re, im);
      for (let k = 0; k < rowH; k++) {
        const v = Math.min(1, Math.max(0, (dbp(ps[k]) + 80) / 60)), [R, G, B] = HEAT(v), y = r * (rowH + gap) + (rowH - 1 - k), o = (y * W + px) * 3;
        rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
      }
    }
  });
  writePng(file, W, H, rgb);
}

/* ───────────────────────── WAV ───────────────────────── */

function writeWav(file, chans, sr) {
  const n = chans[0].length, ch = chans.length, data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767))), (i * ch + c) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/* ───────────────────────── browser side ───────────────────────── */

async function openBrowser(musicOverride) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  await context.route('http://egg.local/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>audio render</title>' });
    const override = musicOverride && url.pathname === '/js/music.mjs';
    const file = override ? path.resolve(musicOverride) : path.join(DOCS, decodeURIComponent(url.pathname));
    const allowed = override || file.startsWith(DOCS + path.sep);   // the page can only read docs/ (and the one --music file)
    if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ contentType: file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto('http://egg.local/');
  return { browser, page };
}

async function loadSongs(page, builtins) {
  return page.evaluate(async (builtinSongs) => {
    const { GameAudio, lintSong } = await import('/js/audio.mjs');
    let real = null, err = null;
    try { real = (await import('/js/music.mjs')).SONGS; } catch (e) { err = String(e && e.message || e); }
    window.__songs = { ...(real || {}) };
    for (const b of builtinSongs) window.__songs[b.id] = b;
    // a timing probe: one tom every 4th step (0.5 s apart; offset by 2 steps so none sits on the render's frame 0, where an
    // OfflineAudioContext has a ~0.7 ms start-up delay that live play never sees), 2 bars at 120 bpm = a 4 s loop, no swing
    window.__songs.__grid = { id: '__grid', bpm: 120, beatsPerBar: 4, stepsPerBeat: 4, bars: 2, swing: 0, layers: [{ name: 'toms', inst: 'kit', vol: 1, hits: [2, 6, 10, 14, 18, 22, 26, 30].map((s) => [s, 't', 1]) }] };
    window.__GameAudio = GameAudio;
    const info = {}, lint = {};
    for (const [id, s] of Object.entries(window.__songs)) lint[id] = lintSong(s);
    for (const [id, s] of Object.entries(window.__songs)) info[id] = { bpm: s.bpm, bars: s.bars, beatsPerBar: s.beatsPerBar || 4, stepsPerBeat: s.stepsPerBeat || 4, layers: (s.layers || []).length, title: s.title };
    return { real: real ? Object.keys(real) : [], err: real ? null : err, info, lint };
  }, builtins);
}

/** Render in the page, then pull the channels back as Float32Arrays (16-bit transfer; float peaks are measured in the page). */
async function render(page, id, seconds, sr, opts = {}) {
  const meta = await page.evaluate(async ({ id, seconds, sr, opts }) => {
    const a = new window.__GameAudio({ songs: window.__songs });
    const t0 = performance.now();
    const buf = await a.renderOffline(id, seconds, sr, opts);
    const ms = performance.now() - t0;
    window.__buf = buf;
    const peaks = []; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); let p = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > p) p = v; } peaks.push(p); }
    return { channels: buf.numberOfChannels, length: buf.length, sr: buf.sampleRate, peaks, ms };
  }, { id, seconds, sr, opts });
  const chans = [];
  const CH = 1 << 20;
  for (let c = 0; c < meta.channels; c++) {
    const out = new Float32Array(meta.length);
    for (let a = 0; a < meta.length; a += CH) {
      const b64 = await page.evaluate(([c, a, b]) => {
        const d = window.__buf.getChannelData(c).subarray(a, b), i16 = new Int16Array(d.length);
        for (let i = 0; i < d.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(d[i] * 32767)));
        const u8 = new Uint8Array(i16.buffer); let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s);
      }, [c, a, Math.min(meta.length, a + CH)]);
      const raw = Buffer.from(b64, 'base64'), i16 = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
      for (let i = 0; i < i16.length; i++) out[a + i] = i16[i] / 32767;
    }
    chans.push(out);
  }
  return { ...meta, chans };
}

/* ───────────────────────── the report ───────────────────────── */

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const pct = (v) => (100 * v).toFixed(1) + '%';
const pad = (s, n) => String(s).padEnd(n);
const KEY = ['egg', 'goldHatch', 'ducklingLost', 'checkpoint', 'beacon'];
const ALL_SFX = ['egg', 'goldHatch', 'ducklingLost', 'checkpoint', 'beacon', 'jump', 'land', 'stomp', 'spring', 'hit', 'shield', 'shieldBreak', 'magnet', 'crumble', 'fall', 'dead', 'chapter', 'ui', 'uiBack', 'steer'];

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
  const flag = (name) => args.includes('--' + name);
  const OUT = path.resolve(opt('out', '/tmp/claude-0/-home-user-egg-mama/460f0417-2324-5334-b7b8-78b401e3c05a/scratchpad/audio'));
  const SR = +opt('sr', 32000), SFX_SR = 44100;
  const only = opt('songs', '') ? opt('songs', '').split(',') : null;
  fs.mkdirSync(OUT, { recursive: true });

  const builtin = builtinSong();
  const { browser, page } = await openBrowser(opt('music', ''));
  const checks = [], warns = [], report = { songs: {}, sfx: {}, comparison: {} };
  const check = (ok, msg) => { checks.push({ ok, msg }); if (!ok) console.log('  FAIL ' + msg); };
  const warn = (ok, msg) => { if (!ok) { warns.push(msg); console.log('  WARN ' + msg); } };
  try {
    const { real, err, info, lint } = await loadSongs(page, [builtin, stressSong()]);
    console.log(real.length ? `music.mjs found: ${real.length} songs (${real.join(', ')})` : `music.mjs not present (${err}): using the built-in test song only`);
    let ids = ['builtin', 'builtin-stress'];
    if (!flag('builtin-only')) ids = ids.concat(real);
    if (only) ids = ids.filter((id) => only.includes(id));

    /* ── timing: is the scheduler sample-accurate across loop seams and the 4 s scheduling chunks? ── */
    {
      const r = await render(page, '__grid', 4 * 3.5, 44100, {});
      const m = mono(r.chans[0], r.chans[1]), onsets = [];
      let last = -1e9;
      for (let i = 0; i < m.length; i++) if (Math.abs(m[i]) > 0.02 && i - last > 0.25 * 44100) { onsets.push(i); last = i; }
      let worst = 0; const base = onsets[0];
      onsets.forEach((o, i) => { worst = Math.max(worst, Math.abs((o - base) - i * 0.5 * 44100)); });
      console.log(`\n== TIMING ==\n  ${onsets.length} toms across 3 loop seams (4 s loop, 0.5 s apart): worst deviation from the ideal grid ${f2(worst / 44.1)} ms (${worst} samples at 44.1 kHz)`);
      report.timing = { hits: onsets.length, worstSamples: worst, worstMs: worst / 44.1 };
      // (a threshold crossing on a swept triangle jitters by a few samples; anything audible would be tens of samples)
      check(onsets.length >= 27 && worst <= 22, `loop seams and the 4 s scheduling chunks stay on the grid to within 0.5 ms (${onsets.length} hits, worst ${f2(worst / 44.1)} ms)`);
    }

    /* ── songs ── */
    console.log('\n== SONGS ==  (render rate ' + SR + ' Hz; seam render = loop + tail)');
    const loud = {};  // per song: the loudest 1-4 kHz moment
    for (const id of ids) {
      const s = info[id], stepsLoop = s.bars * s.beatsPerBar * s.stepsPerBeat, loopS = stepsLoop * 60 / s.bpm / s.stepsPerBeat;
      // short songs: render two full loops (literally "loop twice and compare"); long ones: the loop plus 10 s, enough to judge the seam
      const total = loopS <= 70 ? loopS * 2 : loopS + 10;
      const r = await render(page, id, total, SR);
      const [L, R] = r.chans, m = mono(L, R), n1 = Math.round(loopS * SR);
      const lr = { L: r.peaks[0], R: r.peaks[1] };
      const row = {
        loopS, renderedS: total, renderMs: Math.round(r.ms), peakL: lr.L, peakR: lr.R,
        peakDb: db(Math.max(lr.L, lr.R)), rmsDb: db(rms(m, 0, n1)), crestDb: db(Math.max(lr.L, lr.R)) - db(rms(m, 0, n1)),
        dcL: mean(L), dcR: mean(R), silence: silence(m, SR), bands: bandShares(m, SR), seam: seamMetrics(m, SR, loopS),
      };
      report.songs[id] = row;
      writeWav(path.join(OUT, `song-${id}.wav`), [L, R], r.sr);
      if (!flag('no-png')) writeSpectrogramPng(path.join(OUT, `spectrogram-song-${id}.png`), [m], r.sr, Math.min(m.length / r.sr, loopS), 8000, 1400);
      console.log(`\n[${id}] ${s.title || ''}  ${s.bpm} bpm  ${s.bars} bars  loop ${f1(loopS)} s  (rendered ${f1(total)} s in ${(r.ms / 1000).toFixed(1)} s)`);
      console.log(`  peak ${f1(row.peakDb)} dBFS (L ${f2(lr.L)} R ${f2(lr.R)})   rms ${f1(row.rmsDb)} dBFS   crest ${f1(row.crestDb)} dB   DC L ${row.dcL.toExponential(1)} R ${row.dcR.toExponential(1)}`);
      console.log(`  bands: ` + BANDS.map(([k]) => `${k} ${pct(row.bands[k])}`).join('  '));
      for (const msg of lint[id] || []) console.log('  LINT ' + msg);
      if (id.startsWith('builtin') && (lint[id] || []).length) warns.push(id + ': lint');
      console.log(`  silence ${pct(row.silence.fraction)} (longest ${f1(row.silence.longestRunS)} s, leading ${f1(row.silence.leadingS)} s)`);
      console.log(`  seam: click x${f2(row.seam.clickRatio)}  level step ${f1(row.seam.levelStepDb)} dB  repeat diff ${f1(row.seam.repeatDiffDb)} dB (control ${f1(row.seam.controlDiffDb)} dB over ${f1(row.seam.spanS)} s)`);
      check(lr.L < 0.98 && lr.R < 0.98, `${id}: peak < 0.98 (L ${f2(lr.L)}, R ${f2(lr.R)})`);
      check(Math.abs(row.dcL) < 0.002 && Math.abs(row.dcR) < 0.002, `${id}: DC offset < 0.002`);
      check(row.silence.fraction < 0.05 && row.silence.leadingS < 1.0, `${id}: no unintended silence`);
      check(row.seam.clickRatio < 2.5, `${id}: no click at the loop seam (x${f2(row.seam.clickRatio)} of the 99.9th percentile step)`);
      // a wrong wrap (the loop restarting off the grid, a missing bar) makes the 2nd pass as unlike the 1st as two unrelated
      // stretches; tails of a busy ending over a sparse opening are musical and only worth a warning
      check(row.seam.repeatDiffDb < Math.max(3, row.seam.controlDiffDb * 0.85), `${id}: the loop's second pass sounds like the first (${f1(row.seam.repeatDiffDb)} dB vs ${f1(row.seam.controlDiffDb)} dB between unrelated sections)`);
      warn(row.seam.repeatDiffDb < Math.max(3, row.seam.controlDiffDb * 0.5), `${id}: the start of the loop sounds ${f1(row.seam.repeatDiffDb)} dB different on the 2nd pass (control ${f1(row.seam.controlDiffDb)}): long tails from the loop end overlap the opening`);
      warn(Math.abs(row.seam.levelStepDb) < 6, `${id}: level step across the seam is ${f1(row.seam.levelStepDb)} dB (loop end vs start)`);
      warn(id === 'builtin-stress' || (row.rmsDb > -26 && row.rmsDb < -12), `${id}: loop rms ${f1(row.rmsDb)} dBFS is outside the -26..-12 dBFS target (songs should sit at one loudness)`);
      warn(row.bands['<90'] < 0.06, `${id}: ${pct(row.bands['<90'])} of the energy is below 90 Hz (phone speakers cannot play it)`);
      // the loudest 1-4 kHz moment of the loop (0.1 s windows)
      const bs = bandSeries(m.subarray(0, n1), SR, 1000, 4000);
      let bi = 0; for (let i = 0; i < bs.v.length; i++) if (bs.v[i] > bs.v[bi]) bi = i;
      loud[id] = { t: bs.t[bi], bandDb: db(bs.v[bi]), loopS };
      console.log(`  loudest 1-4 kHz moment: t=${f1(bs.t[bi])} s at ${f1(db(bs.v[bi]))} dBFS (0.1 s band rms)`);
    }

    /* ── sfx ── */
    console.log('\n== SFX ==  (each rendered alone, ' + SFX_SR + ' Hz)');
    const sfxData = {};
    for (const name of ALL_SFX) {
      const dur = name === 'beacon' ? 4 : name === 'chapter' ? 3 : 2;
      const r = await render(page, 'none', dur, SFX_SR, { music: false, sfx: [[0.05, name, name === 'egg' ? { streak: 0 } : name === 'land' ? { hard: true } : {}]] });
      const x = r.chans[0], act = activeLength(x, SFX_SR), a = Math.round(act.startS * SFX_SR), b = Math.round(act.endS * SFX_SR);
      const sh = bandShares(x.subarray(Math.max(0, a - 256), Math.min(x.length, b + 256)), SFX_SR);
      const shape = cueShape(x, SFX_SR, act.startS);
      let cnum = 0, cden = 0; { const nn = 2048, re = new Float64Array(nn), im = new Float64Array(nn); for (let s = 0; s + nn <= x.length; s += 1024) { const ps = powerSpectrum(x, s, nn, re, im); for (let k = 1; k < ps.length; k++) { cnum += ps[k] * k * SFX_SR / nn; cden += ps[k]; } } }
      const row = { peak: r.peaks[0], peakDb: db(r.peaks[0]), rmsDb: db(rms(x, a, b)), dc: mean(x), lengthS: act.lengthS, startS: act.startS, share0_8_5k: sh['0.8-5k'], share1_4k: sh['1-4k'], centroidHz: cden ? cnum / cden : 0, ...shape };
      sfxData[name] = { x, row };
      report.sfx[name] = row;
      writeWav(path.join(OUT, `sfx-${name}.wav`), [x], SFX_SR);
      console.log(`  ${pad(name, 13)} peak ${pad(f1(row.peakDb), 6)} rms ${pad(f1(row.rmsDb), 6)} len ${pad(f2(row.lengthS), 5)} s  800-5k ${pad(pct(row.share0_8_5k), 6)} 1-4k ${pad(pct(row.share1_4k), 6)} centroid ${pad(Math.round(row.centroidHz), 5)} Hz  pitch ${pad(f1(row.slopeStPerS), 6)} st/s  onsets ${row.onsets}  attack ${pad(f2(row.attackS * 1000), 5)} ms  DC ${row.dc.toExponential(0)}`);
      check(row.peak < 0.98, `sfx ${name}: peak < 0.98 (${f2(row.peak)})`);
      check(Math.abs(row.dc) < 0.002, `sfx ${name}: DC < 0.002`);
      check(row.lengthS > 0.03, `sfx ${name}: audible`);
    }
    for (const k of KEY) check(report.sfx[k].share0_8_5k > 0.6, `key cue ${k} keeps > 60% of its energy in 800 Hz-5 kHz (phone speakers): ${pct(report.sfx[k].share0_8_5k)}`);
    check(report.sfx.goldHatch.lengthS > 0.75 && report.sfx.goldHatch.lengthS < 1.15, `goldHatch is about 0.9 s (${f2(report.sfx.goldHatch.lengthS)} s)`);
    check(report.sfx.beacon.lengthS > 2.1 && report.sfx.beacon.lengthS < 3.0, `beacon is about 2.5 s (${f2(report.sfx.beacon.lengthS)} s)`);
    check(report.sfx.egg.lengthS < 0.2, `an ordinary egg blip is short (${f2(report.sfx.egg.lengthS)} s)`);
    warn(report.sfx.ducklingLost.slopeStPerS < -2, 'ducklingLost pitch contour descends');
    warn(report.sfx.goldHatch.slopeStPerS > 2 && report.sfx.beacon.slopeStPerS > 2, 'goldHatch and beacon pitch contours rise');

    // how different are the five key cues? Compare their spectrograms (24 log bands, 300 Hz-6 kHz, 20 ms frames, dB below each
    // cue's own peak, floored at -50 dB) over the frames where either cue is sounding: 1.0 = the same picture, 0 = unrelated.
    console.log('\n  key cues, spectrogram correlation (lower = more distinct):');
    const sg = KEY.map((k) => cueSpectrogram(sfxData[k].x, SFX_SR));
    const corr = (a, b) => {
      const frames = Math.max(a.active, b.active) + 4; let ma = 0, mb = 0, n = 0;
      const A = [], B = [];
      for (let i = 0; i < frames; i++) for (let j = 0; j < a.bands; j++) { A.push((a.rows[i] || a.empty)[j]); B.push((b.rows[i] || b.empty)[j]); }
      n = A.length; for (let i = 0; i < n; i++) { ma += A[i]; mb += B[i]; } ma /= n; mb /= n;
      let num = 0, da = 0, dbb = 0; for (let i = 0; i < n; i++) { num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; dbb += (B[i] - mb) ** 2; }
      return num / Math.sqrt(da * dbb || 1);
    };
    let worst = -1, worstPair = '';
    console.log('  ' + pad('', 13) + KEY.map((k) => pad(k, 13)).join(''));
    for (let i = 0; i < KEY.length; i++) {
      console.log('  ' + pad(KEY[i], 13) + KEY.map((k, j) => pad(f2(corr(sg[i], sg[j])), 13)).join(''));
      for (let j = i + 1; j < KEY.length; j++) { const c = corr(sg[i], sg[j]); if (c > worst) { worst = c; worstPair = KEY[i] + '/' + KEY[j]; } }
    }
    report.sfxFingerprintMaxCorr = { corr: worst, pair: worstPair };
    check(worst < 0.6, `the five key cues are distinct: highest pairwise spectrogram correlation ${f2(worst)} (${worstPair})`);
    writeSpectrogramPng(path.join(OUT, 'spectrogram-key-cues.png'), KEY.map((k) => sfxData[k].x), SFX_SR, 2.8, 6000);
    writeSpectrogramPng(path.join(OUT, 'spectrogram-sfx-others.png'), ALL_SFX.filter((n) => !KEY.includes(n)).slice(0, 8).map((k) => sfxData[k].x), SFX_SR, 1.4, 6000);

    /* ── sfx against the loudest music ── */
    console.log('\n== SFX vs MUSIC: key cues placed at each song\'s loudest 1-4 kHz moment (stems: music after the duck / sfx before the master) ==');
    console.log('  margin = cue 1-4 kHz peak (0.1 s band rms) minus the music underneath it over the cue\'s length. "raw" = without ducking.');
    const BAND = [1000, 4000];
    for (const id of ids) {
      const at = Math.max(0.5, loud[id].t - 0.3), pre = 2.0;                     // cue starts 0.3 s before the loudest window so the peak is inside it
      const startAt = Math.max(0, at - pre), lead = at - startAt;
      const rows = {};
      for (const cue of ['goldHatch', 'beacon', 'checkpoint', 'ducklingLost', 'egg']) {
        const len = cue === 'beacon' ? 3.2 : 1.4, seconds = lead + len + 0.3;
        const wDry = await render(page, id, seconds, SR, { startAt, stems: true });                                 // music only (no cue, no duck)
        const wWet = await render(page, id, seconds, SR, { startAt, stems: true, sfx: [[lead, cue]] });            // with the cue
        const a = Math.round(lead * SR), b = Math.round((lead + len) * SR);
        const musicRaw = bandSeries(wDry.chans[2].subarray(a, b), SR, ...BAND), musicDuck = bandSeries(wWet.chans[2].subarray(a, b), SR, ...BAND);
        const cueBand = bandSeries(wWet.chans[4].subarray(a, b), SR, ...BAND);
        const maxOf = (s) => Math.max(...s.v);
        const cuePk = db(maxOf(cueBand)), rawPk = db(maxOf(musicRaw)), duckPk = db(maxOf(musicDuck));
        // transient cues (the egg blip is ~70 ms) are diluted by a 0.1 s window: also compare 30 ms windows over 0.8-5 kHz
        const sw = (st, lo, hi) => Math.max(...bandSeries(st.subarray(a, b), SR, lo, hi, 0.03, 0.01).v);
        const shortCue = db(sw(wWet.chans[4], 800, 5000)), shortRaw = db(sw(wDry.chans[2], 800, 5000)), shortDuck = db(sw(wWet.chans[2], 800, 5000));
        // the music underneath at the very moment the cue peaks
        const ci = cueBand.v.indexOf(maxOf(cueBand));
        const duckAtCue = db(musicDuck.v[ci]), rawAtCue = db(musicRaw.v[ci]);
        // how deep and how long the duck is (broadband music energy, ducked vs not)
        const mixPeak = Math.max(wWet.peaks[0], wWet.peaks[1]);
        rows[cue] = { shortMarginRawDb: shortCue - shortRaw, shortMarginDuckedDb: shortCue - shortDuck, cueBandPeakDb: cuePk, musicRawMaxDb: rawPk, musicDuckedMaxDb: duckPk, marginDuckedDb: cuePk - duckPk, marginRawDb: cuePk - rawPk, marginAtPeakDb: cuePk - duckAtCue, marginAtPeakRawDb: cuePk - rawAtCue, mixPeak };
        if (cue === 'goldHatch') {
          const wd = Math.round(0.05 * SR);
          const bb = (st, w0, w1) => db(rms(st, a + Math.round(w0 * SR), a + Math.round(w1 * SR)));
          rows[cue].duckDepthDb = bb(wWet.chans[2], 0.15, 0.7) - bb(wDry.chans[2], 0.15, 0.7);   // broadband music level change under the cue
          void wd;
        }
        if ((id === ids[0] || id === 'builtin-stress') && cue === 'goldHatch') writeWav(path.join(OUT, `mix-goldHatch-over-${id}.wav`), [wWet.chans[0], wWet.chans[1]], SR);
        check(mixPeak < 0.98, `${id}+${cue}: mix peak < 0.98 (${f2(mixPeak)})`);
      }
      report.comparison[id] = rows;
      console.log(`\n  [${id}] loudest music 1-4 kHz window at t=${f1(loud[id].t)} s: ${f1(loud[id].bandDb)} dBFS`);
      console.log('  ' + pad('cue', 13) + pad('cue peak', 10) + pad('music raw', 11) + pad('music duck', 11) + pad('margin duck', 12) + pad('margin raw', 11) + pad('at cue peak (duck/raw)', 25) + pad('30ms 0.8-5k (duck/raw)', 24) + 'mix peak');
      for (const [cue, v] of Object.entries(rows)) {
        console.log('  ' + pad(cue, 13) + pad(f1(v.cueBandPeakDb), 10) + pad(f1(v.musicRawMaxDb), 11) + pad(f1(v.musicDuckedMaxDb), 11) + pad('+' + f1(v.marginDuckedDb), 12) + pad('+' + f1(v.marginRawDb), 11) + pad('+' + f1(v.marginAtPeakDb) + ' / +' + f1(v.marginAtPeakRawDb), 25) + pad('+' + f1(v.shortMarginDuckedDb) + ' / +' + f1(v.shortMarginRawDb), 24) + f2(v.mixPeak) + (v.duckDepthDb !== undefined ? `   (broadband duck ${f1(v.duckDepthDb)} dB)` : ''));
      }
      check(rows.goldHatch.marginDuckedDb >= 6, `${id}: goldHatch peaks >= +6 dB over the loudest music in 1-4 kHz, with ducking (+${f1(rows.goldHatch.marginDuckedDb)} dB; +${f1(rows.goldHatch.marginRawDb)} dB without)`);
      check(rows.goldHatch.marginAtPeakDb >= 6, `${id}: goldHatch >= +6 dB over the music playing at the instant it peaks (+${f1(rows.goldHatch.marginAtPeakDb)} dB)`);
      // the ordinary egg does not duck the music, so against the deliberately brutal stress tune it is only reported
      if (id !== 'builtin-stress') check(rows.egg.shortMarginRawDb >= 4, `${id}: an ordinary egg blip is still clearly audible: +${f1(rows.egg.shortMarginRawDb)} dB over the loudest music in 0.8-5 kHz (30 ms windows)`);
      warn(rows.egg.shortMarginRawDb < 14, `${id}: the egg blip is ${f1(rows.egg.shortMarginRawDb)} dB over the music: loud enough to tire children over an hour`);
      check(rows.beacon.marginDuckedDb >= 6 && rows.checkpoint.marginDuckedDb >= 3 && rows.ducklingLost.marginDuckedDb >= 3, `${id}: beacon (>= +6) / checkpoint / ducklingLost (>= +3) stand out too, ducking included`);
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(report, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed, ${warns.length} warnings.  Files: ${OUT}`);
  for (const c of failed) console.log('  FAILED: ' + c.msg);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
