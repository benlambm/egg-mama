/*
 * Egg Mama — the audio engine (DESIGN.md §9). Web Audio only, every sound synthesised in code.
 *
 *   const audio = new GameAudio({ muted, songs });      // songs = SONGS from music.mjs (this file does NOT import it)
 *   audio.unlock();                                      // from a user gesture (pointerup / click / keydown)
 *   audio.playSong('meadow', { fade: 3.5 });             // crossfades from whatever is playing
 *   audio.handle(simEvent);  audio.sfx('ui');
 *   audio.suspend(); audio.resume();                     // paused / hidden / rotated away  (main decides when)
 *
 * ── SONG FORMAT (what music.mjs builds; compiled once per song object) ───────────────────────────────────
 *   { id, title, bpm, beatsPerBar: 4, stepsPerBeat: 4, bars, swing: 0..0.5, gain?: 1,
 *     layers: [{ name, inst, vol, pan, fx?: { delay?:{beats,feedback,mix}, vibrato?:{rate,depth,delaySteps},
 *                                              filter?:{type,freq,q} },
 *                play?: [[barFrom, barTo), …],           // bars where the layer is audible (end exclusive)
 *                notes?: [[step, midi, lenSteps, vel?], …],
 *                hits?:  [[step, 'k'|'s'|'h'|'o'|'t'|'c'|'r'|'sh'|'cl', vel?], …] }] }
 *   - A step is a 16th (stepsPerBeat per beat). The loop is bars*beatsPerBar*stepsPerBeat steps and is seamless:
 *     the scheduler works on an integer step counter (time = t0 + n*stepDur, never accumulated), so there is no
 *     drift in an hour-long session, and note tails simply ring over the seam.
 *   - swing delays every ODD 16th by swing*stepDur (0.33 = triplet shuffle, 0.5 = dotted/very heavy).
 *   - vel: 0..1 (a value > 1 is read as MIDI 0..127), default 0.8. vol is the layer level, ~0.2-1.
 *   - vibrato.depth is in cents (a value < 1 is read as a fraction of a semitone); delaySteps = onset delay.
 *   - song.gain (optional) trims a whole song so all songs sit at one loudness.
 *   - A note belongs to the bar it STARTS in for `play` purposes; its length may run past the bar line.
 *
 * ── LIFECYCLE (AUDIO-2) ──────────────────────────────────────────────────────────────────────────────────
 *   The context runs only while  unlocked && !muted && !suspended.  suspend()/mute stop the scheduler and
 *   suspend the AudioContext (currentTime freezes), so the song position is KEPT and resume()/unmute simply
 *   continues it. Exactly one scheduler timer exists at any time (token guarded). sfx() and playSong() are
 *   safe at any moment: before unlock, while muted, while suspended, after dispose. playSong remembers the
 *   requested song, so unlocking / unmuting / resuming starts it.
 *
 * ── WIRING IT UP (main.mjs) ──────────────────────────────────────────────────────────────────────────────
 *   const audio = new GameAudio({ muted: settings.muted, songs: SONGS });        // SONGS from music.mjs
 *   - unlock(): on EVERY pointerup / click / keydown (cheap and idempotent). iOS Safari unlocks audio from touchend / click-class gestures; touchstart / pointerdown may not count.
 *   - audio.playSong('title') on the title screen; the landscape song when 'chapter-enter' arrives (fade 3-4 s);
 *     'beacon' when the beacon lights; playSong(songFor(chapter, circuit), { fade: 0.4 }) after a retry / continue.
 *   - for (const e of drainEvents(game)) audio.handle(e);   (one 'gold' + 'hatch' pair sounds ONCE; 'respawn' is silent)
 *   - audio.sfx('ui') / ('uiBack') for menu buttons. Menus that pause the game are silent: suspend() stops the context.
 *   - suspend() on pause / rotate-away / blur / visibilitychange hidden / pagehide;  resume() when play continues.
 *   - setMuted(b) on the mute button / M key; persist the flag yourself. Muting suspends the context, un-muting resumes
 *     the song exactly where it was (same as pause).
 *   - songs are compiled on first use; a malformed song or a browser without Web Audio can never throw into the game.
 *   - lintSong(song) lists what compile would silently drop (use it in tests for music.mjs).
 *   - renderOffline(id, seconds, sampleRate, opts) renders through the same code (tools/audio-render.mjs measures it).
 *
 * ── MIX ──────────────────────────────────────────────────────────────────────────────────────────────────
 *   songBus -> musicBus -> high-pass 90 Hz -> DUCK -> mix        (music; the duck dips for four key sfx)
 *   sfxBus --------------------------------------> mix          (sfx bypass the duck)
 *   mix -> compressor -> soft clipper (< 0.97) -> mute gain -> destination
 */
import { SFX_NAMES, SFX_INFO, playSfx } from './sfx.mjs';

export { SFX_NAMES };
export const INSTRUMENTS = Object.freeze(['pulse12', 'pulse25', 'pulse50', 'tri', 'saw', 'sawLead', 'bell', 'marimba',
  'pluck', 'pad', 'bassTri', 'bassPulse', 'bassSaw', 'kit']);
export const KIT_HITS = Object.freeze(['k', 's', 'h', 'o', 't', 'c', 'r', 'sh', 'cl']);

// Purely sonic constants (not gameplay tuning).
const TICK_MS = 25;            // scheduler timer period
const LOOKAHEAD = 0.2;         // schedule this far ahead of AudioContext.currentTime (a little over the 150 ms norm: phones have jank)
const LATE = 0.05;             // a step more than this late is skipped rather than played in a burst
const RESYNC = 0.25;           // ...and a cursor this far behind jumps straight to "now"
const START_DELAY = 0.06;      // headroom before a new song's first step
const MUSIC_LEVEL = 0.5;       // music bus trim
const SFX_LEVEL = 1.0;         // sfx bus level: sfx sit above the music
const DUCK_ATTACK_TC = 0.012; // s, time constant of the dip
const DUCK_RELEASE_TC = 0.16;  // s, time constant of the swell back
const MAX_VOICES = 150;        // music notes are dropped (never the sfx) beyond this many live voices
const MAX_PLAYERS = 3;         // the song playing plus at most two fading out: a caller that keeps changing its mind must not pile up songs
const INAUDIBLE = 0.02;        // a song this quiet (-34 dB) is dropped on the spot instead of being faded
const MAX_SFX_VOICES = 220;
const NOT_RUNNING_SFX_CAP = 12;// while the context has not started yet, only queue this many voices
const RESUME_RETRY_TICKS = 40; // ~1 s: if we want sound but the context is not running (iOS 'interrupted'), ask again

const dbToGain = (db) => Math.pow(10, db / 20);
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const safe = (fn) => { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); return r; } catch (e) { return undefined; } };

/* ───────────────────────── voice bookkeeping ───────────────────────── */

/**
 * Every note / effect is a small group of nodes. We keep each group in a pooled record with the time it ends;
 * sweep() (run every scheduler tick) disconnects the nodes of finished records and recycles them, so the live
 * node count is bounded by the song's polyphony, not by how long the game has been running.
 */
class Voices {
  constructor() { this.live = []; this.pool = []; }
  begin() {
    const v = this.pool.pop() || { n: [], end: 0, lg: null };
    v.n.length = 0; v.end = 0; v.lg = null;
    this.live.push(v);
    return v;
  }
  sweep(now) {
    const live = this.live;
    let w = 0;
    for (let i = 0; i < live.length; i++) {
      const v = live[i];
      if (v.end > 0 && v.end < now - 0.02) this._free(v);
      else live[w++] = v;
    }
    live.length = w;
  }
  _free(v) {
    const n = v.n;
    for (let i = 0; i < n.length; i++) { try { n[i].disconnect(); } catch (e) { /* already gone */ } }
    n.length = 0; v.lg = null;
    this.pool.push(v);
  }
  freeAll() { for (const v of this.live) this._free(v); this.live.length = 0; }
  get count() { return this.live.length; }
}

/* ───────────────────────── the mixer (one per context) ───────────────────────── */

function makeNoise(ctx) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * 1.5));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x2545f491;                                    // xorshift: repeatable noise for offline renders
  for (let i = 0; i < len; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ((s >>> 0) / 2147483648) - 1; }
  return buf;
}

/** Zero-mean pulse wave with duty d: real/imag Fourier terms of a rectangular pulse. */
function pulseWave(ctx, duty, harmonics = 48) {
  const real = new Float32Array(harmonics + 1), imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    real[k] = Math.sin(2 * k * Math.PI * duty) / (k * Math.PI);
    imag[k] = (1 - Math.cos(2 * k * Math.PI * duty)) / (k * Math.PI);
  }
  return ctx.createPeriodicWave(real, imag);
}
/** A sine-harmonic recipe: amps[0] is the fundamental. */
function harmonicWave(ctx, amps) {
  const real = new Float32Array(amps.length + 1), imag = new Float32Array(amps.length + 1);
  for (let i = 0; i < amps.length; i++) imag[i + 1] = amps[i];
  return ctx.createPeriodicWave(real, imag);
}

function softClipCurve() {
  // y = A*tanh(x/A) over inputs in [-2, 2] (the shaper sits behind a 0.5 gain): unity near 0, never above A
  const A = 0.97, n = 2049, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = ((i / (n - 1)) * 2 - 1) * 2; c[i] = A * Math.tanh(x / A); }
  return c;
}

class Graph {
  constructor(ctx, { muted = false, stems = false } = {}) {
    this.ctx = ctx;
    this.voices = new Voices();
    this.cache = {};                                     // sfx PeriodicWaves
    this.noise = makeNoise(ctx);
    this._seed = 0x9e3779b9;

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = MUSIC_LEVEL;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 90; this.hp.Q.value = 0.707;
    this.duck = ctx.createGain(); this.duck.gain.value = 1;
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = SFX_LEVEL;
    this.mix = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 10; this.comp.ratio.value = 3;
    this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.pre = ctx.createGain(); this.pre.gain.value = 0.5;
    this.shaper = ctx.createWaveShaper(); this.shaper.curve = softClipCurve();
    try { this.shaper.oversample = '2x'; } catch (e) { /* optional */ }
    this.out = ctx.createGain(); this.out.gain.value = muted ? 0 : 1;   // the mute gain

    this.musicBus.connect(this.hp); this.hp.connect(this.duck); this.duck.connect(this.mix);
    this.sfxBus.connect(this.mix);
    this.mix.connect(this.comp); this.comp.connect(this.pre); this.pre.connect(this.shaper); this.shaper.connect(this.out);
    if (stems && ctx.createChannelMerger) {
      // test hook: 6 channels = [mix L,R | music after the duck L,R | sfx before the master L,R]
      const m = ctx.createChannelMerger(6);
      const tap = (node, ch) => { const s = ctx.createChannelSplitter(2); node.connect(s); s.connect(m, 0, ch); s.connect(m, 1, ch + 1); };
      tap(this.out, 0); tap(this.duck, 2); tap(this.sfxBus, 4);
      try { ctx.destination.channelInterpretation = 'discrete'; } catch (e) { /* ignore */ }
      m.connect(ctx.destination);
    } else this.out.connect(ctx.destination);

    this.waves = {
      p12: pulseWave(ctx, 0.125), p25: pulseWave(ctx, 0.25), p50: pulseWave(ctx, 0.5), p30: pulseWave(ctx, 0.30, 32),
      // bass voices carry strong upper harmonics: phone speakers cannot reproduce the fundamental
      bassTri: harmonicWave(ctx, [1, 0.35, 0.55, 0.20, 0.30, 0.10, 0.15, 0.06]),
    };
    this.duckModel = { v0: 1, tA: 0, target: 1, relT: 0 };
  }

  rnd() { this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0; return this._seed / 4294967296; }

  /** The sfx environment sfx.mjs expects. */
  sfxEnv() {
    return { ctx: this.ctx, out: this.sfxBus, noise: this.noise, cache: this.cache, voice: () => this.voices.begin(), rnd: () => this.rnd() };
  }

  _duckLevel(t) {
    const d = this.duckModel;
    if (t <= d.tA) return d.v0;
    if (t < d.relT) return d.target + (d.v0 - d.target) * Math.exp(-(t - d.tA) / DUCK_ATTACK_TC);
    const vR = d.target + (d.v0 - d.target) * Math.exp(-(d.relT - d.tA) / DUCK_ATTACK_TC);
    return 1 + (vR - 1) * Math.exp(-(t - d.relT) / DUCK_RELEASE_TC);
  }
  /** Dip the music by `db` from time t, hold for `seconds`, then let it swell back. Overlapping cues merge. */
  doDuck(t, db, seconds) {
    const p = this.duck.gain, d = this.duckModel;
    const cur = this._duckLevel(t);
    let target = dbToGain(-db), endT = t + seconds;
    if (t < d.relT) { target = Math.min(target, d.target); endT = Math.max(endT, d.relT); }
    p.cancelScheduledValues(t);
    p.setValueAtTime(cur, t);
    p.setTargetAtTime(target, t, DUCK_ATTACK_TC);
    p.setTargetAtTime(1, endT, DUCK_RELEASE_TC);
    this.duckModel = { v0: cur, tA: t, target, relT: endT };
  }
}

/* ───────────────────────── songs: compile once ───────────────────────── */

const compiled = new WeakMap();

function normVel(v) { return v === undefined || v === null || !(v >= 0) ? 0.8 : clamp(v > 1 ? v / 127 : v, 0, 1); }

/** Turn the song object into a per-step event table (so the scheduler does no parsing and no allocation). */
function compileSong(song) {
  let c = compiled.get(song);
  if (c) return c;
  const bpm = clamp(+song.bpm || 120, 40, 260);
  const bpb = (song.beatsPerBar | 0) || 4, spb = (song.stepsPerBeat | 0) || 4;
  const bars = Math.max(1, song.bars | 0 || 1);
  const stepsPerBar = bpb * spb, loopSteps = bars * stepsPerBar;
  const stepDur = 60 / bpm / spb;
  const steps = new Array(loopSteps).fill(null);
  const layers = Array.isArray(song.layers) ? song.layers : [];
  const used = [];
  layers.forEach((def, li) => {
    const play = Array.isArray(def.play) && def.play.length ? def.play : null;
    const audible = (s) => {
      if (!play) return true;
      const bar = Math.floor(s / stepsPerBar);
      for (let i = 0; i < play.length; i++) if (bar >= play[i][0] && bar < play[i][1]) return true;
      return false;
    };
    let n = 0;
    const add = (s, ev) => { (steps[s] || (steps[s] = [])).push(ev); n++; };
    if (Array.isArray(def.notes)) for (const nt of def.notes) {
      const s = Math.floor(nt[0]), midi = +nt[1];
      if (!(s >= 0 && s < loopSteps) || !Number.isFinite(midi) || !audible(s)) continue;
      add(s, { li, hz: midiToHz(midi), len: Math.max(1, +nt[2] || 1) * stepDur, vel: normVel(nt[3]), hit: null });
    }
    if (Array.isArray(def.hits)) for (const h of def.hits) {
      const s = Math.floor(h[0]);
      if (!(s >= 0 && s < loopSteps) || KIT_HITS.indexOf(h[1]) < 0 || !audible(s)) continue;
      add(s, { li, hz: 0, len: 0, vel: normVel(h[2]), hit: h[1] });
    }
    used[li] = n > 0;
  });
  c = { song, bpm, stepDur, loopSteps, stepsPerBar, steps, layers, used, swing: clamp(+song.swing || 0, 0, 0.5),
    duration: loopSteps * stepDur, gain: song.gain > 0 ? +song.gain : 1 };
  compiled.set(song, c);
  return c;
}

/**
 * Check a song object against the format and the brief. Returns a list of human-readable problems (empty = clean).
 * compileSong() silently drops what it cannot use (that keeps the game running); this tells the author what was dropped.
 */
export function lintSong(song) {
  const out = [];
  if (!song || typeof song !== 'object') return ['song is not an object'];
  const id = song.id || '(no id)', bpm = +song.bpm, bpb = (song.beatsPerBar | 0) || 4, spb = (song.stepsPerBeat | 0) || 4;
  const bars = song.bars | 0, stepsPerBar = bpb * spb, loopSteps = bars * stepsPerBar;
  if (!song.id) out.push('missing id');
  if (!(bpm >= 60 && bpm <= 200)) out.push(`bpm ${song.bpm} is outside 60-200`);
  if (!(bars >= 1)) out.push(`bars ${song.bars} must be >= 1`);
  if (song.swing !== undefined && !(song.swing >= 0 && song.swing <= 0.5)) out.push(`swing ${song.swing} must be 0..0.5`);
  const dur = loopSteps * 60 / (bpm || 120) / spb;
  if (bars >= 1 && bpm > 0) {
    if (song.id === 'title' ? (dur < 30 || dur > 90) : (dur < 100 && song.id !== 'beacon')) out.push(`loop is ${dur.toFixed(1)} s: ${song.id === 'title' ? 'the title song should be about 40-60 s' : 'chapter songs should be 100-170 s'}`);
  }
  if (!Array.isArray(song.layers) || !song.layers.length) { out.push('no layers'); return out.map((m) => `${id}: ${m}`); }
  song.layers.forEach((l, i) => {
    const nm = `layer ${i} '${l && l.name}'`;
    if (!l) { out.push(`${nm} is empty`); return; }
    if (INSTRUMENTS.indexOf(l.inst) < 0) out.push(`${nm}: unknown instrument '${l.inst}'`);
    if (l.vol !== undefined && !(l.vol >= 0 && l.vol <= 1.5)) out.push(`${nm}: vol ${l.vol} is outside 0-1.5`);
    if (l.pan !== undefined && !(l.pan >= -1 && l.pan <= 1)) out.push(`${nm}: pan ${l.pan} is outside -1..1`);
    const kit = l.inst === 'kit';
    if (kit && l.notes && l.notes.length) out.push(`${nm}: the kit plays 'hits', its 'notes' are ignored`);
    if (!kit && l.hits && l.hits.length) out.push(`${nm}: only the kit plays 'hits', they are ignored on ${l.inst}`);
    if (Array.isArray(l.play)) for (const r of l.play) if (!Array.isArray(r) || !(r[0] >= 0 && r[1] > r[0] && r[1] <= bars)) out.push(`${nm}: play range ${JSON.stringify(r)} is outside 0..${bars} bars`);
    let beyond = 0, bad = 0, audible = 0;
    const ranges = Array.isArray(l.play) && l.play.length ? l.play : null;
    const inPlay = (s) => !ranges || ranges.some((r) => Math.floor(s / stepsPerBar) >= r[0] && Math.floor(s / stepsPerBar) < r[1]);
    for (const n of (kit ? l.hits : l.notes) || []) {
      const s = Math.floor(n[0]);
      if (!(s >= 0 && s < loopSteps)) { beyond++; continue; }
      if (kit ? KIT_HITS.indexOf(n[1]) < 0 : !(Number.isFinite(+n[1]) && n[1] >= 12 && n[1] <= 120)) { bad++; continue; }
      if (!kit && !(n[2] >= 1)) bad++;
      if (inPlay(s)) audible++;
    }
    if (beyond) out.push(`${nm}: ${beyond} ${kit ? 'hits' : 'notes'} start at or after the loop end (step ${loopSteps}) and are dropped`);
    if (bad) out.push(`${nm}: ${bad} malformed ${kit ? 'hits' : 'notes'}`);
    if (!audible) out.push(`${nm} never sounds (no events inside its play ranges)`);
  });
  return out.map((m) => `${id}: ${m}`);
}

/* ───────────────────────── instruments ───────────────────────── */

/**
 * Per-instrument layer defaults. `filter` is a fixed low-pass that tames fizz (replaced by fx.filter if the song
 * asks for one); the bass voices carry their harmonics in the oscillator itself.
 */
const INST = {
  pulse12:   { filter: { type: 'lowpass', freq: 6000, q: 0.5 } },
  pulse25:   { filter: { type: 'lowpass', freq: 6000, q: 0.5 } },
  pulse50:   { filter: { type: 'lowpass', freq: 6000, q: 0.5 } },
  tri:       {},
  saw:       { filter: { type: 'lowpass', freq: 4200, q: 0.5 } },
  sawLead:   { filter: { type: 'lowpass', freq: 5200, q: 0.7 } },
  bell:      {},
  marimba:   {},
  pluck:     {},
  pad:       { filter: { type: 'lowpass', freq: 1500, q: 0.6 }, slowSweep: true },
  bassTri:   {},
  bassPulse: { filter: { type: 'lowpass', freq: 2400, q: 0.6 } },
  bassSaw:   { filter: { type: 'lowpass', freq: 1800, q: 1.0 } },
  kit:       { kit: true },
};

/** gain envelope for a held note: attack, decay toward sustain, release from `off`. Returns the stop time. */
function adsr(p, t, off, peak, a, dtc, sus, rtc) {
  off = Math.max(off, t + a + 0.004);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (sus < 1) p.setTargetAtTime(peak * sus, t + a, dtc);
  p.setTargetAtTime(0, off, rtc);
  return off + rtc * 7;
}
/** gain envelope for a struck sound that rings by itself. Returns the stop time. */
function strike(p, t, peak, a, tc, len) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(0, t + a, tc);
  return t + a + (len || tc * 7);
}

function mkOsc(g, L, v, wave, f, t, stop, dur, cents) {
  const ctx = g.ctx, o = ctx.createOscillator();
  if (typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
  o.frequency.value = f;
  if (cents) o.detune.value = cents;
  const vb = L.vib;
  if (vb && dur >= vb.delay + 0.1) {                       // vibrato only on notes long enough to use it
    if (!v.lg) {
      const l = ctx.createOscillator(), lg = ctx.createGain();
      l.frequency.value = vb.rate;
      lg.gain.setValueAtTime(0, t); lg.gain.setValueAtTime(0, t + vb.delay);
      lg.gain.linearRampToValueAtTime(vb.depth, t + vb.delay + 0.25);
      l.connect(lg); l.start(t); l.stop(stop);
      v.n.push(l, lg); v.lg = lg;
    }
    v.lg.connect(o.detune);
  }
  o.start(t); o.stop(stop);
  v.n.push(o);
  return o;
}

function heldVoice(g, L, v, t, dur, f, peak, wave, a, dtc, sus, rtc, detunes) {
  const gn = g.ctx.createGain(), stop = adsr(gn.gain, t, t + dur, peak, a, dtc, sus, rtc);
  for (let i = 0; i < detunes.length; i++) mkOsc(g, L, v, wave, f, t, stop, dur, detunes[i]).connect(gn);
  gn.connect(L.in); v.n.push(gn); v.end = stop;
}

const NOTE = {
  pulse12: (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.20 * k, g.waves.p12, 0.004, 0.09, 0.6, 0.04, [0]),
  pulse25: (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.22 * k, g.waves.p25, 0.004, 0.09, 0.6, 0.04, [0]),
  pulse50: (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.22 * k, g.waves.p50, 0.004, 0.09, 0.6, 0.04, [0]),
  tri:     (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.38 * k, 'triangle', 0.006, 0.20, 0.85, 0.05, [0]),
  saw:     (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.13 * k, 'sawtooth', 0.01, 0.15, 0.7, 0.08, [-7, 7]),
  sawLead: (g, L, v, t, d, f, k) => {
    const gn = g.ctx.createGain(), stop = adsr(gn.gain, t, t + d, 0.19 * k, 0.006, 0.12, 0.75, 0.06);
    mkOsc(g, L, v, 'sawtooth', f, t, stop, d, 0).connect(gn);
    const pg = g.ctx.createGain(); pg.gain.value = 0.55;
    mkOsc(g, L, v, g.waves.p25, f, t, stop, d, 5).connect(pg); pg.connect(gn);
    gn.connect(L.in); v.n.push(gn, pg); v.end = stop;
  },
  bell: (g, L, v, t, d, f, k) => {
    // two-operator FM with an inharmonic ratio: bright strike that mellows as the modulation index decays
    const ctx = g.ctx, tc = 0.28 + Math.min(d, 1.5) * 0.25, stop = t + 0.003 + tc * 7;
    const gn = ctx.createGain(); strike(gn.gain, t, 0.36 * k, 0.003, tc, stop - t - 0.003);
    const car = mkOsc(g, L, v, 'sine', f, t, stop, d, 0), mod = ctx.createOscillator(), mg = ctx.createGain();
    mod.frequency.value = f * 3.5;
    mg.gain.setValueAtTime(f * 2.4, t); mg.gain.exponentialRampToValueAtTime(f * 0.06, t + 0.9);
    mod.connect(mg); mg.connect(car.frequency); mod.start(t); mod.stop(stop);
    car.connect(gn); gn.connect(L.in); v.n.push(mod, mg, gn); v.end = stop;
  },
  marimba: (g, L, v, t, d, f, k) => {
    const ctx = g.ctx, tc = 0.16 + Math.min(d, 1) * 0.12, stop = t + 0.003 + tc * 7;
    const g1 = ctx.createGain(), g2 = ctx.createGain();
    strike(g1.gain, t, 0.45 * k, 0.003, tc, stop - t - 0.003);
    strike(g2.gain, t, 0.13 * k, 0.002, 0.045, 0.34);
    mkOsc(g, L, v, 'sine', f, t, stop, d, 0).connect(g1);
    mkOsc(g, L, v, 'sine', f * 4, t, t + 0.35, d, 0).connect(g2);
    g1.connect(L.in); g2.connect(L.in); v.n.push(g1, g2); v.end = stop;
  },
  pluck: (g, L, v, t, d, f, k) => {
    // a saw through a closing low-pass: the string-ish "pwip"
    const ctx = g.ctx, gn = ctx.createGain(), fl = ctx.createBiquadFilter(), stop = t + 0.003 + 0.18 * 7;
    fl.type = 'lowpass'; fl.Q.value = 1.5;
    fl.frequency.setValueAtTime(Math.min(7000, f * 8 + 800), t); fl.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.5), t + 0.22);
    strike(gn.gain, t, 0.42 * k, 0.003, 0.18, stop - t - 0.003);
    mkOsc(g, L, v, 'sawtooth', f, t, stop, d, 0).connect(fl); fl.connect(gn); gn.connect(L.in);
    v.n.push(fl, gn); v.end = stop;
  },
  pad: (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.085 * k, 'sawtooth', Math.min(0.35, d * 0.4), 0.3, 1, 0.18, [-11, 0, 11]),
  bassTri:   (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.50 * k, g.waves.bassTri, 0.004, 0.12, 0.7, 0.05, [0]),
  bassPulse: (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.32 * k, g.waves.p30, 0.004, 0.12, 0.65, 0.05, [0]),
  bassSaw:   (g, L, v, t, d, f, k) => heldVoice(g, L, v, t, d, f, 0.28 * k, 'sawtooth', 0.004, 0.14, 0.65, 0.05, [0]),
};

/** One-shot noise through a shared kit filter. */
function noiseHit(g, L, v, t, filt, peak, a, len) {
  const ctx = g.ctx, src = ctx.createBufferSource(), gn = ctx.createGain();
  src.buffer = g.noise; src.loop = true;
  gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(peak, t + a); gn.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(gn); gn.connect(filt);
  src.start(t, g.rnd() * (g.noise.duration - 0.2)); src.stop(t + len + 0.02);
  v.n.push(src, gn); v.end = Math.max(v.end, t + len + 0.03);
  return gn;
}
function drumTone(g, L, v, t, type, f0, f1, sweep, peak, len) {
  const ctx = g.ctx, o = ctx.createOscillator(), gn = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(peak, t + 0.003); gn.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(gn); gn.connect(L.in);
  o.start(t); o.stop(t + len + 0.02);
  v.n.push(o, gn); v.end = Math.max(v.end, t + len + 0.03);
}

const HIT = {
  k:  (g, L, v, t, k) => { drumTone(g, L, v, t, 'triangle', 200, 52, 0.12, 0.95 * k, 0.26); noiseHit(g, L, v, t, L.kit.bp2, 0.22 * k, 0.001, 0.012); },
  s:  (g, L, v, t, k) => { noiseHit(g, L, v, t, L.kit.bp2, 0.50 * k, 0.002, 0.17); drumTone(g, L, v, t, 'triangle', 210, 150, 0.07, 0.34 * k, 0.12); },
  h:  (g, L, v, t, k) => { noiseHit(g, L, v, t, L.kit.hp7, 0.22 * k, 0.002, 0.045); },
  o:  (g, L, v, t, k) => { noiseHit(g, L, v, t, L.kit.hp7, 0.19 * k, 0.003, 0.26); },
  t:  (g, L, v, t, k) => { drumTone(g, L, v, t, 'triangle', 175, 95, 0.18, 0.60 * k, 0.30); },
  c:  (g, L, v, t, k) => { noiseHit(g, L, v, t, L.kit.hp7, 0.28 * k, 0.003, 1.3); },
  r:  (g, L, v, t, k) => { drumTone(g, L, v, t, 'triangle', 880, 880, 0, 0.45 * k, 0.05); noiseHit(g, L, v, t, L.kit.bp2, 0.18 * k, 0.001, 0.02); },
  sh: (g, L, v, t, k) => { noiseHit(g, L, v, t, L.kit.bp6, 0.17 * k, 0.012, 0.07); },
  cl: (g, L, v, t, k) => {
    const gn = noiseHit(g, L, v, t, L.kit.bp1, 0.5 * k, 0.002, 0.20), p = gn.gain;
    // three quick re-attacks, then the tail: the hand-clap flutter. (Automation is re-written from scratch.)
    p.cancelScheduledValues(t);
    p.setValueAtTime(0, t); p.linearRampToValueAtTime(0.5 * k, t + 0.002);
    p.setValueAtTime(0.12 * k, t + 0.012); p.linearRampToValueAtTime(0.5 * k, t + 0.014);
    p.setValueAtTime(0.12 * k, t + 0.026); p.linearRampToValueAtTime(0.5 * k, t + 0.028);
    p.exponentialRampToValueAtTime(0.0001, t + 0.20);
  },
};

/* ───────────────────────── a song playing ───────────────────────── */

function biquad(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f;
}

class SongPlayer {
  /** startTime: when step `startStep` sounds. The player's gain starts at 0 (caller fades it in). */
  constructor(g, c, id, startTime, startStep = 0) {
    this.g = g; this.c = c; this.id = id;
    this.ctx = g.ctx;
    this.t0 = startTime - startStep * c.stepDur;      // when (virtual) step 0 sounded; every step time derives from it
    this.next = startStep;                             // next integer step to schedule (grows without bound; wrapped by %)
    this.out = false; this.endTime = Infinity;         // set when this player is fading out
    this.nodes = []; this.sources = [];
    this.bus = this.ctx.createGain(); this.bus.gain.value = 0;   // fade stage 0: the layers feed it
    this.bus.connect(g.musicBus); this.nodes.push(this.bus);
    this.stages = [{ node: this.bus, fade: null, level: 0, end: 0 }];
    this.layers = c.layers.map((def, li) => (c.used[li] ? this._buildLayer(def, c) : null));
  }

  _buildLayer(def, c) {
    const ctx = this.ctx, spec = INST[def.inst] || INST.tri, nodes = this.nodes;
    const fx = def.fx || {};
    const L = { inst: INST[def.inst] ? def.inst : 'tri', in: null, vib: null, kit: null };
    const input = ctx.createGain();
    input.gain.value = clamp(def.vol === undefined ? 0.6 : +def.vol, 0, 2) * c.gain;
    nodes.push(input); L.in = input;
    let tail = input;
    if (spec.kit) {
      // shared filters for the noise drums; they feed the layer input (so vol / pan / fx apply to the whole kit)
      L.kit = { hp7: biquad(ctx, 'highpass', 7000, 0.7), bp2: biquad(ctx, 'bandpass', 2200, 0.8),
        bp1: biquad(ctx, 'bandpass', 1300, 0.9), bp6: biquad(ctx, 'bandpass', 6200, 1.2) };
      for (const k of Object.keys(L.kit)) { L.kit[k].connect(input); nodes.push(L.kit[k]); }
    }
    const fl = fx.filter || spec.filter;
    if (fl && (fl.freq > 0)) {
      const type = fl.type === 'highpass' || fl.type === 'bandpass' ? fl.type : 'lowpass';
      const bq = biquad(ctx, type, fl.freq, fl.q === undefined ? 0.7 : fl.q);
      tail.connect(bq); tail = bq; nodes.push(bq);
      if (spec.slowSweep && !fx.filter) {                  // the pad's slow breathing low-pass
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 0.13; lg.gain.value = fl.freq * 0.3;
        lfo.connect(lg); lg.connect(bq.frequency); lfo.start(); nodes.push(lfo, lg); this.sources.push(lfo);
      }
    }
    if (def.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = clamp(+def.pan, -1, 1);
      tail.connect(p); tail = p; nodes.push(p);
    }
    tail.connect(this.bus);
    const dl = fx.delay;
    if (dl && dl.mix > 0) {
      const d = ctx.createDelay(4), fb = ctx.createGain(), lp = biquad(ctx, 'lowpass', 3200, 0.5), wet = ctx.createGain();
      d.delayTime.value = clamp((+dl.beats || 0.75) * 60 / c.bpm, 0.02, 3.9);
      fb.gain.value = clamp(+dl.feedback || 0, 0, 0.85); wet.gain.value = clamp(+dl.mix, 0, 1);
      tail.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); d.connect(wet); wet.connect(this.bus);
      nodes.push(d, fb, lp, wet);
    }
    const vb = fx.vibrato;
    if (vb && vb.depth > 0) {
      const depth = vb.depth < 1 ? vb.depth * 100 : vb.depth;
      L.vib = { rate: clamp(+vb.rate || 5.5, 0.5, 12), depth: clamp(depth, 0, 80), delay: Math.max(0, (+vb.delaySteps || 0) * c.stepDur) };
    }
    return L;
  }

  /**
   * Equal-power fade of this song to `to`, starting at time t, as a piecewise-linear ramp so its level stays exactly
   * computable (levelAt). Live automation is never rewritten (cancelScheduledValues on a running ramp behaves
   * differently across browsers and can click): a fade that starts while the previous one is still running goes
   * into a NEW gain stage in series, so the level is always the continuous product of the stages.
   */
  fadeTo(t, dur, to) {
    let st = this.stages[this.stages.length - 1];
    if (st.end > t + 1e-9) {
      const node = this.ctx.createGain();
      st.node.disconnect(); st.node.connect(node); node.connect(this.g.musicBus);
      this.nodes.push(node);
      st = { node, fade: null, level: 1, end: 0 };
      this.stages.push(st);
    }
    const from = stageLevel(st, t), p = st.node.gain;
    if (!(dur > 0.03)) { p.setValueAtTime(to, t); st.level = to; st.fade = null; st.end = t; return; }
    p.setValueAtTime(from, t);
    for (let i = 1; i <= FADE_STEPS; i++) p.linearRampToValueAtTime(fadeShape(from, to, i / FADE_STEPS), t + dur * i / FADE_STEPS);
    st.fade = { t0: t, dur, from, to }; st.end = t + dur;
  }
  /** Current output level of this song (what the stages multiply to) at time t. */
  levelAt(t) {
    let lv = 1;
    for (let i = 0; i < this.stages.length; i++) lv *= stageLevel(this.stages[i], t);
    return lv;
  }
  fadeOut(now, dur) {
    if (this.out) return;
    this.out = true;
    this.fadeTo(now, dur, 0);
    this.endTime = now + Math.max(dur, 0.03);
  }
  /** Cut a song that is already leaving short (too many songs at once): a quick fade in series with whatever it is doing. */
  hurry(t, dur) {
    if (this.out && this.endTime <= t + dur) return;
    this.out = true;
    this.fadeTo(t, dur, 0);
    this.endTime = Math.min(this.endTime, t + Math.max(dur, 0.03));
  }

  /** Create the voices for every step whose time is <= `until`. `now` = ctx.currentTime. */
  schedule(until, now) {
    const c = this.c, sd = c.stepDur, g = this.g;
    let n = this.next;
    if (now - (this.t0 + n * sd) > RESYNC) n = Math.max(n, Math.ceil((now - this.t0) / sd));   // fell far behind: skip, don't burst
    for (;;) {
      const base = this.t0 + n * sd;
      if (base > until || base >= this.endTime) break;
      const s = n % c.loopSteps, evs = c.steps[s];
      if (evs !== null) {
        const time = base + ((s & 1) ? c.swing * sd : 0);
        if (time >= now - LATE) for (let i = 0; i < evs.length; i++) this._fire(evs[i], time);
      }
      n++;
    }
    this.next = n;
  }

  _fire(ev, t) {
    const g = this.g, L = this.layers[ev.li];
    if (!L || g.voices.count >= MAX_VOICES) return;
    if (ev.hit ? !L.kit : !NOTE[L.inst]) return;            // drum hits on a pitched layer / notes on the kit: ignore
    const v = g.voices.begin();
    try {
      if (ev.hit) HIT[ev.hit](g, L, v, t, ev.vel);
      else NOTE[L.inst](g, L, v, t, ev.len, ev.hz, ev.vel);
    } catch (e) { v.end = Math.max(v.end, t); }
    if (v.end === 0) v.end = t + 0.05;
  }

  dispose() {
    for (const s of this.sources) safe(() => s.stop());
    for (const n of this.nodes) safe(() => n.disconnect());
    this.nodes.length = 0; this.sources.length = 0; this.layers = [];
  }
}

const FADE_STEPS = 12;
function stageLevel(st, t) {
  const f = st.fade;
  if (!f) return st.level;
  const x = clamp((t - f.t0) / f.dur, 0, 1) * FADE_STEPS, i = Math.min(FADE_STEPS - 1, Math.floor(x));
  const a = fadeShape(f.from, f.to, i / FADE_STEPS), b = fadeShape(f.from, f.to, (i + 1) / FADE_STEPS);
  return a + (b - a) * (x - i);
}
function fadeShape(from, to, x) {
  // equal-power: rising uses sin, falling uses cos, so an outgoing and incoming pair keep constant power
  return to >= from ? from + (to - from) * Math.sin(x * Math.PI / 2) : to + (from - to) * Math.cos(x * Math.PI / 2);
}

/* ───────────────────────── GameAudio ───────────────────────── */

export class GameAudio {
  /**
   * @param {object}  o
   * @param {boolean} o.muted   initial mute (the owner persists it)
   * @param {object}  o.songs   SONGS from music.mjs, { id: song }. Left out (DESIGN.md §9 shows `new GameAudio({ muted })`):
   *                            music.mjs is imported on first use instead, so either way of wiring it up works.
   * Test seams (all optional): AudioContextClass, OfflineAudioContextClass, timers {setInterval, clearInterval}, navigator,
   * document / window (where visibilitychange / pagehide are listened for).
   */
  constructor({ muted = false, songs, AudioContextClass, OfflineAudioContextClass, timers, navigator: nav, document: doc, window: win } = {}) {
    this._muted = !!muted;
    this._songs = songs && typeof songs === 'object' ? songs : null;   // null = not given: loaded from music.mjs on first use
    this._songsLoading = false;
    this._AC = AudioContextClass; this._OAC = OfflineAudioContextClass;
    this._timers = timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id) };
    this._nav = nav || (typeof navigator !== 'undefined' ? navigator : null);
    this._doc = doc || (typeof document !== 'undefined' ? document : null);
    this._win = win || (typeof window !== 'undefined' ? window : null);
    this._hidden = false;                    // the page is hidden / being unloaded: a backstop in case main forgets suspend()
    this._unwatch = null;
    this._ctx = null; this._g = null; this._env = null;
    this._ctxRunning = null;                 // what we last asked the context to do (null = never asked)
    this._suspended = false;                 // the app paused / hid us
    this._disposed = false;
    this._timer = null; this._token = 0;     // exactly one scheduler timer, token-guarded
    this._stuck = 0;                         // ticks spent with a context that is not running
    this._players = [];                      // SongPlayers: the newest is `_active`, older ones are fading out
    this._active = null;
    this._songId = null; this._songFade = 0.4;
    this._streak = 0; this._eggT = -1e9; this._goldT = -1e9;
    this._last = Object.create(null);        // per-cue time of the last play (rate limit)
  }

  get muted() { return this._muted; }
  /** For tests / debugging: live voices, players, whether a scheduler timer exists. */
  get stats() { return { voices: this._g ? this._g.voices.count : 0, players: this._players.length, scheduler: this._timer !== null, running: this._wantRun }; }
  get _wantRun() { return !this._muted && !this._suspended && !this._hidden && !this._disposed; }

  /** Call from a user gesture (pointerup / click / keydown). Safe to call again and again. */
  unlock() {
    if (this._disposed) return;
    try { if (this._nav && this._nav.audioSession) this._nav.audioSession.type = 'playback'; } catch (e) { /* optional */ }
    if (!this._ctx) this._create();
    this._apply(true);
  }

  _create() {
    const AC = this._AC || (typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext));
    if (!AC) return;
    let ctx = null;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return; } }
    try { this._g = new Graph(ctx, { muted: this._muted }); } catch (e) { safe(() => ctx.close()); return; }   // no Web Audio worth having: stay silent
    this._ctx = ctx;
    this._env = this._g.sfxEnv();
    try {
      // the OS can suspend / interrupt a context behind our back (phone call, Siri, a tab switch on iOS): if we still
      // want sound, ask for it back. (If we suspended it ourselves, _wantRun is false and this does nothing.)
      ctx.addEventListener('statechange', () => {
        if (this._ctx !== ctx) return;
        if (this._wantRun) { if (ctx.state !== 'running' && ctx.state !== 'closed') safe(() => ctx.resume()); }
        else if (ctx.state === 'running') safe(() => ctx.suspend());     // the OS gave it back (iOS ends an interruption) while we are paused / muted: stay stopped, don't burn the battery
      });
    } catch (e) { /* optional */ }
    this._watchPage();
    try {
      // iOS: a silent one-sample buffer played inside the gesture finishes the unlock on older WebKit
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch (e) { /* ignore */ }
  }

  /**
   * Backstop for AUDIO-2 ("background the game and the music stops"): a hidden page or a pagehide stops the sound even if
   * main forgets to call suspend(). It is a separate flag, so it never un-pauses a game that main has suspended itself:
   * coming back only clears this flag, and the song continues once main also calls resume().
   */
  _watchPage() {
    const doc = this._doc, win = this._win;
    if (this._unwatch || (!doc && !win)) return;
    const sync = () => { this._hidden = !!doc && doc.visibilityState === 'hidden'; this._apply(false); };
    const hide = () => { this._hidden = true; this._apply(false); };
    try {
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', sync);
      if (win && win.addEventListener) { win.addEventListener('pagehide', hide); win.addEventListener('pageshow', sync); }
      this._unwatch = () => {
        try { if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', sync); } catch (e) { /* gone */ }
        try { if (win && win.removeEventListener) { win.removeEventListener('pagehide', hide); win.removeEventListener('pageshow', sync); } } catch (e) { /* gone */ }
      };
      this._hidden = !!doc && doc.visibilityState === 'hidden';
    } catch (e) { /* optional */ }
  }

  setMuted(b) {
    b = !!b;
    if (b === this._muted) return;
    this._muted = b;
    this._apply(false);
  }

  suspend() { if (this._disposed) return; this._suspended = true; this._apply(false); }
  resume() { if (this._disposed) return; this._suspended = false; this._apply(false); }

  /** Bring the context, the scheduler and the song in line with unlocked / muted / suspended. */
  _apply(fromGesture) {
    const ctx = this._ctx;
    if (!ctx || this._disposed) return;
    const run = this._wantRun, g = this._g, now = ctx.currentTime;
    if (run) {
      let wake = fromGesture || ctx.state !== 'running';       // a gesture is the one moment iOS lets us start it
      if (this._ctxRunning !== true) {
        g.out.gain.cancelScheduledValues(now);
        g.out.gain.setValueAtTime(0, now);
        g.out.gain.linearRampToValueAtTime(1, now + 0.04);     // no pop when coming back from mute / pause
        this._ctxRunning = true;
        // We asked for suspend() a moment ago, but `state` only changes once the audio thread has done it. Whatever
        // it says now, the resume must be queued behind that suspend, or the context would end up suspended with
        // nobody (outside a gesture, on iOS) able to wake it again.
        wake = true;
      }
      if (wake) safe(() => ctx.resume());
      this._startScheduler();
      this._syncSong();
    } else {
      this._stopScheduler();
      g.out.gain.cancelScheduledValues(now);
      g.out.gain.setValueAtTime(0, now);                       // silence immediately
      if (this._ctxRunning !== false) { this._ctxRunning = false; safe(() => ctx.suspend()); }
    }
  }

  _startScheduler() {
    if (this._timer !== null) return;                          // one scheduler, whatever happens
    const token = ++this._token;
    this._timer = this._timers.setInterval(() => this._tick(token), TICK_MS);
  }
  _stopScheduler() {
    if (this._timer !== null) { this._timers.clearInterval(this._timer); this._timer = null; }
    this._token++;                                             // any callback already queued becomes a no-op
  }

  _tick(token) {
    if (token !== this._token || !this._ctx || this._disposed) return;
    const ctx = this._ctx, now = ctx.currentTime, until = now + LOOKAHEAD, ps = this._players;
    if (ctx.state !== 'running' && ++this._stuck % RESUME_RETRY_TICKS === 0) safe(() => ctx.resume());
    safe(() => this._g.voices.sweep(now));
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      safe(() => p.schedule(until, now));                       // audio must never throw into the game
      if (p.out && now >= p.endTime + 0.06) { safe(() => p.dispose()); ps.splice(i, 1); if (this._active === p) this._active = null; }
    }
  }

  /* ── music ── */

  /** Start song `id` from its beginning, crossfading over `fade` seconds. Same id again is a no-op. */
  playSong(id, { fade = 0.4 } = {}) {
    if (this._disposed || id === this._songId) return;
    this._songId = id == null ? null : id;
    this._songFade = fade;
    this._syncSong();
  }
  stopSong({ fade = 0.4 } = {}) {
    if (this._disposed) return;
    this._songId = null; this._songFade = fade;
    this._syncSong();
  }

  _syncSong() {
    const ctx = this._ctx;
    if (!ctx || !this._wantRun) return;
    const want = this._songId, cur = this._active, now = ctx.currentTime, fade = this._songFade;
    if (want === null) {
      if (cur) { cur.fadeOut(now, fade); this._active = null; }
      return;
    }
    if (cur && cur.id === want && !cur.out) return;
    if (!this._songs) { this._loadSongs(); return; }
    const song = this._songs[want];
    if (!song) return;
    let p = null;
    try { p = new SongPlayer(this._g, compileSong(song), want, now + START_DELAY, 0); }   // a malformed song must not crash the game
    catch (e) { return; }
    const start = now + START_DELAY;                           // the old song starts fading exactly when the new one starts
    this._dropInaudible(now, start);
    for (const q of this._players) if (!q.out) q.fadeOut(start, fade);
    for (let i = 0; i < this._players.length - (MAX_PLAYERS - 1); i++) this._players[i].hurry(start, 0.25);   // oldest first; the new one makes MAX_PLAYERS
    p.fadeTo(start, fade, 1);
    this._players.push(p); this._active = p;
    safe(() => p.schedule(now + LOOKAHEAD, now));
  }

  /** No songs were passed in: import music.mjs once (a same-origin module, cached by the service worker), then start the wanted song. */
  _loadSongs() {
    if (this._songsLoading || this._disposed) return;
    this._songsLoading = true;
    const done = (songs) => { this._songs = songs && typeof songs === 'object' ? songs : {}; this._songsLoading = false; if (!this._disposed) this._syncSong(); };
    try { import('./music.mjs').then((m) => done(m && m.SONGS), () => done({})); } catch (e) { done({}); }
  }

  /**
   * A song that nobody can hear (it was changed away from a moment after it began to fade in, say because Mama backed up
   * over a landscape boundary and rolled on again) is disposed at once rather than faded: it would otherwise keep
   * scheduling every note of a whole song for the length of the fade.
   */
  _dropInaudible(now, start) {
    const ps = this._players;
    for (let i = ps.length - 1; i >= 0; i--) {
      const q = ps[i];
      if (Math.max(q.levelAt(now), q.levelAt(start)) >= INAUDIBLE) continue;
      safe(() => q.dispose());
      ps.splice(i, 1);
      if (this._active === q) this._active = null;
    }
  }

  /* ── sound effects ── */

  /** Play a cue. Returns true if it was scheduled. Safe before unlock / while muted or suspended (does nothing). */
  sfx(name, opts) {
    if (this._disposed || !this._wantRun || !this._ctx) return false;
    const info = SFX_INFO[name];
    if (!info) return false;
    const ctx = this._ctx, now = ctx.currentTime, o = opts || {};
    if (now - (this._last[name] === undefined ? -1e9 : this._last[name]) < info.gap) return false;
    const live = this._g.voices.count;
    if (live > MAX_SFX_VOICES || (live > MAX_SFX_VOICES - 40 && info.prio === 0)) return false;
    if (ctx.state !== 'running' && live > NOT_RUNNING_SFX_CAP) return false;   // the context has not started: don't pile up stale cues
    this._last[name] = now;
    try { return this._playAt(name, now + 0.004, o, now, this._g, this._env) > 0; } catch (e) { return false; }
  }

  /** Schedule at an absolute time on graph `g` (also used by renderOffline). `now` is the clock for the egg streak. */
  _playAt(name, t, o, now, g, env) {
    const info = SFX_INFO[name];
    if (!info) return 0;
    if (name === 'egg' && o.streak === undefined && g === this._g) {
      this._streak = (now - this._eggT) < 1.2 ? Math.min(this._streak + 1, 8) : 0;   // rising pitch while eggs keep coming
      this._eggT = now;
      o = { ...o, streak: this._streak };
    }
    const dur = playSfx(env, name, t, o);
    if (info.duck) g.doDuck(t, info.duck.db, name === 'goldHatch' && o.full ? 0.75 : info.duck.seconds);
    return dur;
  }

  /** Map a simulation event (sim.mjs header) to a sound. 'respawn', 'cue', 'start', 'crumble-fall' are silent. */
  handle(e) {
    if (!e || this._disposed || !this._wantRun || !this._ctx) return;
    switch (e.type) {
      case 'jump': this.sfx('jump'); break;
      case 'land': this.sfx('land', { hard: !!e.hard }); break;
      case 'egg': this.sfx('egg'); break;
      case 'gold': this._goldT = this._ctx.currentTime; this.sfx('goldHatch', { full: e.hatched === false }); break;   // 'gold' carries the hatch: play it once…
      case 'hatch': if (this._ctx.currentTime - this._goldT > 0.6) this.sfx('goldHatch'); break;   // …and ignore the 'hatch' that follows it
      case 'shield': this.sfx('shield'); break;
      case 'shield-break': this.sfx('shieldBreak'); break;
      case 'magnet': this.sfx('magnet'); break;
      case 'stomp': this.sfx('stomp'); break;
      case 'spring': this.sfx('spring'); break;
      case 'hit': this.sfx('hit'); break;
      case 'duckling-lost': this.sfx('ducklingLost'); break;
      case 'fall': this.sfx('fall'); break;
      case 'checkpoint': this.sfx('checkpoint'); break;
      case 'crumble-start': this.sfx('crumble'); break;
      case 'steer': this.sfx('steer', { dir: e.dir }); break;
      case 'chapter-enter': case 'exit': this.sfx('chapter'); break;
      case 'dead': this.sfx('dead'); break;
      case 'beacon': this.sfx('beacon'); break;
      default: break;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._stopScheduler();
    this._disposed = true;
    if (this._unwatch) { this._unwatch(); this._unwatch = null; }
    for (const p of this._players) p.dispose();
    this._players.length = 0; this._active = null;
    if (this._g) this._g.voices.freeAll();
    const ctx = this._ctx;
    this._ctx = null;
    if (ctx) safe(() => ctx.close());
  }

  /**
   * Test hook: render `seconds` of song `id` (from the beginning, or from opts.startAt seconds) with an
   * OfflineAudioContext. opts: { sfx: [[time, name, sfxOpts?], …], music: false (sfx only), startAt, stems }.
   * With stems:true the result has 6 channels: [mix L,R | music after the duck L,R | sfx before the master L,R].
   * The same SongPlayer / Graph code as live play is used, scheduled in chunks like the live scheduler.
   */
  async renderOffline(id, seconds, sampleRate = 44100, opts = {}) {
    const OAC = this._OAC || (typeof globalThis !== 'undefined' && (globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext));
    if (!OAC) throw new Error('OfflineAudioContext is not available');
    const channels = opts.stems ? 6 : 2;
    const ctx = new OAC(channels, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
    const g = new Graph(ctx, { stems: !!opts.stems });
    const env = g.sfxEnv();
    const song = opts.music === false ? null : (this._songs || {})[id];
    let player = null;
    if (song) {
      const c = compileSong(song);
      player = new SongPlayer(g, c, id, 0, Math.max(0, Math.round((opts.startAt || 0) / c.stepDur)));
      player.bus.gain.value = 1; player.stages[0].level = 1;
      player.t0 = -player.next * c.stepDur;                  // step `next` sounds at time 0
    }
    // sfx first so the duck model sees them in time order
    const list = (opts.sfx || []).map((x) => ({ t: x[0], name: x[1], o: x[2] || {} })).sort((a, b) => a.t - b.t);
    for (const s of list) this._playAt(s.name, s.t, { streak: 0, ...s.o }, s.t, g, env);   // (a render never touches the live streak state)
    // the music is scheduled the way the live scheduler does it, in chunks, freeing finished voices as it goes
    const CH = 4;
    const chunk = (T) => { if (player) player.schedule(Math.min(T + CH, seconds), T); g.voices.sweep(T); };
    chunk(0);
    if (typeof ctx.suspend === 'function' && seconds > CH * 1.5) {
      for (let T = CH; T < seconds - 0.5; T += CH) {
        const at = T;
        ctx.suspend(at).then(() => { chunk(at); ctx.resume(); }).catch(() => {});
      }
    } else if (player) player.schedule(seconds, 0);
    return ctx.startRendering();
  }
}
