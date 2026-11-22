/*
 * Egg Mama — the simulation. No browser code: it runs in Node for tests and in
 * the page for play. Deterministic: same level + same inputs = same game.
 *
 *   const game = createGame(level, { eggs, score, flock }, { checkpoint: 0 });
 *   startRun(game);                       // Mama eases into her gentle roll
 *   act(game, 'jump' | 'brake' | 'push'); // gesture events (one per swipe)
 *   step(game, { left, right });          // held keys, called at fixed T.step
 *   for (const e of drainEvents(game)) …  // audio, particles, saving, UI
 *
 * ── LEVEL FORMAT (produced by levelgen.mjs, consumed here) ───────────────
 * y grows DOWN. A platform's (x, y) is its TOP-LEFT; Mama's (x, y) is her FEET.
 *   level = {
 *     chapter, circuit, seed,
 *     start: { x, y },                     // feet position at chapter start (on platform 0)
 *     endX,                                // crossing the gate at endX completes the chapter
 *     platforms: [{ id, kind, x, y, w, h, solid?, ice?, motion?, crumble? }],
 *        kind:  'ground'  long static island, drawn thick. `solid` (default true) = side faces block Mama.
 *               'ledge'   thin static one-way slab (jump up through it, land on top)
 *               'crumble' one-way slab that gives way T.crumbleDelay s after she lands
 *               'lift'    one-way slab moving vertically   (motion.axis 'y')
 *               'mover'   one-way slab moving horizontally (motion.axis 'x')
 *        ice:   true -> low friction (T.iceAccel)
 *        motion:{ axis:'x'|'y', amp, period, phase }   position = base + amp*sin(2π t/period + phase)
 *     pickups:  [{ id, kind:'egg'|'gold'|'shield'|'magnet', x, y }]          (x,y = centre)
 *     enemies:  [{ id, kind:'walker', x0, x1, y, speed, phase }              (y = ground top it walks on)
 *               |{ id, kind:'flyer', cx, cy, ax, ay, period, phase }]
 *     hazards:  [{ id, kind:'spikes', x, y, w, h?, cycle?:{ period, up, phase } }]   (y = ground top)
 *     springs:  [{ id, x, y, w? }]                                            (x = centre, y = ground top)
 *     checkpoints: [{ id, x, y, platform }]    id 0 is the chapter start; y = ground top under the flag
 *     beacon:   null | { x, y }                (chapter 13 only; y = ground top)
 *     cues:     [{ x, text, kind:'tip' }]      captions shown when Mama passes x
 *     beats:    [{ kind:'opening'|'middle'|'closing', x0, x1, name }]
 *     water:    null | { y }                   decorative flood line (drawing only)
 *   }
 *
 * ── EVENTS (game.events, drained with drainEvents) ───────────────────────
 *   start, jump, land{hard}, egg{id,x,y,points}, gold{id,x,y,points,hatched},
 *   hatch{x,y,flock}, shield{x,y}, shield-break{x,y}, magnet{x,y}, stomp{x,y,points},
 *   spring{x,y}, hit{source:'enemy'|'spikes'|'flyer'}, duckling-lost{x,y,flock},
 *   fall{x,y}, respawn{x,y}, checkpoint{index,x,y}, crumble-start{id}, crumble-fall{id},
 *   steer{dir}, cue{text,kind}, dead{}, exit{x,y}, beacon{x,y}
 */
import { T, clamp, smooth } from './tuning.mjs';

const TAU = Math.PI * 2;
const BUCKET = 256;

/* ───────────────────────── pure helpers (shared with art/bot/levelgen) ───────────────────────── */

/** Where a platform's top-left is at time t (ignores crumble fall). */
export function platformPosAt(p, t) {
  const m = p.motion;
  if (!m) return { x: p.x, y: p.y, vx: 0, vy: 0 };
  const a = TAU * t / m.period + (m.phase || 0);
  const s = Math.sin(a) * m.amp, v = Math.cos(a) * m.amp * TAU / m.period;
  return m.axis === 'x' ? { x: p.x + s, y: p.y, vx: v, vy: 0 } : { x: p.x, y: p.y + s, vx: 0, vy: v };
}

/** Where an enemy is at time t. Returns { x, y, face }. y is the feet (walker) or centre (flyer). */
export function enemyPosAt(e, t) {
  if (e.kind === 'walker') {
    const range = Math.max(1, e.x1 - e.x0);
    const d = ((t * e.speed + (e.phase || 0) * 2 * range) % (2 * range) + 2 * range) % (2 * range);
    return { x: e.x0 + (d < range ? d : 2 * range - d), y: e.y, face: d < range ? 1 : -1 };
  }
  const a = TAU * t / e.period + (e.phase || 0);
  return { x: e.cx + e.ax * Math.sin(a), y: e.cy + e.ay * Math.cos(a), face: Math.cos(a) * e.ax >= 0 ? 1 : -1 };
}

/** True while a cycling spike hazard is up (always true for plain spikes). */
export function hazardActive(h, t) {
  if (!h.cycle) return true;
  const c = h.cycle;
  return (((t / c.period + (c.phase || 0)) % 1) + 1) % 1 * c.period < c.up;
}

/** Warning fraction 0..1 for a cycling hazard about to rise (art can wiggle it). */
export function hazardWarn(h, t) {
  if (!h.cycle || hazardActive(h, t)) return 0;
  const c = h.cycle;
  const into = ((((t / c.period + (c.phase || 0)) % 1) + 1) % 1) * c.period;
  const wait = c.period - into;              // seconds until it rises
  return wait < 0.45 ? 1 - wait / 0.45 : 0;
}

export const WALKER = Object.freeze({ w: 34, h: 26 });
export const FLYER = Object.freeze({ w: 30, h: 24 });
export const SPIKE_H = 16;
export const SPRING_W = 34;

/* ───────────────────────── level preparation ───────────────────────── */

const prepared = new WeakMap();
function bucketize(items, extent) {
  const map = new Map();
  items.forEach((item, i) => {
    const [a, b] = extent(item);
    for (let k = Math.floor(a / BUCKET); k <= Math.floor(b / BUCKET); k++) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    }
  });
  return map;
}
function prepareLevel(level) {
  let info = prepared.get(level);
  if (info) return info;
  info = {
    platformBuckets: bucketize(level.platforms, (p) => {
      const amp = p.motion && p.motion.axis === 'x' ? p.motion.amp : 0;
      return [p.x - amp, p.x + p.w + amp];
    }),
    pickupBuckets: bucketize(level.pickups, (p) => [p.x - T.magnetRadius, p.x + T.magnetRadius]),
    enemyBuckets: bucketize(level.enemies, (e) => (e.kind === 'walker' ? [e.x0 - 30, e.x1 + 30] : [e.cx - e.ax - 30, e.cx + e.ax + 30])),
    hazardBuckets: bucketize(level.hazards, (h) => [h.x, h.x + h.w]),
    springBuckets: bucketize(level.springs, (s) => [s.x - 40, s.x + 40]),
    movers: level.platforms.map((p, i) => (p.motion || p.kind === 'crumble' ? i : -1)).filter((i) => i >= 0),
  };
  prepared.set(level, info);
  return info;
}
/** Items of `list` whose bucket range touches [x-pad, x+pad]. Result is a reused array: consume before the next call. */
function near(game, map, list, x, pad) {
  const out = game._near; out.length = 0;
  const stamp = ++game._tick;
  const seen = game._seen;
  for (let k = Math.floor((x - pad) / BUCKET); k <= Math.floor((x + pad) / BUCKET); k++) {
    const idx = map.get(k);
    if (!idx) continue;
    for (let j = 0; j < idx.length; j++) {
      const i = idx[j];
      if (seen[i] !== stamp) { seen[i] = stamp; out.push(list[i]); }
    }
  }
  return out;
}
const nearPlatforms = (game, x, pad) => near(game, game.info.platformBuckets, game.platforms, x, pad);

/* ───────────────────────── creating a game ───────────────────────── */

/**
 * @param level  from generateLevel()
 * @param carry  { eggs, score, flock } carried from the save / previous chapter
 * @param opts   { checkpoint: index to start from (default 0) }
 */
export function createGame(level, carry = {}, opts = {}) {
  const cpIndex = clamp(opts.checkpoint || 0, 0, level.checkpoints.length - 1);
  const cp = level.checkpoints[cpIndex];
  const game = {
    level, info: prepareLevel(level),
    t: 0, status: 'ready', statusT: 0, events: [],
    eggs: carry.eggs | 0, score: carry.score | 0, flock: clamp(carry.flock | 0, 0, T.maxFlock),
    shield: false, magnet: 0,
    checkpoint: cpIndex,
    platforms: level.platforms.map((p) => ({
      ...p, cx: p.x, cy: p.y, pcx: p.x, pcy: p.y, vx: 0, vy: 0, state: 'idle', st: 0, fallV: 0,
    })),
    pickups: level.pickups.map((p) => ({ ...p, taken: false })),
    enemies: level.enemies.map((e) => {
      const pos = enemyPosAt(e, 0);
      return { ...e, x: pos.x, y: pos.y, face: pos.face, defeated: false, defeatT: 0 };
    }),
    springs: level.springs.map((s) => ({ ...s, w: s.w || SPRING_W, bounceT: -9 })),
    cuesShown: new Set(),
    mama: null, followers: [], followSide: -1,
    hist: { x: new Float32Array(600), y: new Float32Array(600), n: 0, acc: 0 },
    stats: { jumps: 0, stomps: 0, falls: 0, hits: 0, eggs: 0, golds: 0, maxX: cp.x, time: 0 },
    beaconLit: false,
    _near: [], _tick: 0, _seen: new Int32Array(Math.max(level.platforms.length, level.pickups.length, level.enemies.length, level.hazards.length, level.springs.length, 1)),
  };
  placeAtCheckpoint(game, cp);
  // Pickups behind the checkpoint were counted when it was saved: don't hand them out twice.
  if (cpIndex > 0) for (const p of game.pickups) if (p.x < cp.x - 40) p.taken = true;
  for (const c of level.cues) if (c.x < cp.x) game.cuesShown.add(c);
  return game;
}

function placeAtCheckpoint(game, cp) {
  const ground = game.platforms.find((p) => p.id === cp.platform) || game.platforms[0];
  game.mama = {
    x: cp.x, y: ground.cy, px: cp.x, py: ground.cy, vx: 0, vy: 0, onGround: true, ground,
    face: 1, coyote: 0, buffer: 0, stompBuffer: 0, invuln: 0, rollIn: 0, airT: 0,
    steerDir: 0, steerUntil: -1, steerLock: 0, phase: 0, squash: 0, hurtT: 0, hop: 0,
  };
  resetHistory(game);
  updateFollowers(game);
}

function resetHistory(game) {
  const h = game.hist, m = game.mama;
  h.x.fill(m.x); h.y.fill(m.y); h.n = 0; h.acc = 0;
}

export function drainEvents(game) {
  const out = game.events;
  game.events = [];
  return out;
}
const emit = (game, type, data = {}) => game.events.push({ type, ...data });

/** Carry-over totals for the next chapter / the save. */
export const snapshotCarry = (game) => ({ eggs: game.eggs, score: game.score, flock: game.flock });

/* ───────────────────────── player commands ───────────────────────── */

/** Begin (or resume) play: Mama eases into her slow roll and gets a moment of grace. */
export function startRun(game) {
  game.status = 'running';
  easeIn(game);
  emit(game, 'start');
}

/** Call when play resumes after a pause / rotation: ease back in, brief grace. */
export function easeIn(game) {
  const m = game.mama;
  m.rollIn = 0;
  m.invuln = Math.max(m.invuln, 1.0);
  m.steerUntil = -1; m.steerDir = 0;
  m.buffer = 0;
  if (m.onGround) m.vx = Math.min(m.vx, T.cruise * T.rollInStart);
}

/** One gesture = one action. Returns true if it did something. */
export function act(game, action) {
  if (game.status !== 'running') return false;
  const m = game.mama;
  if (action === 'jump') { m.buffer = T.buffer; m.stompBuffer = 0.2; return true; }
  if (game.t < m.steerLock) return false;
  if (action === 'brake' || action === 'push') {
    m.steerDir = action === 'push' ? 1 : -1;
    m.steerUntil = game.t + T.steerSeconds;
    emit(game, 'steer', { dir: m.steerDir });
    return true;
  }
  return false;
}

/* ───────────────────────── stepping ───────────────────────── */

const approach = (v, target, delta) => (v < target ? Math.min(target, v + delta) : Math.max(target, v - delta));

export function step(game, held = {}, dt = T.step) {
  game.t += dt;
  const m = game.mama;
  m.px = m.x; m.py = m.y;
  for (const f of game.followers) { f.px = f.x; f.py = f.y; }
  updatePlatforms(game, dt);
  updateEnemies(game);
  for (const s of game.springs) if (s.bounceT > -9 && game.t - s.bounceT > 1) s.bounceT = -9;

  if (game.status === 'running') {
    game.stats.time += dt;
    updateMama(game, held, dt);
    updateMagnet(game, dt);
    checkWorld(game);
  } else if (game.status === 'ready') {
    settleReady(game);
  } else if (game.status === 'dead') {
    game.statusT += dt;
    m.vy = Math.min(m.vy + T.gravity * dt, T.maxFall);
    m.y += m.vy * dt; m.x += m.vx * dt;
    m.hurtT += dt;
  } else if (game.status === 'exit') {
    game.statusT += dt;
    m.invuln = 9;
    glide(game, T.cruise, dt);
  } else if (game.status === 'beacon') {
    game.statusT += dt;
    m.invuln = 9;
    glide(game, 0, dt);
  }
  m.squash = Math.max(0, m.squash - dt * 4);
  m.hurtT = Math.max(0, m.hurtT - dt);
  recordHistory(game, dt);
  updateFollowers(game);
}

function settleReady(game) {
  const m = game.mama;
  m.y = m.ground.cy; m.x += m.ground.cx - m.ground.pcx;
}

/** Roll along the ground at a set speed with no hazards (gate exit / beacon celebration). */
function glide(game, speed, dt) {
  const m = game.mama;
  if (m.onGround) {
    m.x += m.ground.cx - m.ground.pcx; m.y = m.ground.cy;
    m.vx = approach(m.vx, speed, T.groundAccel * dt);
    m.x += m.vx * dt;
    if (!supports(m.ground, m.x)) { m.onGround = false; m.vy = 0; }
  } else {
    m.vy = Math.min(m.vy + T.gravity * dt, T.maxFall);
    m.x += m.vx * dt; m.y += m.vy * dt;
    land(game, m.y - m.vy * dt);
  }
  m.phase += m.vx * dt;
}

function updatePlatforms(game, dt) {
  const t = game.t;
  const movers = game.info.movers;
  for (let k = 0; k < movers.length; k++) {
    const p = game.platforms[movers[k]];
    p.pcx = p.cx; p.pcy = p.cy;
    if (p.kind === 'crumble') {
      if (p.state === 'rumble') {
        p.st += dt;
        if (p.st >= T.crumbleDelay) { p.state = 'fall'; p.st = 0; p.fallV = 0; emit(game, 'crumble-fall', { id: p.id }); }
      } else if (p.state === 'fall') {
        p.st += dt; p.fallV = Math.min(p.fallV + T.gravity * 0.7 * dt, T.maxFall);
        p.cy += p.fallV * dt;
        if (p.st >= T.crumbleRespawn) { p.state = 'idle'; p.st = 0; p.cy = p.y; p.pcy = p.y; }
      }
    } else {
      const pos = platformPosAt(p, t);
      p.cx = pos.x; p.cy = pos.y; p.vx = pos.vx; p.vy = pos.vy;
    }
  }
}

function updateEnemies(game) {
  for (const e of near(game, game.info.enemyBuckets, game.enemies, game.mama.x, 900)) {
    if (e.defeated) continue;
    const pos = enemyPosAt(e, game.t);
    e.x = pos.x; e.y = pos.y; e.face = pos.face;
  }
}

const solidTop = (p) => p.state === 'idle' || p.state === 'rumble';
const supports = (p, x) => solidTop(p) && x >= p.cx - T.edgeForgive && x <= p.cx + p.w + T.edgeForgive;

function updateMama(game, held, dt) {
  const m = game.mama, t = game.t;
  m.rollIn += dt;
  m.invuln = Math.max(0, m.invuln - dt);
  m.coyote = Math.max(0, m.coyote - dt);
  m.buffer = Math.max(0, m.buffer - dt);
  m.stompBuffer = Math.max(0, m.stompBuffer - dt);

  // ride the platform we stand on
  if (m.onGround) { m.x += m.ground.cx - m.ground.pcx; m.y = m.ground.cy; }

  // ── horizontal: gentle roll, steering swipes, held keys, ease-in ──
  let target = T.cruise;
  const locked = t < m.steerLock;
  if (!locked) {
    if (t < m.steerUntil) target = m.steerDir > 0 ? T.push : -T.back;
    else if (T.keyHoldSteer && held.right && !held.left) target = T.push;
    else if (T.keyHoldSteer && held.left && !held.right) target = -T.back;
  }
  if (m.onGround && target > 0) target *= T.rollInStart + (1 - T.rollInStart) * smooth(m.rollIn / T.rollInSeconds);
  const accel = m.onGround ? (m.ground.ice ? T.iceAccel : T.groundAccel) : T.airAccel;
  m.vx = approach(m.vx, target, accel * dt);
  const prevX = m.x;
  m.x += m.vx * dt;
  m.phase += m.vx * dt;
  if (m.vx > 8) m.face = 1; else if (m.vx < -8) m.face = -1;
  resolveWalls(game, prevX);

  // ── leaving the ground? ──
  if (m.onGround && !supports(m.ground, m.x)) { m.onGround = false; m.coyote = T.coyote; m.vy = 0; }

  // ── jump (buffered before landing, coyote after an edge) ──
  if (m.buffer > 0 && (m.onGround || m.coyote > 0)) {
    m.vy = -T.jumpSpeed; m.onGround = false; m.coyote = 0; m.buffer = 0; m.airT = 0;
    game.stats.jumps++;
    emit(game, 'jump', { x: m.x, y: m.y });
  }

  // ── vertical ──
  if (!m.onGround) {
    const prevY = m.y;
    m.vy = Math.min(m.vy + T.gravity * dt, T.maxFall);
    m.y += m.vy * dt;
    m.airT += dt;
    land(game, prevY);
  }

  // ── world interactions ──
  if (m.y > T.killY) { fallOut(game); return; }
}

/** Solid ground slabs block her sides; a very low edge is stepped onto instead. */
function resolveWalls(game, prevX) {
  const m = game.mama, hw = T.mamaHalfW;
  for (const p of nearPlatforms(game, m.x, 60)) {
    if (p.kind !== 'ground' || p.solid === false) continue;
    const top = p.cy, bottom = p.cy + p.h;
    if (m.y <= top + 0.01 || m.y - T.mamaH >= bottom) continue;        // above or below the slab
    if (m.x + hw <= p.cx || m.x - hw >= p.cx + p.w) continue;          // beside it
    if (m.y - top <= T.stepUp) { m.y = top; if (!m.onGround && m.vy >= 0) landOn(game, p, false); continue; }
    if (prevX + hw <= p.cx + 0.5) m.x = p.cx - hw;                      // hit its left face
    else if (prevX - hw >= p.cx + p.w - 0.5) m.x = p.cx + p.w + hw;     // hit its right face
    else continue;                                                      // came from above/below: vertical pass handles it
    m.vx = 0;
  }
}

function land(game, prevY) {
  const m = game.mama;
  if (m.vy < 0) return;
  let best = null;
  for (const p of nearPlatforms(game, m.x, T.footHalfW + T.edgeForgive + 2)) {
    if (!solidTop(p)) continue;
    if (m.x < p.cx - T.edgeForgive || m.x > p.cx + p.w + T.edgeForgive) continue;
    if (prevY <= p.pcy + 1.5 && m.y >= p.cy - 0.01 && (!best || p.cy < best.cy)) best = p;
  }
  if (best) landOn(game, best, true);
}

function landOn(game, p, withEvent) {
  const m = game.mama;
  const hard = m.vy > 380;
  m.y = p.cy; m.vy = 0; m.onGround = true; m.ground = p; m.coyote = 0;
  if (withEvent && m.airT > 0.12) { m.squash = hard ? 1 : 0.6; emit(game, 'land', { x: m.x, y: m.y, hard }); }
  m.airT = 0;
  if (p.kind === 'crumble' && p.state === 'idle') { p.state = 'rumble'; p.st = 0; emit(game, 'crumble-start', { id: p.id }); }
  // a jump asked just before landing happens right away on the next step (buffer)
}

function hurt(game, source) {
  const m = game.mama;
  if (m.invuln > 0 || game.status !== 'running') return;
  game.stats.hits++;
  emit(game, 'hit', { source, x: m.x, y: m.y - 20 });
  if (game.shield) {
    game.shield = false;
    emit(game, 'shield-break', { x: m.x, y: m.y - 20 });
    knock(game, 1.0);
  } else if (game.flock > 0) {
    game.flock--;
    emit(game, 'duckling-lost', { x: m.x, y: m.y - 20, flock: game.flock });
    knock(game, T.invulnHit);
  } else {
    die(game);
  }
}

function knock(game, invuln) {
  const m = game.mama;
  m.invuln = invuln; m.hurtT = 0.6;
  m.vx = T.knockVx; m.vy = T.knockVy; m.onGround = false; m.coyote = 0;
  m.steerLock = game.t + T.hitSteerLock; m.steerUntil = -1;
}

function die(game) {
  const m = game.mama;
  game.status = 'dead'; game.statusT = 0;
  m.vx = -40; m.vy = -380; m.onGround = false; m.hurtT = 1;
  emit(game, 'dead', { x: m.x, y: m.y });
}

function fallOut(game) {
  const m = game.mama;
  game.stats.falls++;
  emit(game, 'fall', { x: m.x, y: Math.min(m.y, T.viewH) });
  if (game.shield) { game.shield = false; emit(game, 'shield-break', { x: m.x, y: T.viewH - 20 }); }
  else if (game.flock > 0) { game.flock--; emit(game, 'duckling-lost', { x: m.x, y: T.viewH - 20, flock: game.flock }); }
  else { die(game); return; }
  respawn(game);
}

/** Put Mama back on safe footing at the latest checkpoint flag. */
export function respawn(game) {
  const cp = game.level.checkpoints[game.checkpoint];
  const keep = { invuln: T.invulnRespawn };
  placeAtCheckpoint(game, cp);
  easeIn(game);
  game.mama.invuln = keep.invuln;
  emit(game, 'respawn', { x: cp.x, y: cp.y });
}

function updateMagnet(game, dt) {
  if (game.magnet <= 0) return;
  game.magnet = Math.max(0, game.magnet - dt);
  const m = game.mama, cx = m.x, cy = m.y - 20;
  for (const p of near(game, game.info.pickupBuckets, game.pickups, cx, T.magnetRadius + 20)) {
    if (p.taken || (p.kind !== 'egg' && p.kind !== 'gold')) continue;
    const dx = cx - p.x, dy = cy - p.y, d = Math.hypot(dx, dy);
    if (d < T.magnetRadius && d > 1) { const s = Math.min(d, T.magnetPull * dt); p.x += dx / d * s; p.y += dy / d * s; }
  }
}

function checkWorld(game) {
  const m = game.mama, t = game.t, lvl = game.level;
  const cx = m.x, cy = m.y - 20;
  game.stats.maxX = Math.max(game.stats.maxX, m.x);

  // pickups
  for (const p of near(game, game.info.pickupBuckets, game.pickups, cx, 40)) {
    if (p.taken) continue;
    if (Math.abs(p.x - cx) > 60) continue;
    const r = (p.kind === 'gold' ? T.goldRadius : T.eggRadius) + T.mamaPickupRadius;
    if (Math.hypot(p.x - cx, p.y - cy) > r) continue;
    p.taken = true;
    collect(game, p);
  }

  // checkpoint flags
  for (let i = game.checkpoint + 1; i < lvl.checkpoints.length; i++) {
    const c = lvl.checkpoints[i];
    if (m.x >= c.x) { game.checkpoint = i; emit(game, 'checkpoint', { index: i, x: c.x, y: c.y }); } else break;
  }

  // captions
  for (const c of lvl.cues) {
    if (m.x >= c.x && !game.cuesShown.has(c)) { game.cuesShown.add(c); emit(game, 'cue', { text: c.text, kind: c.kind || 'tip' }); }
  }

  // springs: roll or land onto one and up you go
  for (const s of near(game, game.info.springBuckets, game.springs, m.x, 40)) {
    if (Math.abs(m.x - s.x) > s.w / 2 + 4) continue;
    if (m.vy >= 0 && m.y >= s.y - 14 && m.y <= s.y + 8 && game.t - s.bounceT > 0.3) {
      s.bounceT = game.t;
      m.vy = -T.springSpeed; m.onGround = false; m.coyote = 0; m.airT = 0;
      emit(game, 'spring', { x: s.x, y: s.y });
    }
  }

  // enemies
  for (const e of near(game, game.info.enemyBuckets, game.enemies, m.x, 40)) {
    if (e.defeated) continue;
    const size = e.kind === 'walker' ? WALKER : FLYER;
    const top = e.kind === 'walker' ? e.y - size.h : e.y - size.h / 2;
    const bottom = top + size.h;
    if (Math.abs(m.x - e.x) > T.mamaHalfW + size.w * 0.42) continue;
    if (m.y < top || m.y - T.mamaH > bottom) continue;
    const stomp = m.vy > 40 && m.py <= top + 12;
    if (stomp) {
      e.defeated = true; e.defeatT = t;
      m.vy = m.stompBuffer > 0 ? -T.stompJump : -T.stompBounce; m.onGround = false; m.coyote = 0; m.stompBuffer = 0; m.buffer = 0; m.airT = 0;
      game.score += T.scoreStomp; game.stats.stomps++;
      emit(game, 'stomp', { x: e.x, y: top, points: T.scoreStomp });
    } else if (m.invuln <= 0) {
      hurt(game, e.kind === 'walker' ? 'enemy' : 'flyer');
      if (game.status !== 'running') return;
    }
  }

  // spikes
  for (const h of near(game, game.info.hazardBuckets, lvl.hazards, m.x, 30)) {
    if (m.x + T.mamaHalfW < h.x + 2 || m.x - T.mamaHalfW > h.x + h.w - 2) continue;
    if (!hazardActive(h, t)) continue;
    const hh = h.h || SPIKE_H;
    if (m.y > h.y - hh + 3 && m.y - T.mamaH < h.y) { hurt(game, 'spikes'); if (game.status !== 'running') return; }
  }

  // the beacon, then the gate
  if (lvl.beacon && !game.beaconLit && m.x >= lvl.beacon.x - 10) {
    game.beaconLit = true; game.status = 'beacon'; game.statusT = 0;
    game.score += T.scoreBeacon;
    emit(game, 'beacon', { x: lvl.beacon.x, y: lvl.beacon.y });
    return;
  }
  if (!lvl.beacon && m.x >= lvl.endX) {
    game.status = 'exit'; game.statusT = 0;
    game.score += T.scoreChapter;
    emit(game, 'exit', { x: m.x, y: m.y });
  }
}

function collect(game, p) {
  const m = game.mama;
  game.stats.eggs += (p.kind === 'egg' || p.kind === 'gold') ? 1 : 0;
  if (p.kind === 'egg') {
    game.eggs++; game.score += T.scoreEgg;
    emit(game, 'egg', { id: p.id, x: p.x, y: p.y, points: T.scoreEgg });
  } else if (p.kind === 'gold') {
    game.eggs++; game.score += T.scoreGold; game.stats.golds++;
    const hatched = game.flock < T.maxFlock;
    emit(game, 'gold', { id: p.id, x: p.x, y: p.y, points: T.scoreGold, hatched });
    if (hatched) { game.flock++; emit(game, 'hatch', { x: p.x, y: p.y, flock: game.flock }); }
  } else if (p.kind === 'shield') {
    game.shield = true; game.score += 5; emit(game, 'shield', { x: m.x, y: m.y - 20 });
  } else if (p.kind === 'magnet') {
    game.magnet = T.magnetSeconds; game.score += 5; emit(game, 'magnet', { x: m.x, y: m.y - 20 });
  }
}

/* ───────────────────────── the flock ───────────────────────── */

function recordHistory(game, dt) {
  const h = game.hist, m = game.mama, period = 1 / T.historyRate;
  h.acc += dt;
  while (h.acc >= period) {
    h.acc -= period;
    const i = h.n % h.x.length;
    h.x[i] = m.x; h.y[i] = m.y; h.n++;
  }
}

function updateFollowers(game) {
  const m = game.mama, h = game.hist, n = game.flock;
  if (m.vx > 20) game.followSide = -1; else if (m.vx < -20) game.followSide = 1;
  const side = game.followSide;
  const list = game.followers;
  while (list.length > n) list.pop();
  let leaderX = m.x;
  for (let i = 0; i < n; i++) {
    const delay = T.flockDelay + i * T.flockGap;
    const back = Math.round(delay * T.historyRate);
    const idx = ((h.n - 1 - back) % h.x.length + h.x.length) % h.x.length;
    const hasData = h.n - 1 - back >= 0;
    let x = hasData ? h.x[idx] : m.x + side * (i + 1) * T.flockMinSpacing;
    const y = hasData ? h.y[idx] : m.y;
    x = side < 0 ? Math.min(x, leaderX - T.flockMinSpacing) : Math.max(x, leaderX + T.flockMinSpacing);
    leaderX = x;
    let f = list[i];
    if (!f) { f = list[i] = { x, y, px: x, py: y, face: 1, air: false, born: game.t }; }
    f.x = x; f.y = y; f.face = side < 0 ? 1 : -1; f.air = Math.abs(y - f.py) > 0.4;
  }
}

/** Mama's hurtbox, for art/debug/tests. */
export const mamaBox = (game) => ({ x0: game.mama.x - T.mamaHalfW, x1: game.mama.x + T.mamaHalfW, y0: game.mama.y - T.mamaH, y1: game.mama.y });

/**
 * Independent copy for look-ahead (the test bot's planner). The static level is shared;
 * everything that changes during play is copied. `light` skips the flock trail.
 */
export function cloneGame(game, light = true) {
  const m = game.mama;
  const copy = {
    ...game,
    events: [], stats: { ...game.stats },
    platforms: game.platforms.map((p) => ({ ...p })),
    pickups: game.pickups.map((p) => ({ ...p })),
    enemies: game.enemies.map((e) => ({ ...e })),
    springs: game.springs.map((q) => ({ ...q })),
    cuesShown: new Set(game.cuesShown),
    mama: { ...m },
    followers: light ? [] : game.followers.map((f) => ({ ...f })),
    hist: light ? { x: new Float32Array(1), y: new Float32Array(1), n: 0, acc: 0 } : { x: game.hist.x.slice(), y: game.hist.y.slice(), n: game.hist.n, acc: game.hist.acc },
    _near: [], _tick: 0, _seen: new Int32Array(game._seen.length),
  };
  const gi = game.platforms.indexOf(m.ground);
  copy.mama.ground = gi >= 0 ? copy.platforms[gi] : m.ground;
  return copy;
}
