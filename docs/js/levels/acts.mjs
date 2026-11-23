/*
 * Egg Mama — acts: 30-70 s arcs built from beats, and the per-landscape plan that strings them together.
 *
 * An ACT is a small story: it starts easy, builds through its stages, peaks, then eases off. Its template is a list of STAGES;
 * each stage has a weight (its share of the act's length) and a pool of beat specs that it draws from until its share is used
 * up. A spec is a beat name, or "a+b" for beats played back to back with little recovery room (a combination). A stage can
 * instead be a fixed SEQUENCE (set pieces are scripted); a slot of a sequence may offer alternatives ("a|b"), and a pool may
 * contain '@compact' (the small beats of the elements the player already knows). An act may set `overlay`: how often a long rest
 * carries a ledge to climb. A set piece ends in a `finale` (the golden-egg crown) that keeps its own stretch.
 *
 * The roles (recall / teach / vary / combine / breather / setpiece / closing) set where an act sits on the landscape's ramp.
 * No two consecutive acts use the same template (a ring buffer of recent ids).
 *
 * THE PACING CONTROLLER (runStages). levelgen gives an act a quota of THREAT-WEIGHTED required events (see levelgen.mjs and
 * builder.eventsSince: a moth counts the share of the time an idle Mama would be hit by it). The next event is due
 * at x0 + (events so far + 1/2) * per; the first rest of every spec is as long as it takes for the spec's first event to land
 * there (the ground since the last event, a flag included, already counts as rest; the approach stays >= ~300 u, ~420 u before
 * spikes in the first two spike landscapes). Choosing WHICH spec: tryOrder() scores a pool by variety (a beat type that already
 * fills a quarter of the landscape is a last resort; unseen ones and the landscape's own element come first, the own element most in
 * its teaching act: OWN_BONUS), by how well the spec's events per length (learned in this level, else measured once in a scratch world)
 * match the pace, by the chain cap (params.chainCap: singles early, longer chains later; runSpec also refuses a spec that would grow a
 * chain, across beats, past 4 events in the first six landscapes and 7 later) and by starvation (>= ~1100 u since the last required
 * event, a moth counts as one: only a beat with an event will do; a beat with nothing required in it only fits where the next event is
 * not yet due). When an act is ahead of schedule it takes a short, easy rest that may carry a ledge to climb instead of piling events
 * up. The first walkers, moths and spikes get a little help on the flag before them (a golden egg, and a shield from the 3rd landscape
 * on). An act may ask for more room after it (`minRoom`: Meadow's closing act keeps 2300 u so the first snail always fits).
 * What is still too long a wait after all that is cut by levels/densify.mjs once the whole circuit is built.
 */
import { T, clamp, lerp } from '../tuning.mjs';
import { Builder, Y0 } from './builder.mjs';
import { rng } from '../rng.mjs';
import { P, ELEMENT_INTRO, chainCap } from './params.mjs';
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
  breather: { role: 'breather', w: 1.15, flag: true, stages: [Q(1, 'upper', 'eggField', 'goldenPatch', 'eggField')] },
  breather2: { role: 'breather', w: 1.1, flag: true, stages: [Q(1, 'treasure', 'eggField', 'goldenPatch', 'hills')] },
  close: { role: 'closing', w: 1.5, flag: true, stages: [S(0.5, 'gap1', 'gapHill', '@compact'), S(0.5, 'upper', 'gapPair', 'cliffHop', '@compact')] },

  // ───── Meadow: jump, gap, eggs ─────
  gapsTeach: { role: 'teach', w: 3.0, stages: [S(0.28, 'gap1'), S(0.4, 'gap1', 'stepUp', 'gapHill'), S(0.32, 'gap1', 'gapPair', 'gapHill', 'stepUp')] },
  stepsAct: { role: 'vary', w: 3.0, stages: [S(0.3, 'stepUp', 'stairs'), S(0.4, 'stepUp', 'stairs', 'gapHill', 'cliffHop'), S(0.3, 'stairs', 'gapPair', 'gapHill')] },
  ledgeHops: { role: 'vary', w: 3.4, overlay: 0.8, stages: [S(0.3, 'upper+gap1', 'upperRoute'), S(0.4, 'upper+stepUp', 'upper+gapPair', 'upperRoute'), S(0.3, 'upper+gapHill', 'upper+gap1', 'stepUp')] },
  gapRhythm: { role: 'combine', w: 3.4, stages: [S(0.3, 'gapPair', 'gap1', 'gapHill'), S(0.4, 'gapChain', 'gap1', 'upper', 'cliffHop'), S(0.3, 'gapChain', 'gapPair', 'stairs')] },
  goldenHill: { role: 'setpiece', w: 4.6, stages: [Q(1, 'gapPair', 'hillTop', 'cliffHop', 'upper', 'gapChain|stairs', 'hillTop')], finale: ['crown'] },
  snailFirst: { role: 'closing', w: 3.0, minRoom: 2300, stages: [Q(0.5, 'walker1', 'gap1', 'walker1'), S(0.5, 'gap1', 'runEggs', 'stepUp')] },      // (the first gentle snail comes first: Meadow always meets one, however little room the act has)

  // ───── Clover Mill: read a patrolling snail ─────
  recallGaps: { role: 'recall', w: 2.0, stages: [S(0.5, 'gap1', 'stepUp', 'gapHill'), S(0.5, 'gapPair', 'upper', 'cliffHop')] },
  snailTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'walker1'), S(0.4, 'walker1', 'upper', 'walkerWide'), S(0.3, 'walker1', 'walkerIsland', 'walkerStep')] },
  snailVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'walker1', 'walkerPair', 'walkerStep', 'stairs'), S(0.4, 'walkerPair', 'walker1+gap1', 'upperRoute', 'walkerWide', 'gapHill'), S(0.3, 'walkerIsland', 'walkerPair', 'walkerStep+gap1', 'cliffHop')] },
  windmillYard: { role: 'setpiece', w: 4.4, stages: [Q(1, 'walker1', 'walkerWide', 'walkerIsland', 'walkerStep+upper', 'walkerPair')], finale: ['crown'] },
  cloverGaps: { role: 'combine', w: 3.2, stages: [S(0.3, 'walker1+gap1', 'gapPair', 'walkerWide', 'stairs'), S(0.4, 'walkerIsland', 'gapChain', 'walker1+gapPair', 'stairs', 'cliffHop'), S(0.3, 'walkerPair', 'walkerIsland+gap1', 'walkerStep', 'gapHill')] },

  // ───── Reedwater: stepping logs over the flood ─────
  recallSnails: { role: 'recall', w: 2.0, stages: [S(0.5, 'walker1', 'gap1', 'gapHill'), S(0.5, 'walkerIsland', 'upper', 'walkerStep')] },
  logsTeach: { role: 'teach', w: 3.4, stages: [S(0.3, 'logs'), S(0.4, 'logs', 'gap1', 'logsZig', 'upper'), S(0.3, 'logs', 'logsZig', 'logsRaft', 'gapHill')] },
  logsVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'logs', 'logsRaft', 'gap1'), S(0.4, 'logsZig', 'logsStairs', 'upperRoute', 'walker1', 'logsLane'), S(0.3, 'logsRaft', 'logsLane', 'gapPair', 'logsStairs')] },
  floatingLogs: { role: 'setpiece', w: 4.4, stages: [Q(1, 'logs|logsZig', 'upper', 'logsRaft', 'logsStairs|logsLane', 'gap1', 'logsLane|logsZig')], finale: ['crown'] },
  reedCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'logs', 'walker1', 'logsZig'), S(0.4, 'logs+walker1', 'logsStairs', 'logsLane', 'walker1'), S(0.3, 'logsZig+gap1', 'logsRaft', 'walkerPair', 'gap1')] },

  // ───── Orchard Heights: springs to the branches ─────
  recallLogs: { role: 'recall', w: 2.0, stages: [S(0.5, 'logs', 'upper', 'gapHill'), S(0.5, 'gapPair', 'walker1', 'cliffHop')] },
  springTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'springLedge', 'gap1'), S(0.36, 'springLedge', 'springGap+springBrake', 'stepUp', 'logsZig'), S(0.3, 'springTwo', 'springGap+springPush', 'springBrake+gap1', 'branchSteps')] },
  springVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'springGap+gap1', 'springBrake+gap1', 'springTall', 'branchSteps'), S(0.4, 'springHops', 'springPush+gap1', 'springGap+walker1', 'springChain', 'branchSteps+springBrake'), S(0.3, 'springLedge+gap1', 'springTwo+logs', 'springPush+gapPair', 'logsStairs')] },
  blossomBounce: { role: 'setpiece', w: 4.4, stages: [Q(1, 'springLedge|springBrake', 'springHops', 'branchSteps', 'springChain+gap1', 'springPush')], finale: ['crown'] },
  orchardCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'springLedge', 'logs', 'branchSteps'), S(0.4, 'springGap+walker1', 'springBrake+walker1', 'logs+springGap', 'springHops', 'gapChain'), S(0.3, 'walkerIsland+springGap', 'springPush+gap1', 'springTall+gapPair', 'branchSteps')] },

  // ───── Amber Quarry: crumbling ledges ─────
  recallSprings: { role: 'recall', w: 2.0, stages: [S(0.5, 'springLedge', 'gap1', 'gapHill'), S(0.5, 'springGap', 'logs', 'cliffHop')] },
  crumbleTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'crumbleUpper'), S(0.36, 'crumbleUpper', 'crumbleBridge'), S(0.3, 'crumbleBridge', 'crumbleChain', 'crumbleStairs')] },
  crumbleVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'crumbleBridge', 'crumbleUpper', 'crumbleSkip'), S(0.4, 'crumbleChain', 'logs', 'walker1', 'crumbleStairs'), S(0.3, 'crumbleChain', 'crumbleBridge+gap1', 'crumbleSkip')] },
  quarryCrane: { role: 'setpiece', w: 4.4, stages: [Q(1, 'crumbleChain', 'crumbleBridge+crumbleChain', 'crumbleUpper', 'crumbleStairs', 'crumbleSkip', 'crumbleChain+logs')], finale: ['crown'] },
  quarryCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'crumbleChain', 'springLedge', 'crumbleStairs'), S(0.4, 'crumbleChain+walker1', 'crumbleBridge+springGap', 'logs', 'crumbleSkip'), S(0.3, 'crumbleChain', 'walkerIsland+crumbleBridge', 'crumbleStairs')] },

  // ───── Fogwood: flying moths (the moth training ground: a moth is something to READ, but a Mama who never jumps is hit by only a third
  //        of them, so the real jumps come from the mossy logs, gaps and cracked stones the moths drift over, and from the low swoopers) ─────
  recallCrumbles: { role: 'recall', w: 2.0, stages: [S(0.5, 'crumbleBridge', 'walker1', 'gapHill'), S(0.5, 'crumbleUpper', 'logs', 'branchSteps')] },
  mothTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'flyerHigh', 'gap1', 'gapHill', 'logsZig'), S(0.36, 'flyerHigh+gap1', 'flyer1+gap1', 'logsZig', 'gapPair'), S(0.3, 'flyer1+logs', 'mothDip', 'gapPair', 'crumbleBridge')] },
  mothVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'flyer1+gap1', 'logs', 'crumbleBridge', 'gapPair', 'logsStairs'), S(0.4, 'flyer1+gapPair', 'logsStairs', 'crumbleChain', 'walker1', 'gapHill', 'logsZig', 'mothDip'), S(0.3, 'mothHill', 'gapChain', 'logsZig', 'logs', 'crumbleBridge')] },
  mothLanterns: { role: 'setpiece', w: 4.4, stages: [Q(1, 'flyer1+gap1', 'logsZig', 'mothSwarm', 'crumbleChain', 'flyer1+logs', 'gapChain', 'mothHill', 'logs')], finale: ['crown'] },
  mothCombine: { role: 'combine', w: 3.4, stages: [S(0.3, 'flyer1+logs', 'gapPair', 'flyerPair', 'logsStairs', 'crumbleBridge'), S(0.4, 'flyer1+walker1', 'gapChain', 'flyer1+crumbleChain', 'logsZig', 'crumbleBridge', 'gap1'), S(0.3, 'flyer1+crumbleBridge', 'mothLane', 'logsStairs', 'gapPair', 'logs')] },

  // ───── Ember Canyon: gap then spikes ─────
  recallMoths: { role: 'recall', w: 2.0, stages: [S(0.5, 'flyer1', 'gap1', 'gapHill'), S(0.5, 'flyerHigh', 'crumbleBridge', 'mothDip')] },
  spikeTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'spike1', 'gap1', 'gapHill'), S(0.36, 'spike1', 'gapSpike', 'gapPair', 'logsZig'), S(0.3, 'spikeRow', 'gapSpike', 'spikeStep', 'crumbleBridge')] },
  spikeVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'spike1', 'spikeStep', 'spikeRow', 'gapPair', 'logsStairs'), S(0.4, 'gapSpike', 'spikeCycle', 'upperRoute', 'spikeStep', 'gapChain', 'crumbleBridge'), S(0.3, 'spikeRow', 'spikeCycle', 'gapSpike', 'logsZig', 'crumbleChain')] },
  canyonRun: { role: 'setpiece', w: 4.4, stages: [Q(1, 'spikeRow', 'gapSpike', 'gapChain', 'spikeStep', 'crumbleChain', 'spikeCycle', 'logsZig', 'spike1', 'gapSpike')], finale: ['crown'] },
  canyonCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'spike1', 'flyer1', 'spikeStep', 'gapPair'), S(0.4, 'gapSpike', 'flyerHigh', 'crumbleChain', 'mothLane', 'spikeRow', 'gapChain'), S(0.3, 'spikeCycle', 'walker1+spike1', 'spikeStep', 'crumbleBridge', 'logsZig')] },

  // ───── Glass Coast: lifts ─────
  recallSpikes: { role: 'recall', w: 2.0, stages: [S(0.5, 'spike1', 'gap1', 'gapHill'), S(0.5, 'spikeStep', 'upperRoute', 'spike1')] },
  liftTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'liftRide'), S(0.36, 'liftRide', 'upper', 'liftFerry'), S(0.3, 'liftRide', 'liftClimb', 'liftDrop', 'liftHop')] },
  liftVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'liftRide', 'gapPair', 'liftFerry', 'liftHop'), S(0.4, 'liftClimb', 'walker1', 'liftRide', 'liftDrop', 'liftValley'), S(0.3, 'liftClimb', 'liftRide+gap1', 'liftFerry+upper', 'liftHop')] },
  cliffLifts: { role: 'setpiece', w: 4.4, stages: [Q(1, 'liftClimb', 'liftRide|liftHop', 'liftDrop|liftValley', 'liftFerry+gap1', 'liftHop')], finale: ['crown'] },
  liftCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'liftRide', 'spike1', 'liftFerry'), S(0.4, 'liftRide+spike1', 'flyer1', 'liftClimb', 'liftDrop'), S(0.3, 'liftClimb+gap1', 'walkerIsland+liftRide', 'liftFerry+spike1')] },

  // ───── Lantern Caverns: lift -> crumble ─────
  recallLifts: { role: 'recall', w: 2.0, stages: [S(0.5, 'liftRide', 'crumbleBridge', 'liftFerry'), S(0.5, 'liftClimb', 'upper', 'crumbleStairs')] },
  liftCrumbleTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'liftCrumble'), S(0.36, 'liftCrumble', 'liftRide', 'liftFerry'), S(0.3, 'liftCrumble', 'crumbleChain', 'liftCrumbleChain', 'crumbleStairs')] },
  liftCrumbleVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'liftCrumble', 'liftCrumble+gap1', 'liftDescent', 'liftFerry'), S(0.4, 'liftCrumble', 'liftCrumble+flyer1', 'liftCrumble+crumbleChain', 'liftCrumbleChain', 'crumbleSkip', 'liftHop'), S(0.3, 'liftCrumble', 'liftCrumble+crumbleUpper', 'liftDescent', 'crumbleStairs')] },
  crystalDescent: { role: 'setpiece', w: 4.4, stages: [Q(1, 'liftDescent', 'liftCrumble', 'liftCrumbleChain', 'crumbleChain', 'liftCrumble+crumbleBridge')], finale: ['crown'] },
  caveCombine: { role: 'combine', w: 3.4, stages: [S(0.3, 'liftCrumble', 'liftCrumble+spike1', 'liftFerry', 'crumbleSkip'), S(0.4, 'liftCrumble+gap1', 'liftCrumble+flyer1', 'liftDescent+liftCrumble', 'liftCrumbleChain', 'liftHop'), S(0.3, 'liftCrumble+crumbleBridge', 'liftCrumble+spikeGap', 'crumbleSkip', 'crumbleStairs')] },

  // ───── Frostline: ice ─────
  recallCaves: { role: 'recall', w: 2.0, stages: [S(0.5, 'liftCrumble', 'crumbleChain', 'gapHill'), S(0.5, 'liftRide', 'spike1', 'crumbleStairs')] },
  iceTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'iceRun'), S(0.36, 'iceRun', 'iceSteps+iceLeap', 'upper', 'iceSteps'), S(0.3, 'iceRun+iceSpring', 'iceSteps', 'iceSteps+iceLeap')] },
  iceVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'iceRun', 'stepUp+iceLeap', 'iceSteps'), S(0.4, 'iceRun', 'spike1+iceSpring', 'iceSteps', 'upper'), S(0.3, 'iceRun+iceLeap', 'gapSpike', 'spikeStep')] },
  iceSlide: { role: 'setpiece', w: 4.4, stages: [Q(1, 'iceRun', 'iceRun+spike1', 'iceSteps+iceLeap', 'iceRun+gapSpike', 'iceSteps+iceSpring')], finale: ['crown'] },
  iceCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'iceRun', 'walker1', 'iceSteps+iceSpring'), S(0.4, 'iceRun+spike1', 'liftRide', 'iceRun+walker1', 'spikeRow+iceLeap'), S(0.3, 'iceRun+iceSpring', 'flyer1+iceRun', 'spikeStep')] },

  // ───── Moonridge: walker patrol and a mover ─────
  recallIce: { role: 'recall', w: 2.0, stages: [S(0.5, 'iceRun', 'walker1', 'gapHill'), S(0.5, 'gapPair+iceSpring', 'upper', 'cliffHop+iceLeap')] },
  moverTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'moverFerry'), S(0.36, 'moverFerry', 'walker1'), S(0.3, 'moverFerry', 'walkerIsland', 'ferryStep')] },
  moverVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'moverFerry', 'walkerPair', 'ferryStep', 'ferryWalker'), S(0.4, 'walkerIsland+moverFerry', 'ferryTwo', 'upper', 'walkerStep', 'ferryWalker'), S(0.3, 'moverFerry+walker1', 'walkerPair', 'ferryTwo', 'ferryStep')] },
  moonBridge: { role: 'setpiece', w: 4.4, stages: [Q(1, 'moverFerry', 'walkerIsland+moverFerry', 'ferryTwo|ferryWalker', 'ferryStep', 'moverFerry+walker1', 'ferryWalker|walkerPair')], finale: ['crown'] },
  moonCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'moverFerry', 'spike1', 'ferryStep', 'ferryWalker'), S(0.4, 'moverFerry+walker1', 'liftRide', 'flyer1+moverFerry', 'ferryTwo', 'ferryWalker'), S(0.3, 'moverFerry+spike1', 'walkerIsland+liftRide', 'ferryStep+gap1', 'ferryWalker')] },

  // ───── Dawnbridge: broken spans ─────
  recallMovers: { role: 'recall', w: 2.0, stages: [S(0.5, 'moverFerry', 'gap1', 'gapHill'), S(0.5, 'walkerIsland', 'upper', 'cliffHop')] },
  bridgeTeach: { role: 'teach', w: 3.4, stages: [S(0.34, 'bridge'), S(0.36, 'bridge', 'upper', 'bridgeArch'), S(0.3, 'bridge', 'bridgeArch', 'bridgePillars')] },
  bridgeVary: { role: 'vary', w: 3.4, stages: [S(0.3, 'bridgeWalker', 'spike1', 'walker1', 'moverFerry', 'bridgeMissing'), S(0.4, 'bridge', 'upperRoute', 'walker1', 'spike1', 'liftFerry', 'flyer1', 'moverFerry', 'bridgeWalker'), S(0.3, 'bridgeArch', 'walker1', 'spike1', 'liftFerry', 'bridgeWalker', 'moverFerry')] },
  brokenBridge: { role: 'setpiece', w: 4.4, stages: [Q(1, 'bridge', 'bridgeMissing', 'moverFerry', 'walker1', 'spike1', 'bridgeArch+gap1', 'liftFerry', 'bridgePillars', 'spike1', 'bridgeWalker', 'flyer1')], finale: ['crown'] },
  bridgeCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'flyer1', 'walker1', 'bridgeArch', 'spike1', 'moverFerry'), S(0.4, 'bridge+spike1', 'crumbleChain', 'walker1', 'moverFerry', 'bridgeWalker', 'liftFerry'), S(0.3, 'moverFerry+bridge', 'walker1+spike1', 'liftFerry', 'bridgeWalker', 'bridgeMissing')] },

  // ───── Beacon Summit: springs, lifts and timed jumps ─────
  recallBridges: { role: 'recall', w: 2.0, stages: [S(0.5, 'bridge', 'gapPair', 'bridgeArch'), S(0.5, 'gapChain', 'upper', 'branchSteps')] },
  summitTeach: { role: 'teach', w: 3.4, stages: [Q(0.3, 'springGap+liftRide'), S(0.36, 'liftHop', 'springHops+gapPair', 'bridge', 'liftClimb', 'crumbleChain', 'liftFerry'), S(0.34, 'liftHop+gap1', 'springGap+liftRide', 'walker1+gap1', 'springHops', 'moverFerry', 'springLedge+gap1')] },
  summitVary: { role: 'vary', w: 3.4, stages: [S(0.35, 'springGap+liftRide', 'liftHop', 'liftFerry', 'branchSteps+liftRide', 'flyer1', 'spike1'), S(0.35, 'liftClimb+springGap', 'liftRide+gapPair', 'springHops+gapChain', 'branchSteps', 'springTwo+liftRide', 'bridge', 'walker1'), S(0.3, 'liftCrumble+springGap', 'liftHop+springGap', 'springChain', 'springHops+gapPair', 'liftValley', 'moverFerry', 'spike1+gap1')] },
  summitClimb: { role: 'setpiece', w: 4.7, stages: [Q(1, 'springGap+liftRide', 'liftHop', 'bridgeArch', 'springHops+liftRide', 'crumbleChain', 'liftHop+springGap+gapPair', 'spikeStep', 'springHops+gapChain', 'moverFerry')], finale: ['crown'] },
  summitCombine: { role: 'combine', w: 3.2, stages: [S(0.3, 'liftRide+springGap+walker1', 'liftClimb+spike1', 'liftHop+gap1', 'flyer1+bridge'), S(0.4, 'liftHop+springGap', 'springHops+gapChain', 'liftRide+springGap+gapPair', 'moverFerry+springGap+liftRide', 'liftFerry+springTall', 'springGap+springBrake', 'crumbleChain', 'walker1+spike1'), S(0.3, 'liftCrumble+springGap+gap1', 'liftHop+springGap+gapPair', 'branchSteps+liftRide', 'liftHop', 'liftValley', 'bridgePillars')] },
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

const OWN_BONUS = { teach: -3, recall: -0.5, vary: -1.2, combine: -0.6, closing: -0.5 };
const REST_MIN = 100, REST_MAX = 900;
const STARVE_U = 1100;              // this far (u, ~13 s) from the last required event the next beat MUST contain one
const GAP_CAP = 2100;               // ...and the ground between two required events (rest included) never goes much beyond this (~21 s)
/** Beats with nothing REQUIRED in them (egg arcs, high routes, springs to the branches, crowns): they keep a stretch alive but do not count as events. */
/** Landscapes whose teaching act brings the first of a hazard (walkers, moths, spikes): their flag carries a little help. */
const HELP = new Set([1, 5, 6]);
const OPTIONAL_ONLY = new Set(['runEggs', 'goldenPatch', 'hills', 'upper', 'upperRoute', 'eggField', 'treasure', 'crown', 'springLedge', 'springTwo', 'springTall', 'springChain', 'springBrake', 'springPush', 'iceSpring', 'iceLeap', 'crumbleUpper']);
const hasEvent = (spec) => spec.split('|').some((alt) => alt.split('+').some((n) => !OPTIONAL_ONLY.has(n)));   // the pacing controller's range for the quiet ground before a spec (u)
const FLAG_EVERY = 2500;            // u of main route after a flag before the next one is due (~23 s)
const FLAG_MAX = 2900;              // try not to go beyond this (~26 s) between flags
const FLAG_HARD = 3100;             // never beyond this when a spec ends: the next flag is then <= 3100 + ~640 u (34 s) away; the rule is 35 s
const lastFlag = (B) => (B.cps.length ? B.cps[B.cps.length - 1].x : -1e9);

/**
 * The biggest cluster of events (each less than 330 u, 3 s, after the one before) among `xs`, continuing the cluster the world
 * built so far ends in (`B.tailChain` events, the last starting at `B.lastEvStart`). Returns { best, run, last }.
 */
function chainOf(B, xs) {
  let best = 0, run = B.tailChain, prev = B.lastEvStart;
  for (const x of [...xs].sort((p, q) => p - q)) { run = x - prev < 330 ? run + 1 : 1; prev = x; best = Math.max(best, run); }
  return { best, run, last: prev };
}

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
    if (attempt === 1) { const sx = B.x; B.station({ after: 380 }); dropPickups(B, c, sx, B.x); flagged = true; }
    for (let i = 0; i < parts.length; i++) {
      const beat = BEATS[parts[i]];
      if (!beat) throw new Error('unknown beat ' + parts[i]);
      // a flag that is due takes the place of the usual recovery room (it has the same safe ground around it)
      if (i === 0 && !flagged && B.x - lastFlag(B) > FLAG_EVERY) { const sx = B.x; B.station({ after: 380 }); dropPickups(B, c, sx, B.x); flagged = true; }
      if (i === 0 && c.due != null && !flagged) {
        // the pacing controller: the first rest is as long as it takes for this spec's first event to land on the schedule. The
        // flat ground since the last event already counts (a beat's own tail is recovery room too), and the approach stays >= ~300 u.
        const lead = expectOf(B, spec).first;
        const tail = Math.max(0, B.x - B.lastEventX);
        // spikes get the most recovery room (>= ~420 u from the landing in the first two spike landscapes, ~300 u after that)
        const approach = /spike/.test(spec) ? (c.ch <= 7 ? 420 : 320) : 300;
        const floor = Math.max(100, approach - tail - Math.min(lead, 120));
        // a beat with nothing required in it has no event to space: it only needs the minimum room (the next event's rest does the pacing)
        c.restLen = hasEvent(spec) ? Math.min(Math.max(100, GAP_CAP - tail - lead), clamp(c.due - B.x - lead, floor, REST_MAX)) : floor;
      }
      if (!(i === 0 && flagged)) rest(B, c, i === 0 ? 1 : 0.42, i === 0 ? 230 : 170);
      if (i === 0 && B.x - B.lastGold > 5200 && B.cur.w >= 90) { B.gold(B.x - Math.min(B.cur.w * 0.5, 70), B.y - 28); B.lastGold = B.x; }   // keep the golden eggs coming (about one per 40-50 s): on the flat ground she is rolling over anyway
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
    // a chain (events less than ~3 s apart, counting the one just before) never grows past what this point of the journey allows
    const chain = chainOf(B, B.evXs);
    if (chain.best > (c.ch < 6 ? 4 : 7)) { B.rollback(mk); return false; }
    if (B.evXs.length) { B.tailChain = chain.run; B.lastEvStart = chain.last; }
    B.events += ev;
    if (B.evRaw > 0) B.lastEventX = B.evLast;
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
  if (known >= 6) out.push('flyer1');                                         // (Fogwood's own moths are placed by its acts, not used as filler)
  if (known >= 6) out.push('spike1', 'gapSpike');
  if (known >= 7) out.push('liftFerry');
  if (known >= 10) out.push('moverFerry');
  return out;
}

/**
 * What a spec typically delivers before it has been built in this level: { ev, len, first } measured once by building it in
 * a scratch world (a fixed seed, mid-game difficulty, every element available). Memoised; the result never depends on the call.
 */
const PRIORS = new Map();
function priorOf(spec) {
  let pr = PRIORS.get(spec);
  if (pr) return pr;
  let ev = 0, len = 0, first = 0, n = 0;
  for (let sd = 1; sd <= 3; sd++) {
    const rand = rng(sd * 7919);
    const B = new Builder(rand, { circuit: 1 });
    B.ch = 12; B.begin(-300, Y0, 560); B.station({});
    const c = { d: 6, k: 0.5, rand, ch: 12, circuit: 1 };
    const m = B.mark(), parts = spec.split('+');
    let x0 = 0;
    for (let i = 0; i < parts.length; i++) {
      rest(B, c, i === 0 ? 1 : 0.42, i === 0 ? 230 : 170);
      if (i === 0) x0 = B.x;
      BEATS[parts[i]].fn(B, c);
      if (B.bad) break;
    }
    if (B.bad) continue;
    const e = B.eventsSince(m);
    ev += e; len += B.x - x0; first += Number.isFinite(B.evFirst) ? Math.max(0, B.evFirst - x0) : 0; n++;
  }
  pr = n ? { ev: ev / n, len: len / n, first: first / n } : { ev: 1, len: 700, first: 100 };
  PRIORS.set(spec, pr);
  return pr;
}
/** What to expect of a spec here: what it has delivered so far in this level, else its prior. */
const expectOf = (B, spec) => { const r = B.rich[spec]; return r && r.n ? { ev: r.ev / r.n, len: r.len / r.n, first: r.first / r.n } : priorOf(spec); };

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
  const starved = B.x - B.lastEventX > STARVE_U;
  if (!pool.some(hasEvent)) pool = [...pool, ...compactSpecs(c, c.role)];            // nothing required to pick from: add the small beats (the pool is only ever optional extras)
  const used = {};
  for (let k = B.logStart; k < B.beatLog.length; k++) used[B.beatLog[k]] = (used[B.beatLog[k]] || 0) + 1;
  const total = Math.max(10, B.beatLog.length - B.logStart);
  const cap = chainCap(c.d);
  const scored = B.rand.shuffle(pool).filter((s) => s !== last || pool.length < 2).map((spec) => {
    const share = Math.max(...spec.split('+').map((n) => (used[n] || 0) / total));
    const r = expectOf(B, spec);
    let mismatch = 0.25;
    if (Number.isFinite(c.evLeft)) mismatch += Math.max(0, r.ev - Math.max(1, c.evLeft + 0.5)) * 0.9;     // never much past the act's quota
    if (want != null) {
      // the rest this spec would need before it to land on the wanted pace; outside [REST_MIN, REST_MAX] it cannot
      const need = (1000 * r.ev) / Math.max(0.5, want) - r.len;
      mismatch = need < REST_MIN ? (REST_MIN - need) / 500 : need > REST_MAX ? (need - REST_MAX) / 900 : 0;
    }
    // a spec whose footprint cannot fit in the room that is left only wastes tries: try it last
    const fit = r.len + REST_MIN + 150 > room ? 3 : 0;
    // chains lengthen over the hour: a beat that packs more events together than this point of the journey asks for is a last resort
    const own = spec.split('+').some((n) => BEATS[n] && ELEMENT_INTRO[BEATS[n].needs] === c.ch && c.ch > 0) ? OWN_BONUS[c.role] ?? -1.5 : 0;    // the landscape's own element keeps its place (most in its teaching act, least in the later ones: a landscape is not one idea)
    const chain = own ? 0 : Math.max(0, r.ev - cap - 0.3) * 5;       // (the beat itself shortens its chain when the quota is nearly used)
    // a beat with nothing required in it only fits where the next event is not yet due (else it just stretches the gap): otherwise it waits
    const idle = !hasEvent(spec) && c.due != null && c.due - B.x < r.len + 350 ? 40 : 0;
    // the wait for the next required event if this beat goes in (its own length, the rests around it, a flag if one falls due)
    const wait = !hasEvent(spec) ? (B.x - B.lastEventX) + r.len + 650 + (B.x + r.len - lastFlag(B) > FLAG_EVERY ? 600 : 0) : 0;
    const dead = (starved && !hasEvent(spec) ? 60 : 0) + idle + (wait > GAP_CAP + 500 ? 80 : 0);          // too long without anything to do: only a beat with an event will do
    const fresh = spec.split('+').every((n) => !used[n]) ? -2.5 : 0;           // a beat this landscape has not shown yet: variety first
    const over = share >= 0.26 ? 20 : 0;                                       // no beat type may grow past about a quarter of the landscape
    return { spec, sc: share * 12 + over + fresh + own + mismatch * 2.5 * (c.behind || 1) + fit + chain + dead };
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
  c.role = act.role;
  c.overlayP = act.overlay;                     // how often a long rest carries a ledge to climb (default 0.3)
  const xFull = x1;
  if (act.finale) x1 = Math.max(x0 + 600, x1 - 1200);          // the finale (the golden crown) keeps its own stretch at the end
  // The pacing controller: `pace.per` is the stretch of non-station ground each required event may take. The next event is
  // due at x0 + (stations so far) + (events so far + 1/2) * per; the first rest of every spec is as long as it takes to
  // reach that (within [RMIN, RMAX]). Specs that pack several events leave a longer rest after them, and the landscape
  // lands on its event rate whatever mix of beats the dice give.
  const sl0 = B.stationLen, ev0 = B.events;
  const steer = () => {
    c.evLeft = pace ? Math.max(0, pace.events - (B.events - ev0)) : Infinity;
    // behind its schedule by more than two events: let the pace matter more than variety when choosing what comes next
    c.behind = pace && (x0 + (B.events - ev0) * pace.per) < B.x - 2 * pace.per ? 3 : 1;
     c.due = pace && pace.per > 0 ? x0 + (B.events - ev0 + 0.5) * pace.per : null;      // where the next event is due
    c.restLen = null;
  };
  const helpAct = act.role === 'teach' && HELP.has(c.ch);
  if (act.flag || B.x - lastFlag(B) > 1900 || helpAct) {      // an act that is far from the last flag starts on one
    const sx = B.x;
    // (a teaching act that brings the first walker / moth / spike gets a little help on a flag: if the last flag is less than 13 s behind, its
    // quiet ground does and no second station is built, which would only add 11 s of empty ground to the wait for the first event)
    if (act.flag || B.x - lastFlag(B) > 1400) B.station({ after: 380 }); else B.run(520, 'line');
    dropPickups(B, c, sx, B.x);
    // the first walkers, moths and spikes get a little help on the flag before them: a golden egg (a duckling) and, from the 3rd landscape on, a shield
    if (act.role === 'teach' && HELP.has(c.ch) && !B.helped.has(c.ch)) {
      B.helped.add(c.ch);
      const mid = (sx + B.x) / 2;
      B.gold(mid - 40, B.y - 28); B.lastGold = Math.max(B.lastGold, B.x);
      if (c.ch >= 2) { B.pickup('shield', mid + 50, B.y - 30); B.lastShield = Math.max(B.lastShield, B.x); }
    }
  }
  for (let si = 0; si < act.stages.length; si++) {
    const st = act.stages[si];
    acc += st.w;
    const end = x0 + ((x1 - x0) * acc) / total;
    const limit = Math.min(hardLimit, strict ? x1 : st.seq && act.finale ? xFull - 950 : x1 + (act.finale ? 150 : 450));          // a stage may use more than its share; later stages then start later and the next act's budget shrinks (a finale keeps its stretch)
    let guard = 0, idx = 0, misses = 0, idled = 0;
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
        const want = pace ? (Math.max(0, pace.events - (B.events - ev0)) / Math.max(500, x1 - B.x)) * 1000 : null;
        const room = limit - B.x;
        // ahead of schedule (the quota is used up): a short stretch of easy ground first, carrying an egg arc or a ledge to climb for
        // (the next event is not yet due); never two in a row, so the gap between events stays short
        if (pace && idled < 1 && c.evLeft < 0.34 && c.due - B.x > 500 && x1 - B.x > 700) {
          if (B.x - lastFlag(B) > FLAG_EVERY) { const sx = B.x; B.station({ after: 380 }); dropPickups(B, c, sx, B.x); }
          else { c.overlayP = 0.65; c.restLen = clamp(c.due - B.x - 200, 300, 700); rest(B, c, 1, 300); c.overlayP = undefined; c.restLen = null; }
          idled++; continue;
        }
        idled = 0;
        for (const spec of tryOrder(B, c, expandPool(st.pool, c, act.role), last, want, room)) {
          if (runSpec(B, c, spec, limit)) { last = spec; done = true; break; }
        }
        // nothing from the pool fits any more: spend what is left on something to do rather than bare ground
        if (!done) for (const spec of tryOrder(B, c, fillers(c.ch, act.role), last, null, room)) { if (runSpec(B, c, spec, limit)) { last = spec; done = true; break; } }
      }
      if (!done) misses++;
    }
  }
  // the stages are done but some of the act's length is left: spend it on something small to do (never bare ground)
  c.restLen = null;
  for (let guard = 0; guard < 6 && x1 - B.x > 560; guard++) {
    c.k = 1; c.d = dAt(B.x); steer();
    const fillLimit = Math.min(hardLimit, strict ? x1 : x1 + (act.finale ? 100 : 300));
    const room = fillLimit - B.x;
    const list = [...compactSpecs(c, act.role), ...fillers(c.ch, act.role)];
    let done = false;
    for (const spec of tryOrder(B, c, list, last, null, room)) if (runSpec(B, c, spec, fillLimit)) { last = spec; done = true; break; }
    if (!done) break;
  }
  c.restLen = null; c.due = null; c.evLeft = Infinity; c.overlayP = undefined;
  if (act.finale) {
    // a celebration should not come after a long wait: something to do first if the last required event is far behind
    if (B.x - B.lastEventX > 900) {
      c.k = 1; c.d = dAt(B.x);
      for (const spec of tryOrder(B, c, compactSpecs(c, act.role), last, null, Math.min(hardLimit, xFull + 600) - B.x)) if (runSpec(B, c, spec, Math.min(hardLimit, xFull + 600))) { last = spec; break; }
    }
    for (const spec of act.finale) { c.k = 1; c.d = dAt(B.x); if (!runSpec(B, c, spec, Math.min(hardLimit, xFull + 1800))) { c.miniCrown = true; if (!runSpec(B, c, spec, hardLimit + 500)) runSpec(B, c, spec, Infinity); c.miniCrown = false; } }
  }
}

export { BEATS, Y0, P, T, lerp };
