/*
 * Egg Mama — the planner bot (the fairness oracle for the level generator).
 *
 * It plays the REAL sim (createGame / startRun / act / step) with only the three actions a thumb has:
 * jump, brake, push (>= 0.15 s apart, one per gesture). It has no privileged knowledge beyond what a player
 * sees: the geometry ahead (platforms, enemies, hazards, springs) and the fact that moving things are
 * deterministic functions of time. It plans by cloning the game (cloneGame) and simulating short action
 * sequences a few seconds ahead:
 *
 *   1. roll the clone forward doing nothing; if nothing bad happens for ~2.5 s, keep rolling;
 *   2. otherwise find the first thing that goes wrong (a fall or a hit) and try one action at every 0.05 s
 *      before it; pick the CENTRE of the widest run of times that survive (like a calm player aiming at the
 *      middle of the takeoff window). If no single action is enough (a chain), go one action deeper.
 *
 * Options (all optional):
 *   startCheckpoint, stopAtCheckpoint   play one flag-to-flag segment (default: checkpoint 0 to the last)
 *   allowSteer (true)  false = jump only ... except brake (and nothing else) while ice is near, if iceBrake
 *   iceBrake  (true)
 *   noise: { latency, jitter, seed, compensate }  human execution error: every action lands `jitter` s
 *          (uniform +-) away from the planned time; `compensate` (default true) means the player has learnt
 *          their own latency and aims early by that much (a calm, practised child). No re-planning to fix
 *          an executed action: a mistimed jump is just a mistimed jump.
 *   tOffset   game clock offset (moving platforms / enemies / cycling spikes are functions of game.t)
 *   maxSeconds, collect (include pickups so eggs get collected), flock (carry), horizon, trace
 *
 * Returns { ok, reason, t, clean, x, hits, falls, stomps, jumps, steers, eggs, golds, plans, rollouts, log }.
 * `ok` = reached the target alive with ZERO hits and ZERO falls (flock defaults to 0, so any hit would kill).
 * `clean` = main-route seconds (game time minus the roll-in the sim gives at every start), meant to be summed.
 *
 * Imperfect players (LEVELS-2; the report and the (E) tests use them):
 *   playMash(level, opts)      a button-mashing toddler: no plan, jumps the instant Mama lands, random extra jumps and
 *                              random push / brake swipes; one flag-to-flag segment, no flock (a hit ends the try)
 *   clearRates(level, { kind: 'mash' | 'sloppy' | 'clumsy', trials, stride, seed })
 *                              per-landscape share of flag-to-flag segments cleared. 'sloppy' is the planner bot with 80 ms of
 *                              UNCOMPENSATED latency and +-80 ms of jitter: a calm but clumsy player; 'clumsy' the same with 120 ms
 *                              and +-120 ms: a small child on a slow phone (every jump arrives 0-240 ms late)
 */
import { T } from '../docs/js/tuning.mjs';
import { createGame, startRun, act, step, cloneGame } from '../docs/js/sim.mjs';
import { rng } from '../docs/js/rng.mjs';

export const ROLLIN_LOSS = T.rollInSeconds * (1 - T.rollInStart) * 0.5;   // seconds lost to the ease-in at every start
const DT = T.step;
const PLAN_GRID = 6;                       // plan on a 0.05 s grid
const NOHELD = Object.freeze({});
const MIN_GAP_STEPS = Math.ceil(0.15 / DT); // actions at least 0.15 s apart

/* ───────────────────────── level windows ───────────────────────── */

/**
 * A shallow copy of the level holding only the things that can matter between x0 and x1 (ids unchanged, so
 * checkpoints still find their platforms). Cloning the whole ~10^4-platform world for every rollout would
 * be hopeless, and nothing outside the window can touch her.
 */
export function windowLevel(level, x0, x1, { pickups = false } = {}) {
  const hit = (a, b) => b >= x0 && a <= x1;
  return {
    ...level,
    platforms: level.platforms.filter((p) => hit(p.x - (p.motion && p.motion.axis === 'x' ? p.motion.amp : 0), p.x + p.w + (p.motion && p.motion.axis === 'x' ? p.motion.amp : 0))),
    pickups: pickups ? level.pickups.filter((p) => hit(p.x - T.magnetRadius, p.x + T.magnetRadius)) : [],
    enemies: level.enemies.filter((e) => (e.kind === 'walker' ? hit(e.x0 - 40, e.x1 + 40) : hit(e.cx - e.ax - 40, e.cx + e.ax + 40))),
    hazards: level.hazards.filter((h) => hit(h.x, h.x + h.w)),
    springs: level.springs.filter((s) => hit(s.x - 40, s.x + 40)),
  };
}

/** Flag-to-flag segments of a level: [{ from, to, x0, x1, ch }]; the last one runs to the beacon / endX. */
export function segmentsOf(level) {
  const cps = level.checkpoints, out = [];
  for (let i = 0; i < cps.length; i++) {
    const last = i === cps.length - 1;
    out.push({ from: i, to: last ? null : i + 1, x0: cps[i].x, x1: last ? (level.beacon ? level.beacon.x : level.endX) : cps[i + 1].x, ch: cps[i].ch ?? 0 });
  }
  return out;
}

/* ───────────────────────── rollouts and planning ───────────────────────── */

/** Seconds for her feet to come back down to `dy` below the takeoff height (kinematics a player learns by playing). */
function airTime(dy) {
  const disc = T.jumpSpeed * T.jumpSpeed + 2 * T.gravity * dy;
  return disc < 0 ? NaN : (T.jumpSpeed + Math.sqrt(disc)) / T.gravity;
}

/**
 * The default way to carry on after a planned action: when the ground ahead of her ends, take off so that she
 * lands a little inside the next platform she can see (or against a wall she must hop onto). Used ONLY to
 * continue rollouts, so that the first action of a chain can be centred in its own window.
 * Returns the x where she should take off (Infinity: nothing to jump to).
 */
function takeoffX(g) {
  const ground = g.mama.ground;
  const end = ground.cx + ground.w;
  let next = null;
  for (const p of g.platforms) {
    if (p === ground || p.cx < end - 2 || p.cx - end > 120) continue;
    if (!next || p.cx < next.cx) next = p;
  }
  if (!next) return Infinity;
  const dy = next.cy - ground.cy;
  if (next.cx - end <= 2 && dy > -T.stepUp) return Infinity;        // it simply continues: keep rolling
  const t = airTime(dy);
  if (!(t > 0)) return Infinity;
  return Math.min(next.cx + 12 - T.cruise * t, end + 4);
}

class Planner {
  constructor(opts, ctx) { this.o = opts; this.ctx = ctx; this.rollouts = 0; this.budget = 0; }

  actions(game) {
    const o = this.o;
    if (o.allowSteer) return ['jump', 'brake', 'push'];
    if (o.iceBrake && this.iceNear(game)) return ['jump', 'brake'];
    return ['jump'];
  }
  iceNear(game) {
    const x = game.mama.x;
    for (const p of game.platforms) if (p.ice && p.x < x + 700 && p.x + p.w > x - 200) return true;
    return false;
  }

  /**
   * Roll a clone forward `steps` steps with the given [{n, a}] actions, then (if `policy`) carry on with the
   * default takeoff habit. Returns { fail: step|0, x }.
   */
  rollout(base, plan, steps, policy = false) {
    this.rollouts++;
    const g = cloneGame(base, true);
    const h0 = g.stats.hits, f0 = g.stats.falls;
    const x0 = g.mama.x;
    const stopX = this.ctx.stopX;
    let k = 0, lastAct = -1e9, tg = null, tx = Infinity, blockRun = 0, blockStart = 0;
    const home = g.mama.ground;                 // the takeoff habit only joins in once she has landed somewhere NEW
    let armed = false;
    for (let i = 0; i < steps; i++) {
      while (k < plan.length && plan[k].n === i) { act(g, plan[k].a); lastAct = i; k++; }
      if (policy && !armed && g.mama.onGround && g.mama.ground !== home) armed = true;
      if (policy && armed && k >= plan.length && g.mama.onGround && i - lastAct >= MIN_GAP_STEPS) {
        const gr = g.mama.ground;
        if (gr !== tg || gr.motion) { tg = gr; tx = takeoffX(g); }
        if (g.mama.x >= tx) { act(g, 'jump'); lastAct = i; }
      }
      step(g, NOHELD);
      if (g.events.length) g.events.length = 0;
      // pressed against a wall for a quarter of a second: she has stopped rolling, which is trouble from the first moment
      if (g.mama.vx < 5 && i > 12) { if (!blockRun) blockStart = i + 1; if (++blockRun >= 30) return { fail: blockStart, x: g.mama.x, stuck: true }; } else blockRun = 0;
      if (g.stats.hits > h0 || g.stats.falls > f0 || g.status === 'dead') return { fail: i + 1, x: g.mama.x };
      if (g.status !== 'running' || g.mama.x >= stopX) return { fail: 0, x: g.mama.x, done: true };
    }
    // standing still against a wall counts as failing too: she must keep rolling
    if (g.mama.x - x0 < 0.12 * T.cruise * steps * DT) return { fail: steps, x: g.mama.x, stuck: true };
    return { fail: 0, x: g.mama.x };
  }

  /** A clone advanced `n` steps (doing nothing) with `a` then performed. */
  advance(base, n, a) {
    const g = cloneGame(base, true);
    for (let i = 0; i < n; i++) { step(g, NOHELD); if (g.events.length) g.events.length = 0; }
    if (a) act(g, a);
    return g;
  }

  /**
   * Plan from `base`. Returns { none: true } if nothing is needed, { n, a, width } (the first action to take, n
   * steps from now) or null if she cannot be saved. Only the first action is ever acted on: the bot looks again
   * after it, exactly as a player reacts to what they see.
   */
  plan(base) {
    this.budget = this.o.maxRollouts;
    return this.search(base, this.o.depth, null, 0);
  }

  search(base, depth, acts, minN) {
    const H = this.o.horizonSteps;
    const r0 = this.rollout(base, [], H);
    if (!r0.fail) return { none: true };
    if (depth <= 0) return null;
    const tf = r0.fail;
    const lists = acts ? [acts] : (() => { const all = this.actions(base); return all.length > 1 ? [['jump'], all] : [all]; })();
    for (const list of lists) {
      const H2 = Math.min(tf + 180, 460);
      const wins = [];          // the action, then the usual takeoff habit, survives
      const partial = [];       // the action alone gets past the first trouble: { n, a }
      const start = Math.ceil(minN / PLAN_GRID) * PLAN_GRID;
      for (let n = start; n <= tf; n += PLAN_GRID) {
        for (const a of list) {
          const r = this.rollout(base, [{ n, a }], H2, true);
          if (!r.fail) wins.push({ n, a });
          else {
            const r2 = this.rollout(base, [{ n, a }], H2, false);
            if (r2.fail > tf + 12 && !r2.stuck) partial.push({ n, a });
          }
          if (this.budget-- < 0) return null;
        }
      }
      if (wins.length) { const w = this.centre(wins); return { n: w.n, a: w.a, width: w.width }; }
      // no single action is enough: take the middle of the times that get past the first trouble, and check that
      // she can then be saved (looking one action deeper). Try the middle first, then outward.
      let tries = 0;
      for (const p of this.outward(partial)) {
        if (tries++ >= this.o.branch) break;
        const child = this.advance(base, p.n, p.a);
        const sub = this.search(child, depth - 1, list, MIN_GAP_STEPS);
        if (sub) return { n: p.n, a: p.a, width: 0 };
        if (this.budget < 0) return null;
      }
    }
    return null;
  }

  /** Candidates ordered run by run (widest run first), each run from its middle outward. */
  outward(cands) {
    const byA = new Map();
    for (const w of cands) { if (!byA.has(w.a)) byA.set(w.a, []); byA.get(w.a).push(w.n); }
    const runs = [];
    for (const [a, ns] of byA) {
      let s = 0;
      for (let i = 1; i <= ns.length; i++) {
        if (i === ns.length || ns[i] - ns[i - 1] > PLAN_GRID) {
          const lo = ns[s], hi = ns[i - 1], mid = (lo + hi) / 2;
          runs.push({ a, width: hi - lo, items: ns.slice(s, i).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid)) });
          s = i;
        }
      }
    }
    runs.sort((p, q) => (q.a === 'jump') - (p.a === 'jump') || q.width - p.width);
    const out = [];
    for (const r of runs) for (const n of r.items) out.push({ n, a: r.a });
    return out;
  }

  /** Centre of the widest contiguous run of winning times for one action type (ties: the earliest). */
  centre(wins) {
    const byA = new Map();
    for (const w of wins) { if (!byA.has(w.a)) byA.set(w.a, []); byA.get(w.a).push(w.n); }
    let best = null;
    for (const [a, ns] of byA) {
      let s = 0;
      for (let i = 1; i <= ns.length; i++) {
        if (i === ns.length || ns[i] - ns[i - 1] > PLAN_GRID) {
          const lo = ns[s], hi = ns[i - 1], width = hi - lo;
          const score = width + (a === 'jump' ? 1000 : 0);        // prefer a jump to steering
          if (!best || score > best.score) best = { score, n: Math.round((lo + hi) / 2 / PLAN_GRID) * PLAN_GRID, a, width: width * DT };
          s = i;
        }
      }
    }
    return { n: best.n, a: best.a, width: best.width };
  }
}

/* ───────────────────────── playing ───────────────────────── */

const DEFAULTS = {
  allowSteer: true, iceBrake: true, noise: null, tOffset: 0, maxSeconds: 150, collect: false,
  flock: 0, horizon: 2.5, maxRollouts: 3000, branch: 4, depth: 8, trace: false,
};

export function playLevel(level, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cps = level.checkpoints;
  const startCp = o.startCheckpoint ?? 0;
  const toEnd = o.stopAtCheckpoint == null;                      // no stop flag: play on to the beacon / gate
  const stopCp = toEnd ? Infinity : o.stopAtCheckpoint;
  const x0 = cps[startCp].x;
  const stopX = toEnd ? Infinity : cps[stopCp].x;
  const worldEnd = level.beacon ? level.beacon.x : level.endX;
  const sub = windowLevel(level, x0 - 400, (toEnd ? worldEnd : stopX) + 900, { pickups: o.collect });
  const game = createGame(sub, { eggs: 0, score: 0, flock: o.flock }, { checkpoint: startCp });
  game.t = o.tOffset;
  startRun(game);
  const ctx = { stopX };
  const P = new Planner({ ...o, horizonSteps: Math.round(o.horizon / DT) }, ctx);
  const noise = o.noise ? { latency: 0.08, jitter: 0.05, seed: 1, compensate: true, ...o.noise } : null;
  const nrand = noise ? rng(noise.seed >>> 0 || 1) : null;

  const res = { ok: false, reason: 'timeout', t: 0, clean: 0, x: x0, hits: 0, falls: 0, stomps: 0, jumps: 0, steers: 0, eggs: 0, golds: 0, plans: 0, unsolved: 0, rollouts: 0, log: [], got: [] };
  const queue = [];                       // pending [{ at: step index, a }]
  let si = 0, nextPlan = 0, lastActStep = -1e9;
  const maxSteps = Math.round(o.maxSeconds / DT);

  for (; si < maxSteps; si++) {
    // execute due actions (never closer than 0.15 s apart)
    while (queue.length && queue[0].at <= si && si - lastActStep >= MIN_GAP_STEPS) {
      const q = queue.shift();
      act(game, q.a);
      lastActStep = si;
      if (q.a !== 'jump') res.steers++;
      if (o.trace) res.log.push([+(game.t - o.tOffset).toFixed(2), q.a, +game.mama.x.toFixed(1)]);
    }
    // think
    if (!queue.length && si >= nextPlan && game.status === 'running') {
      const r = P.plan(game);
      res.plans++;
      if (r && r.none) nextPlan = si + Math.round(1.0 / DT);
      else if (r) {
        // one action at a time, then look again (a human reacts to what they see)
        let at = si + r.n;
        if (noise) {
          const jit = (nrand() * 2 - 1) * noise.jitter;
          const lat = noise.compensate ? 0 : noise.latency;
          at = Math.max(si, at + Math.round((jit + lat) / DT));
        }
        queue.push({ at, a: r.a });
        nextPlan = at + 1;
      } else { res.unsolved++; nextPlan = si + Math.round(0.25 / DT); }
    }
    step(game, NOHELD);
    if (game.events.length) {
      for (const e of game.events) {
        if (e.type === 'stomp') res.stomps++;
        else if (o.collect && (e.type === 'egg' || e.type === 'gold')) res.got.push(e.id);
      }
      game.events.length = 0;
    }
    if (game.status !== 'running') {
      res.reason = game.status === 'dead' ? (game.stats.falls > res.falls ? 'fall' : 'hit') : game.status;
      break;
    }
    if (game.checkpoint >= stopCp) { res.reason = 'checkpoint'; break; }
  }
  const s = game.stats;
  res.hits = s.hits; res.falls = s.falls; res.jumps = s.jumps; res.stomps = s.stomps;
  res.eggs = s.eggs; res.golds = s.golds;
  res.t = game.t - o.tOffset; res.clean = Math.max(0, res.t - ROLLIN_LOSS); res.x = game.mama.x;
  res.rollouts = P.rollouts; res.flock = game.flock;
  res.ok = (res.reason === 'checkpoint' || res.reason === 'beacon' || res.reason === 'exit') && s.hits === 0 && s.falls === 0;
  if (!o.trace) delete res.log;
  if (!o.collect) delete res.got;
  return res;
}

/**
 * Play a whole stretch of the world segment by segment (each restarts at its flag, like Retry / Continue do),
 * summing clean times. Returns { ok, segments: [{ from, to, ...result }], clean, failed: first failing result }.
 */
export function playWorld(level, opts = {}) {
  const segs = segmentsOf(level);
  const from = opts.fromCheckpoint ?? 0, to = opts.toCheckpoint ?? segs.length;     // segment indices [from, to)
  const out = { ok: true, segments: [], clean: 0, failed: null };
  for (let i = from; i < to; i++) {
    const r = playLevel(level, { ...opts, startCheckpoint: i, stopAtCheckpoint: segs[i].to ?? undefined });
    out.segments.push({ from: i, to: segs[i].to, ...r });
    out.clean += r.clean;
    if (!r.ok && out.ok) { out.ok = false; out.failed = { from: i, ...r }; if (opts.stopOnFail !== false) break; }
  }
  return out;
}

/* ───────────────────────── a button-mashing toddler ───────────────────────── */

/**
 * The youngest player: no plan at all. She jumps the instant Mama lands (most of the time), adds random extra jumps
 * (`rate` per second) and now and then a random push or brake swipe (`steerRate` per second). One flag-to-flag segment.
 * Options: startCheckpoint, stopAtCheckpoint (default start + 1), seed, tOffset, flock (default 0: a hit ends the run),
 * rate (2.2), steerRate (0.25), reland (0.8: chance of jumping again at once on landing), maxSeconds.
 * Returns { ok, reason, x, hits, falls, t }.
 */
export function playMash(level, opts = {}) {
  const o = { startCheckpoint: 0, stopAtCheckpoint: null, seed: 1, tOffset: 0, flock: 0, rate: 2.2, steerRate: 0.25, reland: 0.8, maxSeconds: 70, ...opts };
  const cps = level.checkpoints;
  const stopCp = o.stopAtCheckpoint ?? o.startCheckpoint + 1;
  const x0 = cps[o.startCheckpoint].x, stopX = cps[stopCp] ? cps[stopCp].x : (level.beacon ? level.beacon.x : level.endX);
  const sub = windowLevel(level, x0 - 400, stopX + 900);
  const game = createGame(sub, { eggs: 0, score: 0, flock: o.flock }, { checkpoint: o.startCheckpoint });
  game.t = o.tOffset;
  startRun(game);
  const rand = rng((o.seed >>> 0) || 1);
  const maxSteps = Math.round(o.maxSeconds / DT);
  let wasGround = game.mama.onGround, lastAct = -1e9, reason = 'timeout';
  for (let si = 0; si < maxSteps; si++) {
    const m = game.mama;
    const can = si - lastAct >= MIN_GAP_STEPS;
    if (can) {
      if (m.onGround && !wasGround && rand() < o.reland) { act(game, 'jump'); lastAct = si; }
      else if (rand() < o.rate * DT) { act(game, 'jump'); lastAct = si; }
      else if (rand() < o.steerRate * DT) { act(game, rand() < 0.5 ? 'push' : 'brake'); lastAct = si; }
    }
    wasGround = m.onGround;
    step(game, NOHELD);
    if (game.events.length) game.events.length = 0;
    if (game.status !== 'running') { reason = game.status === 'dead' ? 'dead' : game.status; break; }
    if (game.checkpoint >= stopCp) { reason = 'checkpoint'; break; }
  }
  const s = game.stats;
  return { ok: reason === 'checkpoint' || reason === 'beacon' || reason === 'exit', reason, x: game.mama.x, hits: s.hits, falls: s.falls, t: game.t - o.tOffset };
}

/**
 * Per-landscape clear rates of a whole level for a kind of imperfect player, segment by segment.
 *   kind 'mash'    the toddler above, `trials` seeds per segment
 *   kind 'sloppy'  the planner bot with 80 ms of UNCOMPENSATED latency and +-80 ms of jitter (a calm but clumsy player)
 *   kind 'clumsy'  the same with 120 ms and +-120 ms
 * Returns { rates: [13 fractions], runs: [13 counts], overall }. A segment counts as cleared when she reaches the next flag
 * with no flock to absorb a hit (every hit would end the attempt).
 */
export function clearRates(level, { kind = 'mash', trials = 3, stride = 1, seed = 1, opts = {} } = {}) {
  const segs = segmentsOf(level);
  const n = level.chapters.length;
  const ok = new Array(n).fill(0), runs = new Array(n).fill(0);
  for (let i = 0; i < segs.length; i += stride) {
    const s = segs[i];
    if (s.to === null) continue;                                   // the final stretch to the beacon is plain ground
    for (let k = 0; k < trials; k++) {
      const sd = mixSeedLite(seed, i, k);
      const r = kind === 'mash'
        ? playMash(level, { startCheckpoint: s.from, stopAtCheckpoint: s.to, seed: sd, tOffset: (sd % 977) / 97, ...opts })
        : playLevel(level, { startCheckpoint: s.from, stopAtCheckpoint: s.to, allowSteer: false, tOffset: (sd % 977) / 97, noise: { latency: kind === 'clumsy' ? 0.12 : 0.08, jitter: kind === 'clumsy' ? 0.12 : 0.08, compensate: false, seed: sd }, ...opts });
      runs[s.ch]++; if (r.ok) ok[s.ch]++;
    }
  }
  const rates = ok.map((v, i) => (runs[i] ? v / runs[i] : NaN));
  return { rates, runs, ok, overall: ok.reduce((a, b) => a + b, 0) / Math.max(1, runs.reduce((a, b) => a + b, 0)) };
}
const mixSeedLite = (a, b, c) => (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f)) >>> 0;
