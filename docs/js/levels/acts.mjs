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
import { P, ELEMENT_INTRO, STATION_SHARE } from './params.mjs';
import { BEATS, rest, dropPickups } from './beats.mjs';
import './beats2.mjs';
import './beats3.mjs';  // crown, hillTop (set-piece flourishes)
import './beats4.mjs';  // structural variants of every landscape's signature element
import './beats5.mjs';  // more variants, and the optional ice sequences

export const ROLE_OFFSET = { opening: -0.3, recall: -0.6, teach: -0.4, vary: 0.0, combine: 0.35, setpiece: 0.5, breather: -0.8, closing: -0.5 };

const S = (w, ...pool) => ({ w, pool });
const Q = (w, ...seq) => ({ w, seq });

/** id -> { role, w (relative length), stages, flag?, finale? }. Stage = S(share, ...specs) pool, or Q(share, ...specs) sequence. */
export const ACTS = {
  // ───── openings / breathers / closings shared by landscapes ─────
  open: { role: 'opening', w: 1.0, stages: [] },                       // built by levelgen: the join, the flag and the quiet stretch
  breather: { role: 'breather', w: 1.6, flag: true, stages: [Q(1, 'upper', 'eggField', 'goldenPatch', 'eggField')] },
  breather2: { role: 'breather', w: 1.5, flag: true, stages: [Q(1, 'treasure', 'eggField', 'goldenPatch', 'hills')] },
  close: { role: 'closing', w: 1.5, flag: true, stages: [S(0.5, 'gap1', 'runEggs', 'gapHill', '@compact'), S(0.5, 'gap1', 'upper', 'gapPair', 'cliffHop', '@compact')] },

  // ───── Meadow: jump, gap, eggs ─────
  gapsTeach: { role: 'teach', w: 3.0, stages: [S(0.28, 'gap1'), S(0.4, 'gap1', 'gap1', 'stepUp', 'gapHill'), S(0.32, 'gap1', 'gapPair', 'gapHill')] },
  stepsAct: { role: 'vary', w: 3.0, stages: [S(0.3, 'stepUp', 'stairs'), S(0.4, 'stepUp', 'stairs', 'gap1', 'cliffHop'), S(0.3, 'stairs', 'gapPair', 'gapHill')] },
  ledgeHops: { role: 'vary', w: 3.4, stages: [S(0.3, 'upper', 'upperRoute'), S(0.4, 'upper', 'upperRoute', 'gap1', 'stepUp'), S(0.3, 'upper', 'gapPair', 'gapHill')] },
  gapRhythm: { role: 'combine', w: 3.4, stages: [S(0.3, 'gapPair', 'gap1', 'gapHill'), S(0.4, 'gapChain', 'gap1', 'upper', 'cliffHop'), S(0.3, 'gapChain', 'gapPair', 'stairs')] },
  goldenHill: { role: 'setpiece', w: 3.0, stages: [Q(1, 'hillTop', 'gapPair', 'hillTop', 'upperRoute', 'hillTop')], finale: ['crown'] },
  snailFirst: { role: 'closing', w: 2.2, flag: true, stages: [S(0.45, 'gap1', 'runEggs', 'stepUp'), Q(0.55, 'walker1', 'gap1', 'walker1')] },

  // ───── Clover Mill: read a patrolling snail ─────
  recallGaps: { role: 'recall', w: 2.0, stages: [S(0.5, 'gap1', 'stepUp', 'gapHill'), S(0.5, 'gapPair', 'upper', 'cliffHop')] },
  snailTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'walker1'), S(0.4, 'walker1', 'upper', 'walkerWide'), S(0.3, 'walker1', 'walkerIsland', 'walkerStep')] },
  snailVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'walker1', 'walkerPair', 'walkerStep'), S(0.4, 'walkerPair', 'walker1+gap1', 'upperRoute', 'walkerWide'), S(0.3, 'walkerIsland', 'walkerPair', 'walkerStep+gap1')] },
  windmillYard: { role: 'setpiece', w: 3.4, stages: [Q(1, 'walker1', 'walkerWide', 'walkerIsland', 'walkerStep+upper', 'walkerPair', 'walkerIsland+walker1')], finale: ['crown'] },
  cloverGaps: { role: 'combine', w: 3.2, stages: [S(0.3, 'walker1+gap1', 'gapPair', 'walkerWide'), S(0.4, 'walkerIsland', 'gapChain', 'walker1+gapPair', 'stairs'), S(0.3, 'walkerPair', 'walkerIsland+gap1', 'walkerStep')] },

  // ───── Reedwater: stepping logs over the flood ─────
  recallSnails: { role: 'recall', w: 2.0, stages: [S(0.5, 'walker1', 'gap1', 'gapHill'), S(0.5, 'walkerIsland', 'upper', 'walkerStep')] },
  logsTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'logs'), S(0.4, 'logs', 'upper', 'logsZig'), S(0.3, 'logs', 'logsZig', 'logsRaft')] },
  logsVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'logs', 'gapPair', 'logsRaft'), S(0.4, 'logsZig', 'upperRoute', 'walker1', 'logsLane', 'logsStairs'), S(0.3, 'logsStairs', 'gapChain', 'logsLane')] },
  floatingLogs: { role: 'setpiece', w: 3.4, stages: [Q(1, 'logs|logsZig', 'upper', 'logsRaft', 'logsStairs|logsLane', 'gap1', 'logsLane|logsZig')], finale: ['crown'] },
  reedCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'logs', 'walker1', 'logsZig'), S(0.4, 'logs+walker1', 'walkerIsland', 'logsLane', 'cliffHop'), S(0.3, 'logsZig+gap1', 'walkerPair', 'logsRaft')] },

  // ───── Orchard Heights: springs to the branches ─────
  recallLogs: { role: 'recall', w: 2.0, stages: [S(0.5, 'logs', 'upper', 'gapHill'), S(0.5, 'gapPair', 'walker1', 'cliffHop')] },
  springTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'springLedge', 'gap1'), S(0.36, 'springLedge', 'springGap', 'stepUp', 'logsZig'), S(0.3, 'springTwo', 'springGap', 'springBrake', 'branchSteps')] },
  springVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'springGap+gap1', 'springBrake', 'springTall', 'branchSteps'), S(0.4, 'springHops', 'springPush', 'springGap+walker1', 'springChain', 'branchSteps'), S(0.3, 'springLedge+gap1', 'springTwo+logs', 'springTall', 'logsStairs')] },
  blossomBounce: { role: 'setpiece', w: 3.4, stages: [Q(1, 'springLedge|springBrake', 'springHops', 'branchSteps', 'springChain+gap1', 'springGap+gapPair', 'springPush', 'springTall+walker1')], finale: ['crown'] },
  orchardCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'springLedge', 'logs', 'branchSteps'), S(0.4, 'springGap+walker1', 'springTwo', 'logs+springGap', 'springHops', 'gapChain'), S(0.3, 'walkerIsland+springGap', 'springPush', 'springTall+gapPair', 'branchSteps')] },

  // ───── Amber Quarry: crumbling ledges ─────
  recallSprings: { role: 'recall', w: 2.0, stages: [S(0.5, 'springLedge', 'gap1', 'gapHill'), S(0.5, 'springGap', 'logs', 'cliffHop')] },
  crumbleTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'crumbleUpper'), S(0.36, 'crumbleUpper', 'crumbleBridge'), S(0.3, 'crumbleBridge', 'crumbleChain', 'crumbleStairs')] },
  crumbleVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'crumbleBridge', 'crumbleUpper', 'crumbleSkip'), S(0.4, 'crumbleChain', 'logs', 'walker1', 'crumbleStairs'), S(0.3, 'crumbleChain', 'crumbleBridge+gap1', 'crumbleSkip')] },
  quarryCrane: { role: 'setpiece', w: 3.4, stages: [Q(1, 'crumbleChain', 'crumbleBridge+crumbleChain', 'crumbleUpper', 'crumbleStairs', 'crumbleSkip', 'crumbleChain+logs')], finale: ['crown'] },
  quarryCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'crumbleChain', 'springLedge', 'crumbleStairs'), S(0.4, 'crumbleChain+walker1', 'crumbleBridge+springGap', 'logs', 'crumbleSkip'), S(0.3, 'crumbleChain', 'walkerIsland+crumbleBridge', 'crumbleStairs')] },

  // ───── Fogwood: flying moths ─────
  recallCrumbles: { role: 'recall', w: 2.0, stages: [S(0.5, 'crumbleBridge', 'walker1', 'gapHill'), S(0.5, 'crumbleUpper', 'logs', 'branchSteps')] },
  mothTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'flyerHigh'), S(0.36, 'flyerHigh', 'flyer1'), S(0.3, 'flyer1', 'flyerPair', 'mothDip')] },
  mothVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'flyer1', 'flyerHigh+flyer1', 'mothDip'), S(0.4, 'flyer1+gap1', 'flyerPair', 'flyerHigh+gap1', 'mothLane'), S(0.3, 'flyerPair', 'flyer1+gapPair', 'mothHill')] },
  mothLanterns: { role: 'setpiece', w: 3.4, stages: [Q(1, 'flyer1', 'mothLane', 'flyer1+gap1', 'mothSwarm', 'mothHill', 'flyerPair')], finale: ['crown'] },
  mothCombine: { role: 'combine', w: 3.4, stages: [S(0.3, 'flyer1', 'flyerHigh+flyer1', 'mothSwarm'), S(0.4, 'flyer1+walker1', 'flyerPair+gap1', 'flyer1+crumbleChain', 'mothHill'), S(0.3, 'flyer1+crumbleBridge', 'mothLane', 'mothDip+gap1')] },

  // ───── Ember Canyon: gap then spikes ─────
  recallMoths: { role: 'recall', w: 2.0, stages: [S(0.5, 'flyer1', 'gap1', 'gapHill'), S(0.5, 'flyerHigh', 'crumbleBridge', 'mothDip')] },
  spikeTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'spike1'), S(0.36, 'spike1', 'gapSpike'), S(0.3, 'spikeRow', 'gapSpike', 'spikeStep')] },
  spikeVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'spike1', 'spikeGap', 'spikeStep'), S(0.4, 'gapSpike', 'spikeCycle', 'upperRoute', 'spikeStep'), S(0.3, 'spikeRow', 'spikeGap', 'spikeCycle')] },
  canyonRun: { role: 'setpiece', w: 3.4, stages: [Q(1, 'spikeRow', 'gapSpike', 'spikeStep', 'spikeGap+spikeRow', 'spikeCycle', 'gapSpike+spike1')], finale: ['crown'] },
  canyonCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'spike1+gap1', 'flyer1', 'spikeStep'), S(0.4, 'gapSpike', 'spikeRow+flyerHigh', 'crumbleChain', 'mothLane'), S(0.3, 'spikeCycle+gap1', 'walkerIsland+spike1', 'spikeStep+gap1')] },

  // ───── Glass Coast: lifts ─────
  recallSpikes: { role: 'recall', w: 2.0, stages: [S(0.5, 'spike1', 'gap1', 'gapHill'), S(0.5, 'spikeGap', 'upperRoute', 'spikeStep')] },
  liftTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'liftRide'), S(0.36, 'liftRide', 'upper', 'liftFerry'), S(0.3, 'liftRide', 'liftClimb', 'liftDrop', 'liftHop')] },
  liftVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'liftRide', 'gapPair', 'liftFerry', 'liftHop'), S(0.4, 'liftClimb', 'walker1', 'liftRide', 'liftDrop', 'liftHop'), S(0.3, 'liftClimb', 'liftRide+gap1', 'liftFerry+upper', 'liftHop')] },
  cliffLifts: { role: 'setpiece', w: 3.4, stages: [Q(1, 'liftClimb', 'liftRide|liftHop', 'liftDrop', 'liftFerry+gap1', 'liftClimb|liftHop', 'liftRide+gap1')], finale: ['crown'] },
  liftCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'liftRide', 'spike1', 'liftFerry'), S(0.4, 'liftRide+spike1', 'flyer1', 'liftClimb', 'liftDrop'), S(0.3, 'liftClimb+gap1', 'walkerIsland+liftRide', 'liftFerry+spike1')] },

  // ───── Lantern Caverns: lift -> crumble ─────
  recallLifts: { role: 'recall', w: 2.0, stages: [S(0.5, 'liftRide', 'crumbleBridge', 'liftFerry'), S(0.5, 'liftClimb', 'upper', 'crumbleStairs')] },
  liftCrumbleTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'liftCrumble'), S(0.36, 'liftCrumble', 'liftRide'), S(0.3, 'liftCrumble', 'crumbleChain', 'liftCrumbleChain')] },
  liftCrumbleVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'liftCrumble', 'liftCrumble+gap1', 'liftDescent'), S(0.4, 'liftCrumble', 'liftCrumble+flyer1', 'liftCrumble+crumbleChain', 'liftCrumbleChain'), S(0.3, 'liftCrumble', 'liftCrumble+crumbleUpper', 'liftDescent')] },
  crystalDescent: { role: 'setpiece', w: 3.4, stages: [Q(1, 'liftDescent', 'liftCrumble', 'liftDescent', 'liftCrumbleChain', 'crumbleChain', 'liftCrumble+crumbleBridge')], finale: ['crown'] },
  caveCombine: { role: 'combine', w: 3.4, stages: [S(0.3, 'liftCrumble', 'liftCrumble+spike1', 'liftFerry'), S(0.4, 'liftCrumble+gap1', 'liftCrumble+flyer1', 'liftDescent+liftCrumble', 'liftCrumbleChain'), S(0.3, 'liftCrumble+crumbleBridge', 'liftCrumble+spikeGap', 'crumbleSkip')] },

  // ───── Frostline: ice ─────
  recallCaves: { role: 'recall', w: 2.0, stages: [S(0.5, 'liftCrumble', 'crumbleChain', 'gapHill'), S(0.5, 'liftRide', 'spike1', 'crumbleStairs')] },
  iceTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'iceRun'), S(0.36, 'iceRun', 'upper', 'iceSteps', 'iceLeap'), S(0.3, 'iceRun', 'iceSteps', 'iceSpring', 'iceLeap')] },
  iceVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'iceRun', 'stepUp', 'iceSteps', 'iceLeap'), S(0.4, 'iceRun', 'spike1', 'iceSpring', 'iceSteps'), S(0.3, 'iceRun', 'gapSpike', 'spikeStep', 'iceLeap')] },
  iceSlide: { role: 'setpiece', w: 3.4, stages: [Q(1, 'iceRun', 'iceRun+spike1', 'iceLeap', 'iceSteps', 'iceRun+gapSpike', 'iceSpring', 'iceSteps+gap1')], finale: ['crown'] },
  iceCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'iceRun', 'walker1', 'iceSteps', 'iceSpring'), S(0.4, 'iceRun+spike1', 'liftRide', 'iceRun+walker1', 'spikeRow', 'iceLeap'), S(0.3, 'iceRun', 'flyer1+iceRun', 'spikeStep', 'iceSpring')] },

  // ───── Moonridge: walker patrol and a mover ─────
  recallIce: { role: 'recall', w: 2.0, stages: [S(0.5, 'iceRun', 'walker1', 'gapHill'), S(0.5, 'gapPair', 'upper', 'cliffHop')] },
  moverTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'moverFerry'), S(0.36, 'moverFerry', 'walker1'), S(0.3, 'moverFerry', 'walkerIsland', 'ferryStep')] },
  moverVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'moverFerry', 'walkerPair', 'ferryStep', 'ferryWalker'), S(0.4, 'walkerIsland+moverFerry', 'ferryTwo', 'upper', 'walkerStep', 'ferryWalker'), S(0.3, 'moverFerry+walker1', 'walkerPair', 'ferryTwo', 'ferryStep')] },
  moonBridge: { role: 'setpiece', w: 3.4, stages: [Q(1, 'moverFerry', 'walkerIsland+moverFerry', 'ferryTwo|ferryWalker', 'ferryStep', 'moverFerry+walker1', 'ferryWalker|walkerPair')], finale: ['crown'] },
  moonCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'moverFerry', 'spike1', 'ferryStep', 'ferryWalker'), S(0.4, 'moverFerry+walker1', 'liftRide', 'flyer1+moverFerry', 'ferryTwo', 'ferryWalker'), S(0.3, 'moverFerry+spike1', 'walkerIsland+liftRide', 'ferryStep+gap1', 'ferryWalker')] },

  // ───── Dawnbridge: broken spans ─────
  recallMovers: { role: 'recall', w: 2.0, stages: [S(0.5, 'moverFerry', 'gap1', 'gapHill'), S(0.5, 'walkerIsland', 'upper', 'cliffHop')] },
  bridgeTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'bridge'), S(0.36, 'bridge', 'upper', 'bridgeArch'), S(0.3, 'bridge', 'bridgeArch', 'bridgePillars')] },
  bridgeVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'bridge', 'gapPair', 'bridgeMissing', 'bridgeWalker'), S(0.4, 'bridge', 'upperRoute', 'walker1', 'bridgePillars', 'bridgeWalker'), S(0.3, 'bridgeArch', 'bridge+gap1', 'bridgeMissing', 'bridgeWalker')] },
  brokenBridge: { role: 'setpiece', w: 3.4, stages: [Q(1, 'bridge', 'bridgeMissing', 'bridgePillars|bridgeWalker', 'bridgeArch+gap1', 'bridge|bridgeWalker', 'bridgeMissing')], finale: ['crown'] },
  bridgeCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'bridge', 'flyer1', 'bridgeArch', 'bridgeWalker'), S(0.4, 'bridge+spike1', 'crumbleChain', 'bridge+flyer1', 'bridgePillars', 'bridgeWalker'), S(0.3, 'bridgeMissing', 'moverFerry+bridge', 'bridgeArch+walker1', 'bridgeWalker')] },

  // ───── Beacon Summit: springs, lifts and timed jumps ─────
  recallBridges: { role: 'recall', w: 2.0, stages: [S(0.5, 'bridge', 'gapPair', 'bridgeArch'), S(0.5, 'gapChain', 'upper', 'branchSteps')] },
  summitTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'springGap+liftRide', 'liftRide+gap1', 'liftFerry'), S(0.36, 'liftHop', 'springHops+gapPair', 'liftClimb', 'liftRide+gapPair'), S(0.3, 'liftHop+gap1', 'springGap+liftRide', 'springLedge+gap1', 'springHops')] },
  summitVary: { role: 'vary', w: 3.4, stages: [S(0.35, 'springGap+liftRide', 'liftHop', 'liftFerry', 'branchSteps+liftRide'), S(0.35, 'liftClimb+springGap', 'liftRide+gapPair', 'springHops+gapChain', 'branchSteps', 'springTwo+liftRide'), S(0.3, 'liftCrumble+springGap', 'liftHop+springGap', 'springChain', 'springHops+gapPair')] },
  summitClimb: { role: 'setpiece', w: 3.6, stages: [Q(1, 'springGap+liftRide', 'liftHop', 'springHops+liftRide', 'liftHop+springGap+gapPair', 'liftClimb+springLedge', 'springHops+gapChain')], finale: ['crown'] },
  summitCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'liftRide+springGap+walker1', 'liftClimb+spike1', 'liftHop+gap1'), S(0.4, 'liftHop+springGap', 'springHops+gapChain', 'liftRide+springGap+gapPair', 'moverFerry+springGap+liftRide', 'liftFerry+springTall'), S(0.3, 'liftCrumble+springGap+gap1', 'liftHop+springGap+gapPair', 'branchSteps+liftRide', 'liftHop')] },
  summitClose: { role: 'closing', w: 1.6, flag: true, stages: [S(0.5, 'upper', 'gap1', 'gapPair', '@compact'), S(0.5, 'springGap', 'liftRide', 'gap1', '@compact')] },
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

/** The landscape index where the newest element an act uses is first taught (circuit 1 order): its 'level' in the curriculum. */
export function actIntro(id) {
  const act = ACTS[id];
  const specs = [...(act.finale || []), ...act.stages.flatMap((st) => st.pool || st.seq || [])];
  let lvl = 0;
  for (const spec of specs) {
    if (spec === '@compact') continue;                                        // only elements already known
    for (const alt of spec.split('|')) for (const part of alt.split('+')) lvl = Math.max(lvl, ELEMENT_INTRO[BEATS[part].needs] ?? 0);
  }
  return lvl;
}

/* ───────────────────────── running an act ───────────────────────── */

const REST_MIN = 100, REST_MAX = 900;   // the pacing controller's range for the quiet ground before a spec (u)
const FLAG_EVERY = 2500;            // u of main route after a flag before the next one is due (~23 s)
const FLAG_MAX = 2900;              // try not to go beyond this (~26 s) between flags
const FLAG_HARD = 3100;             // never beyond this when a spec ends: the next flag is then <= 3100 + ~640 u (34 s) away; the rule is 35 s
const lastFlag = (B) => (B.cps.length ? B.cps[B.cps.length - 1].x : -1e9);

/** Flat ground up to x, with a flag in it if the last one is far behind (used to pad out an act). */
export function fillTo(B, x) {
  while (x - B.x > 120) {
    const room = x - B.x;
    if (B.x - lastFlag(B) > 1100 && room >= 380) { B.station({ before: 260, after: Math.min(420, room - 260) }); continue; }
    B.run(Math.min(room, room > 1500 ? 900 : room), 'auto');
  }
  if (x - B.x > 0) B.run(x - B.x, 'line');
}

/** One run of beats from a spec "a" or "a+b" (tight combination). Returns true if it was built (else rolled back). */
function runSpec(B, c, spec, limit) {
  const parts = spec.split('+');
  for (let attempt = 0; attempt < 2; attempt++) {
    const mk = B.mark();
    let flagged = false, xs = null, sls = 0;
    if (attempt === 1) { const sx = B.x; B.station({ after: 420 }); dropPickups(B, c, sx, B.x); flagged = true; }
    for (let i = 0; i < parts.length; i++) {
      const beat = BEATS[parts[i]];
      if (!beat) throw new Error('unknown beat ' + parts[i]);
      // a flag that is due takes the place of the usual recovery room (it has the same safe ground around it)
      if (i === 0 && !flagged && B.x - lastFlag(B) > FLAG_EVERY) { const sx = B.x; B.station({ after: 420 }); dropPickups(B, c, sx, B.x); flagged = true; }
      if (i === 0 && c.due != null && !flagged) {
        // the pacing controller: the first rest is as long as it takes for this spec's first event to land on the schedule. The
        // flat ground since the last event already counts (a beat's own tail is recovery room too), and the approach stays >= ~300 u.
        const r = B.rich[spec];
        const lead = r && r.n ? r.first / r.n : 120;
        const tail = Math.max(0, B.x - B.lastEventX);
        c.restLen = clamp(c.due - B.x - lead, Math.max(100, 300 - tail - Math.min(lead, 120)), REST_MAX);
      }
      if (!(i === 0 && flagged)) rest(B, c, i === 0 ? 1 : 0.42, i === 0 ? 230 : 170);
      if (i === 0 && B.x - B.lastGold > 4400) { B.logBeat('goldenPatch'); BEATS.goldenPatch.fn(B, c); B.run(200, 'line'); }   // keep the golden eggs coming (about one per 40-50 s)
      B.logBeat(parts[i]);
      if (i === 0) { xs = B.x; sls = B.stationLen; }
      beat.fn(B, c);
      if (B.bad) break;
    }
    // every main-route platform stays in the readable band (y 150..310, lifts' sweeps inside 130..340), and she ends near the usual height
    let dyBad = Math.abs(B.y - Y0) > 30;
    for (let k = mk.p; k < B.plats.length && !dyBad; k++) {
      const p = B.plats[k];
      if (p.o) continue;
      const amp = p.motion && p.motion.axis === 'y' ? p.motion.amp : 0;
      if (p.y < 156 || p.y > 308 || p.y - amp < 134 || p.y + amp > 336) dyBad = true;
    }
    if (B.bad || B.x > limit || dyBad) { B.rollback(mk); return false; }
    const far = B.x - lastFlag(B);
    // too long without a flag: flag first, then rebuild. Near the landscape's end the next flag is the one at the join.
    const toJoin = B.joinFlagX - B.x;
    if (attempt === 0 && (far > FLAG_MAX || (toJoin < 1100 && B.joinFlagX - lastFlag(B) > 3300))) { B.rollback(mk); continue; }
    if (far > FLAG_HARD || (toJoin < 1100 && B.joinFlagX - lastFlag(B) > 3650)) { B.rollback(mk); return false; }
    const ev = B.eventsSince(mk);
    B.events += ev;
    if (ev > 0) B.lastEventX = B.evLast;
    const st = B.rich[spec] || (B.rich[spec] = { ev: 0, len: 0, n: 0, first: 0 });
    st.ev += ev; st.len += B.x - xs - (B.stationLen - sls); st.n++;       // the spec's own footprint: its first rest is not part of it
    st.first += Number.isFinite(B.evFirst) ? Math.max(0, B.evFirst - xs) : 0;  // how far into the spec its first event sits
    return true;
  }
  return false;
}

/**
 * Beats with nothing REQUIRED in them but plenty to do if she wants: egg arcs to jump for, high routes with golden eggs,
 * springs to the branches. When an act has asked for all the events it was owed, the rest of its length is spent on these
 * (never on empty rolling), so the world stays alive without getting any harder.
 */
export function fillers(ch, role = 'vary') {
  const known = role === 'recall' && ch > 0 ? ch - 1 : ch;           // a landscape's own signature is never met before its teaching act
  const out = ['upper', 'upperRoute', 'eggField', 'hills'];
  if (known >= 1) out.push('treasure');
  if (known >= 3) out.push('springLedge', 'springTwo', 'springTall', 'springChain', 'springBrake', 'springPush');
  if (known >= 4) out.push('crumbleUpper');
  if (known >= 9) out.push('iceLeap', 'iceSpring');
  return out;
}

/**
 * Small beats with something REQUIRED in them (a hop, a patrol...) that an act can use to finish its length: only elements the
 * player already knows (the landscape's own signature only after its teaching act, so it is always introduced alone).
 */
export function compactSpecs(c, role) {
  const known = (role === 'recall' || role === 'teach') && c.ch > 0 ? c.ch - 1 : c.ch;
  const out = ['gap1', 'gapPair', 'gapHill'];
  if (known >= 1) out.push('walker1');
  if (known >= 2) out.push('logsZig');
  if (known >= 4) out.push('crumbleBridge');
  if (known >= 5) out.push('flyer1');
  if (known >= 6) out.push('spike1', 'gapSpike');
  if (known >= 7) out.push('liftFerry');
  if (known >= 10) out.push('moverFerry');
  return out;
}

/** A pool with '@compact' replaced by the small beats of the elements the player already knows. */
function expandPool(pool, c, role) {
  return pool.includes('@compact') ? [...pool.filter((x) => x !== '@compact'), ...compactSpecs(c, role)] : pool;
}

/**
 * The order to try the specs of a pool in: the beat types this landscape has used least come first (no type grows past
 * a third of the landscape), and among those the ones whose events-per-length (learned so far) suit what the pacing
 * controller still needs: when the act is behind its event quota, richer specs; when ahead, calmer ones.
 */
function tryOrder(B, c, pool, last, want, room = Infinity) {
  const used = {};
  for (let k = B.logStart; k < B.beatLog.length; k++) used[B.beatLog[k]] = (used[B.beatLog[k]] || 0) + 1;
  const total = Math.max(10, B.beatLog.length - B.logStart);
  const scored = B.rand.shuffle(pool).filter((s) => s !== last || pool.length < 2).map((spec) => {
    const share = Math.max(...spec.split('+').map((n) => (used[n] || 0) / total));
    const r = B.rich[spec];
    let mismatch = 0.25;
    if (r && r.n >= 1 && Number.isFinite(c.evLeft)) mismatch += Math.max(0, r.ev / r.n - Math.max(1, c.evLeft + 0.5)) * 0.9;     // never much past the act's quota
    if (r && r.n >= 1 && want != null) {
      // the rest this spec would need before it to land on the wanted pace; outside [REST_MIN, REST_MAX] it cannot
      const need = (1000 * (r.ev / r.n)) / Math.max(0.5, want) - r.len / r.n;
      mismatch = need < REST_MIN ? (REST_MIN - need) / 500 : need > REST_MAX ? (need - REST_MAX) / 900 : 0;
    }
    // a spec whose footprint cannot fit in the room that is left only wastes tries: try it last
    const fit = r && r.n >= 1 && r.len / r.n + REST_MIN + 150 > room ? 3 : 0;
    return { spec, sc: share * 8 + mismatch * 2.5 * (c.behind || 1) + fit };
  });
  scored.sort((a, b) => a.sc - b.sc);
  return scored.map((x) => x.spec);
}

/**
 * Run an act (stage by stage) from the cursor to about x1. `c` carries rand / ch / circuit; difficulty comes from
 * dAt(x). Pool stages draw random specs until their share of the length is used; sequence stages (set pieces)
 * play their specs in order, cycling, and every act can end with a `finale` (e.g. the golden crown).
 */
export function runStages(B, c, act, x0, x1, dAt, strict = false, hardLimit = Infinity, pace = null) {
  const total = act.stages.reduce((s, st) => s + st.w, 0) || 1;
  let acc = 0, last = '';
  // The pacing controller: `pace.per` is the stretch of non-station ground each required event may take. The next event is
  // due at x0 + (stations so far) + (events so far + 1/2) * per; the first rest of every spec is as long as it takes to
  // reach that (within [RMIN, RMAX]). Specs that pack several events leave a longer rest after them, and the landscape
  // lands on its event rate whatever mix of beats the dice give.
  const sl0 = B.stationLen, ev0 = B.events;
  const steer = () => {
    c.evLeft = pace ? Math.max(0, pace.events - (B.events - ev0)) : Infinity;
    // behind its schedule by more than two events: let the pace matter more than variety when choosing what comes next
    c.behind = pace && (x0 + (B.stationLen - sl0) + (B.events - ev0) * pace.per) < B.x - 2 * pace.per ? 3 : 1;
     c.due = pace && pace.per > 0 ? x0 + (B.stationLen - sl0) + (B.events - ev0 + 0.5) * pace.per : null;      // where the next event is due
    c.restLen = null;
  };
  if (act.flag || B.x - lastFlag(B) > 1900) { const sx = B.x; B.station({ after: 400 }); dropPickups(B, c, sx, B.x); }      // an act that is far from the last flag starts on one
  for (let si = 0; si < act.stages.length; si++) {
    const st = act.stages[si];
    acc += st.w;
    const end = x0 + ((x1 - x0) * acc) / total;
    const limit = Math.min(hardLimit, strict ? x1 : x1 + 1300);          // a stage may use more than its share; later stages then start later and the next act's budget shrinks
    let guard = 0, idx = 0, misses = 0;
    while (B.x < end - 300 && guard++ < 80 && misses < 3) {
      c.k = clamp((B.x - x0) / (x1 - x0), 0, 1);
      c.d = dAt(B.x);
      steer();
      let done = false;
      if (st.seq) {
        for (let t = 0; t < Math.min(3, st.seq.length) && !done; t++) {
          const slot = st.seq[idx % st.seq.length];
          idx++;
          // a slot may offer alternatives ("a|b"): the one that suits the pace and the variety best goes first
          const alts = slot.includes('|') ? tryOrder(B, c, slot.split('|'), last, null, limit - B.x) : [slot];
          for (const spec of alts) if (runSpec(B, c, spec, limit)) { last = spec; done = true; break; }
        }
      } else {
        const want = pace ? (Math.max(0, pace.events - (B.events - ev0)) / (Math.max(500, x1 - B.x) * (1 - STATION_SHARE))) * 1000 : null;
        // quota used up and distance left: spend it on things to do that are not required
        const spend = pace && c.evLeft < 1 && x1 - B.x > 600;
        const room = limit - B.x;
        for (const spec of tryOrder(B, c, spend ? fillers(c.ch, act.role) : expandPool(st.pool, c, act.role), last, spend ? null : want, room)) {
          if (runSpec(B, c, spec, limit)) { last = spec; done = true; break; }
        }
        // nothing from the pool fits any more: spend what is left on something to do rather than bare ground
        if (!done && !spend) for (const spec of tryOrder(B, c, fillers(c.ch, act.role), last, null, room)) { if (runSpec(B, c, spec, limit)) { last = spec; done = true; break; } }
      }
      if (!done) misses++;
    }
  }
  // the stages are done but some of the act's length is left: spend it on something small to do (never bare ground)
  c.restLen = null;
  for (let guard = 0; guard < 6 && x1 - B.x > 560; guard++) {
    c.k = 1; c.d = dAt(B.x); steer();
    const room = Math.min(hardLimit, strict ? x1 : x1 + 300) - B.x;
    const owed = pace && c.evLeft >= 1;
    const list = owed ? [...compactSpecs(c, act.role), ...fillers(c.ch, act.role)] : [...fillers(c.ch, act.role), ...compactSpecs(c, act.role)];
    let done = false;
    for (const spec of tryOrder(B, c, list, last, null, room)) if (runSpec(B, c, spec, Math.min(hardLimit, strict ? x1 : x1 + 300))) { last = spec; done = true; break; }
    if (!done) break;
  }
  c.restLen = null; c.due = null; c.evLeft = Infinity;
  if (act.finale) for (const spec of act.finale) { c.k = 1; c.d = dAt(B.x); runSpec(B, c, spec, Math.min(hardLimit, strict ? x1 : x1 + 1500)); }
}

export { BEATS, Y0, P, T, lerp };
