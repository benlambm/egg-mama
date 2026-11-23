/*
 * Egg Mama — the soak driver: ONE module that runs unchanged in Node (headless reference) and in the page (the real game).
 * Used by tests/e2e/soak-*.mjs; nothing here is part of the game.
 *
 * The idea is REPLAY. The Node planner bot (tests/bot.mjs playLevel) decides WHEN to jump from a look-ahead search of the real sim.
 * Its executed actions (`trace: true` -> [[t, action, x], ...], t = game seconds since the run started rounded to 0.01, x the
 * position rounded to 0.1) are first pinned to EXACT step indices (resolveSteps: the step whose Mama position matches the logged x;
 * a hop chain does not survive a 10 ms rounding) and then replayed, step by step, against:
 *   - a headless game in Node (replayHeadless), and
 *   - the REAL game object inside the page (replayInPage), stepped through window.__egg.fastForward one T.step at a time, so every
 *     event goes through main.mjs's own bookkeeping (checkpoint saves, chapter-enter -> song, beacon -> next-circuit save).
 * Both start from exactly the state playLevel starts from (createGame at a flag, game.t = phase, startRun) and act at the same step
 * indices, so BOTH replays must end where the planner ended (same x, same game time, zero hits and falls); if they do not, the
 * integrated page is not running the same sim as Node. The planner's own verdict (ok / where it failed) is the fairness oracle.
 *
 * In the page, import it from a server rooted at the REPO (so '../docs/js/sim.mjs' is the very module instance main.mjs uses):
 *   const drv = await import('/tools/soak-driver.mjs');
 */
import { createGame, startRun, act, step, drainEvents, snapshotCarry, cloneGame } from '../docs/js/sim.mjs';
import { T } from '../docs/js/tuning.mjs';

const NOHELD = Object.freeze({});

/* ───────────────────────── fingerprints (is the page's world the world Node planned on?) ───────────────────────── */

/** 32-bit FNV-1a over every number that shapes the world. Equal levels give equal prints, in Node and in Chromium. */
export function levelFingerprint(level) {
  let h = 0x811c9dc5;
  const mix = (v) => {
    const n = Math.round(v * 16);                       // 1/16 u is far finer than anything in the sim
    h = Math.imul(h ^ (n & 0xffff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((n >>> 16) & 0xffff), 0x01000193) >>> 0;
  };
  const kinds = { ground: 1, ledge: 2, crumble: 3, lift: 4, mover: 5, egg: 6, gold: 7, shield: 8, magnet: 9, walker: 10, flyer: 11, spikes: 12 };
  for (const p of level.platforms) { mix(kinds[p.kind] || 0); mix(p.x); mix(p.y); mix(p.w); mix(p.h); if (p.motion) { mix(p.motion.amp); mix(p.motion.period); mix(p.motion.phase || 0); } }
  for (const p of level.pickups) { mix(kinds[p.kind] || 0); mix(p.x); mix(p.y); }
  for (const e of level.enemies) { mix(kinds[e.kind] || 0); mix(e.x0 ?? e.cx); mix(e.x1 ?? e.ax); mix(e.speed ?? e.period); mix(e.phase || 0); }
  for (const s of level.hazards) { mix(s.x); mix(s.y); mix(s.w); if (s.cycle) { mix(s.cycle.period); mix(s.cycle.up); } }
  for (const s of level.springs) { mix(s.x); mix(s.y); }
  for (const c of level.checkpoints) { mix(c.x); mix(c.y); mix(c.platform); }
  for (const c of level.chapters || []) { mix(c.x0); mix(c.x1); mix(c.flag); }
  mix(level.endX);
  return h.toString(16).padStart(8, '0');
}

/* ───────────────────────── replay ───────────────────────── */

/** playLevel's `trace` log -> [[tSeconds, action, x], ...] (rounded; see resolveSteps) */
export const traceOf = (res) => (res && res.log ? res.log.map((l) => [l[0], l[1], l[2]]) : []);

/**
 * A game exactly as playLevel starts one: createGame at `flag`, game.t = phase, startRun.
 * `carry` = { eggs, score, flock }.
 */
export function freshGame(level, flag, { phase = 0, carry = {} } = {}) {
  const g = createGame(level, { eggs: carry.eggs | 0, score: carry.score | 0, flock: carry.flock | 0 }, { checkpoint: flag });
  g.t = phase;
  startRun(g);
  return g;
}

/**
 * Pin a rounded planner trace to exact step indices. playLevel logs each executed action as [t (0.01 s), action, x (0.1 u)]; a step is
 * 1/120 s, so t alone leaves two candidate steps and a long hop chain is not forgiving of the wrong one. Mama's x at the moment of the
 * action tells them apart (she rolls ~0.9 u a step). Runs the trace on a headless game and returns
 * { steps: [[stepIndex, action], ...], unresolved } (unresolved = actions that matched no step within 0.06 u; they fall back to the
 * nearest time).
 */
export function resolveSteps(level, flag, trace, { phase = 0, carry = {}, maxSeconds = 800, stopCp = null } = {}) {
  const g = freshGame(level, flag, { phase, carry });
  const out = [];
  let k = 0, n = 0, unresolved = 0;
  const maxSteps = Math.round(maxSeconds / T.step);
  while (k < trace.length && n < maxSteps && g.status === 'running' && (stopCp === null || g.checkpoint < stopCp)) {
    const [r, a, xl] = trace[k];
    if (n * T.step >= r - 0.0125) {
      // candidates: this step and the next three; their x without any action in between (a gesture never moves x within a step)
      const probe = cloneGame(g, true);
      let best = 0, bestErr = Infinity;
      for (let c = 0; c < 4; c++) {
        const err = Math.abs(probe.mama.x - xl) + Math.abs((n + c) * T.step - r) * 1e-3;     // time only breaks ties (a wall: x does not move)
        if ((n + c) * T.step <= r + 0.0126 && err < bestErr) { bestErr = err; best = c; }
        step(probe, NOHELD, T.step);
      }
      if (bestErr > 0.06 + 1e-3 * 0.0126) unresolved++;
      // advance `best` steps first, then act
      for (let c = 0; c < best; c++) { step(g, NOHELD, T.step); drainEvents(g); n++; }
      out.push([n, a]);
      act(g, a); k++;
    }
    step(g, NOHELD, T.step); drainEvents(g); n++;
  }
  return { steps: out, unresolved };
}

/**
 * Replay `actions` ([[stepIndex, action], ...] from resolveSteps) on `g`. `stepOnce()` performs ONE T.step (and must drain events);
 * it may be the headless step or the page's fastForward. Stops when the game stops running, when the checkpoint index reaches
 * `stopCp` (null = play to the beacon / end), or after `maxSeconds` of game time. `onStep(g)` (optional) runs after every step.
 */
export function replayTrace(g, actions, { stopCp = null, maxSeconds = 800, stepOnce, onStep } = {}) {
  const t0 = g.t;
  let k = 0, steps = 0;
  const maxSteps = Math.round(maxSeconds / T.step);
  let reason = 'timeout';
  while (steps < maxSteps) {
    while (k < actions.length && steps >= actions[k][0]) act(g, actions[k++][1]);
    stepOnce(g);
    steps++;
    if (onStep) onStep(g);
    if (g.status !== 'running') { reason = g.status; break; }          // 'dead' | 'beacon' | 'exit'
    if (stopCp !== null && g.checkpoint >= stopCp) { reason = 'checkpoint'; break; }
  }
  return outcome(g, reason, steps, k, t0);
}

function outcome(g, reason, steps, acted, t0) {
  const s = g.stats;
  return {
    reason, ok: (reason === 'checkpoint' || reason === 'beacon' || reason === 'exit') && s.hits === 0 && s.falls === 0,
    x: g.mama.x, y: g.mama.y, t: g.t, seconds: g.t - t0, steps, acted, checkpoint: g.checkpoint, slot: g.slot, status: g.status,
    hits: s.hits, falls: s.falls, jumps: s.jumps, eggs: g.eggs, score: g.score, flock: g.flock,
  };
}

/** The headless reference: replay against a fresh game built from the level in this very process. */
export function replayHeadless(level, flag, actions, { stopCp = null, maxSeconds = 800, phase = 0, carry = {} } = {}) {
  const g = freshGame(level, flag, { phase, carry });
  const events = {};
  const r = replayTrace(g, actions, {
    stopCp, maxSeconds,
    stepOnce: (gg) => { step(gg, NOHELD, T.step); const ev = drainEvents(gg); for (let i = 0; i < ev.length; i++) events[ev[i].type] = (events[ev[i].type] || 0) + 1; },
  });
  r.events = events;
  return r;
}

/* ───────────────────────── in the page ───────────────────────── */

const egg = () => window.__egg;

/**
 * Start a clean run at `flag` on the page's REAL game: teleport() adopts a new game (camera, song tracker, preload bookkeeping),
 * then that game object is overwritten, in place, with a pristine createGame state so the run begins exactly like playLevel's
 * (status running, game.t = phase, Mama idle at the flag, ease-in). Totals are carried (the game's own, or `carry` when given).
 * Returns the live game.
 */
export function restartAt(flag, { phase = 0, carry: given } = {}) {
  const e = egg(), lvl = e.level();
  const cp = lvl.checkpoints[flag];
  e.teleport(cp.x, { flag });
  const g = e.game();
  const carry = given ? { eggs: given.eggs | 0, score: given.score | 0, flock: given.flock | 0 } : snapshotCarry(g);
  Object.assign(g, createGame(lvl, carry, { checkpoint: flag }));
  g.t = phase;
  startRun(g);
  e.renderer.resetCamera(g);
  return g;
}

/**
 * Replay exact-step actions on the page's live game through __egg.fastForward (real event handling). Chapter-enter / checkpoint events are
 * counted from the real event stream. `maxSeconds` is game time.
 */
export function replayInPage(actions, { stopCp = null, maxSeconds = 800, onStep = null } = {}) {
  const e = egg();
  const events = {};
  const g = e.game();
  const r = replayTrace(g, actions, {
    stopCp, maxSeconds, onStep,
    stepOnce: () => {
      const out = e.fastForward(T.step);
      const ev = out.events;
      for (const k in ev) events[k] = (events[k] || 0) + ev[k];
    },
  });
  r.events = events;
  return r;
}

/* ───────────────────────── health scans ───────────────────────── */

const bad = (v) => typeof v === 'number' && !Number.isFinite(v);

/** Every number the sim and the camera hold must be finite. Returns a list of problems (empty = healthy). */
export function scanSim(g, renderer) {
  const out = [];
  const chk = (name, obj, keys) => { for (const k of keys) if (bad(obj[k])) out.push(`${name}.${k}=${obj[k]}`); };
  chk('game', g, ['t', 'statusT', 'eggs', 'score', 'flock', 'magnet', 'checkpoint', 'slot']);
  chk('mama', g.mama, ['x', 'y', 'px', 'py', 'vx', 'vy', 'phase', 'squash', 'hurtT', 'invuln', 'rollIn', 'airT', 'coyote', 'buffer']);
  g.followers.forEach((f, i) => chk(`follower${i}`, f, ['x', 'y', 'px', 'py']));
  const movers = g.info.movers;
  for (let i = 0; i < movers.length; i++) chk(`platform${movers[i]}`, g.platforms[movers[i]], ['cx', 'cy']);
  for (let i = 0; i < g.enemies.length; i++) { const en = g.enemies[i]; if (bad(en.x) || bad(en.y)) out.push(`enemy${i}=${en.x},${en.y}`); }
  for (let i = 0; i < g.pickups.length; i++) { const p = g.pickups[i]; if (bad(p.x) || bad(p.y)) { out.push(`pickup${i}=${p.x},${p.y}`); break; } }
  if (renderer) {
    const c = renderer.camera;
    if (!c || bad(c.x) || bad(c.y)) out.push(`camera=${c && c.x},${c && c.y}`);
    const v = renderer.view;
    if (v) chk('view', v, ['w', 'h', 'scale', 'dpr']);
  }
  return out;
}

/** Sprite cache and decoded paintings: how much the renderer is holding. */
export function cacheStats(renderer) {
  const m = renderer.cache && renderer.cache.map;
  let entries = 0, pixels = 0;
  if (m) for (const s of m.values()) { entries++; const c = s && s.canvas; if (c) pixels += (c.width || 0) * (c.height || 0); }
  return { sprites: entries, spriteMB: +(pixels * 4 / 1048576).toFixed(2), decoded: renderer.stats ? renderer.stats.decoded : 0 };
}
