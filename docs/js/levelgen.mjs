/*
 * Egg Mama — the world generator (DESIGN.md section 4).
 *
 *   generateLevel({ circuit, seed, trace? }) -> ONE Level: all 13 landscapes of one circuit in a single coordinate space.
 *   levelSeed(journeySeed, circuit)          -> the uint32 seed of that circuit.
 *
 * The Level follows the format in sim.mjs's header, plus these additions (all optional for consumers):
 *   platform.o = 1     an OPTIONAL platform (upper route / alcove / branch ledge / ice leap): never required to finish, and
 *                      always hung above an unbroken main route, so falling off it costs nothing
 *   cues[].kind        'story' (landscape opening) | 'trail' (a chapter.trail line) | 'tip' (a lesson, just before its first use)
 *   acts[]             { ch, id, role, x0, x1, d0, d1, beats, beatX }: beats = the names of the beats built in the act, in
 *                      order (plus 'gapCarve' for a hop the dead-stretch guard carved), beatX = where each starts (u): the report's
 *                      listings and the variety tests read them
 *   water              always { y: 330 }; the renderer draws it only in landscapes whose chapter says `water`
 *   trace (an optional ARRAY argument)  one { ch, id, quota, got, budget, used, pad } record per act is pushed into it: the
 *                      pacing controller's books, for the report and the tests. It never changes the Level.
 *
 * Pure and deterministic (seeded rng only; no Math.random, no Date). The structure:
 *   levels/phys.mjs      what one swipe can reach (windows, chains, spikes, springs), checked against the sim
 *   levels/params.mjs    how demands scale with levelDifficulty(); RATE (threat-weighted required events a minute per landscape); chainCap
 *   levels/builder.mjs   the cursor-based builder with undo, an event count and a beat log
 *   levels/beats*.mjs    the building blocks (a gap with an egg arc, a snail patrol, a crumble chain, a lift ride, ...);
 *                        beats4/5: structural variants of every signature and the optional ice / spring-steering sequences
 *   levels/acts.mjs      acts = arcs of beats; the per-landscape plan; the runner and its pacing controller
 *   levels/cues.mjs      story captions, trail lines and tips
 *   levels/densify.mjs   the dead-stretch guard: carves a hop into any wait over ~18 s
 *   levels/demand.mjs    the generator's own yardstick of how demanding a stretch is (tests / report). tests/felt.mjs is the
 *                        independent one: it counts what the player has to DO from the finished geometry only
 *
 * The felt ramp (LEVELS-2/3): each landscape is paced to a number of THREAT-WEIGHTED required events a minute, rising slowly from about
 * 5.3 in Meadow to about 11 at the Summit (params.RATE; a hop, a wall, a walker, a static spike, a lift or mover board / exit count 1,
 * a flyer the share of the time a Mama who never jumps is hit by it, ~0.35 for a low moth and 0 for a high one, a spring that carries a
 * gap 0.25: builder.eventsSince / phys.flyerThreat). levelgen turns that into a quota of events for every act (shared by weight and role:
 * recall and closing a little calmer, set piece and combine a little busier), and acts.mjs spaces the events by the length of the rest
 * before each beat, so a landscape lands on its rate whatever the dice give. Early landscapes are mostly single events, later ones
 * doubles, triples ... (params.chainCap, and a hard chain check): "plan the second landing". Later circuits are NOT harder than circuit
 * 2 (params.levelDifficulty: the ramp saturates, D_MAX 16); they only ask a few more events a minute (params.circuitRate).
 * No stretch is empty: after the circuit is built, levels/densify.mjs carves a small hop into any wait for a required event over ~18 s
 * (breathers excepted), so no run waits over 26 s, and optional activity (egg arcs that want a jump, ledges to climb, springs, golden eggs)
 * is never more than a few seconds away. A rise is a small hop (not a zero-gap wall she stops dead against) except now and then.
 */
import { T, clamp } from './tuning.mjs';
import { rng, mixSeed } from './rng.mjs';
import { CHAPTERS } from './chapters.mjs';
import { Builder, Y0 } from './levels/builder.mjs';
import { assemble } from './levels/assemble.mjs';
import { ACTS, PLAN, ROLE_OFFSET, runStages, fillTo, actIntro } from './levels/acts.mjs';
import { RATE, ROLE_RATE, levelDifficulty, D_MAX } from './levels/params.mjs';
import { placeCues } from './levels/cues.mjs';
import { densify } from './levels/densify.mjs';

/** The seed of circuit `circuit` of a journey. */
export function levelSeed(journeySeed, circuit) {
  return mixSeed(journeySeed >>> 0, circuit | 0, 0x5eed);
}

const FLAG_OFFSET = 300;           // every landscape's first flag sits this far into it
const JOIN = 300;                  // safe ground before a landscape boundary (the dissolve happens over it)
const OPEN_LEN = 860;              // hazard-free stretch from the boundary (>= 700 required)

/**
 * Which acts a landscape uses. Circuit 1 follows the teaching order (each lesson once, alone, then grown). Later
 * circuits keep every landscape's opening, signature lesson, breather, set piece and closing but redraw the
 * 'recall', 'vary' and 'combine' slots from the library (every element is known by then), skipping anything used
 * in the last couple of landscapes (`recent` is the ring buffer), so each repeat has a fresh arrangement. A landscape
 * only borrows from elements up to four landscapes ahead of it (its 'recall' act from elements no newer than its own
 * landscape), so Meadow never grows lifts or ice and a join never opens with something heavier than what came before.
 */
function planFor(i, circuit, rand, recent) {
  const base = PLAN[i];
  if (circuit < 2) return base.slice();
  const roleOf = (id) => ACTS[id].role;
  const library = Object.keys(ACTS);
  const plan = base.slice();
  for (const role of ['recall', 'vary', 'combine']) {
    const slot = plan.findIndex((id) => roleOf(id) === role);
    if (slot < 0) continue;
    const candidates = library.filter((id) => roleOf(id) === role && !plan.includes(id) && !recent.includes(id) && actIntro(id) <= (role === 'recall' ? i : i + 4));
    if (candidates.length) plan[slot] = candidates[rand.int(0, candidates.length - 1)];
  }
  return plan;
}

export function generateLevel({ circuit = 1, seed = 1, trace = null } = {}) {
  seed >>>= 0;
  const B = new Builder(rng(mixSeed(seed, 0xB011D)), { circuit });
  const acts = [];
  const chapters = [];
  const landscapes = [];
  let x0 = 0;
  let recent = [];

  for (let i = 0; i < CHAPTERS.length; i++) {
    const land = rng(mixSeed(seed, i, 0xC0DE));
    B.rand = land;
    const L = Math.round(CHAPTERS[i].seconds * T.cruise);
    const x1 = x0 + L;                      // nominal end; the next landscape's first flag is exactly L further on
    const last = i === CHAPTERS.length - 1;
    const dBase = (x) => levelDifficulty(i, circuit, clamp((x - x0) / L, 0, 1));

    // ── the boundary: join the previous landscape, flag, quiet stretch ──
    B.ch = i;
    if (i === 0) B.begin(-300, Y0, 600);
    else {
      if (B.x < x0) B.run(x0 - B.x, 'line');
      B.newIsland();
    }
    B.run(FLAG_OFFSET - (B.x - x0), 'line');
    const flagId = B.cps.length;
    B.flag();
    const openStart = x0;
    if (i === 0) {                           // the very first golden egg of a circuit, on flat safe ground
      B.run(300, 'line');
      B.gold(B.x - 90, B.y - 28); B.lastGold = B.x;
    }
    B.run(x0 + OPEN_LEN - B.x, 'hops');            // eggs hung in arcs: something to jump for even here
    B.lastGold = Math.max(B.lastGold, i === 0 ? B.x : B.lastGold);
    chapters.push({ index: i, x0, x1, flag: flagId });
    const bound = { openEnd: B.x };

    // ── the acts ──
    const plan = planFor(i, circuit, land, recent).filter((id) => id !== 'open');
    const endTarget = last ? x1 + FLAG_OFFSET - 480 - 260 - 100 : x1 - JOIN;    // where the last act stops
    B.joinFlagX = last ? endTarget + 300 : x1 + FLAG_OFFSET;
    let remaining = plan.reduce((s, id) => s + ACTS[id].w, 0);
    // events this landscape should ask for in all, shared among its acts by role (breathers and the opening ask none)
    const wanted = RATE(i, 0.5, circuit) * (L / T.cruise / 60);
    let eventW = plan.reduce((s, id) => s + ACTS[id].w * (ROLE_RATE[ACTS[id].role] ?? 1), 0);
    const ev0 = B.events;
    const landActs = [];
    B.logStart = B.beatLog.length;                      // the variety bookkeeping of this landscape starts here
    for (const id of plan) {
      const act = ACTS[id];
      const budget = Math.max(600, ((endTarget - B.x) * act.w) / remaining);
      remaining -= act.w;
      const share = act.w * (ROLE_RATE[act.role] ?? 1);
      const myEvents = eventW > 0 ? Math.max(0, wanted - (B.events - ev0)) * share / eventW : 0;     // what is still owed, split by weight
      eventW -= share;
      // never ask for more than fits: even at the shortest rests an event takes about 400 u
      const asked = Math.min(myEvents, budget / 400);
      const pace = asked > 0.5 ? { per: budget / asked, events: asked } : null;
      const beatLog0 = B.beatLog.length, evBefore = B.events;
      const ax0 = B.x, ax1 = ax0 + budget;
      const off = ROLE_OFFSET[act.role] ?? 0;
      const dAt = (x) => clamp(dBase(x) + off, 0, D_MAX);
      const c = { rand: land, ch: i, circuit, d: dAt(ax0), k: 0 };
      B.iceMode = CHAPTERS[i].ice === true && act.role !== 'recall';      // Frostline's climb is slippery from its first lesson on
      const lastAct = id === plan[plan.length - 1];
      // the last act ends before the join; every earlier act leaves it at least ~1450 u (13 s; its `minRoom` if it asks for more) so a closing is never a stub
      runStages(B, c, act, ax0, ax1, dAt, lastAct, lastAct ? endTarget : endTarget - (ACTS[plan[plan.length - 1]].minRoom ?? 1450), pace);
      const xBeforePad = B.x;
      if (lastAct) fillTo(B, ax1);                     // only the landscape's last act is padded out (with a flag if one is due): any other leftover goes to the next act
      if (trace) trace.push({ ch: i, id, quota: +myEvents.toFixed(1), got: B.events - evBefore, budget: Math.round(budget), used: Math.round(xBeforePad - ax0), pad: Math.round(B.x - xBeforePad) });
      landActs.push({ ch: i, id, role: act.role, x0: ax0, x1: B.x, d0: dAt(ax0), d1: dAt(B.x), beats: B.beatLog.slice(beatLog0), beatX: B.beatX.slice(beatLog0) });
      recent.push(id); if (recent.length > 18) recent.shift();       // ring buffer of the last ~2 landscapes' templates
    }
    acts.push(...landActs);
    landscapes.push({ index: i, x0, x1, open: [openStart, bound.openEnd], acts: landActs.length });
    if (last) break;
    B.iceMode = false;
    // ── tail: safe ground up to the next boundary ──
    fillTo(B, x1);
    x0 = x1;
  }

  // ── the beacon: last, on safe ground well after the final hazard ──
  B.station({ before: 300, after: 420 });
  const beaconX = B.x + 60;
  const endX = beaconX + 140;
  B.run(endX + 140 - B.x, 'line');
  const beacon = { x: beaconX, y: B.y };
  chapters[chapters.length - 1].x1 = endX;

  // ── the dead-stretch guard: a small hop carved into any wait for a required event that is still too long ──
  densify(B, { acts, chapters, seed, circuit, endX: beaconX });

  const cues = placeCues(B, chapters, beacon);
  const beats = [];
  for (const ls of landscapes) {
    const mine = acts.filter((a) => a.ch === ls.index);
    const mid = mine.slice(0, -1);
    beats.push({ kind: 'opening', x0: ls.x0, x1: ls.open[1], name: CHAPTERS[ls.index].name });
    if (mid.length) beats.push({ kind: 'middle', x0: ls.open[1], x1: mine[mine.length - 1].x0, name: CHAPTERS[ls.index].learn });
    beats.push({ kind: 'closing', x0: mine[mine.length - 1].x0, x1: ls.index === CHAPTERS.length - 1 ? endX : ls.x1, name: mine[mine.length - 1].id });
  }

  const level = assemble(B, {
    circuit, seed,
    start: { x: B.cps[0].x, y: Y0 },
    endX,
    chapters,
    beacon,
    cues,
    beats,
    water: { y: 330 },
    acts: acts.map((a) => ({ ch: a.ch, id: a.id, role: a.role, x0: Math.round(a.x0), x1: Math.round(a.x1), d0: +a.d0.toFixed(2), d1: +a.d1.toFixed(2), beats: a.beats, beatX: a.beatX })),
  });
  return level;
}
