#!/usr/bin/env node
/*
 * Generate the app icons: docs/icons/icon-192.png, icon-512.png and apple-touch-icon.png (180).
 *
 *   node tools/make-icons.mjs             # uses the real Mama when art-actors.mjs provides drawMama
 *   node tools/make-icons.mjs --builtin   # always use the built-in front-facing Mama
 *
 * Draws one 1024x1024 master in headless Chromium (Playwright is installed globally; nothing to install)
 * with the game's own art helpers (docs/js/artkit.mjs), then scales it down. If docs/js/art-actors.mjs
 * exists and exports drawMama, the real Mama is stamped into the scene; otherwise a built-in drawing of her
 * (same look: warm upper-left light, coloured outlines) is used. Re-run it after the actor art changes.
 *
 * The art keeps everything important inside the central 80 % so the same files also work as "maskable"
 * icons (Android crops them to a circle / squircle). Backgrounds are opaque: iOS fills transparency with black.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'icons');

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html' };
const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
const kit = await import('/docs/js/artkit.mjs');
const { eggPath, volumeFill, outline, lit, shade, rgba, oval, paint, linear, radial, star, rr, INK, SpriteCache } = kit;
const c = document.getElementById('c').getContext('2d');
const S = 1024;

// ───── sky, sun, clouds ─────
c.fillStyle = linear(c, 0, 0, 0, S, [0, '#2f9be6', 0.55, '#8fd0f2', 1, '#dff3ee']); c.fillRect(0, 0, S, S);
c.fillStyle = radial(c, 790, 250, 10, 330, [0, 'rgba(255,248,200,.95)', 0.35, 'rgba(255,240,170,.45)', 1, 'rgba(255,240,170,0)']); c.fillRect(0, 0, S, S);
c.fillStyle = '#fff6c9'; oval(c, 790, 250, 82, 82); c.fill();
const cloud = (x, y, k) => { c.fillStyle = 'rgba(255,255,255,.92)'; for (const [dx, dy, r] of [[0, 0, 46], [52, -18, 58], [112, 0, 44], [58, 14, 56]]) { oval(c, x + dx * k, y + dy * k, r * k, r * k * 0.8); c.fill(); } };
cloud(110, 210, 1.05); cloud(560, 120, 0.8);

// ───── hills ─────
const hill = (y0, amp, base, rim) => {
  const top = (x) => y0 - Math.sin(x / S * Math.PI * 1.6 + amp) * 70;
  c.beginPath(); c.moveTo(-8, S); c.lineTo(-8, top(-8));
  for (let x = 0; x <= S + 16; x += 16) c.lineTo(x, top(x));
  c.lineTo(S + 8, S); c.closePath();
  c.fillStyle = linear(c, 0, y0 - 80, 0, S, [0, lit(base, 0.25), 1, shade(base, 0.2)]); c.fill();
  c.beginPath(); c.moveTo(-8, top(-8));                                   // rim light along the top edge only
  for (let x = 0; x <= S + 16; x += 16) c.lineTo(x, top(x));
  c.lineWidth = 8; c.lineJoin = 'round'; c.strokeStyle = rim; c.stroke();
};
hill(700, 0.5, '#8fcf62', '#c2e677');
hill(790, 2.4, '#5db04a', '#8fd25a');
c.fillStyle = linear(c, 0, 840, 0, S, [0, '#4a9a3c', 1, '#357a30']); c.fillRect(0, 880, S, S);

// ───── helpers: stamp a little thing at (x, y) with scale ─────
const at = (x, y, k, fn) => { c.save(); c.translate(x, y); c.scale(k, k); fn(); c.restore(); };

// ───── Mama (origin = feet, ~44 tall) ─────
let usedReal = false;
async function realMama() {
  if (location.search.includes('builtin')) return false;
  try {
    const mod = await import('/docs/js/art-actors.mjs');
    if (typeof mod.drawMama !== 'function') return false;
    const cache = new SpriteCache(); cache.setScale(11.5 * 1.0);
    at(512, 850, 11.5, () => mod.drawMama(c, cache, { x: 0, y: 0, face: 1, vx: 0, phase: 0, onGround: true, vy: 0, squash: 0, hurt: 0, invulnFlash: false, shield: false, happy: true, t: 0.4, rock: 0 }));
    return true;
  } catch (e) { console.warn('drawMama failed, using the built-in Mama:', e && e.message); return false; }
}
function mama() {
  c.fillStyle = 'rgba(40,24,10,.28)'; oval(c, 0, 1, 21, 3.6); c.fill();
  for (const fx of [-7, 7]) { oval(c, fx, -1.2, 6, 3.2); paint(c, '#ffb347', outline('#ffb347'), 1.4); }
  for (const s of [-1, 1]) { oval(c, s * 17.5, -19, 5.2, 9, s * 0.35); paint(c, '#fff0cf', outline('#e8c88a'), 1.7); }
  eggPath(c, 0, -22, 17.5, 22); volumeFill(c, '#fff2d0', -17.5, -44, 17.5, 0);
  eggPath(c, 0, -22, 17.5, 22); paint(c, null, outline('#e8c88a'), 2);
  c.fillStyle = 'rgba(255,255,255,.55)'; oval(c, -8.5, -34, 3, 6.2, 0.5); c.fill();     // gloss
  // head tuft
  c.beginPath(); c.moveTo(-5, -43.5); c.quadraticCurveTo(-8, -52, -3, -50); c.quadraticCurveTo(-1, -56, 2, -50); c.quadraticCurveTo(7, -53, 5, -43.5); c.closePath(); paint(c, '#ffd25a', outline('#ffb52e'), 1.6);
  // cheeks, eyes, beak
  c.fillStyle = 'rgba(255,143,130,.6)'; oval(c, -10.5, -16.5, 4.2, 2.8); c.fill(); oval(c, 10.5, -16.5, 4.2, 2.8); c.fill();
  c.fillStyle = INK; oval(c, -6, -25, 2.9, 4.1); c.fill(); oval(c, 6, -25, 2.9, 4.1); c.fill();
  c.fillStyle = '#fff'; oval(c, -5, -26.4, 1.1, 1.3); c.fill(); oval(c, 7, -26.4, 1.1, 1.3); c.fill();
  c.beginPath(); c.moveTo(-3.8, -19); c.quadraticCurveTo(0, -22.5, 3.8, -19); c.quadraticCurveTo(0, -12.5, -3.8, -19); c.closePath(); paint(c, '#ff9a2e', outline('#ff9a2e'), 1.4);
  c.strokeStyle = '#ffd08a'; c.lineWidth = 1; c.beginPath(); c.moveTo(-2.2, -18.6); c.quadraticCurveTo(0, -19.6, 2.2, -18.6); c.stroke();
}
// golden egg: crown-pointed, glowing, with a sparkle
function goldEgg() {
  c.fillStyle = radial(c, 0, -14, 2, 30, [0, 'rgba(255,230,120,.8)', 1, 'rgba(255,230,120,0)']); c.fillRect(-34, -48, 68, 68);
  c.fillStyle = 'rgba(40,24,10,.25)'; oval(c, 0, 1, 10, 2.4); c.fill();
  c.beginPath(); c.moveTo(0, -29); c.bezierCurveTo(2, -29, 5, -25, 6.4, -23); c.bezierCurveTo(10.5, -18, 11.5, -12, 11.5, -9); c.bezierCurveTo(11.5, -3, 6.5, 0, 0, 0); c.bezierCurveTo(-6.5, 0, -11.5, -3, -11.5, -9); c.bezierCurveTo(-11.5, -12, -10.5, -18, -6.4, -23); c.bezierCurveTo(-5, -25, -2, -29, 0, -29); c.closePath();
  volumeFill(c, '#ffc933', -11.5, -29, 11.5, 0); paint(c, null, outline('#e0a020'), 1.8);
  c.fillStyle = 'rgba(255,255,255,.7)'; oval(c, -5, -18, 2, 5, 0.3); c.fill();
  c.fillStyle = '#fff'; star(c, 12, -30, 6.5, 4, 0.3, 0); c.fill();
}
// duckling
function duckling() {
  c.fillStyle = 'rgba(40,24,10,.25)'; oval(c, 0, 1, 11, 2.2); c.fill();
  for (const fx of [-3, 3.5]) { c.strokeStyle = '#ff9a2e'; c.lineWidth = 1.6; c.lineCap = 'round'; c.beginPath(); c.moveTo(fx, -3); c.lineTo(fx, 0); c.stroke(); }
  oval(c, 0, -10, 10.5, 9.5); volumeFill(c, '#ffd93e', -10.5, -19.5, 10.5, -0.5); oval(c, 0, -10, 10.5, 9.5); paint(c, null, outline('#ffd93e'), 1.6);
  c.beginPath(); c.moveTo(-1, -19); c.quadraticCurveTo(-2, -25, 2, -22); c.quadraticCurveTo(5, -24, 3, -19); paint(c, null, outline('#ffd93e', 0.5), 1.6);
  c.beginPath(); c.moveTo(8.5, -11); c.lineTo(14.5, -9); c.lineTo(8.5, -7); c.closePath(); paint(c, '#ff9a2e', outline('#ff9a2e'), 1.2);
  c.fillStyle = INK; oval(c, 4.2, -13, 1.6, 2); c.fill(); c.fillStyle = '#fff'; oval(c, 4.7, -13.6, 0.55, 0.6); c.fill();
  oval(c, -3, -8, 5.5, 3.6, 0.2); paint(c, '#ffd13a', outline('#ffd13a'), 1.2);
}
// grass tufts and flowers in front
const tuft = (x, y, k) => at(x, y, k, () => { c.strokeStyle = '#9ad45a'; c.lineWidth = 3; c.lineCap = 'round'; for (const [dx, dy] of [[-6, -14], [0, -19], [6, -14]]) { c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(dx * 0.4, dy * 0.6, dx, dy); c.stroke(); } });

usedReal = await realMama();
at(512, 852, 11.5, () => { if (!usedReal) mama(); });
at(222, 872, 6.2, goldEgg);
at(812, 880, 7.2, duckling);
tuft(120, 930, 2.2); tuft(900, 950, 2.4); tuft(640, 960, 2);

// ───── export ─────
const out = {};
for (const size of [512, 192, 180]) {
  const t = document.createElement('canvas'); t.width = t.height = size;
  const g = t.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  let src = document.getElementById('c'), w = S;
  while (w / 2 > size) { const h = document.createElement('canvas'); h.width = h.height = w / 2; const hg = h.getContext('2d'); hg.imageSmoothingQuality = 'high'; hg.drawImage(src, 0, 0, w / 2, w / 2); src = h; w /= 2; }
  g.drawImage(src, 0, 0, size, size);
  out[size] = t.toDataURL('image/png');
}
window.__result = { out, usedReal };
</script>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) throw new Error('outside root');
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log('page:', m.text()); });
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`http://127.0.0.1:${port}/${process.argv.includes('--builtin') ? '?builtin=1' : ''}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 30000 });
  const { out, usedReal } = await page.evaluate(() => window.__result);
  await fs.mkdir(outDir, { recursive: true });
  const names = { 512: 'icon-512.png', 192: 'icon-192.png', 180: 'apple-touch-icon.png' };
  for (const [size, name] of Object.entries(names)) {
    await fs.writeFile(path.join(outDir, name), Buffer.from(out[size].split(',')[1], 'base64'));
    console.log(`wrote docs/icons/${name} (${size}x${size})`);
  }
  console.log(usedReal ? 'used drawMama from art-actors.mjs' : 'used the built-in Mama (art-actors.mjs has no drawMama yet)');
} finally {
  await browser.close();
  server.close();
}
