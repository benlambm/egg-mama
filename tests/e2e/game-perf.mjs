#!/usr/bin/env node
/*
 * Egg Mama — what the whole loop costs, and whether a long session stays healthy (run by hand; NOT part of `node --test`).
 *
 *   node tests/e2e/game-perf.mjs [--soak <seconds of wall time, default 150>] [--quick]
 *   GAME_SHOTS=<dir> for screenshots (default <tmp>/egg-mama-shell, never the repo)
 *
 * Real Chromium with the SOFTWARE rasteriser (no GPU), iPhone 13 landscape 844x390 @3 (a 2532x1170 canvas):
 *   1. frame cost of the real rAF loop (sim + draw) over ~600 frames of autoplay in Meadow, Fogwood (misty) and Lantern Caverns
 *      (dark): JS time per frame and rAF-to-rAF time, p50 / p95; plus `bench`, which adds a 1-px read-back so the rasteriser's
 *      own work is included;
 *   2. the dpr safety net on this slow machine: starts at 3, watch it step down, hold, and not oscillate;
 *   3. a soak: autoplay (god mode + the edge autopilot, drawn, with audio) at 8x speed across landscapes while sampling the JS heap
 *      after a forced GC, the audio voice / player counts and the error count. A healthy loop's heap is flat after warm-up.
 * Numbers are for THIS machine (software raster, shared 4 cores): a phone's GPU will not run the same way, but the shape (what is
 * cheap, what is not, and that nothing grows) carries over.
 */
import { chromium, startServer, reporter, boot, tapSelector, shot, DEVICES } from './shell-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const SOAK = Number(arg('soak', 150));
const QUICK = !!arg('quick', false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (page) => page.evaluate(() => window.__egg.state());
const t = reporter('game perf and soak (software rasteriser, 844x390 @3)');
const errors = [];

const server = await startServer();
const browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
let fails = 1;
try {
  const { context, page, cdp } = await boot(browser, server, DEVICES.iphone13, { errors });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await tapSelector(page, cdp, '[data-screen=title] [data-action=play]');
  await page.waitForFunction(() => window.__egg.state().mode === 'playing');
  await page.evaluate(() => window.__egg.autoplay(true));

  /* ── 1. frame cost ── */
  console.log('\n-- 1. frame cost, whole loop');
  const spots = [['Meadow', 0, 5200], ['Fogwood (misty)', 5, 3200], ['Lantern Caverns (dark)', 8, 3200]];
  const costs = {};
  for (const [name, idx, off] of spots) {
    await page.evaluate(([i, o]) => { const l = window.__egg.level(); window.__egg.teleport(l.chapters[i].x0 + o); }, [idx, off]);
    await sleep(2500);                                                        // sprites bake, painting decodes, ease-in is over
    await page.evaluate(() => window.__egg.resetPerf());
    await page.waitForFunction(() => window.__egg.perfStats().frames >= 600, null, { timeout: 120000, polling: 200 });
    const p = await page.evaluate(() => window.__egg.perfStats());
    const b = await page.evaluate(() => window.__egg.bench(300));
    costs[name] = { p, b };
    const s = await st(page);
    console.log(`  ${name.padEnd(24)} landscape ${s.chapter + 1}  rAF loop: JS ${p.busyP50}/${p.busyP95} ms (p50/p95), frame-to-frame ${p.gapP50}/${p.gapP95} ms`);
    console.log(`  ${''.padEnd(24)} bench (sim + draw + raster read-back, 300 frames): JS ${b.js.p50}/${b.js.p95} ms, with raster ${b.withRaster.p50}/${b.withRaster.p95} ms (max ${b.withRaster.max}); ${b.stats.platforms} platforms, ${b.stats.pickups} pickups on screen`);
    await shot(page, `perf-${idx}`);
    t.ok(s.errors === 0 && !s.crashed, `${name}: no errors`);
    t.ok(p.busyP95 < 60, `${name}: JS time per frame stays sane (p95 ${p.busyP95} ms)`);
  }

  /* ── 2. the dpr safety net ── */
  if (!QUICK) {
    console.log('\n-- 2. resolution safety net on this (slow) machine');
    await page.evaluate(() => window.__egg.teleport(window.__egg.level().chapters[0].x0 + 5200));
    await page.evaluate(() => { const a = window.__egg.adaptive(); a.enabled = true; a.reset(); });
    const trace = [];
    const t0 = Date.now();
    for (let i = 0; i < 28; i++) {
      await sleep(2000);
      const s = await st(page);
      trace.push(`${Math.round((Date.now() - t0) / 1000)}s dpr ${s.dpr} (view ${s.view.dpr}, canvas ${s.canvas.w}x${s.canvas.h}, ema ${s.adaptive.ema} ms)`);
      if (i % 3 === 2) console.log('  ' + trace[trace.length - 1]);
      if (s.adaptive.downs >= 4) break;
    }
    const a = await st(page);
    t.ok(a.adaptive.downs >= 1 || a.adaptive.ema < 24, `the frame time is either fine (${a.adaptive.ema} ms) or the dpr stepped down (${a.adaptive.downs} steps, now ${a.dpr})`);
    t.ok(a.adaptive.ups <= 1, `no oscillation (${a.adaptive.downs} downs, ${a.adaptive.ups} ups)`);
    t.ok(a.canvas.w === Math.round(844 * a.view.dpr) && a.canvas.h === Math.round(390 * a.view.dpr), `the canvas still equals the stage after a dpr change (${a.canvas.w}x${a.canvas.h})`);
    await sleep(700);
    await shot(page, 'perf-adaptive');
    await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  }

  /* ── 3. soak ── */
  console.log(`\n-- 3. soak: ${SOAK} s of wall time, 8x speed, autoplay (god + edge autopilot), drawn, with audio`);
  await page.evaluate(() => { window.__egg.teleport(window.__egg.level().checkpoints[1].x); window.__egg.setSpeed(8); });
  await page.evaluate(() => window.__egg.gc());
  await sleep(500);
  const rows = [];
  const w0 = Date.now();
  const sample = async () => {
    await page.evaluate(() => window.__egg.gc());
    const [h, s] = await Promise.all([page.evaluate(() => window.__egg.heap()), st(page)]);
    const row = { wall: Math.round((Date.now() - w0) / 1000), heapMB: +(h / 1048576).toFixed(1), chapter: s.chapter + 1, circuit: s.circuit, x: Math.round(s.mama.x), t: Math.round(s.t), voices: s.audio.voices, players: s.audio.players, errors: s.errors, song: s.audio.song, mode: s.mode,
      skips: await page.evaluate(() => window.__egg.auto.skips), decoded: await page.evaluate(() => window.__egg.renderer.stats.decoded), saved: s.stored ? `${s.stored.chapter}:${s.stored.flag}` : '-' };
    rows.push(row);
    console.log(`  wall ${String(row.wall).padStart(4)} s  sim ${String(row.t).padStart(5)} s  landscape ${String(row.chapter).padStart(2)}  x ${String(row.x).padStart(6)}  heap ${String(row.heapMB).padStart(5)} MB  voices ${row.voices} players ${row.players}  decoded paintings ${row.decoded}  save ${row.saved}  ${row.song}  skips ${row.skips} errors ${row.errors}`);
    return row;
  };
  await sample();
  while (Date.now() - w0 < SOAK * 1000) {
    await sleep(15000);
    const s = await st(page);
    if (s.mode !== 'playing') { console.log(`  (mode ${s.mode}: ${s.ui})`); if (s.ui === 'finish') { await page.evaluate(() => window.__egg.ui.hide()); } break; }
    await sample();
  }
  const first = rows[1] || rows[0], last = rows[rows.length - 1];
  const reachedChapters = new Set(rows.map((r) => r.chapter)).size;
  console.log(`  crossed ${reachedChapters} landscapes; heap after warm-up ${first.heapMB} MB -> ${last.heapMB} MB`);
  t.ok(rows.every((r) => r.errors === 0), 'no frame or handler errors during the soak');
  t.ok(rows.every((r) => r.players <= 3 && r.voices <= 150), 'audio players and voices stay bounded');
  t.ok(rows.every((r) => r.decoded <= 4), 'at most a few decoded paintings are ever held');
  t.ok(last.heapMB - first.heapMB < 12, `the JS heap is flat after warm-up (${first.heapMB} -> ${last.heapMB} MB)`);
  t.ok(last.chapter > 1 || last.circuit > 1 || SOAK < 60, `the loop carried on through landscape changes (reached landscape ${last.chapter}, circuit ${last.circuit})`);
  const errs = errors.filter((e) => !/favicon/.test(e));
  t.ok(errs.length === 0, 'no console / page errors', errs.slice(0, 5));
  await context.close();
  fails = t.done();
} catch (e) {
  console.error('\nUNCAUGHT:', e);
} finally { await browser.close(); server.stop(); }
process.exitCode = fails ? 1 : 0;
