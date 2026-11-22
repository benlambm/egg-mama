import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { contentVersion, precacheList, rewrite } from "../tools/sync-sw.mjs";

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const SW_SOURCE = fs.readFileSync(path.join(DOCS, "sw.js"), "utf8");
const ORIGIN = "https://example.test";
const SCOPE = `${ORIGIN}/egg-mama/`;

/* ───────── a tiny fake service-worker world: caches, fetch, events ───────── */

function makeWorld({ network = {}, cached = {}, offline = false } = {}) {
  const store = new Map();                                   // cacheName -> Map(url -> Response)
  const listeners = {};
  const calls = { skipWaiting: 0, claim: 0, fetched: [], puts: [], addAll: [] };
  const abs = (input) => new URL(typeof input === "string" ? input : input.url, SCOPE + "sw.js").href;
  const norm = (href, ignoreSearch) => { const u = new URL(href); if (ignoreSearch) u.search = ""; return u.href; };

  const makeCache = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const map = store.get(name);
    return {
      async match(input, opts = {}) {
        const want = norm(abs(input), opts.ignoreSearch);
        for (const [k, v] of map) if (norm(k, opts.ignoreSearch) === want) return v.clone();
        return undefined;
      },
      async put(input, response) { calls.puts.push(abs(input)); map.set(abs(input), response); },
      async add(request) {
        const body = network[new URL(abs(request)).pathname.replace("/egg-mama", "")];
        if (body === undefined) throw new TypeError(`add: ${abs(request)} failed (404)`);
        map.set(abs(request), new Response(body));
      },
      async addAll(requests) {
        calls.addAll.push(requests.map((r) => ({ url: abs(r), cache: r.cache })));
        for (const r of requests) {
          const body = network[new URL(abs(r)).pathname.replace("/egg-mama", "")];
          if (body === undefined) throw new TypeError(`addAll: ${abs(r)} failed (404)`);
          map.set(abs(r), new Response(body));
        }
      },
    };
  };
  for (const [name, files] of Object.entries(cached)) { const c = makeCache(name); for (const [u, b] of Object.entries(files)) c.put(u, new Response(b)); }
  calls.puts.length = 0;

  const caches = {
    open: async (name) => makeCache(name),
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
  };
  const fetchFn = async (input) => {
    const href = abs(input);
    calls.fetched.push(href);
    if (offline) throw new TypeError("Failed to fetch");
    const u = new URL(href);
    const entry = network[u.pathname.replace("/egg-mama", "")];
    if (entry === undefined) return new Response("nope", { status: 404 });
    if (typeof entry === "object" && entry.status) return Object.defineProperty(new Response(entry.body ?? "", { status: entry.status }), "redirected", { value: !!entry.redirected });
    const r = new Response(entry, { status: 200 });
    return Object.defineProperty(r, "type", { value: u.origin === ORIGIN ? "basic" : "cors" });
  };

  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); },
    clients: { claim: () => { calls.claim++; return Promise.resolve(); } },
    registration: { scope: SCOPE },
    location: new URL(SCOPE + "sw.js"),
  };
  // inside a real worker a relative URL like './' resolves against the worker's own address; Node needs telling
  class ScopedRequest extends Request {
    constructor(input, init) { super(typeof input === "string" ? new URL(input, SCOPE + "sw.js").href : input, init); }
  }
  const context = vm.createContext({ self, caches, fetch: fetchFn, Request: ScopedRequest, Response, URL, Promise, console });
  vm.runInContext(SW_SOURCE, context, { filename: "sw.js" });
  // values come out of the vm realm: clone them so deepEqual compares plain arrays/objects
  const read = (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, context)));

  /** Fire an event whose handler may call waitUntil / respondWith; resolve when they settle. */
  async function dispatch(type, props = {}) {
    const waits = []; let responded;
    const event = { ...props, waitUntil: (p) => { waits.push(Promise.resolve(p)); }, respondWith: (p) => { responded = Promise.resolve(p); } };
    const handler = listeners[type];
    assert.ok(handler, `sw.js must listen for '${type}'`);
    handler(event);
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return { response, handled: responded !== undefined };
  }
  const req = (urlPath, init = {}) => {
    const { mode, ...rest } = init;                          // Node refuses to construct a 'navigate' Request: fake that one field
    const r = new Request(new URL(urlPath, SCOPE).href, rest);
    if (mode) Object.defineProperty(r, "mode", { value: mode });
    return r;
  };
  return { store, calls, read, dispatch, req, listeners, makeCache };
}

const FILES_ON_DISK = () => {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(path.join(DOCS, dir), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  walk("", "");
  return out;
};

/** The pure rule the list must obey: code + art files (not backgrounds, not sw.js itself, not .nojekyll). */
export function expectedPrecache(onDisk) {
  return onDisk
    .filter((f) => !f.startsWith("assets/") && f !== "sw.js" && !f.startsWith(".") && !f.endsWith(".DS_Store"))
    .map((f) => `./${f}`).concat(["./"]).sort();
}
export function compareLists(listed, expected) {
  const L = new Set(listed), E = new Set(expected);
  return { missingFromList: [...E].filter((f) => !L.has(f)).sort(), notOnDisk: [...L].filter((f) => !E.has(f)).sort(), duplicates: listed.filter((f, i) => listed.indexOf(f) !== i) };
}

/* ───────── the file lists ───────── */

test("the checker itself notices missing, extra and duplicate entries", () => {
  const onDisk = ["index.html", "style.css", "js/a.mjs", "icons/i.png", "assets/bg.webp", "sw.js", ".nojekyll"];
  assert.deepEqual(expectedPrecache(onDisk), ["./", "./icons/i.png", "./index.html", "./js/a.mjs", "./style.css"]);
  const exp = expectedPrecache(onDisk);
  assert.deepEqual(compareLists(exp, exp), { missingFromList: [], notOnDisk: [], duplicates: [] });
  const r = compareLists(["./", "./index.html", "./index.html", "./js/ghost.mjs"], exp);
  assert.deepEqual(r.missingFromList, ["./icons/i.png", "./js/a.mjs", "./style.css"]);
  assert.deepEqual(r.notOnDisk, ["./js/ghost.mjs"]);
  assert.deepEqual(r.duplicates, ["./index.html"]);
});

test("FILES lists every code/art file on disk, and only those that exist (install is all-or-nothing)", () => {
  const w = makeWorld();
  const listed = w.read("FILES");
  const r = compareLists(listed, expectedPrecache(FILES_ON_DISK()));
  assert.deepEqual(r.duplicates, [], "duplicate entries");
  assert.deepEqual(r.notOnDisk, [], "listed in sw.js FILES but missing on disk (cache.addAll would reject and offline play would never install). Fix: node tools/sync-sw.mjs");
  assert.deepEqual(r.missingFromList, [], "on disk but missing from sw.js FILES, so it would not work offline. Fix: node tools/sync-sw.mjs");
});

test("FILES entries are relative and the page itself is in the list", () => {
  const listed = makeWorld().read("FILES");
  for (const f of listed) assert.ok(f === "./" || f.startsWith("./"), `${f} must be relative so the game works from a repo subpath`);
  for (const must of ["./", "./index.html", "./style.css", "./manifest.webmanifest", "./js/main.mjs", "./js/ui.mjs", "./js/input.mjs", "./js/save.mjs", "./icons/icon-192.png", "./icons/icon-512.png"]) {
    assert.ok(listed.includes(must), `${must} must be cached`);
  }
  assert.ok(!listed.some((f) => f.startsWith("./assets/")), "the ~3 MB of backgrounds must not block install");
  assert.ok(!listed.includes("./sw.js"));
});

test("BACKGROUNDS is exactly the paintings in docs/assets", () => {
  const w = makeWorld();
  const listed = w.read("BACKGROUNDS");
  const onDisk = FILES_ON_DISK().filter((f) => f.startsWith("assets/")).map((f) => `./${f}`).sort();
  assert.equal(listed.length, 13);
  assert.deepEqual([...listed].sort(), onDisk);
});

test("the manifest's icons and start_url are cached, and the HTML links the manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "fullscreen");
  assert.deepEqual(manifest.display_override, ["fullscreen", "standalone"]);
  assert.equal(manifest.orientation, "landscape");
  assert.ok(manifest.background_color && manifest.theme_color);
  const listed = makeWorld().read("FILES");
  for (const icon of manifest.icons) assert.ok(listed.includes(`./${icon.src}`), `${icon.src} is cached`);
  assert.ok(manifest.icons.some((i) => i.sizes === "192x192") && manifest.icons.some((i) => i.sizes === "512x512"));
  assert.ok(listed.includes(manifest.start_url));
  const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  for (const f of manifest.icons.map((i) => i.src)) assert.ok(fs.existsSync(path.join(DOCS, f)), `${f} exists`);
});

test("VERSION fingerprints the files, so a phone that has the game always fetches an edited file", () => {
  const w = makeWorld();
  const listed = w.read("FILES");
  const read = (rel) => fs.readFileSync(path.join(DOCS, rel));
  const expected = contentVersion(listed, SW_SOURCE, read);
  assert.equal(w.read("VERSION"), `egg-mama-${expected}`,
    "a game file (or sw.js itself) changed since the last sync, so phones that already have the game would keep the OLD files for ever. Fix: node tools/sync-sw.mjs");
});

test("the fingerprint moves when any cached byte moves, and only then", () => {
  const files = { "index.html": "<html>", "js/a.mjs": "export const a = 1;" };
  const list = precacheList(Object.keys(files));
  const read = (rel) => files[rel];
  const v1 = contentVersion(list, SW_SOURCE, read);
  assert.match(v1, /^v-[0-9a-f]{10}$/);
  assert.equal(contentVersion(list, SW_SOURCE, read), v1, "stable");
  assert.notEqual(contentVersion(list, SW_SOURCE, (r) => (r === "js/a.mjs" ? "export const a = 2;" : files[r])), v1, "an edited file changes it");
  assert.notEqual(contentVersion(precacheList([...Object.keys(files), "js/b.mjs"]), SW_SOURCE, (r) => files[r] ?? "x"), v1, "a new file changes it");
  assert.notEqual(contentVersion(list, SW_SOURCE.replace("cache-first", "cache-second") + "// worker logic", read), v1, "the worker's own logic changes it");
  // rewriting is idempotent and keeps the PREFIX contract
  const once = rewrite(SW_SOURCE, list, read);
  assert.equal(rewrite(once, list, read), once);
  assert.match(once, /const VERSION = PREFIX \+ 'v-[0-9a-f]{10}';/);
});

test("VERSION is namespaced to this game", () => {
  const w = makeWorld();
  assert.match(w.read("VERSION"), /^egg-mama-.+/);
  assert.equal(w.read("PREFIX"), "egg-mama-");
});

/* ───────── install / activate ───────── */

function fullNetwork() {
  const net = {};
  for (const f of makeWorld().read("FILES")) net[f === "./" ? "/" : f.slice(1)] = `body of ${f}`;
  for (const b of makeWorld().read("BACKGROUNDS")) net[b.slice(1)] = `pixels of ${b}`;
  return net;
}

test("install precaches every listed file (bypassing the HTTP cache) and activates at once", async () => {
  const w = makeWorld({ network: fullNetwork() });
  await w.dispatch("install");
  const [batch] = w.calls.addAll;
  assert.equal(batch.length, w.read("FILES").length);
  const kept = [...w.store.get(w.read("VERSION")).keys()].map((u) => u.replace(SCOPE, "./"));
  assert.ok(kept.includes("./assets/meadow.webp"), "Meadow is kept at install so the very first visit already works offline");
  assert.equal(kept.filter((u) => u.startsWith("./assets/")).length, 1, "but only Meadow: the other 12 paintings are lazy");
  assert.ok(batch.every((r) => r.cache === "reload"), "cache:'reload' so a new version never stores stale files");
  assert.equal(w.calls.skipWaiting, 1);
  assert.ok(w.store.has(w.read("VERSION")));
});

test("a missing Meadow painting never fails the install", async () => {
  const net = fullNetwork(); delete net["/assets/meadow.webp"];
  const w = makeWorld({ network: net });
  await w.dispatch("install");
  assert.equal(w.calls.skipWaiting, 1);
});

test("install fails as a whole when a listed file is missing, so the old version keeps working", async () => {
  const net = fullNetwork(); delete net["/js/main.mjs"];
  const w = makeWorld({ network: net });
  await assert.rejects(() => w.dispatch("install"));
  assert.equal(w.calls.skipWaiting, 0, "never skip waiting after a failed install");
});

test("activate deletes only this game's OLD caches, and claims clients", async () => {
  const v = makeWorld().read("VERSION");
  const w = makeWorld({ cached: { "egg-mama-v0": { "./": "old" }, [v]: { "./": "new" }, "egg-mama-ancient": {}, "egg-runner-2-kitchen-3": { "./": "someone else's" }, "totally-unrelated": {} } });
  await w.dispatch("activate");
  assert.deepEqual([...w.store.keys()].sort(), [v, "egg-runner-2-kitchen-3", "totally-unrelated"].sort());
  assert.equal(w.calls.claim, 1);
});

/* ───────── fetch ───────── */

test("cache-first: a kept file is served without touching the network", async () => {
  const v = makeWorld().read("VERSION");
  const w = makeWorld({ cached: { [v]: { [`${SCOPE}js/main.mjs`]: "cached main" } }, offline: true });
  const { response, handled } = await w.dispatch("fetch", { request: w.req("js/main.mjs") });
  assert.equal(handled, true);
  assert.equal(await response.text(), "cached main");
  assert.deepEqual(w.calls.fetched, []);
});

test("a visit with a query string still finds the kept page", async () => {
  const v = makeWorld().read("VERSION");
  const w = makeWorld({ cached: { [v]: { [SCOPE]: "page", [`${SCOPE}index.html`]: "page" } }, offline: true });
  assert.equal(await (await w.dispatch("fetch", { request: w.req("?sw=1") })).response.text(), "page");
  assert.equal(await (await w.dispatch("fetch", { request: w.req("index.html?utm=x") })).response.text(), "page");
});

test("a background is fetched once, kept, and then served from the copy", async () => {
  const net = { "/assets/meadow.webp": "meadow pixels" };
  const w = makeWorld({ network: net });
  const first = await w.dispatch("fetch", { request: w.req("assets/meadow.webp") });
  assert.equal(await first.response.text(), "meadow pixels");
  assert.deepEqual(w.calls.puts, [`${SCOPE}assets/meadow.webp`], "kept on first use");
  const second = await w.dispatch("fetch", { request: w.req("assets/meadow.webp") });
  assert.equal(await second.response.text(), "meadow pixels");
  assert.equal(w.calls.fetched.length, 1, "second time never hits the network");
});

test("errors, redirects and partial responses are never kept as if they were files", async () => {
  const w = makeWorld({ network: { "/boom": { status: 500 }, "/moved": { status: 200, redirected: true }, "/part": { status: 206 } } });
  for (const p of ["boom", "moved", "part", "missing"]) await w.dispatch("fetch", { request: w.req(p) });
  assert.deepEqual(w.calls.puts, []);
});

test("other origins and non-GET requests are left alone", async () => {
  const w = makeWorld({ network: { "/x": "x" } });
  const cross = new Request("https://elsewhere.test/lib.js");
  const post = w.req("x", { method: "POST", body: "{}" });
  assert.equal((await w.dispatch("fetch", { request: cross })).handled, false);
  assert.equal((await w.dispatch("fetch", { request: post })).handled, false);
  assert.deepEqual(w.calls.fetched, []);
});

test("offline: a page visit that is not kept still opens the game; other misses fail honestly", async () => {
  const v = makeWorld().read("VERSION");
  const w = makeWorld({ cached: { [v]: { [`${SCOPE}index.html`]: "the game" } }, offline: true });
  const nav = await w.dispatch("fetch", { request: w.req("somewhere-else", { mode: "navigate" }) });
  assert.equal(await nav.response.text(), "the game");
  await assert.rejects(() => w.dispatch("fetch", { request: w.req("assets/unknown.webp") }));
});

/* ───────── warming the backgrounds ───────── */

test("'warm' fetches only the backgrounds that are still missing, one at a time, and shrugs off failures", async () => {
  const w0 = makeWorld();
  const v = w0.read("VERSION"), bgs = w0.read("BACKGROUNDS");
  const net = {}; for (const b of bgs) net[b.slice(1)] = `pixels ${b}`;
  delete net["/assets/frostline.webp"];                                    // one is unavailable
  const w = makeWorld({ network: net, cached: { [v]: { [`${SCOPE}assets/meadow.webp`]: "already", [`${SCOPE}assets/orchard.webp`]: "already" } } });
  await w.dispatch("message", { data: { type: "warm" } });
  const fetched = w.calls.fetched.map((u) => u.replace(SCOPE, "./"));
  assert.equal(fetched.length, 11, "13 backgrounds minus the 2 already kept");
  assert.ok(!fetched.includes("./assets/meadow.webp") && !fetched.includes("./assets/orchard.webp"));
  const kept = [...w.store.get(v).keys()].map((u) => u.replace(SCOPE, "./"));
  assert.equal(kept.filter((u) => u.startsWith("./assets/")).length, 12, "12 kept now (frostline failed)");
  await w.dispatch("message", { data: { type: "something-else" } });
  await w.dispatch("message", { data: null });
  assert.equal(w.calls.fetched.length, 11, "unknown messages do nothing");
});

test("'warm' while offline is harmless", async () => {
  const w = makeWorld({ offline: true });
  await w.dispatch("message", { data: { type: "warm" } });
  assert.equal(w.calls.puts.length, 0);
});
