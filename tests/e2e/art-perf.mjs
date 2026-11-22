#!/usr/bin/env node
/*
 * ACTORS art — speed and cache-bound check.   Run:  node tests/e2e/art-perf.mjs
 *
 *   stress    300 actors/frame (every kind round-robin, mixed palettes + lighting) for 300 frames on a full 2532x1170 canvas
 *   typical   33 actors (Mama + flock of 5 + eggs + 3 enemies + pickups + flags + bubble): what a real frame holds
 *   bounds    three whole circuits (39 landscapes, ~3 h of play) of every creature/flag/cast draw in both facings and both
 *             lightings: the SpriteCache must plateau (palette groups are evicted), never grow
 *
 * Headless Chromium rasterises on the CPU, so absolute times are pessimistic against a phone GPU; the limits below are
 * generous guards against regressions, and the numbers are printed so they can be compared run to run.
 */
import assert from 'node:assert/strict';
import { withPage } from '../../tools/art-sheet.mjs';

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok    ' + name); } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

await withPage(async (page, logs) => {
  const stress = await page.evaluate(() => window.sheetApi.perf({ actors: 300, frames: 300, scene: 'stress' }));
  const typical = await page.evaluate(() => window.sheetApi.perf({ frames: 300, scene: 'typical' }));
  const bounds = await page.evaluate(() => window.sheetApi.boundCheck());

  console.log(`stress : ${stress.actors} actors x ${stress.frames} frames  mean ${stress.msPerFrameMean} ms  p95 ${stress.msP95} ms  (${stress.usPerActor} us/actor)  cache ${stress.cacheAfterRun.sprites} sprites / ${stress.cacheAfterRun.mb} MB`);
  console.log(`typical: ${typical.actors} actors x ${typical.frames} frames  mean ${typical.msPerFrameMean} ms  p95 ${typical.msP95} ms  (${typical.usPerActor} us/actor)  cache ${typical.cacheAfterRun.sprites} sprites / ${typical.cacheAfterRun.mb} MB`);
  const last = bounds.history[bounds.history.length - 1];
  console.log(`bounds : after 3 circuits ${last.sprites} sprites / ${last.mb} MB; peak ${Math.max(...bounds.history.map((h) => h.sprites))} sprites / ${Math.max(...bounds.history.map((h) => h.mb))} MB`);

  check('no draw errors', () => { assert.deepEqual(stress.errors, []); assert.deepEqual(typical.errors, []); assert.deepEqual(bounds.errors, []); });
  check('typical frame (33 actors) well inside a 60 fps budget even on the CPU rasteriser', () => assert.ok(typical.msPerFrameMean < 25, `${typical.msPerFrameMean} ms`));
  check('300-actor stress frame stays sane', () => assert.ok(stress.msPerFrameMean < 450, `${stress.msPerFrameMean} ms`));
  check('cache does not keep growing during steady animation (stress)', () => assert.ok(stress.cacheAfterRun.sprites <= stress.cacheAfterWarm.sprites * 1.25 + 40, `${stress.cacheAfterWarm.sprites} -> ${stress.cacheAfterRun.sprites}`));
  check('cache plateaus over 3 circuits: circuit 3 == circuit 2, landscape by landscape', () => {
    const n = bounds.history.length / 3;
    for (let k = 0; k < n; k++) assert.equal(bounds.history[2 * n + k].sprites, bounds.history[n + k].sprites, `landscape ${bounds.history[k].chapter}`);
  });
  check('cache stays small (<= 40 MB, <= 450 sprites)', () => {
    assert.ok(Math.max(...bounds.history.map((h) => h.mb)) <= 40, 'MB'); assert.ok(Math.max(...bounds.history.map((h) => h.sprites)) <= 450, 'sprites');
  });
  check('no console errors', () => assert.deepEqual(logs, []));
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall art-perf checks passed');
process.exit(failures ? 1 : 0);
