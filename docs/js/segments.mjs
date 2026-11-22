/*
 * Egg Mama — the segment library: every beat (building block) and act template the generator can use, plus a
 * helper that builds a tiny one-beat level for testing a single template in isolation.
 */
import { rng } from './rng.mjs';
import { Builder, Y0 } from './levels/builder.mjs';
import { assemble } from './levels/assemble.mjs';
import { BEATS, rest } from './levels/beats.mjs';
import { ACTS, PLAN } from './levels/acts.mjs';
import { ELEMENT_INTRO } from './levels/params.mjs';

export { BEATS, ACTS, PLAN, ELEMENT_INTRO };

/** Names of all beats / act templates (the "dozens of templates"). */
export const beatNames = () => Object.keys(BEATS);
export const actNames = () => Object.keys(ACTS);

/**
 * A small level: a flag, then `repeat` x (rest + the beat) at difficulty d, then a second flag. Used by the tests to
 * run one template through the bot at many difficulties and clock phases. Returns { level, bad, x0, x1 } where bad is
 * set if the beat refused to build (an unfair or unfit variant), and [x0, x1] spans the beat(s).
 */
export function miniLevel(beat, d, seed, { k = 0.5, ch = 0, circuit = 1, repeat = 1 } = {}) {
  const rand = rng(seed);
  const B = new Builder(rand, { circuit });
  B.ch = ch;
  B.begin(-300, Y0, 560);
  B.station({});
  const c = { d, k, rand, ch, circuit };
  const x0 = B.x;
  let bad = null;
  for (let i = 0; i < repeat; i++) {
    rest(B, c);
    BEATS[beat].fn(B, c);
    if (B.bad) { bad = B.bad; break; }
  }
  const x1 = B.x;
  B.run(500, 'line');
  B.flag();
  B.run(400, 'line');
  const level = assemble(B, {
    circuit, seed, start: { x: B.cps[0].x, y: Y0 }, endX: B.x - 100,
    chapters: [{ index: ch, x0: -300, x1: B.x, flag: 0 }], beacon: null, cues: [], beats: [], water: null,
  });
  return { level, bad, x0, x1 };
}
