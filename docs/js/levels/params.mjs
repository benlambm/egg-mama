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
  /**
   * gap width of a required jump (u). The sim lets her mantle onto a ground island across a gap of up to ~38 u
   * without jumping, so even the gentlest gap is 42 u (a real jump, window ~0.68 s); the hardest is 68 (window ~0.45 s).
   */
  gap: (d) => at(42, 68, d),
  /** landing island after a single gap (ground). */
  landing: (d) => at(230, 84, d),
  /** small ground islands inside gap chains. */
  island: (d) => at(170, 86, d),
  /** thin ledges (logs, planks, bridges, steps). */
  ledge: (d) => at(150, 84, d),
  /** safe flat ground between challenges (recovery room). */
  rest: (d) => at(340, 120, d),
  /** walkers */
  walkerSpeed: (d) => at(22, 50, d),
  walkerPatrol: (d) => at(170, 104, d),
  /** flyers (moths, bees, ...): horizontal reach, vertical bob, period */
  flyerAx: (d) => at(34, 76, d),
  flyerAy: (d) => at(14, 34, d),
  flyerPeriod: (d) => at(4.9, 3.3, d),
  /**
   * spikes: width (u). A spike hop's takeoff window is (54.9 - w) u (see phys.spikeWindow: her body must be 13 u clear of the
   * thorns on both sides), so 14 u gives 0.37 s and 19 u gives 0.33 s. (22 -> 32 u gave 0.30 -> 0.21 s: the one element in the
   * game that a sloppy but calm player kept hitting, while every gap, lift and enemy has a window of 0.35 s or more.)
   */
  spikeW: (d) => at(14, 19, d),
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

/**
 * How many REQUIRED events per minute a landscape should ask for (per minute of the whole landscape: flag stations and
 * breathers included, which is what a child experiences). This is the felt ramp: about 5.4 a minute in Meadow rising slowly to
 * about 11 at the Summit (a hop, a lift ride, a walker, a flyer, a spike each count one); the table runs a little above the straight
 * line in the chain-heavy landscapes (stepping logs, cracked ledges) whose signature is a run of hops; the Summit's entry is a pull
 * (its lift and spring beats are long, so the controller settles near 11). `within` nudges it up
 * through a landscape; every later circuit asks 0.9 more but still starts gentle. levelgen paces each landscape to this by rest
 * length; the tests check the result from the built geometry (tests/felt.mjs), never from this function.
 */
const RATE_TABLE = [5.4, 6.0, 7.0, 7.3, 7.6, 8.0, 8.5, 9.0, 9.4, 9.9, 10.4, 10.7, 12.4];
export const RATE = (i, within = 0.5, circuit = 1) => Math.min(13.8, RATE_TABLE[i] + (within - 0.5) * 0.5 + 0.9 * (circuit - 1));

/** How much of the landscape's events each kind of act carries, relative to the others (the gentle sawtooth inside a landscape). */
export const ROLE_RATE = { opening: 0, recall: 0.8, teach: 0.9, vary: 1.0, combine: 1.15, setpiece: 1.2, breather: 0, closing: 0.85 };

/** Longest run of back-to-back hops (a chain: 'plan the second landing'): 2 at the start, 5 at the summit. */
export const chainMax = (d) => Math.round(clamp(2 + 3 * ease(d) / 0.62, 2, 5));

/**
 * How many required events one beat may pack together (a chain: events a second or two apart) before the act controller
 * turns to a calmer beat: singles at first (Meadow), then doubles, then triples, ... fives at the summit. A soft limit.
 */
export const chainCap = (d) => clamp(1.0 + 4.1 * ease(d) / 0.6, 1.0, 5.6);

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
