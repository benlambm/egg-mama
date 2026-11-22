#!/usr/bin/env node
/*
 * Egg Mama — renderer demo (dev only). Boots the REAL Renderer on a real canvas in Chromium, drives it with the real sim
 * and saves screenshots you can look at.
 *
 *   node tools/render-demo.mjs --out <dir> [--viewport iphone|pixel|small|tablet|WxH@dpr] [--world gen|hand]
 *                              [--scenes meadow,dissolve50,...|all] [--seed 12345] [--reduced] [--perf [--perf-scenes a,b]]
 *
 * viewports   iphone 844x390 @3 (safe-area insets 0/47/21/47)   pixel 915x412 @2.625   small 640x300 @2   tablet 1024x768 @2 (4:3)
 * world       gen  = levelgen.generateLevel({circuit:1, seed}) (falls back to the hand-made world if it cannot be imported)
 *             hand = tools/render-demo-world.mjs (7 landscapes, one of everything)
 * It serves the repo root on a random port, uses ONE browser, and always closes both when it finishes.
 * Scene names: see `scenes` in tools/render-demo.html.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

export const VIEWPORTS = {
  iphone: { w: 844, h: 390, dpr: 3, insets: { top: 0, right: 47, bottom: 21, left: 47 } },
  pixel: { w: 915, h: 412, dpr: 2.625, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  small: { w: 640, h: 300, dpr: 2, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  tablet: { w: 1024, h: 768, dpr: 2, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
};
export function parseViewport(s) {
  if (VIEWPORTS[s]) return VIEWPORTS[s];
  const m = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(s || '');
  if (!m) return VIEWPORTS.iphone;
  return { w: +m[1], h: +m[2], dpr: m[3] ? +m[3] : 2, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
}

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json' };
export function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    const tryListen = () => {
      const port = 20000 + Math.floor(Math.random() * 40000);
      server.once('error', tryListen);
      server.listen(port, '127.0.0.1', () => { server.off('error', tryListen); resolve({ server, port }); });
    };
    tryListen();
  });
}

/** Open the demo page at a viewport and run demo.setup(). Returns { page, info }. */
export async function openDemo(browser, port, vp, { world = 'gen', seed = 12345, errors = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/tools/render-demo.html`);
  await page.waitForFunction(() => window.demoReady === true, null, { timeout: 20000 });
  const info = await page.evaluate((o) => window.demo.setup(o), { world, seed, cssW: vp.w, cssH: vp.h, dpr: vp.dpr, insets: vp.insets });
  return { page, ctx, info };
}

async function main() {
  const out = arg('out', path.join(process.env.TMPDIR || '/tmp', 'render-demo'));
  const vp = parseViewport(String(arg('viewport', 'iphone')));
  const world = String(arg('world', 'gen'));
  const seed = Number(arg('seed', 12345));
  const reduced = !!arg('reduced', false);
  let wanted = String(arg('scenes', 'meadow,dissolve50,fogwood,caverns,frostline,beaconLit,hatch,hit,checkpoint,title,dead'));
  fs.mkdirSync(out, { recursive: true });
  const { server, port } = await startServer();
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    const errors = [];
    const { page, info } = await openDemo(browser, port, vp, { world, seed, errors });
    console.log('world', JSON.stringify(info));
    if (wanted === 'all') wanted = await page.evaluate(() => Object.keys(window.demo.scenes).join(','));
    if (reduced) await page.evaluate(() => window.demo.setReduced(true));
    for (const name of wanted.split(',').filter(Boolean)) {
      const t0 = Date.now();
      const r = await page.evaluate((n) => window.demo.scene(n), name);
      const file = path.join(out, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`${name.padEnd(14)} ${Date.now() - t0} ms  ${JSON.stringify({ x: r.x, t: r.t, status: r.status, events: r.events ? [...new Set(r.events.map((e) => e.type))].join(',') : '' })}  -> ${file}`);
    }
    if (arg('perf', false)) {
      // ms per frame: JS only, and JS + software rasterisation (a 1-px read-back forces the flush); then the cost of each
      // layer ALONE above an empty frame (the machine is shared, so every number is the best of several short runs).
      for (const name of String(arg('perf-scenes', 'meadow,fogwood,caverns,frostline')).split(',')) {
        await page.evaluate((n) => window.demo.scene(n), name);
        const r = await page.evaluate(() => {
          const L = window.demo.renderer.layers, keys = Object.keys(L), out = {};
          const all = window.demo.benchBest(20, 6);
          keys.forEach((k) => { L[k] = false; }); out.none = window.demo.benchBest(20, 6).flushMean;
          for (const k of keys) { keys.forEach((q) => { L[q] = false; }); L[k] = true; out[k] = +(window.demo.benchBest(20, 5).flushMean - out.none).toFixed(1); }
          keys.forEach((k) => { L[k] = true; });
          return { js: all.jsMean, raster: all.flushMean, stats: all.stats, layers: out };
        });
        const layers = Object.entries(r.layers).filter(([k]) => k !== 'none').map(([k, v]) => `${k} ${v}`).join(' | ');
        console.log(`perf ${name.padEnd(10)} js ${r.js} ms, js+raster ${r.raster} ms (empty frame ${r.layers.none.toFixed(1)}), ${r.stats.platforms} platforms / ${r.stats.pickups} pickups\n     alone: ${layers}`);
      }
    }
    if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
