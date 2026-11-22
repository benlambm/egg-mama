/*
 * Egg Mama — acts: 30-50 s arcs built from beats, and the per-landscape plan that strings them together.
 *
 * An ACT is a small story: it starts easy, builds through its stages, peaks, then eases off. Its template is a
 * list of STAGES; each stage has a weight (its share of the act's length) and a pool of beat specs that it
 * draws from until its share is used up. A spec is a beat name, or "a+b" for beats played back to back with
 * little recovery room (a combination). A stage can instead be a fixed SEQUENCE (set pieces are scripted).
 *
 * The roles (recall / teach / vary / combine / breather / setpiece / closing) set where an act sits on the
 * landscape's difficulty ramp. No two consecutive acts use the same template (a ring buffer of recent ids).
 */
import { T, clamp, lerp } from '../tuning.mjs';
import { Y0 } from './builder.mjs';
import { P } from './params.mjs';
import { BEATS, rest } from './beats.mjs';
import './beats2.mjs';
import './beats3.mjs';  // crown, hillTop (set-piece flourishes)

export const ROLE_OFFSET = { opening: -0.3, recall: -0.6, teach: -0.4, vary: 0.0, combine: 0.35, setpiece: 0.5, breather: -0.8, closing: -0.5 };

const S = (w, ...pool) => ({ w, pool });
const Q = (w, ...seq) => ({ w, seq });

/** id -> { role, w (relative length), stages, needs: [elements used] } */
export const ACTS = {
  // ───── openings / breathers / closings shared by all landscapes (custom runners below) ─────
  open: { role: 'opening', w: 1.0, stages: [] },                       // built by levelgen: the join, the flag and the quiet stretch
  breather: { role: 'breather', w: 1.6, flag: true, stages: [Q(1, 'upper', 'eggField', 'goldenPatch', 'eggField')] },
  breather2: { role: 'breather', w: 1.5, flag: true, stages: [Q(1, 'treasure', 'eggField', 'goldenPatch', 'hills')] },
  close: { role: 'closing', w: 1.5, flag: true, stages: [S(0.5, 'hills', 'runEggs'), S(0.5, 'gap1', 'upper', 'hills')] },

  // ───── Meadow: jump, gap, eggs ─────
  gapsTeach: { role: 'teach', w: 3.0, stages: [S(0.28, 'gap1'), S(0.4, 'gap1', 'gap1', 'stepUp'), S(0.32, 'gap1', 'gapPair')] },
  stepsAct: { role: 'vary', w: 3.0, stages: [S(0.3, 'stepUp', 'hills'), S(0.4, 'stepUp', 'stairs', 'gap1'), S(0.3, 'stairs', 'gapPair')] },
  ledgeHops: { role: 'vary', w: 3.4, stages: [S(0.3, 'upper'), S(0.4, 'upper', 'gap1', 'stepUp'), S(0.3, 'upper', 'gapPair')] },
  gapRhythm: { role: 'combine', w: 3.4, stages: [S(0.3, 'gapPair', 'gap1'), S(0.4, 'gapChain', 'gap1', 'upper'), S(0.3, 'gapChain', 'gapPair')] },
  goldenHill: { role: 'setpiece', w: 3.0, stages: [Q(1, 'hillTop', 'gapPair', 'hillTop', 'upper', 'hillTop')], finale: ['crown'] },
  snailFirst: { role: 'closing', w: 2.2, flag: true, stages: [S(0.5, 'gap1', 'runEggs', 'stepUp'), S(0.5, 'walker1', 'runEggs')] },

  // ───── Clover Mill: read a patrolling snail ─────
  recallGaps: { role: 'recall', w: 2.0, stages: [S(0.5, 'gap1', 'stepUp'), S(0.5, 'gapPair', 'upper')] },
  snailTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'walker1'), S(0.4, 'walker1', 'upper'), S(0.3, 'walker1', 'walkerIsland')] },
  snailVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'walker1', 'walkerPair'), S(0.4, 'walkerPair', 'walker1+gap1', 'upper'), S(0.3, 'walkerIsland', 'walkerPair')] },
  windmillYard: { role: 'setpiece', w: 3.4, stages: [Q(1, 'walker1', 'walkerPair', 'walkerIsland', 'walker1+upper', 'walkerPair', 'walkerIsland+walker1')], finale: ['crown'] },
  cloverGaps: { role: 'combine', w: 3.2, stages: [S(0.3, 'walker1+gap1', 'gapPair'), S(0.4, 'walkerIsland', 'gapChain', 'walker1+gapPair'), S(0.3, 'walkerPair', 'walkerIsland+gap1')] },

  // ───── Reedwater: stepping logs over the flood ─────
  recallSnails: { role: 'recall', w: 2.0, stages: [S(0.5, 'walker1', 'gap1'), S(0.5, 'walkerIsland', 'upper')] },
  logsTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'logs'), S(0.4, 'logs', 'upper'), S(0.3, 'logs', 'logs')] },
  logsVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'logs', 'gapPair'), S(0.4, 'logs', 'upper', 'walker1'), S(0.3, 'logs', 'gapChain')] },
  floatingLogs: { role: 'setpiece', w: 3.4, stages: [Q(1, 'logs', 'logs+upper', 'logs', 'logs+gap1', 'logs')], finale: ['crown'] },
  reedCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'logs', 'walker1'), S(0.4, 'logs+walker1', 'walkerIsland', 'logs'), S(0.3, 'logs+gap1', 'walkerPair')] },

  // ───── Orchard Heights: springs to the branches ─────
  recallLogs: { role: 'recall', w: 2.0, stages: [S(0.5, 'logs', 'upper'), S(0.5, 'gapPair', 'walker1')] },
  springTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'springLedge'), S(0.36, 'springLedge', 'springGap'), S(0.3, 'springTwo', 'springLedge')] },
  springVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'springGap', 'springLedge'), S(0.4, 'springTwo', 'springGap', 'walker1'), S(0.3, 'springLedge+gap1', 'springTwo')] },
  blossomBounce: { role: 'setpiece', w: 3.4, stages: [Q(1, 'springLedge', 'springTwo', 'springGap+springLedge', 'springTwo', 'springGap+springTwo')], finale: ['crown'] },
  orchardCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'springLedge', 'logs'), S(0.4, 'springGap+walker1', 'springTwo', 'logs+springGap'), S(0.3, 'walkerIsland+springGap', 'springTwo')] },

  // ───── Amber Quarry: crumbling ledges ─────
  recallSprings: { role: 'recall', w: 2.0, stages: [S(0.5, 'springLedge', 'gap1'), S(0.5, 'springGap', 'logs')] },
  crumbleTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'crumbleUpper'), S(0.36, 'crumbleUpper', 'crumbleBridge'), S(0.3, 'crumbleBridge', 'crumbleChain')] },
  crumbleVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'crumbleBridge', 'crumbleUpper'), S(0.4, 'crumbleChain', 'logs', 'walker1'), S(0.3, 'crumbleChain', 'crumbleBridge+gap1')] },
  quarryCrane: { role: 'setpiece', w: 3.4, stages: [Q(1, 'crumbleChain', 'crumbleBridge+crumbleChain', 'crumbleUpper', 'crumbleChain', 'crumbleChain+logs')], finale: ['crown'] },
  quarryCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'crumbleChain', 'springLedge'), S(0.4, 'crumbleChain+walker1', 'crumbleBridge+springGap', 'logs'), S(0.3, 'crumbleChain', 'walkerIsland+crumbleBridge')] },

  // ───── Fogwood: flying moths ─────
  recallCrumbles: { role: 'recall', w: 2.0, stages: [S(0.5, 'crumbleBridge', 'walker1'), S(0.5, 'crumbleUpper', 'logs')] },
  mothTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'flyerHigh'), S(0.36, 'flyerHigh', 'flyer1'), S(0.3, 'flyer1', 'flyerPair')] },
  mothVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'flyer1', 'flyerHigh', 'upper'), S(0.4, 'flyer1+gap1', 'flyerPair', 'logs'), S(0.3, 'flyerPair', 'flyer1+gapPair')] },
  mothLanterns: { role: 'setpiece', w: 3.4, stages: [Q(1, 'flyer1', 'flyerPair', 'flyer1+gap1', 'flyerHigh+flyer1', 'flyerPair')], finale: ['crown'] },
  mothCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'flyer1', 'logs'), S(0.4, 'flyer1+walker1', 'crumbleChain', 'flyerPair+gap1'), S(0.3, 'flyer1+crumbleBridge', 'walkerIsland')] },

  // ───── Ember Canyon: gap then spikes ─────
  recallMoths: { role: 'recall', w: 2.0, stages: [S(0.5, 'flyer1', 'gap1'), S(0.5, 'flyerHigh', 'crumbleBridge')] },
  spikeTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'spike1'), S(0.36, 'spike1', 'gapSpike'), S(0.3, 'spikeRow', 'gapSpike')] },
  spikeVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'spike1', 'spikeGap'), S(0.4, 'gapSpike', 'spikeCycle', 'upper'), S(0.3, 'spikeRow', 'spikeGap', 'spikeCycle')] },
  canyonRun: { role: 'setpiece', w: 3.4, stages: [Q(1, 'spikeRow', 'gapSpike', 'spikeGap+spikeRow', 'spikeCycle', 'gapSpike+spike1')], finale: ['crown'] },
  canyonCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'spike1+gap1', 'flyer1'), S(0.4, 'gapSpike', 'spikeRow+flyerHigh', 'crumbleChain'), S(0.3, 'spikeCycle+gap1', 'walkerIsland+spike1')] },

  // ───── Glass Coast: lifts ─────
  recallSpikes: { role: 'recall', w: 2.0, stages: [S(0.5, 'spike1', 'gap1'), S(0.5, 'spikeGap', 'upper')] },
  liftTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'liftRide'), S(0.36, 'liftRide', 'upper'), S(0.3, 'liftRide', 'liftClimb')] },
  liftVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'liftRide', 'gapPair'), S(0.4, 'liftClimb', 'walker1', 'liftRide'), S(0.3, 'liftClimb', 'liftRide+gap1')] },
  cliffLifts: { role: 'setpiece', w: 3.4, stages: [Q(1, 'liftClimb', 'liftRide', 'liftClimb', 'liftRide+gap1', 'liftClimb')], finale: ['crown'] },
  liftCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'liftRide', 'spike1'), S(0.4, 'liftRide+spike1', 'flyer1', 'liftClimb'), S(0.3, 'liftClimb+gap1', 'walkerIsland+liftRide')] },

  // ───── Lantern Caverns: lift -> crumble ─────
  recallLifts: { role: 'recall', w: 2.0, stages: [S(0.5, 'liftRide', 'crumbleBridge'), S(0.5, 'liftClimb', 'upper')] },
  liftCrumbleTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'liftCrumble'), S(0.36, 'liftCrumble', 'liftRide'), S(0.3, 'liftCrumble', 'crumbleChain')] },
  liftCrumbleVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'liftCrumble', 'crumbleUpper'), S(0.4, 'liftCrumble', 'crumbleChain', 'flyer1'), S(0.3, 'liftCrumble', 'liftClimb')] },
  crystalDescent: { role: 'setpiece', w: 3.4, stages: [Q(1, 'liftDescent', 'liftCrumble', 'liftDescent', 'crumbleChain', 'liftCrumble+crumbleBridge')], finale: ['crown'] },
  caveCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'liftCrumble', 'spike1'), S(0.4, 'liftCrumble+gap1', 'crumbleChain+flyer1', 'liftDescent'), S(0.3, 'liftCrumble', 'spikeGap+crumbleBridge')] },

  // ───── Frostline: ice ─────
  recallCaves: { role: 'recall', w: 2.0, stages: [S(0.5, 'liftCrumble', 'crumbleChain'), S(0.5, 'liftRide', 'spike1')] },
  iceTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'iceRun'), S(0.36, 'iceRun', 'upper'), S(0.3, 'iceRun', 'iceRun')] },
  iceVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'iceRun', 'stepUp'), S(0.4, 'iceRun', 'spike1', 'upper'), S(0.3, 'iceRun', 'gapSpike')] },
  iceSlide: { role: 'setpiece', w: 3.4, stages: [Q(1, 'iceRun', 'iceRun+spike1', 'iceRun', 'iceRun+gapSpike', 'iceRun')], finale: ['crown'] },
  iceCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'iceRun', 'walker1'), S(0.4, 'iceRun+spike1', 'liftRide', 'iceRun+walker1'), S(0.3, 'iceRun', 'flyer1+iceRun')] },

  // ───── Moonridge: walker patrol and a mover ─────
  recallIce: { role: 'recall', w: 2.0, stages: [S(0.5, 'iceRun', 'walker1'), S(0.5, 'gapPair', 'upper')] },
  moverTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'moverFerry'), S(0.36, 'moverFerry', 'walker1'), S(0.3, 'moverFerry', 'walkerIsland')] },
  moverVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'moverFerry', 'walkerPair'), S(0.4, 'walkerIsland+moverFerry', 'moverFerry', 'upper'), S(0.3, 'moverFerry+walker1', 'walkerPair')] },
  moonBridge: { role: 'setpiece', w: 3.4, stages: [Q(1, 'moverFerry', 'walkerIsland+moverFerry', 'moverFerry', 'moverFerry+walker1', 'walkerPair')], finale: ['crown'] },
  moonCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'moverFerry', 'spike1'), S(0.4, 'moverFerry+walker1', 'liftRide', 'flyer1+moverFerry'), S(0.3, 'moverFerry+spike1', 'walkerIsland+liftRide')] },

  // ───── Dawnbridge: broken spans ─────
  recallMovers: { role: 'recall', w: 2.0, stages: [S(0.5, 'moverFerry', 'gap1'), S(0.5, 'walkerIsland', 'upper')] },
  bridgeTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'bridge'), S(0.36, 'bridge', 'upper'), S(0.3, 'bridge', 'bridge')] },
  bridgeVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'bridge', 'gapPair'), S(0.4, 'bridge', 'upper', 'walker1'), S(0.3, 'bridge', 'bridge+gap1')] },
  brokenBridge: { role: 'setpiece', w: 3.4, stages: [Q(1, 'bridge', 'bridge+gap1', 'bridge', 'bridge+bridge', 'bridge')], finale: ['crown'] },
  bridgeCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'bridge', 'flyer1'), S(0.4, 'bridge+spike1', 'crumbleChain', 'bridge+flyer1'), S(0.3, 'bridge', 'moverFerry+bridge')] },

  // ───── Beacon Summit: springs, lifts and timed jumps ─────
  recallBridges: { role: 'recall', w: 2.0, stages: [S(0.5, 'bridge', 'springLedge'), S(0.5, 'liftRide', 'upper')] },
  summitTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'springGap+gap1', 'springLedge'), S(0.4, 'liftRide+gap1', 'springTwo+gapPair', 'springGap+liftRide'), S(0.3, 'liftClimb', 'springGap+gapPair')] },
  summitVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'springGap+liftRide', 'gapChain+springGap'), S(0.4, 'liftRide+gapPair', 'springLedge+gap1', 'moverFerry+gap1'), S(0.3, 'springTwo+gapChain', 'liftCrumble+gap1')] },
  summitClimb: { role: 'setpiece', w: 3.6, stages: [Q(1, 'springGap+liftRide', 'liftRide+gapChain', 'crumbleChain+springLedge', 'moverFerry+gap1', 'liftRide+spike1', 'springTwo+gapPair')], finale: ['crown'] },
  summitCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'springGap+walker1', 'liftRide+spike1'), S(0.4, 'liftRide+gapChain', 'crumbleChain+springGap+gap1', 'moverFerry+spike1'), S(0.3, 'liftCrumble+springGap', 'bridge+spikeRow')] },
  summitClose: { role: 'closing', w: 1.6, flag: true, stages: [S(0.5, 'upper', 'gap1', 'hills'), S(0.5, 'springGap', 'liftRide', 'runEggs')] },
};

/**
 * The plan of each landscape, in order. Circuit 1 uses these exactly (the lessons come in teaching order); later
 * circuits keep each landscape's opening, signature set piece and closing but draw the middle acts from the
 * landscape's pools below (so the arrangement is fresh), with every element already available.
 */
export const PLAN = [
  ['open', 'gapsTeach', 'stepsAct', 'breather', 'ledgeHops', 'gapRhythm', 'goldenHill', 'snailFirst'],
  ['open', 'recallGaps', 'snailTeach', 'breather', 'snailVary', 'windmillYard', 'cloverGaps', 'close'],
  ['open', 'recallSnails', 'logsTeach', 'breather2', 'logsVary', 'floatingLogs', 'reedCombine', 'close'],
  ['open', 'recallLogs', 'springTeach', 'breather', 'springVary', 'blossomBounce', 'orchardCombine', 'close'],
  ['open', 'recallSprings', 'crumbleTeach', 'breather2', 'crumbleVary', 'quarryCrane', 'quarryCombine', 'close'],
  ['open', 'recallCrumbles', 'mothTeach', 'breather', 'mothVary', 'mothLanterns', 'mothCombine', 'close'],
  ['open', 'recallMoths', 'spikeTeach', 'breather2', 'spikeVary', 'canyonRun', 'canyonCombine', 'close'],
  ['open', 'recallSpikes', 'liftTeach', 'breather', 'liftVary', 'cliffLifts', 'liftCombine', 'close'],
  ['open', 'recallLifts', 'liftCrumbleTeach', 'breather2', 'liftCrumbleVary', 'crystalDescent', 'caveCombine', 'close'],
  ['open', 'recallCaves', 'iceTeach', 'breather', 'iceVary', 'iceSlide', 'iceCombine', 'close'],
  ['open', 'recallIce', 'moverTeach', 'breather2', 'moverVary', 'moonBridge', 'moonCombine', 'close'],
  ['open', 'recallMovers', 'bridgeTeach', 'breather', 'bridgeVary', 'brokenBridge', 'bridgeCombine', 'close'],
  ['open', 'recallBridges', 'summitTeach', 'breather2', 'summitVary', 'summitClimb', 'summitCombine', 'summitClose'],
];

/** For circuits >= 2: per landscape, which acts may replace the 'recall', 'vary' and 'combine' slots. */
export const POOLS = PLAN.map((plan) => ({ recall: plan[1], teach: plan[2], vary: plan[4], set: plan[5], combine: plan[6] }));

/* ───────────────────────── running an act ───────────────────────── */

const FLAG_EVERY = 1500;            // u of main route after a flag before the next one is due (~14 s)
const FLAG_MAX = 3000;              // never more than this (~27 s) between flags: the rule is 35 s
const lastFlag = (B) => (B.cps.length ? B.cps[B.cps.length - 1].x : -1e9);

/** Flat ground up to x, with a flag in the middle if the last one is far behind (used to pad out an act). */
export function fillTo(B, x) {
  while (x - B.x > 120) {
    const room = x - B.x;
    if (B.x - lastFlag(B) > 1200 && room > 800) { B.station({ after: Math.min(420, room - 280 - 260) }); continue; }
    B.run(Math.min(room, 1100), 'auto');
  }
  if (x - B.x > 0) B.run(x - B.x, 'line');
}

/** One run of beats from a spec "a" or "a+b" (tight combination). Returns true if it was built (else rolled back). */
function runSpec(B, c, spec, limit) {
  const parts = spec.split('+');
  for (let attempt = 0; attempt < 2; attempt++) {
    const mk = B.mark();
    if (attempt === 1) B.station({ after: 400 });
    for (let i = 0; i < parts.length; i++) {
      const beat = BEATS[parts[i]];
      if (!beat) throw new Error('unknown beat ' + parts[i]);
      if (i === 0 && B.x - lastFlag(B) > FLAG_EVERY) B.station({ after: 400 });
      rest(B, c, i === 0 ? 1 : 0.42, i === 0 ? 280 : 200);
      if (i === 0 && B.x - B.lastGold > 5200 && c.d !== undefined) { BEATS.goldenPatch.fn(B, c); B.run(200, 'line'); }   // keep the golden eggs coming (about one per 40-50 s)
      beat.fn(B, c);
      if (B.bad) break;
    }
    const dyBad = Math.abs(B.y - Y0) > 30;
    if (B.bad || B.x > limit || dyBad) { B.rollback(mk); return false; }
    if (B.x - lastFlag(B) > FLAG_MAX && attempt === 0) { B.rollback(mk); continue; }   // too long without a flag: flag first, then rebuild
    return true;
  }
  return false;
}

/**
 * Run an act (stage by stage) from the cursor to about x1. `c` carries rand / ch / circuit; difficulty comes from
 * dAt(x). Pool stages draw random specs until their share of the length is used; sequence stages (set pieces)
 * play their specs in order, cycling, and every act can end with a `finale` (e.g. the golden crown).
 */
export function runStages(B, c, act, x0, x1, dAt, strict = false) {
  const total = act.stages.reduce((s, st) => s + st.w, 0) || 1;
  let acc = 0, last = '';
  if (act.flag) B.station({ after: 380 });
  for (let si = 0; si < act.stages.length; si++) {
    const st = act.stages[si];
    acc += st.w;
    const end = x0 + ((x1 - x0) * acc) / total;
    const limit = si === act.stages.length - 1 ? (strict ? x1 : x1 + 1300) : (strict ? Math.min(end + 800, x1) : end + 1100);
    let guard = 0, idx = 0, misses = 0;
    while (B.x < end - 300 && guard++ < 80 && misses < 3) {
      c.k = clamp((B.x - x0) / (x1 - x0), 0, 1);
      c.d = dAt(B.x);
      let done = false;
      if (st.seq) {
        for (let t = 0; t < Math.min(3, st.seq.length) && !done; t++) {
          const spec = st.seq[idx % st.seq.length];
          idx++;
          if (runSpec(B, c, spec, limit)) { last = spec; done = true; }
        }
      } else {
        for (const spec of B.rand.shuffle(st.pool)) {
          if (spec === last && st.pool.length > 1) continue;
          if (runSpec(B, c, spec, limit)) { last = spec; done = true; break; }
        }
      }
      if (!done) misses++;
    }
  }
  if (act.finale) for (const spec of act.finale) { c.k = 1; c.d = dAt(B.x); runSpec(B, c, spec, strict ? x1 : x1 + 1500); }
}

export { BEATS, Y0, P, T, lerp };
