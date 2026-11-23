/*
 * Egg Mama — offline play (a plain classic service worker, no modules, no build step).
 *
 * On first load this keeps a copy of every code/art file the game needs. After that the game starts from
 * the copy, with or without a connection, and makes no network requests while you play.
 * The 13 painted backgrounds are ~3 MB, so they are NOT part of the install (except Meadow, where every journey
 * starts): each one is kept the first time the game asks for it, and a 'warm' message (main.mjs sends one once play has started) quietly
 * fetches any that are still missing, one at a time, so a whole hour of landscapes works offline.
 *
 * AFTER YOU CHANGE ANY GAME FILE (and always as the last step before a release): run
 *     node tools/sync-sw.mjs
 * It rewrites FILES (every code/art file on disk) and VERSION (a fingerprint of those files' content). VERSION is
 * what tells phones that already have the game to fetch the new files, and because it is computed nobody has to
 * remember to bump it. tests/sw.test.mjs fails while either is stale. Installing fails as a whole if one listed
 * file is missing, so the old version keeps working instead of leaving a half-installed one.
 */
// Every copy this game keeps has a name starting with PREFIX. Other games on the same web address
// (a GitHub Pages user site hosts many) keep copies of their own under other names.
const PREFIX = 'egg-mama-';
const VERSION = PREFIX + 'v-a06c962859';

const FILES = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/art-actors.mjs',
  './js/art-terrain.mjs',
  './js/artkit.mjs',
  './js/audio.mjs',
  './js/background.mjs',
  './js/chapters.mjs',
  './js/effects.mjs',
  './js/input.mjs',
  './js/levelgen.mjs',
  './js/levels/acts.mjs',
  './js/levels/assemble.mjs',
  './js/levels/beats.mjs',
  './js/levels/beats2.mjs',
  './js/levels/beats3.mjs',
  './js/levels/beats4.mjs',
  './js/levels/beats5.mjs',
  './js/levels/builder.mjs',
  './js/levels/cues.mjs',
  './js/levels/demand.mjs',
  './js/levels/densify.mjs',
  './js/levels/params.mjs',
  './js/levels/phys.mjs',
  './js/loop.mjs',
  './js/main.mjs',
  './js/music.mjs',
  './js/render.mjs',
  './js/rng.mjs',
  './js/save.mjs',
  './js/segments.mjs',
  './js/sfx.mjs',
  './js/sim.mjs',
  './js/tuning.mjs',
  './js/ui.mjs',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Kept lazily (see above). Must match docs/assets/*.webp (tests/sw.test.mjs checks).
const BACKGROUNDS = [
  './assets/meadow.webp',
  './assets/clover-mill.webp',
  './assets/reedwater.webp',
  './assets/orchard.webp',
  './assets/amber-quarry.webp',
  './assets/fogwood.webp',
  './assets/canyon.webp',
  './assets/glass-coast.webp',
  './assets/lantern-caverns.webp',
  './assets/frostline.webp',
  './assets/ridge.webp',
  './assets/dawnbridge.webp',
  './assets/beacon-summit.webp',
];

const FIRST_BACKGROUNDS = [BACKGROUNDS[0]];                       // Meadow: where every journey starts

self.addEventListener('install', (event) => {
  // cache:'reload' = ask the web server itself. Without it the browser may hand over files it downloaded
  // a few minutes ago and a new version would be saved with the OLD files inside it.
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })))
        // the first landscape too (~280 KB), so the very first visit already works offline; a failure here never fails the install
        .then(() => Promise.all(FIRST_BACKGROUNDS.map((file) => cache.add(new Request(file, { cache: 'reload' })).catch(() => { /* kept later */ })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Throw away this game's older copies, and only this game's.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve the kept copy first; go to the network only for something missing, and keep what comes back.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;                // other people's servers are none of our business
  event.respondWith(answer(event, request));
});

async function answer(event, request) {
  const cache = await caches.open(VERSION);
  // ignoreSearch: "index.html?utm=…" or "./?sw" is still the same page
  // ignoreVary: a server that adds "Vary: Accept" or similar must never turn a kept file into a miss (offline play would break)
  const hit = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    // Keep our own files (backgrounds, or anything a future version forgot to list). A 206/redirect/error is not a file.
    if (response.status === 200 && !response.redirected && response.type === 'basic' && inScope(request.url)) {
      event.waitUntil(cache.put(request, response.clone()).catch(() => { /* no room: fetch it again next time */ }));
    }
    return response;
  } catch (err) {
    // Offline and not kept: a page visit still gets the game (it is the only page there is).
    if (request.mode === 'navigate') {
      const page = await cache.match('./index.html');
      if (page) return page;
    }
    throw err;
  }
}

function inScope(href) {
  const scope = self.registration && self.registration.scope;
  return !scope || href.startsWith(scope);
}

// main.mjs: navigator.serviceWorker.ready.then((r) => r.active.postMessage({ type: 'warm' }))
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'warm') return;
  event.waitUntil(warm());
});

async function warm() {
  const cache = await caches.open(VERSION);
  for (const file of BACKGROUNDS) {                               // one at a time: this is background work, never in the way of play
    try {
      if (await cache.match(file)) continue;
      const response = await fetch(file);
      if (response.status === 200) await cache.put(file, response);
    } catch { /* offline or full: try again next session */ }
  }
}
