#!/usr/bin/env node
/*
 * ACTORS art — Playwright (Chromium) checks for docs/js/art-actors.mjs.   Run:  node tests/e2e/art-smoke.mjs
 *
 *   1. extents      every actor's opaque pixels, measured at the real phone scale, match ACTOR_SIZES (art ~44 u Mama, ~22 u
 *                   ducklings, 16x20 eggs, ~34x26 walkers, ~30x24 flyers) and stand on / centre on their documented origin
 *   2. lighting     light stays on the UPPER LEFT for both facings: the mirrored left-facing picture has the same silhouette
 *                   but different shading (a naively flipped sprite would shade identically)
 *   3. robustness   644 calls with missing / NaN / absurd params, unknown species, broken palettes: none throws; the context's
 *                   transform + alpha are left alone; image smoothing is switched back on for sprites
 *   4. sheets       the contact sheets render at 2532x1170 (iPhone 13 landscape, DPR 3) with no draw errors
 *
 * (The contact sheets themselves are for human eyes: node tools/art-sheet.mjs --out <dir>.)
 */
import assert from 'node:assert/strict';
import { withPage } from '../../tools/art-sheet.mjs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok    ' + name); } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
};
const within = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what}: ${v} not in [${lo}, ${hi}]`);

await withPage(async (page, logs) => {
  /* 1. extents */
  const { sizes: S, declared: D } = await page.evaluate(() => window.sheetApi.measure());
  const feet = (name, tol = 1.6) => within(S[name].y1, -1, tol, `${name} feet on the ground (bottom y)`);
  check('Mama: ~46 u tall incl. tuft, shell on her feet', () => {
    const m = S['mama:idle(right)'];
    within(m.h, D.mama.h - 3, D.mama.h + 3, 'height'); within(m.w, D.mama.w - 4, D.mama.w + 4, 'width'); feet('mama:idle(right)');
    within(m.h, 40, 52, 'readable at ~44 u');
  });
  check('Mama stays on screen-sized bounds in every pose', () => {
    for (const k of ['mama:run', 'mama:air', 'mama:squash+hurt+happy']) { within(S[k].h, 40, 64, k + ' height'); within(S[k].w, 30, 52, k + ' width'); }
  });
  check('duckling ~22-26 u, standing on its feet; half Mama\'s height', () => {
    const d = S['duckling(ground)']; within(d.h, D.duckling.h - 3, D.duckling.h + 3, 'height'); feet('duckling(ground)');
    within(d.h / S['mama:idle(right)'].h, 0.4, 0.6, 'duckling / Mama');
  });
  check('plain egg 16x20, centred; golden egg clearly bigger', () => {
    const e = S.egg; within(e.w, D.egg.w - 2, D.egg.w + 3, 'egg w'); within(e.h, D.egg.h - 2, D.egg.h + 3, 'egg h');
    within((e.y0 + e.y1) / 2, -1.5, 1.5, 'egg centred'); within((e.x0 + e.x1) / 2, -1.5, 1.5, 'egg centred x');
    assert.ok(S.gold.h > e.h * 1.25 && S.gold.w > e.w * 1.25, 'golden egg (with its twinkles) must dwarf the plain one');
  });
  check('walkers: feet on the ground, ~34x26', () => {
    for (const sp of ['snail', 'caterpillar', 'beetle', 'crab', 'mite']) {
      const k = 'walker:' + sp; feet(k); within(S[k].w, 24, D.walker.w + 2, k + ' w'); within(S[k].h, 18, D.walker.h + 3, k + ' h');
      within((S[k].x0 + S[k].x1) / 2, -4, 4, k + ' centred on its feet');
    }
  });
  check('flyers: centred, ~30x24 (wings at full spread a bit wider)', () => {
    for (const sp of ['bee', 'moth', 'gull', 'bat', 'owl', 'hawk']) {
      const k = 'flyer:' + sp; within(S[k].w, 24, D.flyer.w + 3, k + ' w'); within(S[k].h, 18, D.flyer.h + 3, k + ' h');
      within((S[k].y0 + S[k].y1) / 2, -6, 6, k + ' vertical centre'); within((S[k].x0 + S[k].x1) / 2, -6, 6, k + ' horizontal centre');
    }
  });
  check('pickups ~24 u, bubble encloses Mama without sinking into the ground, flag taller than Mama', () => {
    for (const k of ['shield', 'magnet']) { within(S[k].w, 20, 28, k + ' w'); within(S[k].h, 20, 29, k + ' h'); within((S[k].y0 + S[k].y1) / 2, -2, 2, k + ' centred'); }
    assert.ok(S.bubble.y1 <= 3.5, 'bubble bottom ' + S.bubble.y1); assert.ok(S.bubble.y0 <= S['mama:idle(right)'].y0 - 3, 'bubble top must clear Mama\'s tuft');
    assert.ok(S.bubble.x0 <= S['mama:idle(right)'].x0 - 2, 'bubble wider than the shell');
    within(S['flag:active'].h, 58, 68, 'flag height'); assert.ok(S['flag:active'].h > S['mama:idle(right)'].h + 10, 'flag must read taller than Mama');
    feet('flag:active', 2.5); feet('flag:inactive', 2.5);                       // its mound sits a touch into the ground
  });

  /* 2. lighting */
  const L = await page.evaluate(() => window.sheetApi.lighting());
  check('light stays upper-left for both facings (mirror test)', () => {
    for (const [name, m] of Object.entries(L.mirror)) { assert.ok(m.iou >= 0.93, `${name}: silhouettes differ when mirrored (IoU ${m.iou})`); assert.ok(m.shadeDiff >= 3, `${name}: shading identical when mirrored => light was flipped (diff ${m.shadeDiff})`); }
  });
  check('symmetric props are lit upper-left (upper-left brighter than lower-right)', () => {
    for (const [name, q] of Object.entries(L.direct)) assert.ok(q.ul > q.lr + 5, `${name}: ul ${q.ul} lr ${q.lr}`);
  });

  /* 3. robustness */
  const E = await page.evaluate(() => window.sheetApi.edge());
  check(`robust to bad input (${E.ran} calls)`, () => assert.deepEqual(E.fails, []));

  /* 3b. regressions found by the audit */
  const R = await page.evaluate(() => window.sheetApi.regress());
  check('shield bubble stays see-through (light AND dark), Mama visible behind it', () => {
    for (const k of ['light', 'dark']) {
      assert.ok(R.bubble[k].interiorAlpha < 0.22, `${k}: bubble interior alpha ${R.bubble[k].interiorAlpha} (a stacked halo makes it milky)`);
      assert.ok(R.bubble[k].mamaBellyShift < 42, `${k}: Mama's belly changes by ${R.bubble[k].mamaBellyShift} luminance behind the bubble`);
    }
  });
  check('dark chapters are detected from the palette when `dark` is omitted; an explicit flag wins', () => {
    for (const [name, v] of Object.entries(R.dark)) { assert.ok(v.caveAutoEqualsDark, name + ': caverns palette, dark omitted != dark:true'); assert.ok(v.caveDarkDiffersFromLight, name + ': dark and light look identical'); assert.ok(v.meadowAutoEqualsLight, name + ': meadow palette, dark omitted != light'); assert.ok(v.explicitWins, name + ': explicit dark:false must override the palette'); }
  });
  check('prewarmActors: complete, incremental under a tiny budget, and afterwards nothing new is baked while drawing', () => {
    assert.equal(R.prewarm.doneAll, true); assert.equal(R.prewarm.newSpritesWhileDrawing, 0, 'drawing baked sprites prewarm missed');
    assert.ok(R.prewarm.incrementalCalls > 5 && R.prewarm.incrementalCalls < 400, 'budgeted prewarm calls: ' + R.prewarm.incrementalCalls); assert.ok(R.prewarm.incrementalSame, 'budgeted prewarm must reach the same cache');
  });

  const C = await page.evaluate(() => window.sheetApi.clipCheck());
  check(`no sprite is clipped by its own box (${C.total} sprites, every landscape, both lightings)`, () => assert.deepEqual(C.bad.slice(0, 5), []));

  /* 4. sheets */
  for (const name of ['mama-meadow', 'chapter-canyon', 'gallery-walkers', 'gallery-flyers']) {
    const r = await page.evaluate((n) => window.sheetApi.render(n, {}), name);
    check(`sheet ${name}: 2532x1170 PNG, no draw errors`, () => {
      const b = Buffer.from(r.url.split(',')[1], 'base64');
      assert.equal(b.readUInt32BE(16), 2532); assert.equal(b.readUInt32BE(20), 1170); assert.deepEqual(r.errors, []);
    });
  }
  check('no console errors', () => assert.deepEqual(logs, []));
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall art-smoke checks passed');
process.exit(failures ? 1 : 0);
