#!/usr/bin/env node
/*
 * Egg Mama — terrain contact-sheet tool (dev only).
 *
 * Renders sample scenes of every art-terrain.mjs export over the real pixel-art backgrounds at
 * iPhone 13 landscape scale (844x390 CSS px, DPR 3 => 2532x1170 px images) with Playwright/Chromium,
 * and measures drawing cost. Look at the PNGs (they are the point), then fix the art.
 *
 *   node tools/terrain-sheet.mjs --out <dir> [--chapters 0,1,..|all] [--scenes A,B,C,D,W] [--perf]
 *                                [--montage] [--zoom "x,y,w,h"] (zoom: crop box in CSS px, saved as <name>-zoom.png)
 *
 * Scenes:  A ground islands + ledges   B crumble (idle / rumble / fall / reform ghost), lift, mover, ice
 *          C spikes (plain + cycling in 3 states), springs (rest / compress / rebound), landmark arch
 *          D beacon (unlit, flare, lit)   W water band with logs/islands (water chapters)
 * `--perf` prints ms/frame and images stamped per frame for a busy screen, and the first-frame (warm-up) cost.
 * It starts its own static file server on a random port and always closes the browser and the server.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

const out = arg('out', path.join(process.env.TMPDIR || '/tmp', 'terrain-sheet'));
const wantScenes = String(arg('scenes', 'A,B,C')).split(',');
const chArg = String(arg('chapters', 'all'));
const doPerf = !!arg('perf', false);
const zoom = arg('zoom', null);
fs.mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

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
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/tools/terrain-sheet.html`);
  await page.waitForFunction(() => window.sheetReady === true, null, { timeout: 15000 });
  const n = await page.evaluate(() => window.sheet.chapters);
  const chapters = chArg === 'all' ? [...Array(n).keys()] : chArg.split(',').map(Number);
  const names = await page.evaluate(() => 0);
  const files = [];
  for (const ci of chapters) {
    for (const sc of wantScenes) {
      if (sc === 'D' && ci !== 12) continue;
      if (sc === 'W' && ![2, 7].includes(ci)) continue;
      await page.evaluate(([c, s]) => window.sheet.render(c, s), [ci, sc]);
      const file = path.join(out, `ch${String(ci).padStart(2, '0')}-${sc}.png`);
      const data = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
      fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      files.push(file);
      if (zoom && zoom !== true) {
        const [x, y, w, h] = zoom.split(',').map(Number);
        const zf = file.replace('.png', '-zoom.png');
        await page.screenshot({ path: zf, clip: { x, y, width: w, height: h } });
      }
    }
  }
  if (doPerf) {
    for (const ci of chapters) {
      const warm = await page.evaluate((c) => window.sheet.warm(c), ci);
      const r = await page.evaluate((c) => window.sheet.perf(c), ci);
      console.log(JSON.stringify({ ...r, ...warm }));
    }
  }
  if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
  console.log(files.join('\n'));
} finally {
  if (browser) await browser.close();
  server.close();
}
