import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedStepper, AdaptiveRes, SaveThrottle, SongTracker, dprLadder } from '../docs/js/loop.mjs';
import { T } from '../docs/js/tuning.mjs';

/* ───────── FixedStepper ───────── */

test('FixedStepper: whole steps out, the remainder becomes alpha', () => {
  const s = new FixedStepper(T.step, T.maxFrame);
  assert.equal(s.advance(1 / 60), 2);
  assert.ok(Math.abs(s.alpha) < 1e-9 || s.alpha >= 0);
  const n = s.advance(0.0125);                 // 1.5 steps
  assert.equal(n, 1);
  assert.ok(s.alpha > 0.4 && s.alpha < 0.6, `alpha ${s.alpha}`);
});

test('FixedStepper: a frame longer than maxFrame is dropped, not caught up', () => {
  const s = new FixedStepper(T.step, T.maxFrame);
  const n = s.advance(5);                      // 5 s hidden then back
  assert.ok(n <= Math.ceil(T.maxFrame / T.step) + 1, `ran ${n} steps`);
  assert.ok(s.alpha >= 0 && s.alpha < 1);
});

test('FixedStepper: reset forgets banked time; bad dt is ignored', () => {
  const s = new FixedStepper(T.step, T.maxFrame);
  s.advance(0.005);
  s.reset();
  assert.equal(s.alpha, 0);
  assert.equal(s.advance(-1), 0);
  assert.equal(s.advance(NaN), 0);
});

test('FixedStepper: the debug speed multiplier scales time and the catch-up cap together', () => {
  const s = new FixedStepper(T.step, T.maxFrame);
  const n = s.advance(1 / 60, 8);
  assert.ok(n >= 15 && n <= 17, `ran ${n}`);   // 8/60 s = 16 steps
  const big = new FixedStepper(T.step, T.maxFrame).advance(1, 8);
  assert.ok(big <= Math.ceil((T.maxFrame * 8) / T.step) + 1);
});

test('FixedStepper: an hour of 60 Hz frames runs exactly an hour of steps (no drift)', () => {
  const s = new FixedStepper(T.step, T.maxFrame);
  let steps = 0;
  for (let i = 0; i < 60 * 3600; i++) steps += s.advance(1 / 60);
  assert.ok(Math.abs(steps * T.step - 3600) < 0.02, `${steps * T.step}`);
});

/* ───────── AdaptiveRes ───────── */

const feed = (a, ms, seconds, t0) => {
  let t = t0, changed = [];
  for (let i = 0; i < seconds * 1000 / ms; i++) { t += ms; const r = a.sample(ms, t); if (r !== null) changed.push([+(t / 1000).toFixed(1), r]); }
  return { t, changed };
};

test('dprLadder: tops out at the device dpr (max 3) and keeps the notches below it', () => {
  assert.deepEqual(dprLadder(3), [3, 2.5, 2, 1.5, 1.25]);
  assert.deepEqual(dprLadder(2.625), [2.625, 2.5, 2, 1.5, 1.25]);
  assert.deepEqual(dprLadder(2), [2, 1.5, 1.25]);
  assert.deepEqual(dprLadder(1), [1]);
  assert.deepEqual(dprLadder(5), [3, 2.5, 2, 1.5, 1.25]);
});

test('AdaptiveRes: smooth 60 fps never changes anything', () => {
  const a = new AdaptiveRes({ deviceDpr: 3 });
  const { changed } = feed(a, 16.7, 120, 0);
  assert.deepEqual(changed, []);
  assert.equal(a.dpr, 3);
});

test('AdaptiveRes: ~2 s of slow frames steps down once, then re-measures before stepping again', () => {
  const a = new AdaptiveRes({ deviceDpr: 3 });
  const { changed } = feed(a, 40, 20, 0);
  assert.equal(changed[0][1], 2.5);
  assert.ok(changed[0][0] >= 2 && changed[0][0] <= 5, `first step at ${changed[0][0]} s`);
  assert.ok(changed.length >= 2 && changed[1][0] - changed[0][0] >= 2, 'at least ~2 s between steps');
  assert.deepEqual(changed.map((c) => c[1]).slice(0, 4), [2.5, 2, 1.5, 1.25]);
  const more = feed(a, 40, 20, 20000);
  assert.deepEqual(more.changed, [], 'floor reached: stays at 1.25');
  assert.equal(a.dpr, 1.25);
});

test('AdaptiveRes: one slow hitch (or a tab switch) is not a reason to drop resolution', () => {
  const a = new AdaptiveRes({ deviceDpr: 3 });
  let t = 0;
  for (let i = 0; i < 600; i++) { t += 16.7; a.sample(i === 300 ? 90 : 16.7, t); }
  assert.equal(a.dpr, 3);
  for (let i = 0; i < 10; i++) { t += 5000; a.sample(5000, t); }       // came back from another tab: ignored
  assert.equal(a.dpr, 3);
});

test('AdaptiveRes: ignores the settle frames after a change or reset', () => {
  const a = new AdaptiveRes({ deviceDpr: 3, settle: 30 });
  let t = 0;
  for (let i = 0; i < 29; i++) { t += 100; assert.equal(a.sample(100, t), null); }     // 29 slow frames, all inside the settle window
  assert.equal(a.slowSince, 0);
  a.reset();
  assert.equal(a.settle, 30);
});

test('AdaptiveRes: steps up at most once per ~30 s, and a step-up that fails is never repeated (no oscillation)', () => {
  const a = new AdaptiveRes({ deviceDpr: 3 });
  let r = feed(a, 40, 5, 0);                       // slow: 3 -> 2.5
  assert.equal(a.dpr, 2.5);
  r = feed(a, 16.7, 25, r.t);                      // fast but only 25 s: no step up yet
  assert.equal(a.dpr, 2.5);
  r = feed(a, 16.7, 12, r.t);                      // 35 s of comfort: step up
  assert.equal(a.dpr, 3, 'stepped back up');
  const upAt = r.t;
  r = feed(a, 40, 4, r.t);                         // ...and it was too much: down again
  assert.equal(a.dpr, 2.5);
  r = feed(a, 16.7, 120, r.t);                     // two minutes of calm: never tries 3 again
  assert.equal(a.dpr, 2.5);
  assert.equal(a.ups, 1);
  assert.ok(r.t > upAt);
});

test('AdaptiveRes: a sharper level that failed does not block a level below it from coming back', () => {
  const a = new AdaptiveRes({ deviceDpr: 3 });
  let r = feed(a, 40, 5, 0);                       // 3 -> 2.5
  r = feed(a, 16.7, 35, r.t);                      // up to 3 (this will fail)
  r = feed(a, 40, 12, r.t);                        // 3 -> 2.5 -> 2 -> 1.5 ...
  assert.ok(a.dpr <= 2);
  const low = a.dpr;
  r = feed(a, 16.7, 40, r.t);                      // calm again: may climb, but never to 3
  assert.ok(a.dpr >= low && a.dpr < 3, `dpr ${a.dpr}`);
});

test('AdaptiveRes: can be switched off', () => {
  const a = new AdaptiveRes({ deviceDpr: 3 });
  a.enabled = false;
  feed(a, 60, 30, 0);
  assert.equal(a.dpr, 3);
});

/* ───────── SaveThrottle ───────── */

test('SaveThrottle: first request writes at once, a burst is coalesced into one later write of the newest', () => {
  let now = 10000; const writes = []; const timers = [];
  const s = new SaveThrottle((v) => writes.push(v), { minGap: 1000, now: () => now, setTimer: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimer: () => {} });
  s.request('a');
  assert.deepEqual(writes, ['a']);
  now += 100; s.request('b'); now += 100; s.request('c');
  assert.deepEqual(writes, ['a'], 'throttled');
  assert.equal(timers.length, 1);
  assert.ok(timers[0][1] > 0 && timers[0][1] <= 1000);
  now += 900; timers[0][0]();
  assert.deepEqual(writes, ['a', 'c']);
  now += 2000; s.request('d');
  assert.deepEqual(writes, ['a', 'c', 'd']);
});

test('SaveThrottle: flush writes the waiting save immediately and a throwing store never escapes', () => {
  let now = 0; const writes = [];
  const s = new SaveThrottle((v) => { writes.push(v); throw new Error('quota'); }, { minGap: 1000, now: () => now, setTimer: () => 1, clearTimer: () => {} });
  s.request('a');
  now = 10; s.request('b');
  assert.equal(s.flush(), true);
  assert.deepEqual(writes, ['a', 'b']);
  assert.equal(s.flush(), false, 'nothing left');
});

/* ───────── SongTracker ───────── */

const level = { chapters: [{ index: 0, x0: 0 }, { index: 1, x0: 10000 }, { index: 2, x0: 20000 }] };

test('SongTracker: the sim event commits the forward crossing at once', () => {
  const t = new SongTracker(level, 260, 100);
  assert.equal(t.index, 0);
  assert.equal(t.update(9900), false);
  assert.equal(t.enter(1), true);
  assert.equal(t.index, 1);
  assert.equal(t.enter(1), false, 'same event twice does nothing');
});

test('SongTracker: braking back across the line does not thrash; a real retreat does, and rolling on again re-commits', () => {
  const t = new SongTracker(level, 260, 100);
  t.enter(1);
  for (const x of [10050, 9990, 9900, 9800, 9760, 10010, 9850]) assert.equal(t.update(x), false, `x ${x}`);
  assert.equal(t.index, 1);
  assert.equal(t.update(9700), true, 'more than 260 u back inside landscape 0');
  assert.equal(t.index, 0);
  assert.equal(t.update(10100), false, 'just over the line again: not yet');
  assert.equal(t.update(10300), true, 'a hysteresis in: landscape 1 again');
  assert.equal(t.index, 1);
});

test('SongTracker: reset jumps to wherever she is (retry, teleport)', () => {
  const t = new SongTracker(level, 260, 100);
  assert.equal(t.reset(25000), 2);
  assert.equal(t.index, 2);
  assert.equal(t.update(25000), false);
});

test('SongTracker: a single-landscape level never changes', () => {
  const t = new SongTracker({ chapter: 4 }, 260, 0);
  assert.equal(t.index, 4);
  assert.equal(t.update(99999), false);
});
