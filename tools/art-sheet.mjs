#!/usr/bin/env node
/*
 * Egg Mama — actor art contact sheets (dev tool; nothing here ships).
 *
 * Renders every ACTORS animation frame (docs/js/art-actors.mjs) at the REAL phone scale — iPhone 13 landscape,
 * 844x390 CSS px at DPR 3 => 3.25 device px per world unit, so a 2532x1170 PNG is one phone frame — composited over
 * crops of the real pixel-art backgrounds (Meadow, Fogwood, Lantern Caverns, and every other landscape) and over a
 * platform-coloured strip, so the art can be judged honestly against ART-1 / ART-2 in SPEC.md.
 *
 *   node tools/art-sheet.mjs                          all sheets  -> $TMPDIR/egg-mama-art-sheets/*.png
 *   node tools/art-sheet.mjs --out DIR                choose the output directory (keep it OUT of the repo)
 *   node tools/art-sheet.mjs mama-meadow chapter-fogwood      only these sheets
 *   node tools/art-sheet.mjs --list                   list sheet names
 *   node tools/art-sheet.mjs --zoom 3 zoom-actors     magnified detail sheet (vector art: bigger is simply sharper)
 *   node tools/art-sheet.mjs --perf                   stamp 300 actors/frame for 300 frames (+ a typical 33-actor scene):
 *                                                     ms/frame, cache size, and cache growth over 3 circuits of 13 landscapes
 *   node tools/art-sheet.mjs --perf --actors 500 --frames 200
 *
 * Sheets:  mama-{meadow,fogwood,caverns}   Mama (run cycle, left, idle, blink, jump arc, squash, hurt, happy), ducklings,
 *                                           eggs, golden egg pulse, hatch burst — over each painting
 *          chapter-<id> (x13)               that landscape's walker + flyer cycles in its own palette, the pickup /
 *                                           flag lineup, Mama + bubble + flock of 5, stomp, flag states — over its painting
 *          gallery-walkers / gallery-flyers every species in every landscape palette (palette-fit check)
 *          zoom-mama / zoom-actors          3x magnified details
 *
 * It starts its own tiny static server on a random port and always closes it and the browser when done. Playwright is
 * the globally installed one (`require('playwright')`); nothing is installed.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };

function parseArgs(argv) {
  const o = { out: process.env.ART_SHEET_OUT || path.join(os.tmpdir(), 'egg-mama-art-sheets'), names: [], perf: false, list: false, zoom: 3, actors: 300, frames: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--perf') o.perf = true;
    else if (a === '--list') o.list = true;
    else if (a === '--zoom') o.zoom = Number(argv[++i]) || 3;
    else if (a === '--actors') o.actors = Number(argv[++i]) || 300;
    else if (a === '--frames') o.frames = Number(argv[++i]) || 300;
    else if (a === '--help' || a === '-h') { o.help = true; }
    else o.names.push(a);
  }
  return o;
}

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.normalize(path.join(root, url));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    const tryListen = (n) => {
      const port = 20000 + Math.floor(Math.random() * 40000);
      server.once('error', (e) => (n > 20 ? reject(e) : tryListen(n + 1)));
      server.listen(port, '127.0.0.1', () => { server.removeAllListeners('error'); resolve({ server, port }); });
    };
    tryListen(0);
  });
}

/** Start the static server + a browser, open the sheet page, run `fn(page)`, and always clean up. */
export async function withPage(fn) {
  const { chromium } = require('playwright');
  const { server, port } = await serve(ROOT);
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && !/willReadFrequently/.test(m.text()))) logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    await page.goto(`http://127.0.0.1:${port}/tools/art-sheet.html`);
    await page.waitForFunction(() => window.sheetReady === true, null, { timeout: 30000 });
    return await fn(page, logs);
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
  }
}

export async function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
  return withPage(async (page, logs) => {
    if (opts.list) { console.log((await page.evaluate(() => window.sheetApi.names())).join('\n')); return; }

    if (opts.perf) {
      const out = {};
      out.stress = await page.evaluate((o) => window.sheetApi.perf(o), { actors: opts.actors, frames: opts.frames, scene: 'stress' });
      out.typical = await page.evaluate((o) => window.sheetApi.perf(o), { frames: opts.frames, scene: 'typical' });
      out.bounds = (await page.evaluate(() => window.sheetApi.boundCheck())).history.filter((h, i) => i % 13 === 12);
      console.log(JSON.stringify(out, null, 2));
      if (logs.length) console.log('console:', logs.slice(0, 10));
      return out;
    }

    fs.mkdirSync(opts.out, { recursive: true });
    const names = opts.names.length ? opts.names : await page.evaluate(() => window.sheetApi.names());
    for (const name of names) {
      const r = await page.evaluate(([n, z]) => window.sheetApi.render(n, { zoom: z }), [name, opts.zoom]);
      const file = path.join(opts.out, name + '.png');
      fs.writeFileSync(file, Buffer.from(r.url.split(',')[1], 'base64'));
      console.log(file + (r.errors.length ? `   !! ${r.errors.length} draw error(s): ${r.errors[0].split('\n')[0]}` : ''));
    }
    if (logs.length) console.log('console:', [...new Set(logs)].slice(0, 10));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
