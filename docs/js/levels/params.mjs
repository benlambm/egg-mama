/*
 * Egg Mama — how demands scale with difficulty.
 *
 * `d` is the effective difficulty 0..20 from chapters.mjs (0 at the very start, ~11 at the first beacon).
 * Every demand the generator creates comes from one of these curves, and demand.mjs inverts the same
 * curves to MEASURE a finished act from its geometry, so the generator and the test of the difficulty
 * ramp agree about what "harder" means.
 */
import { T, clamp, lerp } from '../tuning.mjs';

/** 0..1 eased difficulty (slightly concave so the first half of the journey stays gentle). */
export const ease = (d) => Math.pow(clamp(d / 20, 0, 1), 0.85);
/** inverse of ease(): which d produces eased value e. */
export const unease = (e) => 20 * Math.pow(clamp(e, 0, 1), 1 / 0.85);

const at = (a, b, d) => lerp(a, b, ease(d));

export const P = {
  /** gap width of a required jump (u). The first gaps are 34 (window ~0.7 s), the hardest 68 (window ~0.37 s). */
  gap: (d) => at(34, 68, d),
  /** landing island after a single gap (ground). */
  landing: (d) => at(230, 84, d),
  /** small ground islands inside gap chains. */
  island: (d) => at(170, 86, d),
  /** thin ledges (logs, planks, bridges, steps). */
  ledge: (d) => at(150, 84, d),
  /** safe flat ground between challenges (recovery room). */
  rest: (d) => at(500, 210, d),
  /** walkers */
  walkerSpeed: (d) => at(22, 50, d),
  walkerPatrol: (d) => at(170, 104, d),
  /** flyers (moths, bees, ...): horizontal reach, vertical bob, period */
  flyerAx: (d) => at(34, 76, d),
  flyerAy: (d) => at(14, 34, d),
  flyerPeriod: (d) => at(4.9, 3.3, d),
  /** spikes: width (u) and the wait between a pair */
  spikeW: (d) => at(22, 32, d),
  /** crumbling ledges */
  crumbleW: (d) => at(104, 70, d),
  crumbleGap: (d) => at(22, 42, d),
  /** lifts and movers */
  liftAmp: (d) => at(30, 52, d),
  liftPeriod: (d) => at(6.4, 3.8, d),
  moverAmp: (d) => at(14, 30, d),
  moverPeriod: (d) => at(6.2, 3.8, d),
  /** ice */
  iceIsland: (d) => at(240, 130, d),
  /** springs: how far the landing sits from the launch (comfortable margin) */
  springLandW: (d) => at(220, 130, d),
};

/** Ordered element families and the landscape index (0-based) where each is introduced in circuit 1. */
export const ELEMENT_INTRO = {
  gap: 0, step: 0, hill: 0, upper: 0,
  walker: 1,           // Meadow's very last act teases a gentle snail, but Clover Mill is where it is taught
  logs: 2,
  spring: 3,
  crumble: 4,
  flyer: 5,
  spikes: 6,
  lift: 7,
  liftCrumble: 8,
  ice: 9,
  mover: 10,
  bridge: 11,
  summit: 12,
};

export { T, clamp, lerp };
