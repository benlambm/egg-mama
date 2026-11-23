/*
 * Egg Mama — the captions along the trail (level.cues).
 *   story  the landscape's story, just after she crosses into it
 *   tip    the move a landscape teaches (chapters[i].tip), ~250 u before its first appearance
 *   trail  each chapter.trail line at (about) its fraction, placed in a quiet stretch of flat ground
 * Cues are kept >= 380 u apart (so two captions never fight for the same strip of screen).
 */
import { CHAPTERS } from '../chapters.mjs';

const SPACING = 380;
const TIP_LEAD = 250;

/** Which first-appearance tag each landscape's tip belongs to (the first one that appears wins). */
const TIP_TAGS = [['gap'], ['walker'], ['logs'], ['spring'], ['crumble'], ['flyer'], ['spikes'], ['lift'], ['liftCrumble'], ['ice'], ['mover', 'walker'], ['bridge'], []];

export function placeCues(B, chapters, beacon) {
  const cues = [];
  const near = (x, gap = SPACING) => cues.some((c) => Math.abs(c.x - x) < gap);
  const add = (x, text, kind) => cues.push({ x: Math.round(x), text, kind });

  // story: right after the landscape begins (Meadow: just after she starts rolling)
  for (const ch of chapters) {
    const x = ch.index === 0 ? B.cps[0].x + 40 : ch.x0 + 60;
    add(x, CHAPTERS[ch.index].story, 'story');
  }
  // tips before the first appearance of each landscape's signature
  for (const ch of chapters) {
    const i = ch.index;
    let first = null;
    for (const tag of TIP_TAGS[i]) {
      const f = B.firsts.find((t) => t.ch === i && t.kind === tag);
      if (f && (!first || f.x < first.x)) first = f;
    }
    if (i === CHAPTERS.length - 1) { add(beacon.x - 330, CHAPTERS[i].tip, 'tip'); continue; }
    if (!first) continue;
    let x = first.x - TIP_LEAD;
    // after the story, and never on top of another caption
    x = Math.max(x, ch.x0 + 60 + SPACING);
    if (x < first.x - 120) add(x, CHAPTERS[i].tip, 'tip');
    else add(Math.max(ch.x0 + 60 + SPACING, first.x - 130), CHAPTERS[i].tip, 'tip');
  }
  // the first shield and magnet in the world (and the first WALL: a rise with no gap in front of it, where Mama stops until she is swiped up; the first four landscapes build none)
  const tipFor = { shield: 'A blue shell blocks one hit', magnet: 'A magnet pulls eggs to you', wall: 'Stopped at a wall? Swipe up to hop on' };
  for (const kind of ['shield', 'magnet', 'wall']) {
    const f = B.firsts.filter((t) => t.kind === kind).sort((a, b) => a.x - b.x)[0];
    if (!f) continue;
    const x = f.x - 200;
    if (!near(x)) add(x, tipFor[kind], 'tip');
  }
  // trail lines in quiet stretches near their fractions
  for (const ch of chapters) {
    const L = ch.x1 - ch.x0;
    for (const line of CHAPTERS[ch.index].trail) {
      const target = ch.x0 + line.at * L;
      let best = null;
      for (const [a, b] of B.quiet) {
        if (b - a < 380 || a < ch.x0 + 1100 || b > ch.x1 - 120) continue;
        for (const f of [0.5, 0.3, 0.7]) {
          const x = a + (b - a) * f;
          if (x < a + 190 || x > b - 190 || near(x)) continue;
          const dist = Math.abs(x - target);
          if (!best || dist < best.dist) best = { x, dist };
        }
      }
      if (best) add(best.x, line.text, 'trail');
      else add(clampOutside(target, cues), line.text, 'trail');
    }
  }
  cues.sort((p, q) => p.x - q.x);
  return cues;
}

/** Fallback: push a caption along until it clears the others (rare). */
function clampOutside(x, cues) {
  let guard = 0;
  while (cues.some((c) => Math.abs(c.x - x) < SPACING) && guard++ < 40) x += 60;
  return x;
}
