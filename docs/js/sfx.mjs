/*
 * Egg Mama — sound effects (DESIGN.md §9). Everything is synthesised from oscillators and a noise buffer.
 *
 * This module has NO imports and knows nothing about the engine: audio.mjs hands it an `env`
 *
 *   env = {
 *     ctx,        // AudioContext | OfflineAudioContext
 *     out,        // the AudioNode every effect connects to (the sfx bus, which bypasses the music duck)
 *     noise,      // AudioBuffer of white noise, >= 1 s
 *     cache,      // plain object, one per context (PeriodicWaves are built once and kept here)
 *     voice(),    // -> { n: [], end: 0 } a record the engine uses to disconnect the cue's nodes once it has finished
 *     rnd(),      // deterministic 0..1 (so offline renders are repeatable)
 *   }
 *
 * and calls playSfx(env, name, startTime, opts). Every cue is ONE voice record: all of its nodes are
 * pushed into it and `end` is the time after which they can be thrown away (no growth over an hour).
 *
 * Design rules (children hear thousands of these over an hour):
 *   - soft attacks (>= 3 ms), exponential tails that end at -80 dB (no clicks), nothing harsh or shrill;
 *   - the five important cues are different in SHAPE, not just pitch:
 *       egg          one short bright blip, pitch ladder rises on a streak            (~0.13 s)
 *       goldHatch    shell crack + RISING FOUR-NOTE bell chime + two chick peeps      (~0.9 s, 1-4 kHz, loud)
 *       ducklingLost two DESCENDING sad peeps + a falling whoosh                      (~0.75 s)
 *       checkpoint   TWO-note horn flourish (short, then long) + a few sparkles       (~0.7 s)
 *       beacon       big rising major ARPEGGIO, swelling chord, shimmer, airy sweep   (~2.5 s)
 *   - important cues keep their energy between 800 Hz and 5 kHz (phone speakers have no bass).
 */

export const SFX_NAMES = Object.freeze([
  'egg', 'goldHatch', 'ducklingLost', 'checkpoint', 'beacon', 'jump', 'land', 'stomp', 'spring', 'hit',
  'shield', 'shieldBreak', 'magnet', 'crumble', 'fall', 'dead', 'chapter', 'ui', 'uiBack', 'steer',
]);

/**
 * Per cue: nominal length (s), minimum gap between two plays (s, rate limit: a magnet can pull ten eggs in a
 * blink), priority (2 = always plays, 0 = dropped first when the engine is busy), and the music duck
 * (dB dip + how long it is held before the music swells back) for the four cues that must cut through.
 */
export const SFX_INFO = Object.freeze({
  egg:          { duration: 0.14, gap: 0.035, prio: 0 },
  goldHatch:    { duration: 0.92, gap: 0.30,  prio: 2, duck: { db: 10, seconds: 0.95 } },
  ducklingLost: { duration: 0.78, gap: 0.30,  prio: 2, duck: { db: 9, seconds: 0.78 } },
  checkpoint:   { duration: 0.72, gap: 0.40,  prio: 2, duck: { db: 8, seconds: 0.72 } },
  beacon:       { duration: 2.50, gap: 1.00,  prio: 2, duck: { db: 9, seconds: 2.50 } },
  jump:         { duration: 0.14, gap: 0.08,  prio: 1 },
  land:         { duration: 0.14, gap: 0.08,  prio: 0 },
  stomp:        { duration: 0.18, gap: 0.08,  prio: 1 },
  spring:       { duration: 0.46, gap: 0.15,  prio: 1 },
  hit:          { duration: 0.20, gap: 0.20,  prio: 2 },
  shield:       { duration: 0.55, gap: 0.20,  prio: 1 },
  shieldBreak:  { duration: 0.22, gap: 0.20,  prio: 2 },
  magnet:       { duration: 0.66, gap: 0.30,  prio: 1 },
  crumble:      { duration: 0.52, gap: 0.15,  prio: 0 },
  fall:         { duration: 0.62, gap: 0.30,  prio: 1 },
  dead:         { duration: 1.20, gap: 0.50,  prio: 2 },
  chapter:      { duration: 1.70, gap: 1.00,  prio: 1 },
  ui:           { duration: 0.08, gap: 0.04,  prio: 1 },
  uiBack:       { duration: 0.09, gap: 0.04,  prio: 1 },
  steer:        { duration: 0.14, gap: 0.10,  prio: 0 },
});

/* ───────────────────────── tiny synthesis helpers ───────────────────────── */

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
let VOL = 1; // volume multiplier of the cue being built (playSfx is synchronous, so a module variable is safe)

/** Waves made of sine harmonics (so one oscillator sounds like a bell / horn). Built once per context. */
const WAVES = {
  blip:  [1, 0.30, 0.08],                          // bright but round (the egg)
  chime: [1, 0.40, 0.15, 0.06],                    // glockenspiel-ish
  soft:  [1, 0.18, 0.06],                          // almost a sine, a little air
  horn:  [1, 0.55, 0.40, 0.25, 0.15, 0.10, 0.06],  // mellow brass for the checkpoint flourish
  peep:  [1, 0.12],                                // a chick: nearly pure
  warm:  [1, 0.55, 0.30, 0.15],                    // a soft reed: same pitch as 'soft' but with partials a phone speaker can reproduce
};
function setWave(env, osc, spec) {
  if (spec === 'sine' || spec === 'triangle' || spec === 'square' || spec === 'sawtooth') { osc.type = spec; return; }
  let w = env.cache[spec];
  if (!w) {
    const amps = WAVES[spec];
    const real = new Float32Array(amps.length + 1), imag = new Float32Array(amps.length + 1);
    for (let i = 0; i < amps.length; i++) imag[i + 1] = amps[i];
    w = env.cache[spec] = env.ctx.createPeriodicWave(real, imag);
  }
  osc.setPeriodicWave(w);
}

/**
 * One oscillator through its own gain envelope.
 *   o.t start, o.dur total length, o.peak level, o.a attack (default 4 ms), o.hold (flat time after the attack)
 *   o.f start frequency, o.path [[dt, f], …] (exponential glide through these points) instead of o.f
 *   o.vib {rate, depth(Hz)}  frequency wobble (peeps, boing)
 *   o.wave a WAVES key or an OscillatorNode type, default 'sine'
 */
function tone(env, v, o) {
  const ctx = env.ctx, t = o.t, dur = o.dur, a = o.a === undefined ? 0.004 : o.a;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  setWave(env, osc, o.wave || 'sine');
  const f = osc.frequency;
  if (o.path) {
    f.setValueAtTime(o.path[0][1], t + o.path[0][0]);
    for (let i = 1; i < o.path.length; i++) f.exponentialRampToValueAtTime(o.path[i][1], t + o.path[i][0]);
  } else f.setValueAtTime(o.f, t);
  const peak = Math.max(0.0002, o.peak * VOL);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (o.hold) g.gain.setValueAtTime(peak, t + a + o.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g); g.connect(o.dest || env.out);
  if (o.vib) {
    const l = ctx.createOscillator(), lg = ctx.createGain();
    l.frequency.value = o.vib.rate; lg.gain.value = o.vib.depth;
    l.connect(lg); lg.connect(f);
    l.start(t); l.stop(t + dur + 0.02);
    v.n.push(l, lg);
  }
  osc.start(t); osc.stop(t + dur + 0.02);
  v.n.push(osc, g);
  v.end = Math.max(v.end, t + dur + 0.03);
}

/** A burst of filtered noise. o.f..o.f2 sweeps the filter (exponentially). */
function hiss(env, v, o) {
  const ctx = env.ctx, t = o.t, dur = o.dur, a = o.a === undefined ? 0.004 : o.a;
  const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = env.noise; src.loop = true;
  flt.type = o.type || 'bandpass';
  flt.Q.value = o.q === undefined ? 1 : o.q;
  flt.frequency.setValueAtTime(o.f, t);
  if (o.f2) flt.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
  const peak = Math.max(0.0002, o.peak * VOL);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt); flt.connect(g); g.connect(o.dest || env.out);
  src.start(t, env.rnd() * Math.max(0, env.noise.duration - 0.1)); src.stop(t + dur + 0.02);
  v.n.push(src, flt, g);
  v.end = Math.max(v.end, t + dur + 0.03);
}

/* ───────────────────────── the cues ───────────────────────── */

// An ordinary egg: a small pitch ladder (major pentatonic) climbs while eggs keep coming within ~1.2 s.
// Starts at C6 (above the melody band of the music, where it is heard clearly) and tops out at D7 (2.3 kHz), never shrill.
const EGG_LADDER = [0, 2, 4, 7, 9, 12, 14];
function egg(env, v, t, o) {
  const step = Math.max(0, Math.min(EGG_LADDER.length - 1, o.streak | 0));
  const cents = (env.rnd() - 0.5) * 16;                       // a little variation so it never sounds mechanical
  const f = hz(84 + EGG_LADDER[step] + cents / 100);
  tone(env, v, { t, wave: 'blip', path: [[0, f * 0.92], [0.02, f]], dur: 0.13, peak: 0.36 * (1 - 0.03 * step) });
}

function goldHatch(env, v, t, o) {
  const full = !!o.full;                                      // flock already full: same fanfare without the chick
  let c = t;
  if (!full) {
    // the shell cracks: two dry ticks and a tiny hollow knock
    hiss(env, v, { t, dur: 0.040, f: 2800, q: 1.2, peak: 0.34 });
    hiss(env, v, { t: t + 0.065, dur: 0.035, f: 3600, q: 1.2, peak: 0.26 });
    tone(env, v, { t: t + 0.01, wave: 'triangle', path: [[0, 1500], [0.05, 900]], dur: 0.05, peak: 0.22 });
    c = t + 0.14;
  }
  // rising four-note chime C6 E6 G6 C7
  const notes = [84, 88, 91, 96], peaks = [0.55, 0.60, 0.65, 0.70];
  for (let i = 0; i < 4; i++) {
    tone(env, v, { t: c + i * 0.105, wave: 'chime', f: hz(notes[i]), dur: i === 3 ? 0.62 : 0.50, peak: peaks[i], a: 0.004 });
  }
  tone(env, v, { t: c + 0.315, wave: 'sine', f: hz(108), dur: 0.30, peak: 0.12 }); // sparkle on the top note
  if (!full) {
    // the chick: "pi-pip!"
    tone(env, v, { t: t + 0.62, wave: 'peep', path: [[0, 2500], [0.05, 3300], [0.12, 2900]], dur: 0.14, peak: 0.34, a: 0.008, vib: { rate: 9, depth: 60 } });
    tone(env, v, { t: t + 0.76, wave: 'peep', path: [[0, 2700], [0.05, 3500], [0.11, 3000]], dur: 0.12, peak: 0.28, a: 0.008, vib: { rate: 9, depth: 60 } });
  }
}

function ducklingLost(env, v, t) {
  // two peeps that slide DOWN, the second smaller and lower, with a falling breath of air under them
  tone(env, v, { t, wave: 'peep', path: [[0, 1900], [0.12, 1500], [0.30, 1000]], dur: 0.30, peak: 0.50, a: 0.01, vib: { rate: 6, depth: 45 } });
  tone(env, v, { t: t + 0.30, wave: 'peep', path: [[0, 1500], [0.14, 1100], [0.32, 700]], dur: 0.34, peak: 0.40, a: 0.01, vib: { rate: 6, depth: 40 } });
  hiss(env, v, { t: t + 0.05, dur: 0.55, f: 2400, f2: 500, q: 0.9, a: 0.12, peak: 0.20 });
}

function checkpoint(env, v, t) {
  // "ta-DAAH": a short note, then a longer higher one (a perfect fifth up), a mellow horn, then a few sparkles
  tone(env, v, { t, wave: 'horn', f: hz(84), dur: 0.16, peak: 0.46, a: 0.008 });
  tone(env, v, { t: t + 0.11, wave: 'horn', f: hz(91), dur: 0.66, peak: 0.53, a: 0.01, hold: 0.16, vib: { rate: 5.5, depth: 7 } });
  tone(env, v, { t: t + 0.22, wave: 'chime', f: hz(103), dur: 0.22, peak: 0.13 });
  tone(env, v, { t: t + 0.29, wave: 'chime', f: hz(108), dur: 0.22, peak: 0.12 });
  tone(env, v, { t: t + 0.36, wave: 'chime', f: hz(112), dur: 0.24, peak: 0.11 });
}

function beacon(env, v, t) {
  // C major arpeggio climbing over two octaves, a swelling chord, shimmering pings and an airy sweep
  const arp = [72, 76, 79, 84, 88, 91, 96];
  for (let i = 0; i < arp.length; i++) {
    tone(env, v, { t: t + i * 0.12, wave: 'chime', f: hz(arp[i]), dur: 0.9 + i * 0.12, peak: 0.30 + i * 0.025, a: 0.006 });
  }
  const chord = [84, 88, 91, 96];
  for (let i = 0; i < chord.length; i++) {
    tone(env, v, { t: t + 0.6 + i * 0.03, wave: 'soft', f: hz(chord[i]), dur: 1.9, peak: 0.26, a: 0.55, hold: 0.4 });
  }
  const sparkle = [91, 96, 100, 103];
  for (let i = 0; i < 14; i++) {
    tone(env, v, { t: t + 0.7 + i * 0.095 + env.rnd() * 0.05, wave: 'sine', f: hz(sparkle[(env.rnd() * 4) | 0]), dur: 0.36, peak: 0.07 + env.rnd() * 0.05, a: 0.006 });
  }
  hiss(env, v, { t: t + 0.4, dur: 2.0, f: 900, f2: 4500, q: 0.7, a: 1.0, peak: 0.05 });
}

function jump(env, v, t) {
  // (a sine around 500-1000 Hz is almost inaudible on a phone speaker over music: sweep a little higher and add partials)
  tone(env, v, { t, wave: 'blip', path: [[0, 760], [0.10, 1500]], dur: 0.13, peak: 0.19, a: 0.006 });
}

function land(env, v, t, o) {
  const k = o.hard ? 1.5 : 1;
  tone(env, v, { t, wave: 'horn', path: [[0, 420], [0.07, 200]], dur: 0.11, peak: 0.17 * k });
  hiss(env, v, { t, dur: 0.07, f: 1700, q: 0.8, peak: 0.13 * k });
}

function stomp(env, v, t) {
  tone(env, v, { t, wave: 'triangle', path: [[0, 760], [0.08, 260]], dur: 0.14, peak: 0.30 });
  tone(env, v, { t: t + 0.01, wave: 'blip', path: [[0, 1500], [0.05, 900]], dur: 0.06, peak: 0.20 });
  hiss(env, v, { t, dur: 0.04, f: 2000, q: 1, peak: 0.12 });
}

function spring(env, v, t) {
  // boing: a quick rise, then a wobbling settle
  tone(env, v, { t, wave: 'blip', path: [[0, 330], [0.09, 990], [0.44, 700]], dur: 0.45, peak: 0.30, a: 0.006, vib: { rate: 17, depth: 140 } });
  tone(env, v, { t, wave: 'sine', path: [[0, 660], [0.09, 1980], [0.30, 1400]], dur: 0.30, peak: 0.07, a: 0.006, vib: { rate: 17, depth: 240 } });
}

function hit(env, v, t) {
  // a soft bump, never scary
  tone(env, v, { t, wave: 'horn', path: [[0, 440], [0.12, 190]], dur: 0.17, peak: 0.26, a: 0.005 });
  hiss(env, v, { t, dur: 0.10, f: 1500, q: 0.7, peak: 0.14 });
}

function shield(env, v, t) {
  // five shimmering pings climbing
  const n = [88, 91, 95, 100, 103];
  for (let i = 0; i < n.length; i++) tone(env, v, { t: t + i * 0.05, wave: 'soft', f: hz(n[i]), dur: 0.32, peak: 0.17, a: 0.012 });
}

function shieldBreak(env, v, t) {
  // a glassy pop
  hiss(env, v, { t, dur: 0.05, type: 'highpass', f: 3500, q: 0.7, peak: 0.20 });
  const f = [3140, 2290, 4180];
  for (let i = 0; i < f.length; i++) tone(env, v, { t, wave: 'sine', path: [[0, f[i]], [0.1, f[i] * 0.7]], dur: 0.14, peak: 0.12 });
  tone(env, v, { t, wave: 'blip', path: [[0, 900], [0.06, 400]], dur: 0.07, peak: 0.20 });
}

function magnet(env, v, t) {
  // a humming sweep with a soft electric flutter
  tone(env, v, { t, wave: 'horn', path: [[0, 440], [0.35, 1120], [0.60, 940]], dur: 0.65, peak: 0.17, a: 0.08, vib: { rate: 24, depth: 40 } });
  tone(env, v, { t, wave: 'blip', path: [[0, 660], [0.35, 1680], [0.60, 1410]], dur: 0.65, peak: 0.08, a: 0.08, vib: { rate: 24, depth: 60 } });
}

function crumble(env, v, t, o) {
  // rumble (mid-band so phones can play it) with little stones ticking
  hiss(env, v, { t, dur: 0.5, f: 800, q: 0.6, a: 0.05, peak: 0.22 });
  tone(env, v, { t, wave: 'horn', path: [[0, 150], [0.4, 100]], dur: 0.42, peak: 0.08, a: 0.05 });
  for (let i = 0; i < 9; i++) {
    hiss(env, v, { t: t + 0.03 + env.rnd() * 0.42, dur: 0.022, f: 1500 + env.rnd() * 1200, q: 2, peak: 0.16 + env.rnd() * 0.10 });
  }
}

function fall(env, v, t) {
  tone(env, v, { t, wave: 'soft', path: [[0, 1500], [0.55, 350]], dur: 0.60, peak: 0.22, a: 0.02, vib: { rate: 6, depth: 40 } });
}

function dead(env, v, t) {
  // a gentle descending phrase: E D B G
  const n = [76, 74, 71, 67], at = [0, 0.18, 0.36, 0.56], len = [0.28, 0.28, 0.28, 0.64];
  for (let i = 0; i < 4; i++) {
    tone(env, v, { t: t + at[i], wave: 'warm', f: hz(n[i]), dur: len[i], peak: 0.30, a: 0.02 });
    tone(env, v, { t: t + at[i], wave: 'sine', f: hz(n[i] + 12), dur: len[i], peak: 0.14, a: 0.02 });
  }
}

function chapter(env, v, t) {
  // a soft Cmaj7 shimmer that opens slowly and fades: the landscape is changing
  const n = [84, 88, 91, 95];
  for (let i = 0; i < n.length; i++) tone(env, v, { t: t + i * 0.09, wave: 'soft', f: hz(n[i]), dur: 1.6, peak: 0.10, a: 0.25 });
  hiss(env, v, { t, dur: 1.4, f: 2000, f2: 3500, q: 0.5, a: 0.5, peak: 0.03 });
}

function ui(env, v, t) {
  tone(env, v, { t, wave: 'blip', path: [[0, 880], [0.03, 1175]], dur: 0.07, peak: 0.16 });
}
function uiBack(env, v, t) {
  tone(env, v, { t, wave: 'blip', path: [[0, 880], [0.04, 660]], dur: 0.08, peak: 0.14 });
}

function steer(env, v, t, o) {
  const right = !(o.dir < 0);
  hiss(env, v, { t, dur: 0.12, f: right ? 800 : 1800, f2: right ? 1800 : 800, q: 1.2, a: 0.03, peak: 0.20 });
}

const CUES = {
  egg, goldHatch, ducklingLost, checkpoint, beacon, jump, land, stomp, spring, hit,
  shield, shieldBreak, magnet, crumble, fall, dead, chapter, ui, uiBack, steer,
};

/**
 * Schedule cue `name` at time `t`. opts: { vol (x), streak (egg), hard (land), full (goldHatch), dir (steer) }.
 * Returns the cue's nominal duration in seconds, or 0 for an unknown name.
 */
export function playSfx(env, name, t, opts = {}) {
  const fn = CUES[name];
  if (!fn) return 0;
  VOL = opts.vol === undefined ? 1 : Math.max(0, +opts.vol || 0);
  const v = env.voice();
  try { fn(env, v, t, opts); } catch (e) { v.end = Math.max(v.end, t); VOL = 1; throw e; }
  VOL = 1;
  return SFX_INFO[name].duration;
}
