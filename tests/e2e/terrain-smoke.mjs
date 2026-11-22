#!/usr/bin/env node
/*
 * Egg Mama — terrain art smoke test (Playwright + Chromium, run manually; NOT part of `node --test`).
 *
 *   node tests/e2e/terrain-smoke.mjs [--out <dir>]        (exit code 0 = all checks passed)
 *
 * Uses tools/terrain-sheet.html (the real art-terrain.mjs over the real backgrounds at 844x390 @ DPR 3) and checks:
 *   1. every landscape x scene (A ground+ledges, B crumble/lift/mover/ice, C hazards/springs/gate, D beacon, W water)
 *      renders without page errors and actually paints pixels over the painting;
 *   2. determinism: same scene twice, and again after a brand-new sprite cache, is pixel-identical;
 *   3. far-world exactness: the same platforms drawn 389 000 u from the origin match the near-origin render;
 *   4. cost: ms/frame on a busy screen, images stamped per frame (budget 150), and NO gradient/pattern creation
 *      in steady state (second pass over the same camera path);
 *   5. cache bounds: drawing all 13 landscapes through one cache keeps at most 4 landscapes of tiles/sprites alive;
 *      changing the cache scale rebuilds cleanly;
 *   6. ART-2: crumble (idle / rumble / fall) differs clearly from a safe ledge and from each other; ice differs from plain;
 *      a long island (40 000 u) costs about the same as a short one;
 *   7. platformPadding returns sane numbers for every kind (ground reaches T.killY).
 * Screenshots/temp files go to --out (default: $TMPDIR/terrain-smoke), never into the repo.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : process.argv[i + 1]; };
const out = arg('out', path.join(process.env.TMPDIR || '/tmp', 'terrain-smoke'));
fs.mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

let failures = 0, checks = 0;
const check = (name, fn) => { checks++; try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); } };

const { chromium } = require('playwright');
let browser;
try {
  await new Promise((r) => server.listen(20000 + Math.floor(Math.random() * 40000), '127.0.0.1', r));
  const port = server.address().port;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/willReadFrequently/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/tools/terrain-sheet.html`);
  await page.waitForFunction(() => window.sheetReady === true, null, { timeout: 15000 });
  const N = await page.evaluate(() => window.sheet.chapters);

  /* 1 ─ every landscape x scene renders and paints */
  console.log('1. render every landscape and scene');
  const lowCoverage = [];
  for (let ci = 0; ci < N; ci++) {
    for (const sc of ['A', 'B', 'C', ...(ci === 12 ? ['D'] : []), ...([2, 7].includes(ci) ? ['W'] : [])]) {
      const cov = await page.evaluate(([c, s]) => window.sheet.coverage(c, s), [ci, sc]);
      if (cov < (sc === 'D' ? 0.02 : 0.04)) lowCoverage.push(`${ci}/${sc}=${cov.toFixed(3)}`);
    }
  }
  check('no page errors while drawing everything', () => assert.deepEqual([...new Set(errors)], []));
  check('every scene paints a meaningful number of pixels', () => assert.deepEqual(lowCoverage, []));

  /* 2 ─ determinism */
  console.log('2. determinism');
  const det = await page.evaluate(async (n) => {
    const bad = [];
    for (let ci = 0; ci < n; ci++) {
      await window.sheet.render(ci, 'B', { t: 1.37 }); const a = await window.sheet.dataUrl();
      await window.sheet.render(ci, 'B', { t: 1.37 }); const b = await window.sheet.dataUrl();
      await window.sheet.resetCache();
      await window.sheet.render(ci, 'B', { t: 1.37 }); const c = await window.sheet.dataUrl();
      if (a !== b || a !== c) bad.push(ci);
    }
    return bad;
  }, N);
  check('same scene is pixel-identical on redraw and with a fresh cache (all landscapes)', () => assert.deepEqual(det, []));

  /* 3 ─ far world */
  console.log('3. far-world exactness (389 000 u from the origin)');
  const far = [];
  for (const ci of [0, 4, 8, 12]) far.push([ci, await page.evaluate(([c]) => window.sheet.farDiff(c, 'A', 389000), [ci])]);
  check('platforms drawn 389 000 u away match the near-origin render', () => {
    for (const [ci, d] of far) assert.ok(d.mean < 1.2 && d.badFraction < 0.01, `landscape ${ci}: mean diff ${d.mean.toFixed(3)}, bad fraction ${d.badFraction.toFixed(4)}`);
  });

  /* 4 ─ cost */
  console.log('4. cost');
  const perf = [];
  for (const ci of [0, 2, 5, 8, 9, 12]) { await page.evaluate((c) => window.sheet.perf(c, 60), ci); perf.push(await page.evaluate((c) => window.sheet.perf(c, 240), ci)); }
  console.log('     ' + perf.map((p) => `${p.ch}: ${p.msPerFrame} ms, ${p.stampsPerFrame} stamps`).join(' | '));
  check('busy screen (19 platforms) draws in < 8 ms/frame even on software raster', () => { for (const p of perf) assert.ok(p.msPerFrame < 8, `${p.ch}: ${p.msPerFrame} ms`); });
  check('stamps per frame stay far below the 150 budget', () => { for (const p of perf) assert.ok(p.stampsPerFrame < 60, `${p.ch}: ${p.stampsPerFrame}`); });
  check('steady state creates no gradients or patterns', () => { for (const p of perf) assert.ok(p.gradientsPerFrame === 0 && p.patternsPerFrame === 0, `${p.ch}: ${p.gradientsPerFrame} gradients, ${p.patternsPerFrame} patterns per frame`); });

  /* 5 ─ cache bounds, scale change */
  console.log('5. cache bounds and scale change');
  const cacheInfo = await page.evaluate(async () => {
    const TER = await import('/docs/js/art-terrain.mjs'); const { SpriteCache } = await import('/docs/js/artkit.mjs'); const { CHAPTERS } = await import('/docs/js/chapters.mjs');
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 600; const c = canvas.getContext('2d');
    const cache = new SpriteCache(); cache.setScale(3.25);
    const res = { maxChapters: 0, sizes: [] };
    for (let round = 0; round < 2; round++) for (let ci = 0; ci < CHAPTERS.length; ci++) {
      const ch = CHAPTERS[ci]; c.setTransform(3.25, 0, 0, 3.25, 0, 0);
      for (const kind of ['ground', 'ledge', 'crumble', 'lift', 'mover']) TER.drawPlatform(c, cache, { id: 3 + ci, kind, x: 10, y: 200, w: 200, h: kind === 'ground' ? 120 : 16, motion: kind === 'lift' ? { axis: 'y', amp: 30, period: 4 } : kind === 'mover' ? { axis: 'x', amp: 30, period: 4 } : undefined }, ch, 1);
      TER.drawSpikes(c, cache, { id: 1, x: 100, y: 200, w: 40 }, ch, 1); TER.drawSpring(c, cache, { x: 150, y: 200, bounceT: -9 }, ch, 1); TER.drawGate(c, cache, { x: 80, y: 200, chapter: ch, t: 1 });
      if (ch.beacon) TER.drawBeacon(c, cache, { x: 100, y: 200, lit: true, litT: 1, t: 1 });
      const st = TER.terrainCacheStats(cache); res.maxChapters = Math.max(res.maxChapters, st.chapters.length); res.sizes.push(cache.map.size);
    }
    const before = TER.terrainCacheStats(cache).tiles;
    cache.setScale(2.1);
    c.setTransform(2.1, 0, 0, 2.1, 0, 0);
    TER.drawPlatform(c, cache, { id: 9, kind: 'ground', x: 10, y: 200, w: 200, h: 120 }, CHAPTERS[0], 1);
    res.afterScale = TER.terrainCacheStats(cache); res.beforeTiles = before;
    const img = c.getImageData(30, 430, 1, 1).data; res.paintedAfterScale = img[3];
    return res;
  });
  check('at most 4 landscapes of tiles/sprites stay alive', () => assert.ok(cacheInfo.maxChapters <= 4, `kept ${cacheInfo.maxChapters}`));
  check('sprite count stays bounded over two full circuits', () => { const m = Math.max(...cacheInfo.sizes); assert.ok(m < 400, `max ${m} sprites`); assert.ok(cacheInfo.sizes[cacheInfo.sizes.length - 1] <= m); });
  check('changing the cache scale rebuilds cleanly and still paints', () => { assert.ok(cacheInfo.afterScale.tiles <= 3, `tiles after scale change: ${cacheInfo.afterScale.tiles}`); assert.ok(cacheInfo.paintedAfterScale > 0); });

  /* 6 ─ ART-2 and long islands */
  console.log('6. ART-2 distinctness, ice, very long island');
  const art = await page.evaluate(async () => {
    const TER = await import('/docs/js/art-terrain.mjs'); const { SpriteCache } = await import('/docs/js/artkit.mjs'); const { CHAPTERS } = await import('/docs/js/chapters.mjs');
    const W = 600, H = 300, canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; const c = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new SpriteCache(); cache.setScale(3.25);
    const shot = (ci, p, t = 1) => { c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#7ab'; c.fillRect(0, 0, W, H); c.setTransform(3.25, 0, 0, 3.25, 0, 0); TER.drawPlatform(c, cache, { cx: p.x, cy: p.y, pcx: p.x, pcy: p.y, h: 16, ...p }, CHAPTERS[ci], t); return c.getImageData(0, 0, W, H).data; };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) n++; return n / (a.length / 4); };
    const out = {};
    for (const ci of [0, 4, 8, 10]) {
      const base = { id: 7, x: 20, y: 60, w: 140 };
      const ledge = shot(ci, { ...base, kind: 'ledge' }), idle = shot(ci, { ...base, kind: 'crumble', state: 'idle', st: 0 });
      const rumble = shot(ci, { ...base, kind: 'crumble', state: 'rumble', st: 0.4 }), fall = shot(ci, { ...base, kind: 'crumble', state: 'fall', st: 0.5, cy: 60 + 20 });
      const ice = shot(ci, { ...base, kind: 'ledge', ice: true }), gice = shot(ci, { id: 7, kind: 'ground', x: 20, y: 60, w: 140, h: 120, ice: true }), g = shot(ci, { id: 7, kind: 'ground', x: 20, y: 60, w: 140, h: 120 });
      out[ci] = { ledgeVsCrumble: diff(ledge, idle), idleVsRumble: diff(idle, rumble), idleVsFall: diff(idle, fall), iceVsLedge: diff(ledge, ice), iceVsGround: diff(g, gice) };
    }
    // cost of a short vs a 40 000 u island (visible part only), average ms over 120 frames
    const timeIt = (w) => { const p = { id: 5, kind: 'ground', x: -20000, y: 240, w, h: 120, cx: -20000, cy: 240 }; const q = { ...p, x: 0, cx: 0, w: 300 };
      const run = (pl) => { c.setTransform(3.25, 0, 0, 3.25, 0, 0); for (let i = 0; i < 10; i++) TER.drawPlatform(c, cache, pl, CHAPTERS[0], i); c.getImageData(0, 0, 1, 1); const t0 = performance.now(); for (let i = 0; i < 120; i++) { c.setTransform(3.25, 0, 0, 3.25, -(pl.x + 1000 + i) * 3.25 + (pl.w > 5000 ? 0 : 0), 0); TER.drawPlatform(c, cache, pl, CHAPTERS[0], i); if (i % 20 === 19) c.getImageData(0, 0, 1, 1); } return (performance.now() - t0) / 120; };
      return run(w > 5000 ? p : q); };
    out.shortMs = timeIt(300); out.longMs = timeIt(40000);
    return out;
  });
  check('crumble differs clearly from a safe ledge in every skin family (shape, not just colour)', () => { for (const ci of [0, 4, 8, 10]) assert.ok(art[ci].ledgeVsCrumble > 0.04, `landscape ${ci}: ${art[ci].ledgeVsCrumble}`); });
  check('crumble idle / rumble / fall are visibly different states', () => { for (const ci of [0, 4, 8, 10]) assert.ok(art[ci].idleVsRumble > 0.002 && art[ci].idleVsFall > 0.03, `landscape ${ci}: ${JSON.stringify(art[ci])}`); });
  check('ice changes the look of ledges and ground', () => { for (const ci of [0, 4, 8, 10]) assert.ok(art[ci].iceVsLedge > 0.03 && art[ci].iceVsGround > 0.05, `landscape ${ci}: ${JSON.stringify(art[ci])}`); });
  check('a 40 000 u island costs about the same as a 300 u one', () => assert.ok(art.longMs < Math.max(1.5, art.shortMs * 3), `short ${art.shortMs.toFixed(2)} ms, long ${art.longMs.toFixed(2)} ms`));

  /* 7 ─ padding */
  console.log('7. platformPadding');
  const pad = await page.evaluate(async () => {
    const TER = await import('/docs/js/art-terrain.mjs'); const { T } = await import('/docs/js/tuning.mjs');
    const r = {}; for (const kind of ['ground', 'ledge', 'crumble', 'lift', 'mover']) r[kind] = TER.platformPadding({ kind, x: 0, y: 200, w: 100, h: kind === 'ground' ? 100 : 16, motion: { amp: 60 } });
    return { r, killY: T.killY };
  });
  check('padding is finite, non-negative and ground art reaches the kill line', () => {
    for (const [k, p] of Object.entries(pad.r)) for (const side of ['left', 'right', 'top', 'bottom']) assert.ok(Number.isFinite(p[side]) && p[side] >= 0, `${k}.${side}=${p[side]}`);
    assert.ok(200 + 100 + pad.r.ground.bottom >= pad.killY);
    assert.ok(pad.r.lift.top >= 120);
  });

  /* 7b ─ the DESIGN.md §5 contract: names and parameter shapes the renderer codes against */
  const api = await page.evaluate(async () => {
    const TER = await import('/docs/js/art-terrain.mjs');
    return Object.fromEntries(Object.entries(TER).map(([k, v]) => [k, typeof v === 'function' ? v.length : typeof v]));
  });
  check('exports exactly the DESIGN.md names with the documented arity', () => {
    const want = { drawPlatform: 4, drawSpikes: 4, drawSpring: 4, drawGate: 3, drawBeacon: 3, drawWater: 2, platformPadding: 1 };   // trailing params are defaulted (t, alpha, warn)
    for (const [k, n] of Object.entries(want)) assert.equal(api[k], n, `${k} has arity ${api[k]}, DESIGN wants ${n} leading params`);
  });

  /* 8 ─ audit regressions: soft glow ends in dark landscapes, ledge ends stay inside the slab */
  console.log('8. audit regressions');
  const reg = await page.evaluate(async () => {
    const TER = await import('/docs/js/art-terrain.mjs'); const { SpriteCache } = await import('/docs/js/artkit.mjs'); const { CHAPTERS } = await import('/docs/js/chapters.mjs');
    const out = {};
    // (a) the glow above a dark landscape's ground has no hard vertical edge at the island's end
    {
      const S = 2, W = 700, H = 500, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d', { willReadFrequently: true });
      const cache = new SpriteCache(); cache.setScale(S);
      c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#10103a'; c.fillRect(0, 0, W, H); c.setTransform(S, 0, 0, S, 0, 0);
      TER.drawPlatform(c, cache, { id: 5, kind: 'ground', x: 60, y: 150, w: 200, h: 120, cx: 60, cy: 150 }, CHAPTERS[8], 1);
      const lum = (ux, uy) => { const d = c.getImageData(Math.round(ux * S), Math.round(uy * S), 1, 1).data; return d[0] + d[1] + d[2]; };
      const med = (a) => a.sort((x, y) => x - y)[a.length >> 1], bg = lum(300, 100), mid = med(Array.from({ length: 31 }, (_, i) => lum(100 + i * 4, 144))), left = [lum(60 - 3, 144), lum(60 + 3, 144)], right = [lum(260 - 3, 144), lum(260 + 3, 144)];
      out.glow = { bg, mid, left, right, ratioL: Math.abs(left[1] - left[0]) / Math.max(1, mid - bg), ratioR: Math.abs(right[1] - right[0]) / Math.max(1, mid - bg) };
    }
    // (b) no ledge geometry pokes out past the slab's ends (barbs): record every x passed to the path calls (drawing is in platform-local coordinates)
    {
      const S = 2, cv = document.createElement('canvas'); cv.width = 600; cv.height = 300; const real = cv.getContext('2d');
      const skins = [[1, 'plank'], [2, 'log'], [4, 'stone'], [8, 'crystal'], [9, 'ice'], [11, 'brick'], [12, 'cloud']];
      const bad = [];
      for (const [ci, name] of skins) for (const w of [36, 51, 54, 57, 70, 83, 97, 111]) for (const kind of ['ledge', 'lift', 'mover']) {
        const cache = new SpriteCache(); cache.setScale(S);
        let lo = Infinity, hi = -Infinity;
        const rec = (k, a) => { if (k === 'lineTo' || k === 'moveTo') { lo = Math.min(lo, a[0]); hi = Math.max(hi, a[0]); } else if (k === 'quadraticCurveTo') { for (const x of [a[0], a[2]]) { lo = Math.min(lo, x); hi = Math.max(hi, x); } } };
        const ctx = new Proxy(real, { get(t, k) { const v = t[k]; return typeof v === 'function' ? (...a) => { rec(k, a); return v.apply(t, a); } : v; }, set(t, k, v) { t[k] = v; return true; } });
        real.setTransform(S, 0, 0, S, 0, 0);
        const p = { id: 9 + w, kind, x: 100, y: 100, w, h: 16, cx: 100, cy: 100, motion: kind === 'lift' ? { axis: 'y', amp: 0, period: 4 } : kind === 'mover' ? { axis: 'x', amp: 0, period: 4 } : undefined };
        TER.drawPlatform(ctx, cache, p, CHAPTERS[ci], 1);
        // the platform may legitimately overhang by its own outline; the gantry / rail of lifts and movers are not slab geometry
        if (kind === 'ledge' && (lo < -2.5 || hi > w + 2.5)) bad.push(`${name} w=${w}: path x ${lo.toFixed(1)}..${hi.toFixed(1)} (slab 0..${w}, local coordinates)`);
      }
      out.barbs = bad;
    }
    return out;
  });
  check('dark-landscape ground glow ends softly (no hard vertical edge at the island ends)', () => {
    assert.ok(reg.glow.mid - reg.glow.bg > 20, `glow barely visible: ${JSON.stringify(reg.glow)}`);
    assert.ok(reg.glow.ratioL < 0.55 && reg.glow.ratioR < 0.55, `hard glow edge: ${JSON.stringify(reg.glow)}`);
  });
  check('ledge teeth / scallops never poke out past the slab ends', () => assert.deepEqual(reg.barbs, []));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
