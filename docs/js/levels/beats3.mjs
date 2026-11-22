/*
 * Egg Mama — flourishes used by set pieces: the golden crown (a rainbow of eggs with two golden eggs) and the hill top.
 */
import { clamp } from '../tuning.mjs';
import { Y0 } from './builder.mjs';
import { ease } from './params.mjs';
import { def, settle, goldMain } from './beats.mjs';

const rd = Math.round;

/** The memorable end of a set piece: a rainbow arch of eggs over safe ground with two golden eggs to jump for. */
def('crown', { needs: 'gap', hz: false }, (B, c) => {
  B.run(260, 'line');
  const x0 = B.x;
  B.run(660, 'none');
  const top = B.y;
  const cx = x0 + 330, span = 320, h = rd(c.rand.range(70, 92));
  for (let i = 0; i <= 10; i++) {
    const u = i / 10;
    const x = cx - span / 2 + span * u, y = top - 28 - h * Math.sin(Math.PI * u);
    if (i === 3 || i === 7) goldMain(B, x, y); else B.egg(x, y);
  }
  B.runEggs(x0 + 20, x0 + 140, top, 'line');
  B.runEggs(x0 + 520, B.x - 20, top, 'line');
  B.quiet.push([x0 - 200, B.x]);
  B.run(180, 'line');
});

/** Climb three steps to a plateau with a golden egg, then walk down the other side. Walls forgive a late jump. */
def('hillTop', { needs: 'step', hz: false }, (B, c) => {
  B.tag('step', B.x);
  const steps = 3;
  const hs = [];
  const specs = [];
  for (let i = 0; i < steps; i++) {
    const h = rd(clamp(24 + 10 * ease(c.d) + c.rand.range(0, 12), 24, 40));
    hs.push(h);
    specs.push({ gap: c.d > 2 && c.rand.chance(clamp(0.2 + 0.1 * c.d, 0.4, 1)) ? rd(c.rand.range(30, 40)) : 0, w: rd(c.rand.range(150, 190)), dy: -h, gold: false });   // a wall, or (later) a real gap
  }
  B.train(specs);
  if (B.bad) return;
  B.run(rd(c.rand.range(200, 280)), 'line');
  goldMain(B, B.x - 110, B.y - 30);
  B.run(120, 'line');
  for (let i = steps - 1; i >= 0; i--) {
    B.hop(0, rd(c.rand.range(150, 190)), hs[i]);
    B.runEggs(B.cur.x, B.x, B.y, 'wave');
  }
  settle(B, c);
});
