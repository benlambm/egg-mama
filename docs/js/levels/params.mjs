/*
 * Egg Mama — how demands scale with difficulty.
 *
 * `d` is the effective difficulty 0..20 from chapters.mjs (0 at the very start, ~11 at the first beacon).
 * Every demand the generator creates comes from one of these curves, and demand.mjs inverts the same
 * curves to MEASURE a finished act from its geometry, so the generator and the test of the difficulty
 * ramp agree about what "harder" means.
 */
import { T, clamp, lerp } from '../tuning.mjs';
import { difficulty } from '../chapters.mjs';

/**
 * The difficulty the generator uses for landscape `i` (0-based) at `within` (0..1) of circuit `circuit`.
 *
 * Circuit 1 is chapters.difficulty() as it stands (0 -> ~11: slow, nearly linear). Circuit 2 is the same ramp 4.5 higher (a child
 * who keeps going has played an hour and is ready for a little more). From circuit 3 on NOTHING gets harder in demand: the ramp is
 * circuit 2's, so a circuit starts no harder than circuit 2's Meadow, ends no harder than circuit 2's Summit, and D_MAX caps it
 * (a child who reaches circuit 3 has played two hours and still starts gentle). What grows is only the NUMBER of events a minute
 * (RATE: a small, saturating lift per circuit), never the takeoff windows: with d <= D_MAX every required hop keeps a window of at
 * least ~0.33 s in the model (>= 0.30 s measured in the sim) in ANY circuit, however many.
 * (chapters.difficulty()'s own circuit term, +4.5 a circuit capped at 20, is no longer what the generator reads.)
 */
export const D_MAX = 16;
export function levelDifficulty(i, circuit, within = 0) {
  const d = difficulty(i, 1, within) + (circuit >= 2 ? 4.5 : 0);
  return Math.min(D_MAX, d);
}

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
   * thorns on both sides), so 7 u gives 0.43 s, 14 u 0.37 s and 19 u 0.33 s. Spikes were the tightest element (0.35 s against 0.44-0.55 s
   * for a hop): a clumsy small child (120 ms of unnoticed latency, +-120 ms of jitter) cleared only 62 % of Ember Canyon's segments
   * with 14 u thorns, ~88 % with 7-8 u ones. The art is baked ~1.42x bigger than a thorn module on purpose and is far bigger than the
   * hitbox now (Mama is hurt within ~14 u of its centre, her art overlaps from ~30 u): errs on the forgiving side.
   */
  spikeW: (d) => at(6, 9, d),
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
 * How many THREAT-WEIGHTED required events per minute a landscape should ask for (per minute of the whole landscape: flag stations and
 * breathers included, which is what a child experiences). This is the felt ramp: a hop, a wall, a walker, a static spike, a lift or mover
 * board and exit count 1, a flyer the share of the time a Mama who never jumps is hit by it (~0.35 for a low moth, 0 for a high one:
 * phys.flyerThreat), a spring that carries a gap 0.25. The table is CALIBRATED (not the straight line it looks like): each entry is what
 * the controller was asked for so that the BUILT landscape lands on a smooth ramp, about 5.3 a minute in Meadow rising to about 11 at the
 * Summit (measured over 16 journeys; the carved hops of the dead-stretch guard add about one in ten). The chain-heavy landscapes
 * (stepping logs, cracked ledges) cannot go below ~7 and ~8 whatever is asked, so their entries are low; Meadow's and Clover Mill's are
 * low because the dead-stretch guard adds hops there; the Summit's lift and spring beats are long. `within` nudges it up through a
 * landscape; later circuits ask a little more (circuitRate: saturating) but still start gentle. levelgen paces each landscape to this by
 * rest length; the tests check the result from the built geometry (tests/felt.mjs), never from this function.
 */
const RATE_TABLE = [3.9, 4.0, 5.7, 7.5, 5.6, 8.4, 8.8, 8.7, 8.4, 9.6, 10.3, 10.6, 11.4];
export const RATE = (i, within = 0.5, circuit = 1) => Math.min(13.8, RATE_TABLE[i] + (within - 0.5) * 0.5 + circuitRate(i, circuit));
/**
 * Later circuits ask a few more events a minute, but only a few and with diminishing returns: +0.8 in circuit 2, then up to
 * +0.9 more by the Summit (saturating: circuit 3 +0.45 at the Summit, circuit 4 +0.68, never more than +0.9), none of it in Meadow.
 */
export const circuitRate = (i, circuit) => (circuit < 2 ? 0 : 0.8 + 0.9 * (1 - Math.pow(0.5, circuit - 2)) * (i / 12));

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
