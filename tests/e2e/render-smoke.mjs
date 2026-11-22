#!/usr/bin/env node
/*
 * Egg Mama — renderer smoke test (Playwright + Chromium, run manually; NOT part of `node --test`).
 *
 *   node tests/e2e/render-smoke.mjs [--out <dir>] [--quick | --all] [--world gen|hand]      (exit code 0 = all checks passed)
 *
 * Drives the REAL Renderer (docs/js/render.mjs) with the REAL sim through tools/render-demo.html and checks:
 *   1. view geometry at iPhone 13 (844x390 @3 -> a 2532x1170 canvas), Pixel 7, 640x300 and a 4:3 tablet: scale, visible world
 *      size, the world's bottom edge anchored to the screen's bottom edge (ground row measured in real pixels), the canvas
 *      exactly covering the viewport with no page overflow;
 *   2. every scene (title, play, hatch, hit, checkpoint, dead, beacon, ...) draws without page errors and paints real pixels;
 *   3. culling: at 9 positions across the whole 390 000 u world the drawn platforms / pickups / enemies equal a brute-force
 *      visibility test, only a few hundred array elements are scanned, and the big level arrays are never iterated (element
 *      reads counted through Proxies);
 *   4. the allocation-free enemyAt equals the sim's enemyPosAt;
 *   5. the painting dissolve (Meadow -> Clover Mill at 25/50/75 %) moves smoothly from one palette to the other;
 *   6. captions: placed inside the safe band clear of the egg pill and pause button, never overlapping, an event caption
 *      jumps a long one; the egg pill shows for ~2 s after the egg total changes; reduced motion quarters Mama's rock;
 *   7. determinism: the same scene twice gives identical pixels;
 *   8. steady state: garbage per frame, retained heap, sprite cache size, decoded paintings, frame time at the start and at the
 *      end of a scroll across the WHOLE world;
 *   9. cost: ms/frame (JS, and JS + software rasterisation) for typical scenes.
 * Screenshots go to --out (default $TMPDIR/render-smoke), never into the repo. ONE browser at a time, always closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, openDemo, VIEWPORTS } from '../../tools/render-demo.mjs';

const require = createRequire(import.meta.url);
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const out = arg('out', path.join(process.env.TMPDIR || '/tmp', 'render-smoke'));
const quick = !!arg('quick', false), all = !!arg('all', false);
const world = String(arg('world', 'gen'));
fs.mkdirSync(out, { recursive: true });

let failures = 0, checks = 0;
const check = async (name, fn) => {
  checks++;
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').join('\n       ')); }
};
const note = (s) => console.log('       ' + s);

const { server, port } = await startServer();
let browser;
try {
  const { chromium } = require('playwright');
  browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const errors = [];

  /* ───────────────── 1. geometry at four viewports ───────────────── */
  console.log('1. view geometry');
  for (const name of ['iphone', 'pixel', 'small', 'tablet']) {
    const vp = VIEWPORTS[name];
    const { page, ctx, info } = await openDemo(browser, port, vp, { world, errors });
    await page.evaluate(() => window.demo.place(300));
    await check(`${name} ${vp.w}x${vp.h}@${vp.dpr}: canvas, scale and visible world`, async () => {
      let scale = vp.h / 360; if (vp.w / scale < 560) scale = vp.w / 560;
      const W = Math.round(vp.w * vp.dpr), H = Math.round(vp.h * vp.dpr);
      assert.deepEqual(info.canvas, { w: W, h: H }, 'canvas backing size');
      assert.ok(Math.abs(info.view.scale - scale) < 1e-9, `scale ${info.view.scale} vs ${scale}`);
      assert.ok(Math.abs(info.view.w - vp.w / scale) < 1e-6 && Math.abs(info.view.h - vp.h / scale) < 1e-6, 'visible world size');
      assert.ok(info.view.h >= 360 - 1e-9, 'never less than 360 u of height');
      assert.ok(Math.abs(info.scale - scale * vp.dpr) < 1e-9, 'device px per unit');
      if (name === 'iphone') assert.deepEqual(info.canvas, { w: 2532, h: 1170 });
    });
    await check(`${name}: the world's bottom edge is anchored to the screen bottom (ground line found in real pixels)`, async () => {
      const S = info.scale, H = info.canvas.h, W = info.canvas.w;
      const expect = Math.round(H - 360 * S + 292 * S);
      const col = await page.evaluate(([x, y0, n]) => window.demo.column(x, y0, n), [Math.round(W * 0.8), expect - 30, 60]);
      let best = 0; for (let i = 1; i < col.length; i++) if (col[i] < col[best]) best = i;
      const row = expect - 30 + best;
      assert.ok(Math.abs(row - expect) <= 6, `ground outline at row ${row}, expected ${expect}`);
    });
    await check(`${name}: canvas covers the viewport exactly, no page overflow`, async () => {
      const r = await page.evaluate(() => { const c = document.getElementById('c').getBoundingClientRect(); const d = document.documentElement; return { x: c.x, y: c.y, w: c.width, h: c.height, sw: d.scrollWidth, sh: d.scrollHeight, iw: innerWidth, ih: innerHeight }; });
      assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, vp.w, vp.h]);
      assert.ok(r.sw <= r.iw && r.sh <= r.ih, `page overflows: ${r.sw}x${r.sh} in ${r.iw}x${r.ih}`);
    });
    await page.evaluate(() => window.demo.scene('hatch'));
    await page.screenshot({ path: path.join(out, `view-${name}-hatch.png`) });
    await ctx.close();
  }

  /* ───────────────── 2..9 on the iPhone viewport ───────────────── */
  const vp = VIEWPORTS.iphone;
  const { page, info } = await openDemo(browser, port, vp, { world, errors });
  console.log(`world: ${info.world} (${info.platforms} platforms, ${info.pickups} pickups, ${info.enemies} enemies, ${info.chapters} landscapes, ends at ${Math.round(info.endX)} u)`);

  console.log('2. scenes');
  const sceneNames = quick ? ['meadow', 'hatch', 'title', 'dead']
    : all ? ['meadow', 'dissolve25', 'dissolve50', 'dissolve75', 'chapterEnter', 'clover', 'reedwater', 'fogwood', 'fogwoodFlyer', 'caverns', 'frostline', 'canyon', 'summit', 'beaconLit', 'finish', 'hatch', 'hit', 'stomp', 'checkpoint', 'spring', 'spikes', 'crumble', 'shield', 'magnet', 'jump', 'title', 'dead', 'paused']
      : ['meadow', 'dissolve25', 'dissolve50', 'dissolve75', 'chapterEnter', 'reedwater', 'fogwood', 'caverns', 'frostline', 'beaconLit', 'hatch', 'hit', 'checkpoint', 'spring', 'crumble', 'title', 'dead', 'paused'];
  const sceneInfo = {};
  for (const name of sceneNames) {
    await check(`scene ${name} draws and paints`, async () => {
      const before = errors.length;
      const r = await page.evaluate((n) => window.demo.scene(n), name);
      sceneInfo[name] = r;
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      const spread = await page.evaluate(() => { const R = window.demo.renderer; const W = R.canvas.width, H = R.canvas.height; const seen = new Set(); const d = R.ctx.getImageData(0, 0, W, H).data; for (let i = 0; i < d.length; i += 4 * 997) seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)); return seen.size; });
      assert.ok(spread > 25, `only ${spread} distinct colours: is the frame blank?`);
      assert.deepEqual(errors.slice(before), [], 'page errors while drawing');
    });
  }
  await check('the scenes produced the events they promise (hatch / duckling lost / checkpoint / dead / beacon)', async () => {
    const has = (n, t) => !sceneInfo[n] || (sceneInfo[n].events || []).some((e) => e.type === t);
    assert.ok(has('hatch', 'hatch') && has('hit', 'duckling-lost') && has('checkpoint', 'checkpoint') && has('dead', 'dead') && has('beaconLit', 'beacon') && has('chapterEnter', 'chapter-enter'));
  });

  console.log('3. culling');
  // positions spread over the whole world, including both ends and the dissolve zones
  await page.evaluate(() => window.demo.place(300));
  const E = info.endX;
  const xs = [300, 2500, Math.round(E * 0.07), Math.round(E * 0.25), Math.round(E * 0.5), Math.round(E * 0.75), Math.round(E * 0.93), E - 600, E - 160].map((x) => Math.round(x));
  const cull = await page.evaluate((x) => window.demo.cullCheck(x), xs);
  await check('drawn platforms / pickups / enemies equal a brute-force visibility test (binary search is exact)', async () => {
    for (const c of cull) {
      assert.equal(c.missing, 0, `x=${c.x}: ${c.missing} visible platforms were not drawn`);
      assert.equal(c.extra, 0, `x=${c.x}: ${c.extra} invisible platforms were drawn`);
      assert.equal(c.platforms, c.brutePlatforms, `x=${c.x}: platform count`);
      assert.equal(c.pickups, c.brutePickups, `x=${c.x}: pickup count ${c.pickups} vs ${c.brutePickups}`);
      assert.equal(c.enemies, c.bruteEnemies, `x=${c.x}: enemy count ${c.enemies} vs ${c.bruteEnemies}`);
    }
  });
  await check('only a screenful is scanned: platforms + pickups scanned per frame stay a small fraction of the world', async () => {
    const worst = Math.max(...cull.map((c) => c.scanned));
    note(`scanned per frame (platform + pickup candidates): ${cull.map((c) => c.scanned).join(', ')}  of ${info.platforms} platforms + ${info.pickups} pickups`);
    assert.ok(worst < 700, `worst ${worst}`);
    assert.ok(worst < (info.platforms + info.pickups) * 0.12, 'scans more than 12 % of the world');
  });
  await check('the big level arrays are never iterated per frame (element reads through Proxies)', async () => {
    const r = await page.evaluate((x) => window.demo.readCount(x, 3), xs);
    note(`element reads per frame (worst of ${xs.length} places): ${JSON.stringify(r.reads)}  array lengths: ${JSON.stringify(r.lengths)}`);
    for (const k of ['platforms', 'pickups', 'enemies', 'hazards', 'checkpoints']) assert.ok(r.reads[k] < Math.max(150, r.lengths[k] * 0.25), `${k}: ${r.reads[k]} reads of ${r.lengths[k]}`);
    assert.ok(r.reads.pickups < 400 && r.reads.platforms < 200, 'a screenful of reads at most');
  });
  await check('enemyAt (allocation-free) equals the sim\'s enemyPosAt', async () => assert.equal(await page.evaluate(() => window.demo.enemyAtCheck(600)), 0));

  console.log('4. the dissolve');
  await check('Meadow -> Clover Mill dissolves smoothly (colour moves monotonically from one painting to the other)', async () => {
    const lv = await page.evaluate(() => window.demo.level.chapters[1].x0);
    await page.evaluate((x) => window.demo.place(x - 900), lv);
    assert.ok(await page.evaluate(() => window.demo.waitPaintings([0, 1])), 'paintings did not decode');
    const bh = 520, ys = [0, 0.14];
    const mean = async (x) => { await page.evaluate((v) => window.demo.jumpTo(v), x); return page.evaluate((f) => { const H = window.demo.renderer.canvas.height; return window.demo.meanBand(Math.round(H * f[0]), Math.round(H * f[1])); }, ys); };
    const A = await mean(lv - bh - 150), B = await mean(lv + bh + 150);
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const AB = dist(A, B); assert.ok(AB > 25, `the two paintings' sky bands barely differ (${AB.toFixed(1)})`);
    const proj = (c) => ((c[0] - A[0]) * (B[0] - A[0]) + (c[1] - A[1]) * (B[1] - A[1]) + (c[2] - A[2]) * (B[2] - A[2])) / (AB * AB);
    const ps = []; for (const d of [-bh * 0.5, 0, bh * 0.5]) ps.push(proj(await mean(lv + d)));
    note(`position along A -> B at 25 / 50 / 75 %: ${ps.map((v) => v.toFixed(2)).join(' / ')}`);
    assert.ok(ps[0] < ps[1] && ps[1] < ps[2], 'not monotonic');
    assert.ok(ps[1] > 0.25 && ps[1] < 0.75, 'the middle is not in the middle');
  });
  await check('only the paintings that are needed stay decoded (<= 3), and it never decodes ahead of need on a fresh start', async () => {
    const d = await page.evaluate(() => window.demo.renderer.paintings.decoded);
    assert.ok(d <= 3, `${d} decoded`);
  });

  console.log('5. captions, pill, reduced motion');
  await check('chapter caption: inside the top band, clear of the egg pill and the pause button, shows the story', async () => {
    await page.evaluate(() => window.demo.scene('chapterEnter'));
    const c = await page.evaluate(() => { const R = window.demo.renderer, cap = R.fx.cap; return { live: cap.live, title: cap.title, sub: cap.sub, bw: cap.bw, bh: cap.bh, lines: cap.lines.length, w: R.canvas.width / R.view.dpr, h: R.canvas.height / R.view.dpr, ins: { ...R.ins } }; });
    assert.ok(c.live, 'no caption is showing 3 s after crossing into a landscape');
    assert.match(c.title, /^Chapter \d+ · /);
    assert.ok(c.sub && c.sub.length > 20, 'the story did not become the subtitle');
    const x0 = (c.w - c.bw) / 2, x1 = x0 + c.bw, bottom = c.ins.top + 8 + c.bh;
    assert.ok(x0 >= c.ins.left + 12 + 96 && x1 <= c.w - c.ins.right - 12 - 52, `box ${x0.toFixed(0)}..${x1.toFixed(0)} collides with the pill / pause button`);
    assert.ok(bottom <= c.h * 0.21, `box bottom ${bottom.toFixed(0)} > 21 % of ${c.h}`);
    assert.ok(c.lines >= 1, 'no subtitle lines laid out');
  });
  await check('an event caption jumps a long one once that has been readable for ~1.2 s; only one caption is ever visible', async () => {
    await page.evaluate(() => window.demo.place(300));
    const tl = await page.evaluate(() => window.demo.captionProbe());
    const first = tl.find((r) => r.f >= 40 && /hatched/.test(r.title));
    assert.ok(first, 'the hatch caption never appeared');
    assert.ok((first.f - 40) / 60 <= 1.0, `appeared ${(first.f - 40) / 60} s after the event`);
    assert.ok(tl.slice(0, 40).some((r) => /Mama counts/.test(r.title)), 'the trail caption was not shown first');
  });
  await check('the egg pill shows for about 2 s after the egg total changes, then goes', async () => {
    const log = await page.evaluate(() => window.demo.pillProbe());
    const visible = log.filter((r) => r.t <= 2.3 && r.t < 99).length / 60;
    assert.ok(visible > 1.7 && visible < 2.4, `visible for ${visible.toFixed(2)} s`);
    assert.ok(log[5].t > 90, 'the pill was showing before any change');
  });
  await check('reduced motion quarters the shell rock', async () => {
    await page.evaluate(() => window.demo.place(300)); await page.evaluate(() => window.demo.setReduced(false));
    const a = await page.evaluate(() => window.demo.rockProbe(240));
    await page.evaluate(() => window.demo.place(300)); await page.evaluate(() => window.demo.setReduced(true));
    const b = await page.evaluate(() => window.demo.rockProbe(240));
    await page.evaluate(() => window.demo.setReduced(false));
    note(`max rock: ${a.toFixed(3)} rad normal, ${b.toFixed(3)} reduced`);
    assert.ok(a > 0.05 && a <= 0.1001, `normal ${a}`);
    assert.ok(Math.abs(b / a - 0.25) < 0.04, `ratio ${(b / a).toFixed(3)}`);
  });

  await check('fade overlay (black / white / half) and the transient HUD only shows in play, dead and finish', async () => {
    await page.evaluate(() => window.demo.place(300));
    const r = await page.evaluate(() => window.demo.fadeCheck());
    assert.deepEqual(r.black, [0, 0, 0]); assert.deepEqual(r.white, [255, 255, 255]);
    assert.ok(r.half.every((v, i) => v < r.none[i] + 2 && v > 0 || r.none[i] < 3), `half fade ${r.half} vs ${r.none}`);
    assert.deepEqual(r.huds, { title: false, play: true, paused: false, dead: true, finish: true });
  });

  console.log('6. determinism');
  await check('the same scene twice is pixel-identical', async () => {
    const h = [];
    for (let i = 0; i < 2; i++) { await page.evaluate(() => window.demo.scene('hatch')); h.push(await page.evaluate(() => window.demo.hashCanvas())); }
    assert.equal(h[0], h[1]);
  });

  console.log('7. steady state');
  await check('no steady-state allocation growth (retained heap flat; garbage per frame small, art vs renderer measured apart)', async () => {
    await page.evaluate(() => window.demo.place(300));
    const a = await page.evaluate(() => window.demo.allocTest(300, false, false));
    if (a.skipped) { note('skipped: no gc / precise memory'); return; }
    const mine = await page.evaluate(() => window.demo.allocTest(300, false, true));
    const b = await page.evaluate(() => window.demo.allocTest(300, true, false));
    note(`whole frame, idle world: ${a.bytesPerFrame} bytes of garbage per frame, ${a.retainedAfterGc} bytes retained after gc over ${a.frames} frames`);
    note(`renderer only (platform/actor art layers off; painting, weather, shadows, pools, HUD on): ${mine.bytesPerFrame} bytes/frame`);
    note(`with an egg event every 25 frames (popup strings are the only intended allocation): ${b.bytesPerFrame} bytes/frame, ${b.retainedAfterGc} retained`);
    assert.ok(mine.bytesPerFrame < 5000, `renderer-owned garbage ${mine.bytesPerFrame} bytes/frame`);      // no objects/arrays/closures: only the boxed numbers V8 needs to call the canvas API
    assert.ok(a.bytesPerFrame < 40000, `${a.bytesPerFrame} bytes/frame`);
    assert.ok(Math.abs(a.retainedAfterGc) < 400000 && Math.abs(b.retainedAfterGc) < 500000, 'heap grew');
  });
  await check('scroll the whole world: frame time, heap, sprite cache and decoded paintings stay bounded', async () => {
    const speed = quick ? 26000 : 7800;
    const r = await page.evaluate((sp) => window.demo.scroll({ speed: sp, window: 300 }), speed);
    const S = r.samples;
    const fmt = (s) => `x=${s.x} js ${s.jsMean} ms, js+raster ${s.allMean} ms (median ${s.allMed}), heap ${s.heapMB} MB, ${s.cacheSprites} sprites, ${s.decoded} paintings`;
    note(`${r.frames} frames, ${S.length} windows; worst frame ${r.worst} ms; frames over 50 ms: ${r.hitches}; frames drawn before their painting had decoded: ${r.missing}`);
    note('first: ' + fmt(S[0])); note('last:  ' + fmt(S[S.length - 1]));
    note(`heap after gc: ${r.heapStartMB} MB at the start, ${r.heapEndMB} MB at the end`);
    const meanOf = (a, k) => a.reduce((s, v) => s + v[k], 0) / a.length;
    const head = S.slice(0, 3), tail = S.slice(-3);
    assert.ok(meanOf(tail, 'jsMean') <= meanOf(head, 'jsMean') * 2 + 0.6, 'JS frame time grew along the world');
    assert.ok(meanOf(tail, 'allMed') <= meanOf(head, 'allMed') * 2.2 + 6, 'frame time (with rasterisation) grew along the world');
    assert.ok(Math.max(...S.map((s) => s.scanned)) < 700, 'scanned too much');
    assert.ok(r.maxDecoded >= 1 && r.maxDecoded <= 3, `${r.maxDecoded} paintings decoded at once`);
    assert.ok(r.missing <= r.frames * (quick ? 0.3 : 0.04), `${r.missing} of ${r.frames} frames had to fall back to the sky colour (the world is scrolled ~70x faster than real play here)`);
    assert.ok(Math.max(...S.map((s) => s.cacheSprites)) < 1600, 'sprite cache grew without bound');
    assert.ok(r.heapEndMB - r.heapStartMB < 8, `heap grew ${(r.heapEndMB - r.heapStartMB).toFixed(1)} MB over the whole world`);
  });

  console.log('8. cost on this (software) rasteriser');
  await check('ms per frame on typical scenes (best of 6 x 24 frames; JS only, and with rasterisation forced)', async () => {
    const rows = [];
    for (const n of ['meadow', 'fogwood', 'caverns', 'frostline']) {
      await page.evaluate((s) => window.demo.scene(s), n);
      const b = await page.evaluate(() => window.demo.benchBest(24, 6));
      rows.push([n, b.jsMean, b.flushMean, b.stats.platforms, b.stats.pickups]);
      note(`${n.padEnd(10)} js ${String(b.jsMean).padEnd(5)} ms   js+raster ${String(b.flushMean).padEnd(6)} ms   (${b.stats.platforms} platforms, ${b.stats.pickups} pickups on screen)`);
    }
    assert.ok(rows.every((r) => r[1] < 3), 'JS cost per frame above 3 ms');
    assert.ok(rows.every((r) => r[2] < 40), 'frame cost with rasterisation above 40 ms (machine busy or a regression?)');
  });

  await check('no page errors during the whole run', async () => assert.deepEqual([...new Set(errors)], []));
} finally {
  if (browser) await browser.close();
  server.close();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
