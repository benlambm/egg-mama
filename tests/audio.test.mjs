import assert from "node:assert/strict";
import test from "node:test";
import { GameAudio, SFX_NAMES, INSTRUMENTS, lintSong } from "../docs/js/audio.mjs";
import { SFX_INFO } from "../docs/js/sfx.mjs";
import { CHAPTERS } from "../docs/js/chapters.mjs";
import { pathToFileURL } from "node:url";

/* ══════════════ a hand-written fake Web Audio ══════════════
 * Just enough of AudioContext to record what the engine builds: every node and param automation event,
 * which sources started when, what is still connected, and a clock the tests advance by hand.
 */
class FakeParam {
  constructor(owner, name, value = 0) { this.owner = owner; this.name = name; this.value = value; this.events = []; }
  _add(type, v, t, extra) { this.events.push({ type, v, t, ...extra }); return this; }
  setValueAtTime(v, t) { return this._add("set", v, t); }
  linearRampToValueAtTime(v, t) { return this._add("lin", v, t); }
  exponentialRampToValueAtTime(v, t) { return this._add("exp", v, t); }
  setTargetAtTime(v, t, tc) { return this._add("target", v, t, { tc }); }
  setValueCurveAtTime(c, t, d) { return this._add("curve", c, t, { d }); }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e.t < t); return this; }
}
class FakeNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = new Set(); this.params = []; this.disconnected = false; ctx.live.add(this); ctx.created.push(this); ctx.createdByKind[kind] = (ctx.createdByKind[kind] || 0) + 1; }
  param(name, v) { const p = new FakeParam(this, name, v); this.params.push(p); return p; }
  connect(dest) { this.outputs.add(dest instanceof FakeParam ? dest.owner : dest); return dest; }
  disconnect() { this.outputs.clear(); this.disconnected = true; this.ctx.live.delete(this); }
}
class FakeSource extends FakeNode {
  constructor(ctx, kind) { super(ctx, kind); this.startTime = null; this.stopTime = null; this.frequency = this.param("frequency", 440); this.detune = this.param("detune", 0); this.type = "sine"; this.periodicWave = null; ctx.sources.push(this); }
  start(t = 0, offset) { this.startTime = t; this.offset = offset; }
  stop(t = 0) { this.stopTime = t; }
  setPeriodicWave(w) { this.periodicWave = w; }
}
class FakeContext {
  constructor(opts) {
    this.opts = opts; this.currentTime = 0; this.state = "suspended"; this.sampleRate = 44100;
    this.live = new Set(); this.created = []; this.createdByKind = {}; this.sources = []; this.waves = [];
    this.stateLog = [];
    this.destination = new FakeNode(this, "destination");
    FakeContext.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners || (this.listeners = [])).push([type, fn]); }
  fire(type) { for (const [t, fn] of this.listeners || []) if (t === type) fn(); }
  advance(dt) { if (this.state === "running") this.currentTime += dt; }
  resume() { this.state = "running"; this.stateLog.push("resume"); return Promise.resolve(); }
  suspend() { this.state = "suspended"; this.stateLog.push("suspend"); return Promise.resolve(); }
  close() { this.state = "closed"; this.stateLog.push("close"); return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, "gain"); n.gain = n.param("gain", 1); return n; }
  createOscillator() { return new FakeSource(this, "osc"); }
  createBufferSource() { const n = new FakeSource(this, "buf"); n.buffer = null; n.loop = false; return n; }
  createBiquadFilter() { const n = new FakeNode(this, "biquad"); n.type = "lowpass"; n.frequency = n.param("frequency", 350); n.Q = n.param("Q", 1); return n; }
  createDelay() { const n = new FakeNode(this, "delay"); n.delayTime = n.param("delayTime", 0); return n; }
  createDynamicsCompressor() { const n = new FakeNode(this, "comp"); for (const k of ["threshold", "knee", "ratio", "attack", "release"]) n[k] = n.param(k, 0); return n; }
  createWaveShaper() { const n = new FakeNode(this, "shaper"); n.curve = null; n.oversample = "none"; return n; }
  createStereoPanner() { const n = new FakeNode(this, "panner"); n.pan = n.param("pan", 0); return n; }
  createBuffer(ch, len, sr) { const data = new Float32Array(len); return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: () => data }; }
  createPeriodicWave(real, imag) { const w = { real, imag }; this.waves.push(w); return w; }
  /** nodes still connected that are not the permanent mixer / song infrastructure: sources that started */
  liveSources() { return [...this.live].filter((n) => n instanceof FakeSource); }
}
FakeContext.instances = [];

function fakeTimers() {
  const timers = {
    id: 0, fns: new Map(),
    setInterval(fn) { const id = ++timers.id; timers.fns.set(id, fn); return id; },
    clearInterval(id) { timers.fns.delete(id); },
    fire() { for (const fn of [...timers.fns.values()]) fn(); },
    get count() { return timers.fns.size; },
  };
  return timers;
}

/** Build an engine + fake context + fake timers. */
function rig(songs, extra = {}) {
  FakeContext.instances.length = 0;
  const timers = fakeTimers();
  const audio = new GameAudio({ muted: false, songs, AudioContextClass: FakeContext, timers, ...extra });
  return { audio, timers, get ctx() { return FakeContext.instances[0]; } };
}
/** Advance the clock in scheduler-tick sized steps. */
function run(r, seconds, dt = 0.025) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) { r.ctx.advance(dt); r.timers.fire(); }
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
/** start times of every oscillator that plays midi note m (matched by its frequency) */
function startsOf(ctx, midi) {
  const f = hz(midi);
  return ctx.sources.filter((s) => s.kind === "osc" && s.startTime !== null && near(s.frequency.value, f, 1e-3)).map((s) => s.startTime).sort((a, b) => a - b);
}
/** can audio flow from `a` to `target`? */
function reaches(a, target) {
  const seen = new Set(), stack = [a];
  while (stack.length) { const n = stack.pop(); if (n === target) return true; if (seen.has(n)) continue; seen.add(n); for (const o of n.outputs) stack.push(o); }
  return false;
}

/* ══════════════ test songs ══════════════ */
// 2 bars of 4/4 at 120 bpm: stepDur 0.125 s, loop 32 steps = 4.0 s. Every note has a unique pitch so it can be found by frequency.
const SONG_A = {
  id: "a", title: "A", bpm: 120, beatsPerBar: 4, stepsPerBeat: 4, bars: 2, swing: 0,
  layers: [
    { name: "lead", inst: "pulse25", vol: 0.6, notes: [[0, 72, 2], [8, 74, 2], [16, 76, 2], [31, 77, 1]] },
    { name: "bass", inst: "bassTri", vol: 0.8, notes: [[0, 48, 4], [16, 43, 4]] },
    { name: "drums", inst: "kit", vol: 0.7, hits: [[0, "k"], [4, "s"], [8, "k"], [12, "s"], [2, "h"], [10, "o"], [16, "cl"], [20, "t"], [24, "r"], [28, "sh"], [30, "c"]] },
    { name: "late", inst: "tri", vol: 0.5, play: [[1, 2]], notes: [[0, 60, 2], [16, 62, 2]] }, // audible only in bar 1: step 0 is bar 0 (silent), step 16 is bar 1
  ],
};
const SONG_B = {
  id: "b", title: "B", bpm: 100, beatsPerBar: 4, stepsPerBeat: 4, bars: 2, swing: 0,
  layers: [{ name: "m", inst: "tri", vol: 0.5, notes: [[0, 90, 2], [8, 91, 2]] }],
};
const SONGS = { a: SONG_A, b: SONG_B };
const T0 = 0.06; // a song started at currentTime 0 sounds its first step at START_DELAY

/* ══════════════ lifecycle ══════════════ */

test("nothing is created before unlock; sfx and playSong are safe no-ops that still remember the song", () => {
  const r = rig(SONGS);
  assert.equal(r.audio.sfx("egg"), false);
  r.audio.handle({ type: "gold", hatched: true });
  r.audio.playSong("a", { fade: 0.4 });
  r.audio.suspend(); r.audio.resume(); r.audio.setMuted(true); r.audio.setMuted(false);
  assert.equal(FakeContext.instances.length, 0, "no AudioContext before a user gesture");
  assert.equal(r.timers.count, 0);
  r.audio.unlock();
  run(r, 0.5);
  assert.equal(FakeContext.instances.length, 1);
  assert.equal(r.ctx.state, "running");
  assert.ok(startsOf(r.ctx, 72).length >= 1, "the song requested before unlock starts at unlock");
  assert.equal(r.timers.count, 1);
});

test("unlock sets navigator.audioSession.type to 'playback' and is safe to call repeatedly", () => {
  const nav = { audioSession: { type: "auto" } };
  const r = rig(SONGS, { navigator: nav });
  r.audio.unlock(); r.audio.unlock(); r.audio.unlock();
  assert.equal(nav.audioSession.type, "playback");
  assert.equal(FakeContext.instances.length, 1, "one context only");
  assert.equal(r.timers.count, 1);
});

test("exactly one scheduler survives any number of suspend / resume / mute cycles", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  const staleTick = [...r.timers.fns.values()][0];
  assert.equal(r.timers.count, 1);
  for (let i = 0; i < 8; i++) {
    r.audio.suspend(); assert.equal(r.timers.count, 0, "suspend stops the scheduler"); assert.equal(r.ctx.state, "suspended");
    r.audio.suspend(); assert.equal(r.timers.count, 0);
    r.audio.resume(); assert.equal(r.timers.count, 1); assert.equal(r.ctx.state, "running");
    r.audio.resume(); r.audio.resume(); assert.equal(r.timers.count, 1, "resume twice never makes two timers");
    r.audio.setMuted(true); assert.equal(r.timers.count, 0);
    r.audio.resume(); assert.equal(r.timers.count, 0, "resume while muted stays silent");
    r.audio.setMuted(false); assert.equal(r.timers.count, 1);
    r.audio.unlock(); assert.equal(r.timers.count, 1);
  }
  // a callback that was already queued by an older scheduler does nothing
  const before = r.ctx.created.length;
  r.ctx.advance(1); staleTick(); staleTick();
  assert.equal(r.ctx.created.length, before, "a stale tick from a cleared scheduler is ignored");
  run(r, 1);
  assert.ok(r.ctx.created.length > before, "the live scheduler still works");
  r.audio.suspend();
  assert.equal(r.timers.count, 0);
});

test("an OS interruption (phone call, iOS 'interrupted') is recovered; our own suspend is never undone", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  r.ctx.state = "interrupted"; r.ctx.fire("statechange");
  assert.equal(r.ctx.state, "running", "an unexpected interruption asks for the context back");
  r.ctx.state = "interrupted";                    // an interruption with no event at all: the scheduler retries about once a second
  for (let i = 0; i < 45; i++) r.timers.fire();
  assert.equal(r.ctx.state, "running");
  r.audio.suspend(); r.ctx.fire("statechange");
  assert.equal(r.ctx.state, "suspended", "after suspend() a statechange does not restart it");
  r.audio.resume(); assert.equal(r.ctx.state, "running");
  r.ctx.state = "suspended";                      // the OS suspended it while the app thinks it is playing; resume() must still wake it
  r.audio.resume(); assert.equal(r.ctx.state, "running", "resume() re-asks even when our own bookkeeping says running");
  r.audio.setMuted(true); r.ctx.fire("statechange");
  assert.equal(r.ctx.state, "suspended", "muted stays suspended");
});

test("suspend freezes the song and resume continues it with no gap and no repeat", () => {
  const every = { id: "s", bpm: 120, bars: 4, layers: [{ name: "x", inst: "tri", vol: 0.5, notes: Array.from({ length: 64 }, (_, i) => [i, 40 + (i % 40), 1]) }] };
  // notes at every step with a unique-ish pitch; track by step through start times instead of pitch
  const r = rig({ s: every });
  r.audio.unlock(); r.audio.playSong("s"); run(r, 1.3);
  r.audio.suspend();
  const n1 = r.ctx.sources.length;
  run(r, 5); // time is frozen while suspended
  assert.equal(r.ctx.sources.length, n1, "nothing is scheduled while suspended");
  assert.equal(r.ctx.currentTime, r.ctx.currentTime);
  r.audio.resume(); run(r, 6);
  const starts = r.ctx.sources.filter((s) => s.kind === "osc" && s.startTime !== null && s.frequency.value > 0).map((s) => s.startTime).sort((a, b) => a - b);
  const sd = 0.125;
  const uniq = [...new Set(starts.map((x) => x.toFixed(6)))].map(Number);
  assert.equal(uniq.length, starts.length, "no step is scheduled twice");
  for (let i = 0; i < uniq.length; i++) assert.ok(near(uniq[i], T0 + i * sd, 1e-6), `step ${i} at ${uniq[i]}`);
  assert.ok(uniq.length > 50, "more than 50 consecutive steps were scheduled across the pause");
});

test("a muted engine builds no sound nodes for sfx, events or songs; unmuting starts the remembered song", () => {
  const r = rig(SONGS, { muted: true });
  assert.equal(r.audio.muted, true);
  r.audio.unlock();
  const baseline = r.ctx.created.length;
  assert.equal(r.ctx.state, "suspended", "a muted engine keeps the context suspended");
  assert.equal(r.audio.sfx("goldHatch"), false);
  for (const n of SFX_NAMES) assert.equal(r.audio.sfx(n), false);
  for (const type of ["jump", "egg", "gold", "hatch", "beacon", "dead"]) r.audio.handle({ type });
  r.audio.playSong("a");
  run(r, 2);
  assert.equal(r.ctx.created.length, baseline, "not a single node created while muted");
  assert.equal(r.timers.count, 0);
  r.audio.setMuted(false);
  run(r, 1);
  assert.ok(r.ctx.created.length > baseline);
  assert.ok(startsOf(r.ctx, 72).length >= 1, "the remembered song plays once unmuted");
  // mute silences immediately: master gain to 0 and the context is suspended
  r.audio.setMuted(true);
  assert.equal(r.ctx.state, "suspended");
  const outGain = r.audio._g.out.gain;
  const last = outGain.events[outGain.events.length - 1];
  assert.equal(last.v, 0);
  assert.equal(r.audio.sfx("egg"), false);
});

test("playSong with the same id is a no-op; a different id crossfades; sfx never touch the song", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  const players = r.audio.stats.players, created = r.ctx.created.length;
  r.audio.playSong("a"); r.audio.playSong("a", { fade: 3 });
  assert.equal(r.audio.stats.players, players);
  assert.equal(r.ctx.created.length, created, "no new nodes for the same song");
  r.audio.playSong("b", { fade: 2 });
  assert.equal(r.audio.stats.players, players + 1);
  r.audio.playSong("b");
  assert.equal(r.audio.stats.players, players + 1);
});

test("stopSong fades the music out and retires its nodes; playing again starts from the beginning", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 2.3);
  const liveBefore = r.ctx.live.size;
  r.audio.stopSong({ fade: 0.5 }); run(r, 1.5);
  assert.equal(r.audio.stats.players, 0);
  assert.ok(r.ctx.live.size < liveBefore, "song nodes released");
  const n = startsOf(r.ctx, 72).length;
  r.audio.playSong("a"); run(r, 0.3);
  assert.equal(startsOf(r.ctx, 72).length, n + 1, "the song restarts at step 0");
});

test("dispose stops everything and later calls are harmless", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  r.audio.dispose();
  assert.equal(r.timers.count, 0);
  assert.equal(r.ctx.state, "closed");
  assert.equal(r.audio.sfx("egg"), false);
  r.audio.playSong("b"); r.audio.suspend(); r.audio.resume(); r.audio.unlock(); r.audio.handle({ type: "jump" }); r.audio.dispose();
  assert.equal(r.timers.count, 0);
});

/* ══════════════ the scheduler ══════════════ */

test("the loop is seamless and drift-free: notes land on t0 + n*stepDur across several wraps", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 12);
  const loop = 4.0, sd = 0.125;
  const step0 = startsOf(r.ctx, 72), last = startsOf(r.ctx, 77);
  assert.ok(step0.length >= 3 && last.length >= 3);
  for (let k = 0; k < 3; k++) {
    assert.ok(near(step0[k], T0 + k * loop, 1e-9), `loop ${k} step 0 at ${step0[k]}`);
    assert.ok(near(last[k], T0 + k * loop + 31 * sd, 1e-9), `loop ${k} last step at ${last[k]}`);
    assert.ok(near(step0[k + 1] - last[k], sd, 1e-9) || k === 2, "the first step of the next loop follows the last step by exactly one step");
  }
  // one of each per loop: no duplicate and no missing note around the seam
  const bass = startsOf(r.ctx, 48);
  for (let k = 1; k < bass.length; k++) assert.ok(near(bass[k] - bass[k - 1], loop, 1e-9));
});

test("tails ring over the seam: a note near the end of the loop is not cut at the wrap", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 4.5);
  const f = hz(77);
  const lastNote = r.ctx.sources.find((s) => s.kind === "osc" && near(s.frequency.value, f, 1e-3));
  const wrapAt = T0 + 4;
  assert.ok(lastNote.stopTime > wrapAt, `last-step note (starts ${lastNote.startTime}) stops at ${lastNote.stopTime}, after the seam at ${wrapAt}`);
});

test("play ranges: a layer is only audible in its bars", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 9);
  assert.equal(startsOf(r.ctx, 60).length, 0, "step 0 of 'late' is in bar 0, outside [1,2)");
  const s62 = startsOf(r.ctx, 62);
  assert.ok(s62.length >= 2);
  for (let k = 0; k < s62.length; k++) assert.ok(near(s62[k], T0 + 16 * 0.125 + k * 4, 1e-9));
  // a multi-range layer
  const song = { id: "m", bpm: 120, bars: 4, layers: [{ name: "x", inst: "tri", vol: 0.5, play: [[0, 1], [3, 4]], notes: [[0, 50, 2], [16, 52, 2], [32, 54, 2], [48, 56, 2]] }] };
  const r2 = rig({ m: song });
  r2.audio.unlock(); r2.audio.playSong("m"); run(r2, 8.5);
  assert.equal(startsOf(r2.ctx, 50).length >= 1, true);
  assert.equal(startsOf(r2.ctx, 52).length, 0);
  assert.equal(startsOf(r2.ctx, 54).length, 0);
  assert.equal(startsOf(r2.ctx, 56).length >= 1, true);
});

test("swing delays only the odd sixteenths", () => {
  const song = { id: "w", bpm: 120, bars: 1, swing: 0.25, layers: [{ name: "x", inst: "tri", vol: 0.5, notes: [[0, 60, 1], [1, 62, 1], [2, 64, 1], [3, 65, 1]] }] };
  const r = rig({ w: song });
  r.audio.unlock(); r.audio.playSong("w"); run(r, 1);
  const sd = 0.125;
  assert.ok(near(startsOf(r.ctx, 60)[0], T0, 1e-9));
  assert.ok(near(startsOf(r.ctx, 62)[0], T0 + sd + 0.25 * sd, 1e-9));
  assert.ok(near(startsOf(r.ctx, 64)[0], T0 + 2 * sd, 1e-9));
  assert.ok(near(startsOf(r.ctx, 65)[0], T0 + 3 * sd + 0.25 * sd, 1e-9));
});

test("a long main-thread stall skips the missed steps instead of dumping a burst of late notes", () => {
  const dense = { id: "d", bpm: 120, bars: 8, layers: [{ name: "x", inst: "tri", vol: 0.5, notes: Array.from({ length: 128 }, (_, i) => [i, 60 + (i % 24), 1]) }] };
  const r = rig({ d: dense });
  r.audio.unlock(); r.audio.playSong("d"); run(r, 1);
  const n = r.ctx.sources.length;
  r.ctx.advance(2.0); // 2 s with no scheduler tick (a stalled page)
  r.timers.fire();
  const now = r.ctx.currentTime;
  const fresh = r.ctx.sources.slice(n).filter((s) => s.kind === "osc");
  assert.ok(fresh.length <= 3, `only the next ~150 ms of steps, got ${fresh.length}`);
  for (const s of fresh) assert.ok(s.startTime >= now - 0.06, "no note is scheduled in the past");
});

test("compile is forgiving: bad notes, unknown instruments, drum hits on pitched layers, empty songs", () => {
  const bad = {
    id: "x", bpm: 9999, bars: 0, swing: 5, layers: [
      { name: "a", inst: "nope", vol: 9, notes: [[0, 60, 1], [-4, 60, 1], [9999, 60, 1], ["x", "y"], [2, NaN, 1], [3, 62, -2], [4, 64]] },
      { name: "b", inst: "tri", hits: [[0, "k"]] },
      { name: "c", inst: "kit", notes: [[0, 60, 1]], hits: [[0, "zz"], [0, "k", 200], [1, "sh", 0.5]] },
      { name: "d", inst: "pad", fx: { delay: { beats: 99, feedback: 5, mix: 2 }, vibrato: { rate: 99, depth: 999 }, filter: { type: "weird", freq: -5 } }, notes: [[0, 40, 4]] },
    ],
  };
  const r = rig({ x: bad, e: { id: "e" }, n: null });
  r.audio.unlock();
  assert.doesNotThrow(() => { r.audio.playSong("x"); run(r, 2); r.audio.playSong("e"); run(r, 1); r.audio.playSong("nothing"); r.audio.playSong("n"); run(r, 1); });
});

test("lintSong reports what the engine would silently drop, and passes a clean song", () => {
  const long = { id: "ok", bpm: 120, bars: 64, layers: [{ name: "x", inst: "tri", vol: 0.5, notes: [[0, 60, 2], [1023, 62, 1]], play: [[0, 64]] }, { name: "d", inst: "kit", hits: [[0, "k"]] }] };
  assert.deepEqual(lintSong(long), []);
  assert.deepEqual(lintSong(SONG_A).filter((m) => !/chapter songs/.test(m)), [], "the tiny test songs are only flagged for being short");
  const bad = { id: "bad", bpm: 500, bars: 64, swing: 0.9, layers: [
    { name: "a", inst: "banjo", notes: [[0, 60, 1]] },
    { name: "b", inst: "tri", vol: 5, pan: 3, notes: [[1024, 60, 1], [5000, 60, 1], [0, 200, 1], [4, 60, 0]], play: [[10, 5], [0, 99]] },
    { name: "c", inst: "kit", hits: [[0, "zz"], [3, "k"]], notes: [[0, 60, 1]] },
    { name: "d", inst: "pad", hits: [[0, "k"]], notes: [[0, 40, 4]], play: [[40, 41]] },
  ] };
  const msg = lintSong(bad).join("\n");
  for (const re of [/bpm 500/, /swing 0.9/, /unknown instrument 'banjo'/, /vol 5/, /pan 3/, /2 notes start at or after the loop end \(step 1024\)/, /malformed/, /play range \[10,5\]/, /play range \[0,99\]/, /'notes' are ignored/, /only the kit plays 'hits'/, /layer 3 'd' never sounds/]) assert.match(msg, re);
  assert.deepEqual(lintSong(null), ["song is not an object"]);
  assert.ok(lintSong({ id: "t", bpm: 120, bars: 1, layers: [] }).some((m) => /no layers/.test(m)));
});

test("audio never throws into the game: garbage songs, a context that cannot build, throwing cues", () => {
  const garbage = { id: "g", bpm: 120, bars: 2, layers: [null, { inst: "tri", notes: [null, [0, 60, 1]] }, { inst: "kit", hits: [undefined] }, { inst: "pad", notes: "nope" }] };
  const r = rig({ g: garbage, ok: SONG_A });
  r.audio.unlock();
  assert.doesNotThrow(() => { r.audio.playSong("g"); run(r, 1); r.audio.playSong("ok"); run(r, 1); });
  assert.ok(startsOf(r.ctx, 72).length >= 1, "a good song still plays after a broken one");
  // a context whose graph cannot be built
  class Broken extends FakeContext { createDynamicsCompressor() { throw new Error("no compressor"); } }
  const b = new GameAudio({ songs: SONGS, AudioContextClass: Broken, timers: fakeTimers() });
  assert.doesNotThrow(() => { b.unlock(); b.playSong("a"); b.sfx("egg"); b.handle({ type: "jump" }); b.suspend(); b.resume(); b.setMuted(true); b.dispose(); });
  // no AudioContext at all (old browser, test environment)
  const none = new GameAudio({ songs: SONGS, timers: fakeTimers() });
  assert.doesNotThrow(() => { none.unlock(); none.playSong("a"); assert.equal(none.sfx("egg"), false); none.dispose(); });
  // a cue that throws while being built is swallowed and its record is freed
  const r2 = rig({});
  r2.audio.unlock(); run(r2, 0.1);
  r2.ctx.createOscillator = () => { throw new Error("node limit"); };
  assert.equal(r2.audio.sfx("egg"), false);
  run(r2, 1);
  assert.equal(r2.audio.stats.voices, 0, "the failed cue left nothing behind");
});

test("all 14 instruments and all 9 drum hits make sound without throwing", () => {
  const layers = INSTRUMENTS.map((inst, i) => inst === "kit"
    ? { name: inst, inst, vol: 0.5, hits: ["k", "s", "h", "o", "t", "c", "r", "sh", "cl"].map((h, j) => [j * 2, h]) }
    : { name: inst, inst, vol: 0.5, fx: { vibrato: { rate: 5, depth: 20, delaySteps: 1 }, delay: { beats: 0.75, feedback: 0.3, mix: 0.2 }, filter: { type: "lowpass", freq: 3000, q: 1 } }, pan: (i % 5 - 2) / 3, notes: [[0, 48 + i, 6, 0.9], [8, 55 + i, 2, 100]] });
  const r = rig({ all: { id: "all", bpm: 120, bars: 1, layers } });
  r.audio.unlock(); r.audio.playSong("all");
  assert.doesNotThrow(() => run(r, 3));
  assert.equal(INSTRUMENTS.length, 14);
  assert.ok(r.ctx.sources.length > 40);
  assert.ok(r.ctx.createdByKind.panner >= 3 && r.ctx.createdByKind.delay >= 1, "pan and delay fx were built");
});

test("pulse waves have the requested duty and no DC; bass wave carries upper harmonics", () => {
  const r = rig(SONGS);
  r.audio.unlock();
  const [p12, p25, p50, , bass] = r.ctx.waves;
  for (const [w, duty] of [[p12, 0.125], [p25, 0.25], [p50, 0.5]]) {
    let hi = 0, mean = 0; const N = 2000;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * 2 * Math.PI; let y = 0;
      for (let k = 1; k < w.real.length; k++) y += w.real[k] * Math.cos(k * th) + w.imag[k] * Math.sin(k * th);
      if (y > 0) hi++; mean += y;
    }
    assert.ok(Math.abs(hi / N - duty) < 0.01, `duty ${duty}: ${hi / N}`);
    assert.ok(Math.abs(mean / N) < 0.01, "zero mean");
  }
  const upper = bass.imag.slice(2).reduce((a, b) => a + b * b, 0), fund = bass.imag[1] ** 2;
  assert.ok(upper > fund * 0.5, "the bass has more than a bare sine: harmonics for phone speakers");
});

/* ══════════════ mixer, ducking, crossfade ══════════════ */

test("music passes through the high-pass and the duck; sfx bypass the duck", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 0.5);
  r.audio.sfx("goldHatch"); r.audio.sfx("egg");
  const g = r.audio._g;
  const music = r.ctx.sources.find((s) => s.kind === "osc" && near(s.frequency.value, hz(72), 1e-3));
  assert.ok(reaches(music, g.hp) && reaches(music, g.duck) && reaches(music, r.ctx.destination));
  const sfxSources = r.ctx.sources.filter((s) => s.startTime !== null && s.startTime >= r.ctx.currentTime && !near(s.frequency.value, hz(72), 1e-3) && s.kind === "osc");
  assert.ok(sfxSources.length > 3);
  for (const s of sfxSources) {
    if (!reaches(s, g.sfxBus)) continue; // music notes scheduled in the same window
    assert.equal(reaches(s, g.duck), false, "an sfx voice never goes through the duck");
    assert.ok(reaches(s, r.ctx.destination));
  }
  assert.equal(g.hp.frequency.value, 90);
  // master chain: compressor and soft clipper before the mute gain
  assert.ok(reaches(g.mix, g.comp) && reaches(g.comp, g.shaper) && reaches(g.shaper, g.out) && reaches(g.out, r.ctx.destination));
  assert.ok(g.shaper.curve instanceof Float32Array);
  assert.ok(Math.max(...g.shaper.curve) < 0.98 && Math.min(...g.shaper.curve) > -0.98, "the clipper can never exceed 0.97");
});

test("the four key cues duck the music ~8-10 dB, hold for the cue, then release; ordinary cues do not", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  const p = r.audio._g.duck.gain;
  const n0 = p.events.length;
  r.audio.sfx("egg"); r.audio.sfx("jump"); r.audio.sfx("land");
  assert.equal(p.events.length, n0, "ordinary cues leave the music alone");
  const T = r.ctx.currentTime + 0.004;
  r.audio.sfx("goldHatch");
  const ev = p.events.slice(n0);
  assert.equal(ev[0].type, "set"); assert.equal(ev[0].v, 1);
  const dip = ev.find((e) => e.type === "target" && e.v < 1), rel = ev.find((e) => e.type === "target" && e.v === 1);
  assert.ok(near(dip.t, T) && near(dip.v, Math.pow(10, -10 / 20), 1e-6), "−10 dB starting with the cue");
  assert.ok(near(rel.t, T + SFX_INFO.goldHatch.duck.seconds), "released when the cue ends");
  assert.ok(rel.tc > dip.tc, "the music swells back slower than it dipped");
  for (const [name, db] of [["checkpoint", 8], ["ducklingLost", 9], ["beacon", 10]]) {
    run(r, 3.2); // let each cue and its duck finish
    const m = p.events.length;
    assert.ok(r.audio.sfx(name), name);
    const dv = p.events.slice(m).find((e) => e.type === "target" && e.v < 1);
    assert.ok(dv && near(dv.v, Math.pow(10, -db / 20), 1e-6), `${name} ducks ${db} dB`);
  }
});

test("overlapping duck cues merge: the dip stays as deep as the deepest and lasts until the last one ends", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  r.audio.sfx("goldHatch"); run(r, 0.3);
  const p = r.audio._g.duck.gain, m = p.events.length, now = r.ctx.currentTime;
  r.audio.sfx("checkpoint");
  const ev = p.events.slice(m);
  const dip = ev.find((e) => e.type === "target" && e.v < 1), rel = ev.find((e) => e.type === "target" && e.v === 1);
  assert.ok(near(dip.v, Math.pow(10, -10 / 20), 1e-6), "keeps the deeper dip");
  const goldEnd = r.audio._g.duckModel.relT;
  assert.ok(rel.t >= now + SFX_INFO.checkpoint.duck.seconds - 1e-6 && rel.t >= goldEnd - 1e-9);
  const hold = ev[0];
  assert.ok(hold.v < 0.5, "the automation continues from the already ducked level, not from 1 (no jump)");
});

test("crossfade: the old song fades out and the new one in over the requested time, equal-power, new song from its start", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 5.05);
  const T = r.ctx.currentTime, fade = 3.5;
  const [pa] = r.audio._players;
  r.audio.playSong("b", { fade });
  const pb = r.audio._players.find((p) => p.id === "b");
  assert.equal(r.audio.stats.players, 2);
  const ga = pa.bus.gain.events.filter((e) => e.t >= T - 1e-9), gb = pb.bus.gain.events;
  assert.ok(near(ga[ga.length - 1].t, T + T0 + fade, 1e-9) && near(ga[ga.length - 1].v, 0, 1e-9), "old song ends at 0 after the fade");
  assert.ok(near(gb[gb.length - 1].t, T + T0 + fade, 1e-9) && near(gb[gb.length - 1].v, 1, 1e-9), "new song ends at 1");
  for (let i = 1; i < ga.length; i++) assert.ok(ga[i].v <= ga[i - 1].v + 1e-12, "old fades monotonically down");
  for (let i = 1; i < gb.length; i++) assert.ok(gb[i].v >= gb[i - 1].v - 1e-12, "new rises monotonically");
  for (const f of [0.25, 0.5, 0.75]) {
    const tt = T + T0 + fade * f, a = pa.levelAt(tt), b = pb.levelAt(tt);   // both fades start together, at the new song's first step
    assert.ok(Math.abs(a * a + b * b - 1) < 0.02, `equal power at ${f}: ${a * a + b * b}`);
  }
  run(r, 0.5);
  assert.ok(startsOf(r.ctx, 90).length >= 1, "the new song starts at its beginning");
  assert.ok(near(startsOf(r.ctx, 90)[0], T + T0, 1e-9));
  // the old song keeps playing through the fade and stops being scheduled after it
  run(r, 4);
  const lateA = startsOf(r.ctx, 72).filter((s) => s >= T + T0 + fade + 0.05);
  assert.equal(lateA.length, 0, "no notes of the old song after the fade");
  assert.ok(startsOf(r.ctx, 72).some((s) => s > T && s < T + T0 + fade), "the old song played on during the fade");
  run(r, 0.5);
  assert.equal(r.audio.stats.players, 1, "the old player was retired");
  assert.ok(pa.nodes.length === 0, "its layer chain is disconnected");
});

test("changing song again mid-crossfade never rewrites live automation and the level stays continuous", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 3);
  r.audio.playSong("b", { fade: 3.5 }); run(r, 1.5);
  const pb = r.audio._players.find((p) => p.id === "b");
  const eventsBefore = pb.bus.gain.events.length;
  const t = r.ctx.currentTime + T0;                    // the next fade starts here
  const levelBefore = pb.levelAt(t);
  assert.ok(levelBefore > 0.2 && levelBefore < 0.95, "caught mid-fade: " + levelBefore);
  r.audio.playSong("a", { fade: 3.5 });
  assert.equal(pb.bus.gain.events.length, eventsBefore, "the running fade-in was left alone (no cancel, no rewrite)");
  assert.equal(pb.stages.length, 2, "the fade-out went into a second gain stage in series");
  assert.ok(near(pb.levelAt(t), levelBefore, 1e-9), "continuous at the switch");
  const s2 = pb.stages[1].node.gain.events;
  assert.equal(s2[0].v, 1); assert.ok(near(s2[s2.length - 1].v, 0, 1e-9) && near(s2[s2.length - 1].t, t + 3.5, 1e-9));
  assert.ok(reaches(pb.bus, r.audio._g.musicBus) && pb.bus.outputs.has(pb.stages[1].node), "the stages are chained to the music bus");
  for (let f = 0.1; f < 1; f += 0.1) assert.ok(pb.levelAt(t + 3.5 * f) <= pb.levelAt(t + 3.5 * (f - 0.1)) + 1e-9 || pb.levelAt(t + 3.5 * f) < 0.99);
  run(r, 6);
  assert.equal(r.audio.stats.players, 1);
});

test("the egg blip's pitch rises along a streak and resets after a pause", () => {
  const r = rig(SONGS);
  r.audio.unlock();
  const tops = [];
  const topOf = (since) => r.ctx.sources.slice(since).find((s) => s.kind === "osc" && s.frequency.events.length >= 2);
  for (let i = 0; i < 6; i++) {
    const n = r.ctx.sources.length;
    assert.ok(r.audio.sfx("egg"), "egg " + i);
    tops.push(topOf(n).frequency.events[1].v);
    run(r, 0.12);
  }
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1] * 1.05, `streak step ${i}: ${tops[i]} > ${tops[i - 1]}`);
  run(r, 1.5);
  const n = r.ctx.sources.length;
  r.audio.sfx("egg");
  const base = topOf(n).frequency.events[1].v;
  assert.ok(base < tops[1], "after a pause the ladder starts over");
  assert.ok(base > 1000 && base < 1100, "the first blip is around C6: " + base);
  assert.ok(Math.max(...tops) < 2500, "the top of the ladder stays below 2.5 kHz (never shrill)");
});

/* ══════════════ sfx ══════════════ */

test("all 20 sfx names exist, are synthesized, and free their nodes when they finish", () => {
  assert.equal(SFX_NAMES.length, 20);
  for (const n of ["egg", "goldHatch", "ducklingLost", "checkpoint", "beacon", "jump", "land", "stomp", "spring", "hit", "shield", "shieldBreak", "magnet", "crumble", "fall", "dead", "chapter", "ui", "uiBack", "steer"]) assert.ok(SFX_NAMES.includes(n), n);
  const r = rig({});
  r.audio.unlock(); run(r, 0.2);
  const base = r.ctx.live.size;
  for (const n of SFX_NAMES) {
    const before = r.ctx.created.length;
    assert.ok(r.audio.sfx(n), n);
    assert.ok(r.ctx.created.length > before + 1, n + " builds nodes");
    run(r, 4); // longer than the longest cue
    assert.equal(r.ctx.live.size, base, `${n}: every node disconnected after it finished`);
  }
  assert.equal(r.audio.sfx("notACue"), false);
});

test("cue lengths: goldHatch ~0.9 s, beacon ~2.5 s, checkpoint two notes, ducklingLost descends", () => {
  const r = rig({});
  r.audio.unlock(); run(r, 0.2);
  const endOf = (name, o) => {
    const n = r.ctx.sources.length, t = r.ctx.currentTime;
    r.audio.sfx(name, o);
    const mine = r.ctx.sources.slice(n);
    run(r, 3.2);
    return { end: Math.max(...mine.map((s) => s.stopTime)) - t, mine };
  };
  const gold = endOf("goldHatch"), beacon = endOf("beacon"), lost = endOf("ducklingLost"), chk = endOf("checkpoint");
  assert.ok(gold.end > 0.8 && gold.end < 1.1, "goldHatch " + gold.end);
  assert.ok(beacon.end > 2.3 && beacon.end < 3.1, "beacon " + beacon.end);
  assert.ok(lost.end > 0.6 && lost.end < 1.0, "ducklingLost " + lost.end);
  assert.ok(chk.end > 0.6 && chk.end < 1.0, "checkpoint " + chk.end);
  // ducklingLost: its peeps glide downward
  const peeps = lost.mine.filter((s) => s.kind === "osc" && s.frequency.events.length >= 3);
  assert.ok(peeps.length >= 2);
  for (const p of peeps) assert.ok(p.frequency.events[p.frequency.events.length - 1].v < p.frequency.events[0].v, "descending peep");
  // goldHatch: four chime notes at rising pitches
  const chimes = gold.mine.filter((s) => s.kind === "osc" && s.frequency.events.length === 1 && s.periodicWave).sort((a, b) => a.startTime - b.startTime);
  const f = chimes.map((s) => s.frequency.events[0].v);
  assert.ok(f.length >= 4 && f[0] < f[1] && f[1] < f[2] && f[2] < f[3], "rising chime " + f.join(","));
  // checkpoint: exactly two main notes (horn), the second longer
  const horns = chk.mine.filter((s) => s.kind === "osc" && s.periodicWave && s.frequency.events[0].v < 2000 && s.frequency.events[0].v > 1000);
  assert.equal(horns.length, 2, "two-note flourish");
  assert.ok(horns[1].stopTime - horns[1].startTime > horns[0].stopTime - horns[0].startTime);
});

test("sfx are rate limited so a magnet pulling many eggs cannot flood the graph", () => {
  const r = rig({});
  r.audio.unlock(); run(r, 0.1);
  let played = 0;
  for (let i = 0; i < 200; i++) { if (r.audio.sfx("egg")) played++; run(r, 0.005, 0.005); } // 200 eggs in one second
  assert.ok(played <= 30 && played >= 10, "played " + played);
  played = 0;
  for (let i = 0; i < 50; i++) { if (r.audio.sfx("goldHatch")) played++; run(r, 0.01, 0.01); }
  assert.ok(played <= 2, "goldHatch cannot stack: " + played);
});

test("handle() maps sim events to cues; a golden hatch sounds once; respawn / cue / start are silent", () => {
  const r = rig({});
  r.audio.unlock(); run(r, 0.1);
  const calls = [];
  r.audio.sfx = (name, opts) => { calls.push([name, opts]); return true; };
  const ev = (type, extra = {}) => r.audio.handle({ type, ...extra });
  ev("jump"); ev("land", { hard: true }); ev("land", { hard: false }); ev("egg");
  ev("gold", { hatched: true }); ev("hatch", { flock: 2 });                       // ONE goldHatch for the pair
  run(r, 1);
  ev("gold", { hatched: false });                                                // full flock: still a (chick-less) fanfare
  run(r, 1);
  ev("hatch", { flock: 1 });                                                      // a lone 'hatch' still sounds
  for (const t of ["shield", "shield-break", "magnet", "stomp", "spring", "hit", "duckling-lost", "fall", "checkpoint", "crumble-start", "chapter-enter", "dead", "exit", "beacon"]) ev(t);
  ev("steer", { dir: -1 });
  for (const t of ["respawn", "cue", "start", "crumble-fall", "unknown"]) ev(t);
  assert.deepEqual(calls.map((c) => c[0]), [
    "jump", "land", "land", "egg", "goldHatch", "goldHatch", "goldHatch",
    "shield", "shieldBreak", "magnet", "stomp", "spring", "hit", "ducklingLost", "fall", "checkpoint", "crumble", "chapter", "dead", "chapter", "beacon", "steer",
  ]);
  assert.equal(calls[1][1].hard, true); assert.equal(calls[2][1].hard, false);
  assert.equal(calls[5][1].full, true, "the fourth+ golden egg with a full flock plays the chick-less variant");
  assert.equal(calls[21][1].dir, -1);
});

/* ══════════════ an hour of play ══════════════ */

test("a simulated hour: the node count stays bounded, one timer, no drift, song changes and pauses included", () => {
  // a busy 8-bar song: hats on every 16th, 8th-note lead, pad, bell, plus a crossfade every 2 minutes
  const hats = Array.from({ length: 128 }, (_, i) => [i, i % 2 ? "h" : "o", 0.5]);
  const busy = (id, root) => ({
    id, bpm: 120, bars: 8, swing: 0.1, layers: [
      { name: "drums", inst: "kit", vol: 0.6, hits: [...hats, ...Array.from({ length: 32 }, (_, i) => [i * 4, i % 2 ? "s" : "k"])] },
      { name: "lead", inst: "sawLead", vol: 0.6, fx: { vibrato: { rate: 5, depth: 20, delaySteps: 2 }, delay: { beats: 0.75, feedback: 0.4, mix: 0.2 } }, notes: Array.from({ length: 64 }, (_, i) => [i * 2, root + (i * 5) % 12, 2]) },
      { name: "pad", inst: "pad", vol: 0.4, notes: Array.from({ length: 8 }, (_, i) => [i * 16, root - 12, 16]) },
      { name: "bell", inst: "bell", vol: 0.4, fx: { delay: { beats: 1, feedback: 0.5, mix: 0.3 } }, notes: Array.from({ length: 32 }, (_, i) => [i * 4 + 1, root + 12 + (i % 7), 3]) },
      { name: "bass", inst: "bassPulse", vol: 0.7, notes: Array.from({ length: 64 }, (_, i) => [i * 2, root - 24 + (i % 4) * 2, 1]) },
    ],
  });
  const r = rig({ x: busy("x", 60), y: busy("y", 65) });
  r.audio.unlock(); r.audio.playSong("x"); run(r, 3);
  const base = r.ctx.live.size;
  const events = ["jump", "land", "egg", "egg", "egg", "gold", "hatch", "stomp", "spring", "steer", "shield", "hit", "duckling-lost", "checkpoint", "crumble-start", "magnet", "chapter-enter"];
  let maxLive = 0, maxVoices = 0, maxPlayers = 0, songs = ["x", "y"], si = 0, k = 0;
  const dt = 0.025, ticks = Math.round(3600 / dt);
  for (let i = 0; i < ticks; i++) {
    r.ctx.advance(dt); r.timers.fire();
    if (i % 10 === 0) r.audio.handle({ type: events[(i / 10) % events.length | 0] });       // a sim event every 250 ms
    if (i % 4800 === 0 && i > 0) { si ^= 1; r.audio.playSong(songs[si], { fade: 3.5 }); }  // a landscape change every 2 minutes
    if (i % 24000 === 0 && i > 0) { r.audio.suspend(); r.audio.resume(); r.audio.setMuted(true); r.audio.setMuted(false); } // every 10 minutes
    if (i % 40 === 0) {
      maxLive = Math.max(maxLive, r.ctx.live.size); maxVoices = Math.max(maxVoices, r.audio.stats.voices); maxPlayers = Math.max(maxPlayers, r.audio.stats.players);
    }
    k++;
  }
  if (process.env.AUDIO_VERBOSE) console.log("hour:", { base, maxLive, maxVoices, maxPlayers, created: r.ctx.created.length, liveEnd: r.ctx.live.size, ticks });
  assert.equal(r.timers.count, 1, "still exactly one scheduler");
  assert.ok(r.ctx.created.length > 100000, "an hour of music created " + r.ctx.created.length + " nodes in total");
  assert.ok(maxLive < base + 250, `live nodes stayed bounded: max ${maxLive}, steady ${base}`);
  assert.ok(r.ctx.live.size < base + 60, `and they are released again: ${r.ctx.live.size} live at the end (steady ${base})`);
  assert.ok(maxVoices < 80, "voices bounded: " + maxVoices);
  assert.ok(maxPlayers <= 2, "at most the playing and the fading song: " + maxPlayers);
  // no drift after an hour: the cursor is an integer step counter and sits within the lookahead of the clock
  const player = r.audio._active;
  assert.ok(Number.isInteger(player.next), "integer step counter");
  const cursor = player.t0 + player.next * 0.125;
  assert.ok(cursor > r.ctx.currentTime - 0.2 && cursor < r.ctx.currentTime + 0.5, "the cursor stays within the lookahead of the clock: no drift");
});

test("no drift in an hour: every one of ~28,800 hats lands on t0 + n*stepDur (to a nanosecond), with the loop wrapping 900 times", () => {
  const hats = { id: "h", bpm: 120, bars: 2, swing: 0, layers: [{ name: "hat", inst: "kit", vol: 0.5, hits: Array.from({ length: 32 }, (_, i) => [i, "h", 0.5]) }] };
  const r = rig({ h: hats });
  r.audio.unlock(); r.audio.playSong("h");
  run(r, 3600);
  const hits = r.ctx.sources.filter((x) => x.kind === "buf" && x.startTime >= T0 - 1e-9).map((x) => x.startTime).sort((a, b) => a - b); // (not the iOS silent unlock buffer at t=0)
  assert.ok(hits.length > 28700, "hats scheduled: " + hits.length);
  let worst = 0;
  hits.forEach((t, i) => { worst = Math.max(worst, Math.abs(t - (T0 + i * 0.125))); });
  assert.ok(worst < 1e-9, "worst deviation from the grid after an hour: " + worst + " s");
});

test("renderOffline schedules a song and sfx on an offline context (sfx at their absolute times, duck included)", async () => {
  class FakeOffline extends FakeContext {
    constructor(ch, length, sr) { super({}); this.channels = ch; this.length = length; this.sampleRate = sr; this.state = "suspended"; }
    startRendering() { this.rendered = true; return Promise.resolve({ numberOfChannels: this.channels, length: this.length, sampleRate: this.sampleRate }); }
  }
  FakeContext.instances.length = 0;
  const audio = new GameAudio({ songs: SONGS, OfflineAudioContextClass: FakeOffline, AudioContextClass: FakeContext, timers: fakeTimers() });
  const buf = await audio.renderOffline("a", 9, 32000, { sfx: [[6.0, "goldHatch"], [2.0, "egg", { streak: 3 }]] });
  const ctx = FakeContext.instances[0];
  assert.equal(buf.numberOfChannels, 2);
  assert.equal(buf.length, 9 * 32000);
  assert.ok(ctx.rendered);
  const s72 = startsOf(ctx, 72);
  assert.deepEqual(s72.map((x) => +x.toFixed(6)), [0, 4, 8], "from time 0, looping, up to the render length");
  const duck = [...ctx.live].find((n) => n.kind === "gain" && n.params[0].events.some((e) => e.type === "target" && e.v < 1));
  assert.ok(duck, "a duck was automated");
  assert.ok(near(duck.params[0].events.find((e) => e.type === "target" && e.v < 1).t, 6.0));
  // startAt skips into the song
  FakeContext.instances.length = 0;
  await audio.renderOffline("a", 3, 32000, { startAt: 2.0, music: true });
  const ctx2 = FakeContext.instances[0];
  assert.ok(near(startsOf(ctx2, 76)[0], 0, 1e-9), "step 16 (2 s into the song) sounds at time 0: " + startsOf(ctx2, 76)[0]);
  assert.ok(near(startsOf(ctx2, 72)[0], 2.0, 1e-9), "and the loop wraps 2 s later");
});

/* ══════════════ the real songs (skipped until music.mjs exists) ══════════════ */

test("music.mjs, when it exists: every song the game asks for is there, well-formed, and plays", async (t) => {
  const url = process.env.AUDIO_TEST_MUSIC ? pathToFileURL(process.env.AUDIO_TEST_MUSIC).href : new URL("../docs/js/music.mjs", import.meta.url).href;
  let mod;
  try { mod = await import(url); } catch (e) {
    if (e && e.code === "ERR_MODULE_NOT_FOUND" && /music\.mjs/.test(String(e.message))) return t.skip("music.mjs has not been written yet");
    throw e;   // a half-written or broken file must not hide
  }
  const { SONGS } = mod;
  assert.ok(SONGS && typeof SONGS === "object", "music.mjs exports SONGS");
  const want = ["title", ...CHAPTERS.map((c) => c.song), "beacon"];
  const missing = want.filter((id) => !SONGS[id]);
  assert.deepEqual(missing, [], "songs the game will ask for but music.mjs does not have: " + missing.join(", "));
  for (const id of want) {
    // duration advice (100-170 s) is a warning of tools/audio-render.mjs; structural problems fail here
    const problems = lintSong(SONGS[id]).filter((m) => !/loop is [\d.]+ s/.test(m));
    assert.deepEqual(problems, [], `${id} has problems`);
    assert.ok(SONGS[id].layers.length >= 3, `${id} has at least three layers`);
    const r = rig({ [id]: SONGS[id] });
    r.audio.unlock(); r.audio.playSong(id);
    assert.doesNotThrow(() => run(r, 4));
    assert.ok(r.ctx.sources.length > 5, `${id} makes sound`);
    r.audio.dispose();
  }
});

/* ══════════════ audit additions: lifecycle under a context whose state changes late ══════════════ */

/**
 * A real AudioContext does not change `state` the instant suspend() / resume() is called: the change is applied later on
 * the audio thread and announced with 'statechange'. This fake queues the requests and applies them in order on flush().
 */
class LaggyContext extends FakeContext {
  constructor(o) { super(o); this.pending = []; this.state = "running"; }
  resume() { this.stateLog.push("resume"); this.pending.push("running"); return Promise.resolve(); }
  suspend() { this.stateLog.push("suspend"); this.pending.push("suspended"); return Promise.resolve(); }
  flush() { while (this.pending.length) { const s = this.pending.shift(); if (s !== this.state) { this.state = s; this.fire("statechange"); } } }
}

test("suspend() then an immediate resume() ends running even though state still says 'running' when resume is asked", () => {
  FakeContext.instances.length = 0;
  const timers = fakeTimers();
  const audio = new GameAudio({ songs: SONGS, AudioContextClass: LaggyContext, timers });
  const ctx = () => FakeContext.instances[0];
  audio.unlock(); ctx().flush(); audio.playSong("a");
  for (let i = 0; i < 20; i++) { ctx().advance(0.025); timers.fire(); }
  assert.equal(ctx().state, "running");
  audio.suspend(); audio.resume();                       // a visibility storm: no time for the state to change in between
  assert.equal(ctx().pending[ctx().pending.length - 1], "running", "resume() really asks the context to run (it must not rely on a later statechange: iOS only honours resume() inside a gesture)");
  ctx().flush(); ctx().flush();
  assert.equal(ctx().state, "running", "the last request wins");
  audio.resume(); audio.suspend(); audio.resume(); audio.suspend();
  ctx().flush(); ctx().flush();
  assert.equal(ctx().state, "suspended", "…and when the last request is suspend, it is suspended and stays so");
  assert.equal(timers.count, 0);
  assert.equal(ctx().pending.length, 0);
});

test("when the OS gives the context back late, statechange never fights our own suspend", () => {
  FakeContext.instances.length = 0;
  const timers = fakeTimers();
  const audio = new GameAudio({ songs: SONGS, AudioContextClass: LaggyContext, timers });
  const ctx = () => FakeContext.instances[0];
  audio.unlock(); ctx().flush();
  audio.suspend(); ctx().flush();
  for (let i = 0; i < 5; i++) ctx().fire("statechange");
  ctx().flush();
  assert.equal(ctx().state, "suspended");
  audio.setMuted(true); audio.setMuted(false); audio.setMuted(true);
  ctx().flush();
  assert.equal(ctx().state, "suspended");
});

test("song changes in rapid succession (a stuttering caller) never pile up players or voices", () => {
  const busy = (id, root) => ({
    id, bpm: 120, bars: 4, layers: [
      { name: "drums", inst: "kit", vol: 0.6, hits: Array.from({ length: 64 }, (_, i) => [i, i % 2 ? "h" : "o", 0.5]) },
      { name: "lead", inst: "sawLead", vol: 0.6, fx: { vibrato: { rate: 5, depth: 20, delaySteps: 2 }, delay: { beats: 0.75, feedback: 0.4, mix: 0.2 } }, notes: Array.from({ length: 32 }, (_, i) => [i * 2, root + (i * 5) % 12, 2]) },
      { name: "pad", inst: "pad", vol: 0.4, notes: Array.from({ length: 4 }, (_, i) => [i * 16, root - 12, 16]) },
      { name: "bell", inst: "bell", vol: 0.4, fx: { delay: { beats: 1, feedback: 0.5, mix: 0.3 } }, notes: Array.from({ length: 16 }, (_, i) => [i * 4 + 1, root + 12 + (i % 7), 3]) },
      { name: "bass", inst: "bassPulse", vol: 0.7, notes: Array.from({ length: 32 }, (_, i) => [i * 2, root - 24 + (i % 4) * 2, 1]) },
    ],
  });
  const ids = ["p", "q", "r", "s"], songs = Object.fromEntries(ids.map((id, i) => [id, busy(id, 55 + i * 3)]));
  const r = rig(songs);
  r.audio.unlock(); r.audio.playSong("p"); run(r, 2);
  const base = r.ctx.live.size;
  const storm = (changes, every, fade) => {
    let maxPlayers = 0, maxVoices = 0, maxLive = 0;
    for (let i = 0; i < changes; i++) {
      r.audio.playSong(ids[(i + 1) % 4], { fade });
      run(r, every);
      maxPlayers = Math.max(maxPlayers, r.audio.stats.players); maxVoices = Math.max(maxVoices, r.audio.stats.voices); maxLive = Math.max(maxLive, r.ctx.live.size);
    }
    return { maxPlayers, maxVoices, maxLive };
  };
  // (a) Mama backs up over a landscape boundary and rolls on again, over and over: a change every 1.5 s, each asking for a 3.5 s fade
  const hover = storm(40, 1.5, 3.5);
  run(r, 5);
  assert.ok(hover.maxPlayers <= MAX_PLAYERS_EXPECTED, "players while hovering at a boundary: " + hover.maxPlayers);
  assert.equal(r.audio.stats.players, 1, "one song left once it settles");
  // (b) a caller gone mad: 20 changes a second
  const mad = storm(80, 0.05, 3.5);
  run(r, 5);
  if (process.env.AUDIO_VERBOSE) console.log("churn:", { base, hover, mad });
  assert.ok(mad.maxPlayers <= 12, "players with a change 20 times a second: " + mad.maxPlayers);
  assert.ok(mad.maxVoices <= 150, "voices stay under the cap: " + mad.maxVoices);
  assert.equal(r.audio.stats.players, 1, "one song left once the dust settles");
  assert.ok(r.ctx.live.size < base + 60, "and its nodes are released: " + r.ctx.live.size + " vs " + base);
  assert.equal(r.timers.count, 1);
});
const MAX_PLAYERS_EXPECTED = 4;

test("lifecycle fuzz: random unlock / suspend / resume / mute / playSong / sfx storms keep one scheduler and never sound while off", () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[(rnd() * a.length) | 0];
  for (const Ctx of [FakeContext, LaggyContext, FakeContext, LaggyContext, FakeContext, LaggyContext]) {   // six different random runs (the generator carries on between them)
    FakeContext.instances.length = 0;
    const timers = fakeTimers();
    const audio = new GameAudio({ muted: rnd() < 0.5, songs: SONGS, AudioContextClass: Ctx, timers });
    let maxLive = 0, maxPlayers = 0, maxTimers = 0;
    const ops = ["unlock", "unlock", "suspend", "resume", "mute", "unmute", "song", "song", "stop", "sfx", "sfx", "handle", "advance", "advance", "advance", "visibility"];
    for (let i = 0; i < 6000; i++) {
      const op = pick(ops);
      const ctx = FakeContext.instances[0];
      const sources = ctx ? ctx.sources.length : 0;
      const off = audio.muted || audio._suspended;
      if (op === "unlock") audio.unlock();
      else if (op === "suspend") audio.suspend();
      else if (op === "resume") audio.resume();
      else if (op === "mute") audio.setMuted(true);
      else if (op === "unmute") audio.setMuted(false);
      else if (op === "song") audio.playSong(pick(["a", "b", "nothing"]), { fade: pick([0, 0.4, 3.5]) });
      else if (op === "stop") audio.stopSong({ fade: pick([0, 1]) });
      else if (op === "sfx") audio.sfx(pick(SFX_NAMES));
      else if (op === "handle") audio.handle({ type: pick(["jump", "egg", "gold", "hatch", "beacon", "checkpoint", "dead"]), hatched: rnd() < 0.5 });
      else if (op === "advance" && ctx) { const n = 1 + ((rnd() * 40) | 0); for (let k = 0; k < n; k++) { ctx.advance(0.025); if (ctx.flush && rnd() < 0.3) ctx.flush(); timers.fire(); } }
      if (ctx && ctx.flush && rnd() < 0.5) ctx.flush();
      if (["sfx", "handle", "song", "stop"].includes(op) && off) assert.equal(ctx ? ctx.sources.length : 0, sources, `${op} while off created sound (iteration ${i})`);
      maxTimers = Math.max(maxTimers, timers.count);
      assert.ok(timers.count <= 1, `more than one scheduler at iteration ${i} after ${op}`);
      const made = FakeContext.instances[0];                 // (unlock may just have created it)
      const want = !!made && !audio.muted && !audio._suspended;
      assert.equal(timers.count, want ? 1 : 0, `timer ${timers.count} but wantRun=${want} after ${op} (iteration ${i})`);
      if (made) { maxLive = Math.max(maxLive, made.live.size); maxPlayers = Math.max(maxPlayers, audio.stats.players); }
    }
    const ctx = FakeContext.instances[0];
    if (ctx.flush) { ctx.flush(); ctx.flush(); }
    audio.resume(); audio.setMuted(false);
    if (ctx.flush) { ctx.flush(); ctx.flush(); }
    assert.equal(ctx.state, "running", Ctx.name + ": after the storm, resume + unmute runs the context");
    assert.equal(FakeContext.instances.length, 1, "one context for the whole session");
    assert.ok(maxPlayers <= 5, Ctx.name + " players " + maxPlayers);
    assert.ok(maxLive < 1500, Ctx.name + " live nodes " + maxLive);
    audio.suspend(); audio.dispose();
    assert.equal(timers.count, 0);
  }
});

test("a hidden page / pagehide silences the music by itself (backstop for a main.mjs that forgets suspend()), without ever un-pausing a suspended game", () => {
  const listeners = {};
  const target = (extra = {}) => ({ ...extra, addEventListener(t, f) { (listeners[t] || (listeners[t] = new Set())).add(f); }, removeEventListener(t, f) { listeners[t] && listeners[t].delete(f); } });
  const doc = target({ visibilityState: "visible" }), win = target();
  const emit = (t) => [...(listeners[t] || [])].forEach((f) => f());
  const r = rig(SONGS, { document: doc, window: win });
  r.audio.unlock(); r.audio.playSong("a"); run(r, 1);
  assert.equal(r.timers.count, 1);
  doc.visibilityState = "hidden"; emit("visibilitychange");
  assert.equal(r.ctx.state, "suspended", "hidden: context suspended");
  assert.equal(r.timers.count, 0, "hidden: no scheduler");
  assert.equal(r.audio.sfx("egg"), false, "hidden: sfx do nothing");
  const n = r.ctx.created.length;
  r.audio.resume();                                                    // main resuming while the page is still hidden changes nothing
  assert.equal(r.ctx.state, "suspended"); assert.equal(r.timers.count, 0);
  doc.visibilityState = "visible"; emit("visibilitychange");
  assert.equal(r.ctx.state, "running", "visible again and nobody paused the game: the song continues");
  assert.equal(r.timers.count, 1);
  run(r, 1);
  assert.equal(r.audio.stats.players, 1, "the same song, no restart");
  // main pauses (suspend) and the page goes hidden and visible: it stays silent until main's own resume()
  r.audio.suspend(); doc.visibilityState = "hidden"; emit("visibilitychange"); doc.visibilityState = "visible"; emit("visibilitychange");
  assert.equal(r.ctx.state, "suspended"); assert.equal(r.timers.count, 0);
  r.audio.resume(); assert.equal(r.ctx.state, "running"); assert.equal(r.timers.count, 1);
  // pagehide (iOS bfcache / app switch) and pageshow
  emit("pagehide"); assert.equal(r.ctx.state, "suspended");
  emit("pageshow"); assert.equal(r.ctx.state, "running");
  // a storm of them keeps one scheduler
  for (let i = 0; i < 50; i++) { doc.visibilityState = i % 2 ? "visible" : "hidden"; emit("visibilitychange"); emit(i % 3 ? "pagehide" : "pageshow"); assert.ok(r.timers.count <= 1); }
  doc.visibilityState = "visible"; emit("visibilitychange");
  assert.equal(r.timers.count, 1);
  // the OS un-suspends the context (iOS ends an interruption) while we are paused: we stop it again
  r.audio.suspend(); r.ctx.state = "running"; r.ctx.fire("statechange");
  assert.equal(r.ctx.state, "suspended", "an OS resume under a pause is undone");
  r.audio.resume();
  r.audio.dispose();
  assert.equal((listeners.visibilitychange || new Set()).size + (listeners.pagehide || new Set()).size + (listeners.pageshow || new Set()).size, 0, "dispose removes its listeners");
  void n;
});

test("constructed without `songs` (DESIGN.md §9 shows `new GameAudio({ muted })`): music.mjs is imported on first use, and a missing or slow module is harmless", async () => {
  FakeContext.instances.length = 0;
  const timers = fakeTimers();
  const audio = new GameAudio({ muted: false, AudioContextClass: FakeContext, timers });
  audio.unlock();
  assert.doesNotThrow(() => { audio.playSong("meadow"); audio.playSong("meadow"); audio.playSong("beacon"); });
  await new Promise((res) => setTimeout(res, 100));                 // the import settles (resolved: the real songs; rejected: silence)
  assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) { FakeContext.instances[0].advance(0.025); timers.fire(); } });
  audio.dispose();
  const early = new GameAudio({ AudioContextClass: FakeContext, timers: fakeTimers() });
  early.unlock(); early.playSong("title"); early.dispose();         // disposed before the import resolves
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(early.stats.players, 0);
});

/* ══════════════ audit additions: pause / mute fade the master out before suspending the context (no click) ══════════════ */

function timersWithTimeouts() {
  const t = fakeTimers();
  t.tid = 0; t.timeouts = new Map();
  t.setTimeout = (fn, ms) => { const id = ++t.tid; t.timeouts.set(id, { fn, ms }); return id; };
  t.clearTimeout = (id) => { t.timeouts.delete(id); };
  t.fireTimeouts = () => { for (const [id, x] of [...t.timeouts]) { t.timeouts.delete(id); x.fn(); } };
  return t;
}

test("pause / mute ramp the master to silence first and suspend the context only afterwards; coming back in time never suspends at all", () => {
  FakeContext.instances.length = 0;
  const timers = timersWithTimeouts();
  const audio = new GameAudio({ songs: SONGS, AudioContextClass: FakeContext, timers });
  const ctx = () => FakeContext.instances[0], gain = () => audio._g.out.gain;
  audio.unlock(); audio.playSong("a");
  for (let i = 0; i < 80; i++) { ctx().advance(0.025); timers.fire(); }
  assert.equal(ctx().state, "running");
  const t = ctx().currentTime;
  audio.suspend();
  assert.equal(timers.count, 0, "the scheduler stops at once: no new notes");
  assert.equal(ctx().state, "running", "the context is still running while the fade plays");
  assert.equal(audio.sfx("egg"), false, "no new sfx either");
  let ev = gain().events.filter((e) => e.t >= t - 1e-9);
  assert.equal(ev[0].type, "set"); assert.ok(near(ev[0].v, 1), "the fade starts from full level");
  const ramp = ev.find((e) => e.type === "lin");
  assert.ok(ramp && ramp.v === 0 && ramp.t > t && ramp.t - t < 0.06, "a short linear ramp to silence, not a step");
  assert.equal(timers.timeouts.size, 1);
  assert.ok([...timers.timeouts.values()][0].ms >= (ramp.t - t) * 1000, "the suspend is scheduled after the ramp has finished");
  timers.fireTimeouts();
  assert.equal(ctx().state, "suspended");
  // a second stop request while already stopped changes nothing (still no timer)
  audio.suspend(); audio.setMuted(true);
  assert.equal(timers.timeouts.size, 0);
  // coming back inside the fade window: the context is never suspended and the master ramps up from its current level
  audio.setMuted(false); audio.resume();
  for (let i = 0; i < 40; i++) { ctx().advance(0.025); timers.fire(); }
  const logBefore = ctx().stateLog.length;
  audio.suspend(); ctx().advance(0.015); audio.resume();
  assert.equal(timers.timeouts.size, 0, "resume() cancelled the pending suspend");
  assert.equal(timers.count, 1, "one scheduler");
  assert.equal(ctx().state, "running");
  timers.fireTimeouts();
  assert.equal(ctx().state, "running", "nothing suspended it");
  assert.ok(!ctx().stateLog.slice(logBefore).includes("suspend"), "suspend() was never called on the context");
  const e2 = gain().events;
  const last = e2[e2.length - 1];
  assert.ok(last.type === "lin" && last.v === 1, "back to full level");
  const set = e2[e2.length - 2];
  assert.ok(set.type === "set" && set.v > 0.2 && set.v < 0.9, "…ramping from where the fade had got to (" + set.v.toFixed(2) + "), not from 0 or 1");
  // dispose with a stop pending leaves no timer behind
  audio.suspend(); assert.equal(timers.timeouts.size, 1);
  audio.dispose(); assert.equal(timers.timeouts.size, 0);
});

test("the soft stop does not change the lifecycle guarantees: fuzz again with fade-then-suspend timers", () => {
  let seed = 777;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[(rnd() * a.length) | 0];
  for (const Ctx of [FakeContext, LaggyContext, FakeContext, LaggyContext, FakeContext, LaggyContext]) {
    FakeContext.instances.length = 0;
    const timers = timersWithTimeouts();
    const audio = new GameAudio({ muted: rnd() < 0.5, songs: SONGS, AudioContextClass: Ctx, timers });
    const ops = ["unlock", "suspend", "resume", "mute", "unmute", "song", "sfx", "handle", "advance", "advance", "fire", "fire"];
    for (let i = 0; i < 5000; i++) {
      const op = pick(ops), ctx = FakeContext.instances[0], n0 = ctx ? ctx.sources.length : 0;
      const off = audio.muted || audio._suspended;
      if (op === "unlock") audio.unlock(); else if (op === "suspend") audio.suspend(); else if (op === "resume") audio.resume();
      else if (op === "mute") audio.setMuted(true); else if (op === "unmute") audio.setMuted(false);
      else if (op === "song") audio.playSong(pick(["a", "b"]), { fade: pick([0.4, 3.5]) });
      else if (op === "sfx") audio.sfx(pick(SFX_NAMES));
      else if (op === "handle") audio.handle({ type: pick(["jump", "egg", "gold", "beacon"]) });
      else if (op === "fire") { timers.fireTimeouts(); }
      else if (op === "advance" && ctx) for (let k = 0; k < 1 + ((rnd() * 20) | 0); k++) { ctx.advance(0.025); if (ctx.flush && rnd() < 0.3) ctx.flush(); timers.fire(); }
      if (ctx && ctx.flush && rnd() < 0.5) ctx.flush();
      if (["sfx", "handle", "song"].includes(op) && off) assert.equal(ctx ? ctx.sources.length : 0, n0, `${op} while off made sound (iteration ${i})`);
      const want = !!FakeContext.instances[0] && !audio.muted && !audio._suspended;
      assert.equal(timers.count, want ? 1 : 0, `scheduler ${timers.count} vs wantRun ${want} (iteration ${i}, ${op})`);
      assert.ok(timers.timeouts.size <= 1, "at most one pending suspend");
      if (want) assert.equal(timers.timeouts.size, 0, "no pending suspend while we want sound");
    }
    const ctx = FakeContext.instances[0];
    audio.suspend(); timers.fireTimeouts(); if (ctx.flush) { ctx.flush(); ctx.flush(); }
    assert.equal(ctx.state, "suspended", Ctx.name + ": once the timer fires the context really is suspended");
    audio.resume(); audio.setMuted(false); if (ctx.flush) { ctx.flush(); ctx.flush(); }
    assert.equal(ctx.state, "running"); assert.equal(timers.count, 1);
    audio.dispose();
  }
});

test("a song changed away from before anyone could hear it is dropped at once; a third overlapping song makes the oldest leave quickly", () => {
  const r = rig(SONGS);
  r.audio.unlock(); r.audio.playSong("a"); run(r, 3);
  r.audio.playSong("b", { fade: 3.5 }); run(r, 0.05);          // b has only just started to fade in
  const n = r.audio.stats.players;
  assert.equal(n, 2);
  r.audio.playSong("a", { fade: 3.5 });                         // …and we change our mind
  assert.equal(r.audio.stats.players, 2, "b was dropped (inaudible), the new a replaces it: a (leaving) + a (new)");
  assert.ok(!r.audio._players.some((p) => p.id === "b"));
  // three overlapping songs: the oldest is cut short
  const r2 = rig({ a: SONG_A, b: SONG_B, c: { ...SONG_B, id: "c", bpm: 90 } });
  r2.audio.unlock(); r2.audio.playSong("a"); run(r2, 2);
  r2.audio.playSong("b", { fade: 8 }); run(r2, 1.5);
  r2.audio.playSong("c", { fade: 8 }); run(r2, 1.5);
  const [oldest] = r2.audio._players;
  assert.equal(oldest.id, "a");
  assert.ok(r2.audio.stats.players <= 3);
  r2.audio.playSong("a", { fade: 8 });                          // a 4th: the oldest must now be on a short fuse (0.25 s), not 8 s
  assert.ok(oldest.endTime - r2.ctx.currentTime < 0.5, "the oldest song is hurried out: " + (oldest.endTime - r2.ctx.currentTime));
  run(r2, 1);
  assert.ok(!r2.audio._players.includes(oldest), "and gone");
  assert.equal(r2.timers.count, 1);
});
