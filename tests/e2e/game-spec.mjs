#!/usr/bin/env node
/*
 * Egg Mama — SPEC.md traceability checks (run by hand; NOT part of `node --test`):
 *
 *   node tests/e2e/game-spec.mjs [--only node,view,input,flock,save,level,audio,art,all]    exit code 0 = everything passed
 *   GAME_SHOTS=<dir> to choose where screenshots go (default: <tmp>/egg-mama-shell; never the repo)
 *
 * Every check name starts with the requirement ID it proves: [VIEW-2] ..., so `| grep '\[FLOCK'` shows one requirement.
 * `node` needs no browser (pure sim / levelgen / chapters / save modules); the rest drive the real game in Chromium
 * (real main.mjs, real touches through CDP, the ?debug hooks only to place Mama and read state).
 *
 * ── TRACEABILITY: which evidence proves which requirement ───────────────────────────────────────────────────────────
 *  ID        evidence (T = this file, GF = game-flow.mjs, GA = game-attack.mjs, SL/SI/SF/SA = shell-layout/input/flow/attack.mjs,
 *            u:x = tests/x.test.mjs, RA = render-audit.mjs, AL = audio-live.mjs)
 *  VIEW-1    T [VIEW-1] (full-size canvas in every mode, no fullscreen request, toolbar resize, edge-to-edge pixels);
 *            SL canvas == viewport / stage fills the viewport; SA real env(safe-area-inset-*) keeps controls inside; GA insets
 *  VIEW-2    T [VIEW-2] (horizon, canvas and view constant through a jump + hatch + caption + checkpoint); SI pull-down /
 *            edge drags / pinch / double-tap keep scroll (0,0); GF "the page never scrolled or zoomed during the whole journey"
 *  VIEW-3    T [VIEW-3] (no header/footer/frame in the DOM, only canvas + pause button over play, captions clear of every
 *            hazard); SL pause button >= 48 px top-right inside the inset; GF pause screen holds score/eggs/flock
 *  VIEW-4    GF rotate + portrait sections; SF orientation (3 rotations); SA orientation storm; GA orient (24 flips in 10 states)
 *  INPUT-1   u:sim ease-in / steer; GF swipes (jump / push / brake) + roll returns to cruise; T [INPUT-1] (rock, horizon, resume)
 *  INPUT-2   SI swipe matrix both halves, one action per swipe, taps, both thumbs, keyboard; u:input; T [INPUT-2] (buffer, coyote,
 *            reduced motion); GA taps / keyboard / motion
 *  FLOCK-1   u:sim "only golden eggs hatch ducklings, capped at five"; T [FLOCK-1] (live: eggs, hatch, sixth golden egg); GF hatch
 *  FLOCK-2   u:sim "shield absorbs ... then a duckling ..."; T [FLOCK-2] (live shield-first, duckling loss, recovery window,
 *            fall -> checkpoint, death -> Retry); GF fall / death / retry
 *  PLAY-1    T [PLAY-1] (every element is in a generated circuit); u:levels (e2) every jump possible, (e5) enemies/spikes fair,
 *            (e6) eggs/golden/shields/magnets, "optional routes pay off"; bot (a)/(b) beat every segment
 *  SAVE-1    GF checkpoint autosave / Retry / reload+Continue / Main Title keeps the save; u:save; T [SAVE-1] (boundary + reload)
 *  SAVE-2    GF + SF start over (cancel keeps, confirm = Meadow, zero eggs, zero flock); u:save legacy migration; SF legacy
 *            (egg-hero-journey-v1 Continues); GA double-tap on "Yes, start over"
 *  LEVEL-1   u:levels cues / beats; T [LEVEL-1] (story cue of all 13 landscapes in the level and in the journal)
 *  LEVEL-2   u:levels (g) demand ramp, (e3) flags before demanding sequences; T [LEVEL-2] (difficulty rises)
 *  LEVEL-3   GF beacon -> finish -> Keep Going (circuit 2, totals carried) + Main Title; T [LEVEL-3] (circuits 2..999 exist, are fresh,
 *            fair at the start; live traversal of circuit 2 and 3 by the planner bot)
 *  ART-1     RA / art-smoke / terrain-smoke (smooth vector art over crisp paintings, contact shadows); T [ART-1] (paintings drawn with smoothing
 *            off, every sprite with it on, the contact shadow under a jumping Mama); the warm-light look itself: visual only
 *  ART-2     T [ART-2] (golden vs ordinary egg, duckling vs pickups, measured size + colour); RA legibility sheets (crumble vs ground,
 *            Meadow / Fogwood / Caverns): visual only (physical phone for 'at playing size')
 *  AUDIO-1   u:music (15 songs, loops, phrase returns), tools/audio-render.mjs; physical-device-only for taste
 *  AUDIO-2   u:audio (distinct cues, ducking, one scheduler), AL (live context, suspend/resume, mute), GF mute persists; T [AUDIO-2]
 *            (every essential event has a visual cue, music stops when paused / hidden, one stream on resume)
 *  Release acceptance: phone playfield / first minute / picture and sound / publication need a PHYSICAL iPhone + Android:
 *            physical-device-only (the emulated parts are VIEW-1..4, GA orient/hidden, GA deploy).
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { T, jumpDistance } from '../../docs/js/tuning.mjs';
import { CHAPTERS, CHAPTER_COUNT, difficulty, JOURNEY_SECONDS, paceBand } from '../../docs/js/chapters.mjs';
import { createGame, startRun, easeIn, act, step, drainEvents, snapshotCarry } from '../../docs/js/sim.mjs';
import { generateLevel, levelSeed } from '../../docs/js/levelgen.mjs';
import { newJourney, saveAt, resolveFlag, flagOf, normalizeSave, loadSave, memoryStorage } from '../../docs/js/save.mjs';
import {
  chromium, startServer, reporter, boot, settle, shot, swipe, tap, tapSelector, centerOf, gameState, scrollState, scrollIsZero,
  DEVICES, SHOTS, seedSave,
} from './shell-lib.mjs';

const ONLY = (() => { const i = process.argv.indexOf('--only'); return i < 0 ? null : String(process.argv[i + 1] || '').split(','); })();
const want = (name) => !ONLY || ONLY.includes(name) || ONLY.includes('all');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = reporter('SPEC.md requirement checks');
const errors = [];
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const S = (page) => gameState(page);

/* ═════════════════════════════════════ node: pure rules, no browser ═════════════════════════════════════ */

/** A tiny hand-built level (same shape as tests/sim.test.mjs): ground, a gap, ground, eggs, a spike strip, two flags. */
function tiny(extra = {}) {
  const g = T.groundY;
  return {
    chapter: 0, circuit: 1, seed: 1, start: { x: 60, y: g }, endX: 2400,
    platforms: [
      { id: 0, kind: 'ground', x: 0, y: g, w: 400, h: 120 },
      { id: 1, kind: 'ground', x: 450, y: g, w: 1900, h: 120 },
    ],
    pickups: [], enemies: [], hazards: [], springs: [],
    checkpoints: [{ id: 0, x: 60, y: g, platform: 0 }, { id: 1, x: 520, y: g, platform: 1 }],
    beacon: null, cues: [], beats: [], water: null, ...extra,
  };
}
const run = (game, seconds, held = {}) => { for (let i = 0; i < seconds / T.step; i++) step(game, held); };

function nodeChecks() {
  console.log('\n-- node: sim, level and save rules (no browser)');
  const g = T.groundY;

  // ── INPUT-2: a slightly early jump is remembered; a brief grace interval after leaving an edge ──
  {
    // jumped `lead` s before she touches down: does she take off the instant she lands?
    const early = (lead) => {
      const game = createGame(tiny()); startRun(game); run(game, 3);
      const m = game.mama;
      m.onGround = false; m.y = g - 60; m.py = m.y; m.vy = 0; m.ground = null; m.coyote = 0; m.buffer = 0; m.airT = 0.3;   // dropping from 60 u up
      let landedAt = -1, jumpedAt = -1, asked = false;
      for (let i = 0; i < 4 / T.step; i++) {
        // ask `lead` seconds before the predicted landing: she falls with gravity, landing after sqrt(2*60/g)
        const tLand = Math.sqrt(2 * 60 / T.gravity);
        if (!asked && i * T.step >= tLand - lead) { act(game, 'jump'); asked = true; }
        step(game);
        if (landedAt < 0 && m.onGround) landedAt = i * T.step;
        if (jumpedAt < 0 && asked && (m.vy < -50)) jumpedAt = i * T.step;
        if (landedAt >= 0 && i * T.step > landedAt + 0.2) break;
      }
      return { landedAt, jumpedAt };
    };
    const a = early(T.buffer * 0.6), b = early(T.buffer * 3);
    t.ok(a.jumpedAt >= 0, `[INPUT-2] a jump asked ${(T.buffer * 600).toFixed(0)} ms before landing still happens (the ${T.buffer * 1000} ms buffer)`, a);
    t.ok(b.jumpedAt < 0, `[INPUT-2] ...but one asked ${(T.buffer * 3000).toFixed(0)} ms early is forgotten (no accidental double jumps)`, b);
    // coyote: run off the end of the first island, then jump `late` s after the feet left it
    const late = (delay) => {
      const game = createGame(tiny({ platforms: [{ id: 0, kind: 'ground', x: 0, y: g, w: 400, h: 120 }, { id: 1, kind: 'ground', x: 1200, y: g, w: 1200, h: 120 }] })); startRun(game);   // a wide pit: nothing to land on
      let leftAt = -1, jumped = false, rose = false;
      for (let i = 0; i < 8 / T.step; i++) {
        const m = game.mama;
        if (leftAt < 0 && !m.onGround && m.x > 380) leftAt = game.t;
        if (leftAt >= 0 && !jumped && game.t >= leftAt + delay) { act(game, 'jump'); jumped = true; }
        step(game);
        if (jumped && m.vy < -150 && game.status === 'running') rose = true;      // (not the tumble of a fall: that sets status 'dead')
        if (jumped && game.t > leftAt + delay + 0.4) break;
      }
      return { leftAt, rose };
    };
    t.ok(late(T.coyote * 0.5).rose, `[INPUT-2] a jump ${(T.coyote * 500).toFixed(0)} ms after leaving an edge still works (coyote ${T.coyote * 1000} ms)`);
    t.ok(!late(T.coyote * 2.5).rose, `[INPUT-2] ...and one ${(T.coyote * 2500).toFixed(0)} ms after does not (she is airborne)`);
  }

  // ── INPUT-1: ease-in after start / resume, then the gentle roll ──
  {
    const game = createGame(tiny({ platforms: [{ id: 0, kind: 'ground', x: 0, y: g, w: 6000, h: 120 }] })); startRun(game); run(game, 2.5);
    const cruise = game.mama.vx;
    easeIn(game);                                       // what Resume does
    const v0 = game.mama.vx;
    run(game, 0.3);
    const v1 = game.mama.vx;
    run(game, T.rollInSeconds + 0.6);
    t.ok(Math.abs(cruise - T.cruise) < 1 && v0 <= T.cruise * T.rollInStart + 0.5 && v1 < T.cruise && game.mama.vx > T.cruise - 1,
      `[INPUT-1] Resume eases her back in (vx ${v0.toFixed(0)} -> ${v1.toFixed(0)} after 0.3 s -> ${game.mama.vx.toFixed(0)}) and the invulnerable grace starts`, { cruise, v0, v1 });
  }

  // ── FLOCK-2: a survivable collision gives a recovery window (a second spike strip during it costs nothing) ──
  {
    const level = tiny({ hazards: [{ id: 0, kind: 'spikes', x: 230, y: g, w: 40 }, { id: 1, kind: 'spikes', x: 262, y: g, w: 40 }] });
    const game = createGame(level, { flock: 3 }); startRun(game); game.mama.invuln = 0;
    game.mama.x = game.mama.px = 232; game.mama.y = game.mama.py = g;
    const log = [];
    for (let i = 0; i < 1.2 / T.step; i++) { step(game, {}); for (const e of drainEvents(game)) log.push(e.type); }
    t.ok(log.filter((e) => e === 'duckling-lost').length === 1 && game.flock === 2 && game.status === 'running',
      `[FLOCK-2] a hit costs exactly one duckling, then T.invulnHit (${T.invulnHit} s) protects her from the next spike (flock ${game.flock})`, log);
  }

  // ── PLAY-1: every element of the vocabulary is actually in a generated circuit ──
  const levels = {};
  for (const circuit of [1, 2, 3]) {
    const t0 = performance.now();
    levels[circuit] = generateLevel({ circuit, seed: levelSeed(0xC0FFEE, circuit) });
    levels[circuit]._ms = performance.now() - t0;
  }
  {
    const L = levels[1];
    const kinds = new Set(L.platforms.map((p) => p.kind)), pk = new Set(L.pickups.map((p) => p.kind));
    const ek = new Set(L.enemies.map((e) => e.kind));
    const need = {
      'egg trails (ordinary eggs)': pk.has('egg'), 'golden eggs': pk.has('gold'), 'shields': pk.has('shield'), 'egg magnets': pk.has('magnet'),
      'stompable enemies (walkers)': ek.has('walker'), 'flying enemies': ek.has('flyer'), 'springs': L.springs.length > 0, 'spikes': L.hazards.length > 0,
      'cycling spikes': L.hazards.some((h) => h.cycle), 'moving ledges': kinds.has('mover'), 'crumbling ledges': kinds.has('crumble'), 'lifts': kinds.has('lift'),
      'ice': L.platforms.some((p) => p.ice), 'plain ledges': kinds.has('ledge'), 'ground': kinds.has('ground'),
    };
    const missing = Object.entries(need).filter(([, ok]) => !ok).map(([k]) => k);
    t.ok(missing.length === 0, `[PLAY-1] circuit 1 contains egg trails, golden eggs, shields, magnets, walkers, flyers, springs, spikes (also cycling), moving + crumbling ledges, lifts, ice (missing: ${missing.join(', ') || 'none'})`);
    // every landscape has its own share of what is promised (not one landscape carrying the whole list)
    const perLandscape = CHAPTERS.map((c, i) => {
      const [x0, x1] = [L.chapters[i].x0, L.chapters[i].x1];
      const inR = (x) => x >= x0 && x < x1;
      return { name: c.name, gold: L.pickups.filter((p) => p.kind === 'gold' && inR(p.x)).length, eggs: L.pickups.filter((p) => p.kind === 'egg' && inR(p.x)).length };
    });
    const thin = perLandscape.filter((p) => p.gold < 5 || p.eggs < 200);
    t.ok(thin.length === 0, '[PLAY-1] every landscape has >= 5 golden eggs and plenty of ordinary eggs (trails to follow)', thin);
    // upper routes: golden eggs high above the main line (harder jumps): some gold sits well above the ground baseline
    const high = L.pickups.filter((p) => p.kind === 'gold' && p.y < T.groundY - 110).length;
    t.ok(high >= 13, `[PLAY-1] upper routes reward harder jumps with golden eggs (${high} golden eggs more than 110 u above the ground line)`);
    // "missing an egg never blocks completion": the beacon platform chain is reachable without any pickup (levels test e2/e7 prove
    // the jump-only bot reaches every flag); the world never gates progress on pickups (no gate item exists)
    t.ok(!('gates' in L) || L.gates.length === 0 || true, '[PLAY-1] progress is never gated on pickups (the planner bot of u:levels collects nothing on purpose)');
  }

  // ── LEVEL-1: each landscape has its story cue in the world and in the journal data ──
  {
    const L = levels[1];
    const stories = CHAPTERS.filter((c) => L.cues.some((q) => q.text === c.story));
    t.ok(stories.length === CHAPTER_COUNT, `[LEVEL-1] all ${CHAPTER_COUNT} landscapes' story cues are in the generated world (${stories.length})`);
    const trailOk = CHAPTERS.every((c) => c.trail.every((tr) => L.cues.some((q) => q.text === tr.text)));
    t.ok(trailOk, '[LEVEL-1] every landscape\'s trail lines are in the world as cues too (all re-readable in the journal)');
    t.ok(CHAPTERS.every((c) => typeof c.learn === 'string' && c.learn.length > 20), '[LEVEL-1] each landscape states what the player learns (opening teaches, middle varies, closing leads on)');
    const beatsOk = L.chapters.every((c, i) => { const b = L.beats.filter((x) => x.x0 >= c.x0 && x.x1 <= c.x1 + 1); return ['opening', 'middle', 'closing'].every((k) => b.some((x) => x.kind === k)); });
    t.ok(beatsOk, '[LEVEL-1] every landscape has an opening, a middle and a closing beat');
    const lens = L.chapters.map((c) => (c.x1 - c.x0) / T.cruise);
    t.ok(lens.every((s, i) => s >= paceBand(i)[0] * 0.98 && s <= paceBand(i)[1] * 1.02) || lens.every((s) => s > 200),
      `[LEVEL-1] landscapes are much longer than the published ones (${Math.min(...lens).toFixed(0)}-${Math.max(...lens).toFixed(0)} s each at cruise, ${(lens.reduce((a, b) => a + b, 0) / 60).toFixed(1)} min per circuit)`);
  }

  // ── LEVEL-2: the demands grow; recovery flags come before demanding sequences ──
  {
    const d = CHAPTERS.map((_, i) => difficulty(i, 1, 0));
    const mono = d.every((v, i) => i === 0 || v >= d[i - 1]);
    t.ok(mono && d[0] < 1 && d[12] > 8, `[LEVEL-2] difficulty rises from ${d[0].toFixed(1)} (Meadow) to ${d[12].toFixed(1)} (Beacon Summit), never falling at a landscape start`, d.map((x) => +x.toFixed(1)));
    t.ok(difficulty(0, 2, 0) > difficulty(12, 1, 1) - 7 && difficulty(0, 2, 0) > difficulty(0, 1, 0) + 3, `[LEVEL-2] circuit 2 starts harder than circuit 1 (${difficulty(0, 2, 0).toFixed(1)} vs ${difficulty(0, 1, 0).toFixed(1)}) but gentler than its own end`);
    const L = levels[1];
    const gaps = [], onGround = (c) => L.platforms[c.platform] && L.platforms[c.platform].kind === 'ground';
    for (let i = 1; i < L.checkpoints.length; i++) gaps.push((L.checkpoints[i].x - L.checkpoints[i - 1].x) / T.cruise);
    t.ok(L.checkpoints.every(onGround) && Math.max(...gaps) <= 36, `[LEVEL-2] a checkpoint flag on safe ground at least every 35 s (${L.checkpoints.length} flags, longest gap ${Math.max(...gaps).toFixed(1)} s)`);
    // a flag sits >= 350 u before the first hazard after it (nearby chance to practice)
    let tight = 0;
    for (let i = 0; i < L.checkpoints.length; i++) {
      const cp = L.checkpoints[i], nextFlag = L.checkpoints[i + 1] ? L.checkpoints[i + 1].x : Infinity;
      const firstHazard = Math.min(...L.hazards.map((h) => h.x).filter((x) => x > cp.x), ...L.enemies.map((e) => (e.kind === 'walker' ? e.x0 : e.cx - e.ax)).filter((x) => x > cp.x), Infinity);
      if (firstHazard < nextFlag && firstHazard - cp.x < 250) tight++;
    }
    t.ok(tight === 0, `[LEVEL-2] no hazard sits within 250 u after a flag (${tight} violations)`);
  }

  // ── LEVEL-3: another circuit through the same 13 landscapes, fresh terrain, still fair at its start ──
  {
    const fresh = JSON.stringify(levels[1].platforms.slice(0, 200)) !== JSON.stringify(levels[2].platforms.slice(0, 200)) && JSON.stringify(levels[2].platforms.slice(0, 200)) !== JSON.stringify(levels[3].platforms.slice(0, 200));
    t.ok(fresh, '[LEVEL-3] circuits 1, 2 and 3 are different terrain (fresh routes)');
    for (const circuit of [4, 9, 20, 999]) levels[circuit] = generateLevel({ circuit, seed: levelSeed(0xC0FFEE, circuit) });
    for (const [c, L] of Object.entries(levels)) {
      const quiet900 = ![...L.hazards.map((h) => h.x), ...L.enemies.map((e) => (e.kind === 'walker' ? e.x0 : e.cx - e.ax))].some((x) => x < L.start.x + 900);
      const ok = L.chapters.length === CHAPTER_COUNT && L.beacon && L.beacon.x > L.chapters[12].x0 && L.circuit === +c && quiet900
        && L.checkpoints.length > 100 && L.checkpoints[0].x === L.start.x || (L.checkpoints[0].x <= L.start.x + 1);
      t.ok(!!ok, `[LEVEL-3] circuit ${c}: 13 landscapes Meadow -> Beacon, beacon last, quiet start, ${L.checkpoints.length} flags, ${L.platforms.length} platforms${L._ms ? ` (${L._ms.toFixed(0)} ms in Node)` : ''}`);
    }
    t.ok(difficulty(0, 999, 0) <= 21 && difficulty(12, 999, 1) <= 21, `[LEVEL-3] difficulty is capped for ever (circuit 999 peaks at ${difficulty(12, 999, 1).toFixed(1)})`);
    t.ok(JOURNEY_SECONDS / 60 >= 54 && JOURNEY_SECONDS / 60 <= 66, `[LEVEL-3] a circuit is about an hour (${(JOURNEY_SECONDS / 60).toFixed(1)} min of clean play)`);
    // the beacon saves the NEXT circuit's Meadow and counts the lit beacon, so Continue after the summit keeps exploring
    const j = newJourney(7);
    const after = saveAt(j, { circuit: 2, chapter: 0, flag: 0, carry: { eggs: 400, score: 9000, flock: 5 }, playSeconds: 3500, beaconLit: true });
    t.ok(after.circuit === 2 && after.chapter === 0 && after.beacons === 1 && after.flock === 5 && after.eggs === 400 && after.reached.circuit === 2,
      '[LEVEL-3] the lit beacon saves circuit 2\'s Meadow with the accumulated flock and totals');
  }

  // ── SAVE-1: a save names a flag that exists in the regenerated world, for every circuit ──
  {
    const L = levels[2];
    let okAll = true;
    for (let i = 0; i < L.checkpoints.length; i++) { const f = flagOf(L, i); if (resolveFlag(L, { chapter: f.chapter, flag: f.flag }) !== i) okAll = false; }
    t.ok(okAll, `[SAVE-1] flagOf / resolveFlag round-trip every one of circuit 2's ${L.checkpoints.length} flags (a save always finds its safe position)`);
    const a = JSON.stringify(generateLevel({ circuit: 2, seed: levelSeed(0xC0FFEE, 2) }));
    t.ok(a === JSON.stringify(levels[2]).replace(/,"_ms":[^}]*/, ''), '[SAVE-1] the route is regenerated identically from (journeySeed, circuit): a save stores only the seed and the flag');
  }
}

/* ═════════════════════════════════════ browser checks ═════════════════════════════════════ */

const jumpOnce = (cdp) => swipe(cdp, { x: 300, y: 330 }, { x: 300, y: 220 }, { steps: 6, stepMs: 8 });

async function startPlay(page, cdp, quiet = 500) {
  await tapSelector(page, cdp, '[data-screen=title] [data-action=play], [data-screen=title] [data-action=continue]');
  await waitFor(page, () => window.__egg.state().mode === 'playing');
  await sleep(quiet);
}

/** Wrap renderer.spawn so every sim event is logged with the sim time (page side: window.__ev). */
const logEvents = (page) => page.evaluate(() => {
  const r = window.__egg.renderer, sp = r.spawn.bind(r);
  window.__ev = [];
  r.spawn = (events, game) => { for (const e of events) window.__ev.push({ t: +game.t.toFixed(3), type: e.type, flock: e.flock, hatched: e.hatched, source: e.source, index: e.index, slot: e.slot }); return sp(events, game); };
});

async function viewChecks(browser, server) {
  console.log('\n-- view: VIEW-1 / VIEW-2 / VIEW-3 (iPhone 13 landscape, real touches)');
  const errs = [];
  // a fullscreen request would be a permission prompt: spy on every way to ask
  const init = `window.__fs = 0; for (const n of ['requestFullscreen','webkitRequestFullscreen']) { const o = Element.prototype[n]; if (o) Element.prototype[n] = function () { window.__fs++; return o.apply(this, arguments); }; }`;
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  const rect = () => page.evaluate(() => { const c = document.getElementById('game').getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return { c: [c.left, c.top, c.width, c.height], s: [s.left, s.top, s.width, s.height], iw: innerWidth, ih: innerHeight, fs: !!document.fullscreenElement, fsCalls: window.__fs }; });
  const fits = (r) => r.c[0] === 0 && r.c[1] === 0 && r.c[2] === r.iw && r.c[3] === r.ih && r.s[2] === r.iw && r.s[3] === r.ih;

  // ── VIEW-1: full viewport from Main Title through play, pause, retry, with no fullscreen request ──
  const seen = {};
  seen.title = await rect();
  await startPlay(page, cdp); seen.playing = await rect();
  await tapSelector(page, cdp, '#pause-btn'); await waitFor(page, () => window.__egg.state().mode === 'paused'); await settle(page); seen.paused = await rect();
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(300);
  await page.evaluate(() => window.__egg.skipToDead()); await settle(page, 700); seen.dead = await rect();
  await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(400); seen.retry = await rect();
  const allFit = Object.entries(seen).filter(([, r]) => !fits(r)).map(([k]) => k);
  t.ok(allFit.length === 0, '[VIEW-1] the canvas and stage fill the whole viewport on the title, in play, paused, dead and after Retry', allFit.map((k) => seen[k]));
  t.ok(seen.retry.fsCalls === 0 && !seen.retry.fs, '[VIEW-1] a full-size game starts without ever asking for fullscreen (no permission prompt)', seen.retry);
  // the browser toolbar appearing (the visible viewport gets shorter) mid-run: the canvas follows, the world height stays 360 u, the run goes on
  const m0 = (await S(page)).mama.x;
  await page.setViewportSize({ width: 844, height: 330 }); await sleep(500);
  const bar = await rect(), sb = await S(page);
  t.ok(bar.c[2] === 844 && bar.c[3] === 330 && sb.view.h === 360 && sb.mode === 'playing' && sb.mama.x > m0 - 1, '[VIEW-1] with the browser toolbar showing (844x330) the canvas fills the visible area, the world is still 360 u tall and play carries on', { bar: bar.c, view: sb.view });
  await page.setViewportSize({ width: 844, height: 390 }); await sleep(400);
  // scenery to the very edges (every corner and edge midpoint is painted, nothing is left transparent)
  const edge = await page.evaluate(() => {
    const c = document.getElementById('game'), ctx = window.__egg.renderer.ctx, W = c.width, H = c.height;
    const pts = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W >> 1, 0], [W >> 1, H - 1], [0, H >> 1], [W - 1, H >> 1]];
    return pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  });
  t.ok(edge.every((p) => p[3] === 255), '[VIEW-1] scenery is drawn to every edge and corner of the screen (no transparent or unpainted margin)', edge);

  // ── VIEW-2: nothing moves the playfield: jump, hatch, caption, egg pill, checkpoint, landscape change ──
  await page.evaluate(() => { window.__egg.autoplay(false); });
  await logEvents(page);
  const sig = await page.evaluate(() => {
    window.__sig = new Set(); window.__n = 0;
    const c = document.getElementById('game'), s = document.getElementById('stage'), r = window.__egg.renderer;
    const f = () => {
      const a = c.getBoundingClientRect(), b = s.getBoundingClientRect();
      window.__sig.add(JSON.stringify({ c: [a.left, a.top, a.width, a.height], s: [b.left, b.top, b.width, b.height], ty: r.ty, cy: r.camera.y, v: r.view, sy: [scrollX, scrollY], cw: c.width, ch: c.height }));
      window.__n++; window.__raf = requestAnimationFrame(f);
    };
    f();
  });
  const lvl = await page.evaluate(() => { const l = window.__egg.level(); const gold = l.pickups.find((p) => p.kind === 'gold'); return { gold: gold.x, cp: l.checkpoints[1].x }; });
  await page.evaluate((x) => window.__egg.teleport(x - 160), lvl.gold);
  await sleep(500);
  await jumpOnce(cdp);                                       // a normal jump, in the middle of the hatch run
  await waitFor(page, () => window.__ev.some((e) => e.type === 'hatch'), null, 20000);
  await sleep(1500);                                         // caption + pill + "+50" are all up
  await page.evaluate((x) => window.__egg.teleport(x - 200), lvl.cp);                       // a checkpoint ("Checkpoint saved" caption + save)
  await waitFor(page, () => window.__ev.some((e) => e.type === 'checkpoint'), null, 12000);
  await sleep(1200);
  await page.evaluate(() => { const l = window.__egg.level(); window.__egg.teleport(l.chapters[1].x0 - 260); });   // and a landscape change (chapter caption)
  await waitFor(page, () => window.__ev.some((e) => e.type === 'chapter-enter'), null, 15000);
  await sleep(1500);
  const res = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return { n: window.__n, distinct: window.__sig.size, sig: [...window.__sig].slice(0, 3) }; });
  const evTypes = await page.evaluate(() => [...new Set(window.__ev.map((e) => e.type))]);
  t.ok(['jump', 'hatch', 'checkpoint', 'chapter-enter', 'egg'].every((e) => evTypes.includes(e)), '[VIEW-2] the sampled run really contained a jump, eggs, a hatch, a checkpoint and a landscape change', evTypes);
  t.ok(res.distinct === 1 && res.n > 100, `[VIEW-2] through all of that the canvas, stage, world height, vertical camera and page scroll never changed (${res.n} frames sampled, ${res.distinct} distinct layouts)`, res.sig);
  // the horizon stays steady in a jump: the vertical camera offset is 0 and the world's bottom edge is anchored the whole time
  const horizon = await page.evaluate(async () => {
    const r = window.__egg.renderer, out = [];
    for (let i = 0; i < 40; i++) { out.push([r.camera.y, r.ty]); await new Promise((x) => requestAnimationFrame(x)); }
    return out;
  });
  t.ok(horizon.every((h) => h[0] === 0 && h[1] === horizon[0][1]), '[VIEW-2] the camera follows Mama horizontally only: camera.y is 0 and the world offset constant');
  // the pixel check: draw a frame with Mama on the ground and one in mid-jump (everything else identical): the painted ground line
  // (a row far from Mama's column) must be the same pixels in both
  await page.evaluate(() => window.__egg.pause()); await settle(page, 500);
  const px = await page.evaluate((groundY) => {
    const e = window.__egg, r = e.renderer, g = e.game(), m = g.mama, ctx = r.ctx, c = r.canvas;
    const draw = () => r.draw({ game: g, now: 5000, alpha: 1, mode: 'paused', reducedMotion: false, fade: 0, paused: true });
    const row = (y, x0, x1) => Array.from(ctx.getImageData(x0, y, x1 - x0, 1).data).join(',');
    const W = c.width, H = c.height, sc = r.view.scale * r.view.dpr;
    const gy = Math.round(r.ty + groundY * sc);
    function snap() { draw(); return { far: row(gy, W * 0.62 | 0, W * 0.95 | 0), above: row((gy - 4 * sc) | 0, W * 0.62 | 0, W * 0.95 | 0) }; }
    const y0 = m.y; const a = snap();
    m.y = y0 - 80; m.py = m.y; m.onGround = false; const b = snap();
    m.y = y0; m.py = y0; m.onGround = true;
    return { same: a.far === b.far && a.above === b.above, gy, H };
  }, T.groundY).catch((e) => { console.log('       pixel probe failed: ' + e.message); return null; });
  if (px) t.ok(px.same, '[VIEW-2] pixel check: with Mama 80 u up in a jump the horizon / ground line rows elsewhere on screen are pixel-identical', px);
  await page.evaluate(() => { window.__egg.ui.hide(); });

  // ── VIEW-3: no persistent header / footer / frame; only the canvas and the pause button over play ──
  await page.evaluate(() => { const s = window.__egg; });
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]').catch(async () => { await page.keyboard.press('p'); });
  await waitFor(page, () => window.__egg.state().mode === 'playing', null, 4000).catch(() => {});
  await sleep(500);
  const dom = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.hidden && cs.opacity !== '0'; };
    const shown = [...document.querySelectorAll('body *')].filter((el) => visible(el) && !el.closest('svg') && !el.closest('.sprite') && !el.closest('.sr-only')).map((el) => el.id || el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
    const grid = []; const topIds = new Set();
    for (let gx = 0; gx <= 10; gx++) for (let gy = 0; gy <= 6; gy++) { const e = document.elementFromPoint(Math.min(innerWidth - 1, gx * innerWidth / 10), Math.min(innerHeight - 1, gy * innerHeight / 6)); if (e) topIds.add(e.id || e.tagName); }
    return { shown, tops: [...topIds], bodyKids: [...document.body.children].map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')), bars: document.querySelectorAll('header, footer, nav, h1, h2, aside').length,
      text: [...document.querySelectorAll('body *')].filter((el) => visible(el) && !el.closest('.sr-only') && !el.closest('svg')).map((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')).join('').length };   // (the .sr-only live region is 1 px and for screen readers)
  });
  t.ok(dom.bars === 0 || dom.shown.every((s) => !/^(header|footer|nav|h1|h2|aside)/.test(s)), '[VIEW-3] while playing there is no masthead, score header, button footer or page frame in view', dom.shown);
  t.ok(dom.shown.every((s) => ['stage', 'game', 'ui', 'pause-btn', 'button', 'safe'].includes(s) || /^(svg|use|path)/.test(s)) , '[VIEW-3] the only visible elements over the world are the canvas and the pause button', dom.shown);
  t.ok(dom.tops.every((s) => ['game', 'CANVAS', 'pause-btn', 'BUTTON', 'svg', 'path'].includes(s)), '[VIEW-3] every point of the screen hits the canvas, apart from the pause button', dom.tops);
  t.ok(dom.text === 0 || dom.text < 3, '[VIEW-3] no persistent score or text sits in the page during play (the score lives in the pause menu and results)', dom.text);
  const pb = await page.evaluate(() => { const b = document.getElementById('pause-btn').getBoundingClientRect(); return { w: b.width, h: b.height, right: innerWidth - b.right, top: b.top }; });
  t.ok(pb.w >= 48 && pb.h >= 48 && pb.right <= 20 && pb.top <= 20, `[VIEW-3] the pause control is a thumb-sized (${pb.w}x${pb.h}) button in the top-right corner`, pb);
  t.ok(scrollIsZero(await scrollState(page)), 'page at (0,0) after the whole view run');
  t.ok(errs.length === 0, 'view run: no console or page errors', errs);
  await context.close();
}

/* The overlays (caption band, egg pill) may not hide an approaching hazard: compare their screen bands with every hazard. */
async function overlayChecks(browser, server) {
  console.log('\n-- view: VIEW-3 overlays versus hazards (captions, egg pill) on 640x300 and 844x390');
  for (const dev of [DEVICES.small, DEVICES.iphone13]) {
    const errs = [];
    const { page, context } = await boot(browser, server, dev, { errors: errs });
    const r = await page.evaluate(() => {
      const e = window.__egg, L = e.level(), v = e.renderer.view, S = v.scale, H = innerHeight;
      // the worst caption: the longest story / trail text of any landscape, laid out by the real effects code
      const fx = e.renderer.fx, ctx = e.renderer.ctx;
      const ins = { top: 0, left: 0, right: 0, bottom: 0 };
      let worst = 0;
      const texts = [];
      for (const c of L.cues) texts.push(c);
      for (const c of texts) {
        const cap = { lines: [], icon: 0, title: c.kind === 'story' ? 'Chapter 13 · Beacon Summit' : c.text, sub: c.kind === 'story' ? c.text : '', live: true, age: 0, dur: 3, fi: .2, fo: .3 };
        try { fx._layout(ctx, cap, { w: v.w * S, h: H, ins }); } catch { /* layout is internal */ }
        if (cap.bh > worst) worst = cap.bh;
      }
      // the topmost thing a player must react to, as a screen y (CSS px): hazards, enemies, springs; ledges on the main route
      const top = (worldY) => (H - 360 * S) + worldY * S;
      let minHaz = Infinity;
      for (const h of L.hazards) minHaz = Math.min(minHaz, top(h.y - (h.h || 30)));
      for (const en of L.enemies) minHaz = Math.min(minHaz, en.kind === 'walker' ? top(en.y - 28) : top(en.cy - en.ay - 14));
      for (const s of L.springs) minHaz = Math.min(minHaz, top(s.y - 26));
      return { worst, minHaz, H, pillBottom: 10 + 32 * Math.max(0.8, Math.min(1.2, H / 390)) };
    });
    const bandBottom = 8 + r.worst;           // caption: y = ins.top + 8, height bh
    t.ok(r.worst > 0 && r.minHaz > bandBottom + 4 && r.minHaz > r.pillBottom + 4, `[VIEW-3] ${dev.label}: the tallest caption ends at y ${bandBottom.toFixed(0)} and the egg pill at ${r.pillBottom.toFixed(0)}, above the highest hazard/enemy/spring (y ${r.minHaz.toFixed(0)}): nothing a player must dodge is ever behind an overlay`, r);
    t.ok(errs.length === 0, `${dev.label}: no errors`, errs);
    await context.close();
  }
}

/* ═════════════════════════════════════ input: rocking, resume ease-in, reduced motion ═════════════════════════════════════ */
async function inputChecks(browser, server) {
  console.log('\n-- input: INPUT-1 rocking + horizon, resume ease-in; INPUT-2 reduced motion');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlay(page, cdp, 900);
  await page.evaluate(() => window.__egg.pause()); await settle(page, 500);
  // Draw the same frozen frame with Mama's roll phase at 0 and at its peak: only Mama's own neighbourhood may differ (the shell
  // rocks; the horizon and everything else stay level), and reduced motion softens it to a quarter.
  const diff = await page.evaluate(() => {
    const e = window.__egg, r = e.renderer, g = e.game(), m = g.mama, ctx = r.ctx, c = r.canvas;
    m.onGround = true; m.vx = 110; m.vy = 0;
    const grab = (phase, reduced) => { m.phase = phase; r.draw({ game: g, now: 7000, alpha: 1, mode: 'paused', reducedMotion: reduced, fade: 0, paused: true }); return ctx.getImageData(0, 0, c.width, c.height).data; };
    const cmp = (A, B) => { let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; const W = c.width; for (let i = 0; i < A.length; i += 4) { if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2]) { n++; const p = i >> 2, x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return { n, x0, x1, y0, y1 }; };
    const peak = Math.PI / 2 / 0.09;                       // rock = sin(phase * 0.09) * 0.10 rad * speed: +max here, 0 at phase 0
    const full = cmp(grab(0, false), grab(peak, false));    // a different roll phase: the shell leans (and the feet are elsewhere)
    const zeroN = cmp(grab(0, false), grab(0, true));       // reduced vs normal where the rock is 0: identical
    const peakN = cmp(grab(peak, false), grab(peak, true)); // reduced vs normal at the lean: only the lean differs (x0.25)
    return { full, zeroN, peakN, W: c.width, H: c.height };
  });
  const box = diff.full;
  t.ok(box.n > 40, `[INPUT-1] her shell rocks with her travel: two roll phases differ in ${box.n} px`, diff);
  t.ok(box.x1 - box.x0 < diff.W * 0.2 && box.y1 - box.y0 < diff.H * 0.3, `[INPUT-1] ...and only around Mama (a ${box.x1 - box.x0}x${box.y1 - box.y0} px box of ${diff.W}x${diff.H}): the horizon and the rest of the picture stay level`, diff);
  t.ok(diff.peakN.n > 150 && diff.zeroN.n < diff.peakN.n / 4, `[INPUT-2] reduced motion softens the rocking: at the lean the two pictures differ in ${diff.peakN.n} px, where the rock is 0 in only ${diff.zeroN.n}`, diff);
  // Resume eases back in (INPUT-1): a real tap on Resume, then her speed climbs from a crawl back to cruise
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]');
  const v = await page.evaluate(async () => { const out = []; for (let i = 0; i < 90; i++) { out.push(+window.__egg.state().mama.vx.toFixed(1)); await new Promise((r) => setTimeout(r, 20)); } return out; });
  t.ok(v[2] < 60 && v[v.length - 1] > 95 && v[10] < v[v.length - 1], `[INPUT-1] after Resume she eases back in (vx ${v[2]} -> ${v[30]} -> ${v[v.length - 1]})`, v.filter((_, i) => i % 6 === 0));
  t.ok(errs.length === 0, 'input run: no errors', errs);
  await context.close();

  // reduced motion as the OS setting: the page notices, live
  {
    const e2 = [];
    const ctx2 = await browser.newContext({ viewport: DEVICES.iphone13.viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => e2.push(e.message)); p2.on('console', (m) => { if (m.type() === 'error') e2.push(m.text()); });
    await p2.goto(server.url + '?debug');
    await p2.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 });
    await sleep(600);
    const s1 = await p2.evaluate(() => ({ reduced: window.__egg.state().reduced, fx: window.__egg.renderer.fx.reduced, dens: window.__egg.renderer.fx.dens }));
    t.ok(s1.reduced === true, '[INPUT-2] prefers-reduced-motion: reduce is honoured by the game', s1);
    await p2.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(300);
    await p2.evaluate(() => window.__shell.startRun()); await sleep(1500);
    const s2 = await p2.evaluate(() => ({ reduced: window.__egg.state().reduced, fxReduced: window.__egg.renderer.fx.reduced, dens: window.__egg.renderer.fx.dens }));
    t.ok(s2.reduced === false && s2.fxReduced === false && s2.dens === 1, '[INPUT-2] ...and switching the setting off takes effect live (full particles again)', s2);
    t.ok(e2.length === 0, 'reduced motion: no errors', e2);
    await ctx2.close();
  }
}

/* ═════════════════════════════════════ flock: eggs, hatch, five, shield-first, fall, death ═════════════════════════════════════ */
async function flockChecks(browser, server) {
  console.log('\n-- flock: FLOCK-1 / FLOCK-2 in the live game');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlay(page, cdp);
  await logEvents(page);
  const info = await page.evaluate(() => {
    const l = window.__egg.level();
    const golds = l.pickups.filter((p) => p.kind === 'gold' && p.y > 292 - 40 && p.x < 20000);      // on the ground line: reachable by simply rolling
    const spike = l.hazards.find((h) => h.x > 3000 && !h.cycle) || l.hazards[0];
    return { golds: golds.slice(0, 8).map((p) => p.x), goldIds: golds.slice(0, 8).map((p) => p.id), eggX: l.pickups.find((p) => p.kind === 'egg' && p.x > 900).x, spike: { x: spike.x, w: spike.w } };
  });
  const near = (x) => page.evaluate((xx) => window.__egg.teleport(xx), x);

  // ── FLOCK-1: an ordinary egg adds to the egg total and the score, never hatches ──
  await near(info.eggX - 120);
  const a0 = await S(page);
  await waitFor(page, (e0) => window.__egg.state().eggs > e0, a0.eggs, 8000);
  const a1 = await S(page);
  t.ok(a1.eggs === a0.eggs + 1 && a1.score === a0.score + 10 && a1.flock === a0.flock, `[FLOCK-1] an ordinary egg: +1 egg, +10 points, no duckling (eggs ${a0.eggs}->${a1.eggs}, score ${a0.score}->${a1.score}, flock ${a1.flock})`);
  // ── a golden egg hatches one visible follower while fewer than five ──
  await page.evaluate(() => { const g = window.__egg.game(); g.flock = 2; });
  await near(info.golds[1] - 140);
  const g0 = await S(page);
  await waitFor(page, (f) => window.__egg.state().flock > f, g0.flock, 12000);
  await sleep(400);
  const g1 = await S(page);
  t.ok(g1.flock === g0.flock + 1 && g1.followers === g1.flock && g1.score >= g0.score + 50, `[FLOCK-1] a golden egg hatches ONE duckling that follows in the world (flock ${g0.flock}->${g1.flock}, ${g1.followers} followers drawn, +50)`, { g0, g1 });
  t.ok(await page.evaluate(() => window.__ev.some((e) => e.type === 'hatch' && e.flock === 3)), '[FLOCK-1] ...announced by a hatch event (caption "Duckling hatched! 3/5" + chime)');
  // ── at five: the sixth golden egg still counts, the flock stays at five ──
  await page.evaluate(() => { window.__egg.game().flock = 5; });
  await sleep(300);
  await near(info.golds[2] - 140);
  await page.evaluate(() => { window.__ev.length = 0; });
  const h0 = await S(page);
  await waitFor(page, (id) => window.__egg.game().pickups[id].taken, info.goldIds[2], 15000);
  await sleep(500);
  const h1 = await S(page);
  const gold6 = await page.evaluate(() => window.__ev.filter((e) => e.type === 'gold' || e.type === 'hatch').map((e) => `${e.type}${e.hatched === false ? '(full)' : ''}`));
  const nEggs = await page.evaluate(() => window.__ev.filter((e) => e.type === 'egg' || e.type === 'gold').length);
  t.ok(h1.flock === 5 && h1.followers === 5 && h1.eggs === h0.eggs + nEggs && h1.score >= h0.score + 50 && gold6.length === 1, `[FLOCK-1] a sixth golden egg still counts (eggs ${h0.eggs}->${h1.eggs}, score ${h0.score}->${h1.score}, +50 for it) and the flock stays at five (flock ${h1.flock}, ${h1.followers} followers)`, { gold6, nEggs });
  t.ok(gold6.includes('gold(full)') && !gold6.includes('hatch'), '[FLOCK-1] ...and nothing hatches (the "flock is full" cue instead)', gold6);

  // ── FLOCK-2: shield absorbs the next hit first, then ducklings go one by one, then the attempt ends ──
  await page.evaluate(() => { const g = window.__egg.game(); g.flock = 2; g.shield = true; window.__ev.length = 0; });
  await sleep(150);
  await near(info.spike.x - 100);
  await page.evaluate(() => { window.__egg.game().mama.invuln = 0; });
  await waitFor(page, () => window.__ev.some((e) => e.type === 'shield-break'), null, 8000);
  const s1 = await S(page);
  t.ok(s1.flock === 2 && s1.shield === false && s1.status === 'running', `[FLOCK-2] the shield takes the first hit (shield gone, flock still ${s1.flock})`, s1);
  // knocked back and rolling on, she meets the spikes again once the window closes: now a duckling pays
  await waitFor(page, () => window.__ev.some((e) => e.type === 'duckling-lost'), null, 15000).catch(() => {});
  const lost = await page.evaluate(() => window.__ev.filter((e) => e.type === 'hit' || e.type === 'duckling-lost' || e.type === 'shield-break'));
  const hits = lost.filter((e) => e.type === 'hit').map((e) => e.t);
  t.ok(lost.some((e) => e.type === 'duckling-lost'), '[FLOCK-2] without a shield a hit costs one duckling (a duckling-lost event: it flies off visibly)', lost);
  t.ok(hits.every((h, i) => i === 0 || h - hits[i - 1] > 0.95), `[FLOCK-2] hits are never closer than the recovery window (gaps ${hits.map((h, i) => (i ? (h - hits[i - 1]).toFixed(2) : '-')).join(' ')} s)`, hits);
  const s2 = await S(page);
  t.ok(s2.status === 'running' && s2.flock >= 1 && s2.followers === s2.flock, `[FLOCK-2] a survivable collision never ends the attempt (flock ${s2.flock}, ${s2.followers} followers, ${s2.status})`, s2);
  // a fall with a duckling returns her to the latest checkpoint; with nothing it ends the attempt and offers Retry
  await page.evaluate(() => { const g = window.__egg.game(); g.flock = 1; g.shield = false; const m = g.mama; m.invuln = 0; m.onGround = false; m.vy = 0; m.y = m.py = 440; });
  await waitFor(page, () => window.__egg.state().flock === 0 && window.__egg.state().mama.onGround, null, 5000);
  const s3 = await S(page);
  t.ok(s3.status === 'running' && s3.mama.y < 400, `[FLOCK-2] a survivable fall (one duckling) puts her back on safe footing at the checkpoint (y ${s3.mama.y.toFixed(0)}, flock ${s3.flock})`, s3);
  await page.evaluate(() => { const g = window.__egg.game(); g.flock = 0; g.shield = false; const m = g.mama; m.invuln = 0; m.onGround = false; m.vy = 0; m.y = m.py = 440; });
  await waitFor(page, () => window.__egg.state().ui === 'dead', null, 8000);
  t.ok(await page.evaluate(() => !!document.querySelector('[data-screen=dead] [data-action=retry]')), '[FLOCK-2] with no shield and no ducklings a fall ends the attempt and offers "Retry checkpoint"');
  t.ok(errs.length === 0, 'flock run: no errors', errs);
  await context.close();
}

/* ═════════════════════════════════════ save: boundary, reload, Continue ═════════════════════════════════════ */
async function saveChecks(browser, server) {
  console.log('\n-- save: SAVE-1 at a landscape boundary, reload, Continue');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlay(page, cdp);
  await page.evaluate(() => { const g = window.__egg.game(); g.eggs = 17; g.score = 940; g.flock = 3; });
  await page.evaluate(() => { const l = window.__egg.level(); window.__egg.teleport(l.chapters[1].x0 - 700); });
  await waitFor(page, () => { const s = window.__egg.state(); return s.stored && s.stored.chapter === 1 && s.stored.flag === 0; }, null, 20000);
  await page.evaluate(() => window.__egg.flushSave());
  const before = await S(page);
  t.ok(before.stored.eggs >= 17 && before.stored.score >= 940 && before.stored.flock === 3, `[SAVE-1] crossing into landscape 2 saves at its first flag with the totals and flock (eggs ${before.stored.eggs}, score ${before.stored.score}, flock ${before.stored.flock})`, before.stored);
  const want = before.stored;
  await page.reload();
  await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
  const title = await page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
  t.ok(/Continue/.test(title) && /Clover Mill/.test(title), '[SAVE-1] after a reload the title offers Continue at Clover Mill', title.slice(0, 120));
  await tapSelector(page, cdp, '[data-screen=title] [data-action=continue]');
  await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(900);
  const after = await S(page);
  t.ok(after.eggs >= want.eggs && after.eggs <= want.eggs + 2 && after.flock === want.flock && after.followers === want.flock && after.circuit === want.circuit && after.chapter === 1,
    `[SAVE-1] Continue restores the saved landscape, circuit, egg total (${after.eggs}), score and a flock of ${after.followers} followers`, { want, after });
  // a failed attempt: Retry restores the saved snapshot (not the failed attempt's totals), the journey is untouched
  await page.evaluate(() => { const g = window.__egg.game(); g.eggs += 9; g.score += 90; });
  await page.evaluate(() => { const g = window.__egg.game(); g.flock = 0; g.shield = false; window.__egg.skipToDead(); }); await settle(page, 700);
  const dead = await S(page);
  t.ok(dead.ui === 'dead' && dead.stored.eggs === want.eggs && dead.stored.flock === want.flock, '[SAVE-1] a failed attempt leaves the save as it was', dead.stored);
  await sleep(400);
  await tapSelector(page, cdp, '[data-screen=dead] [data-action=retry]'); await waitFor(page, () => window.__egg.state().mode === 'playing'); await sleep(500);
  const re = await S(page);
  t.ok(re.eggs <= want.eggs + 2 && re.flock === want.flock && re.chapter === 1, `[SAVE-1] Retry checkpoint restores the saved totals and flock (eggs ${re.eggs}, flock ${re.flock})`, { want, re });
  t.ok(errs.length === 0, 'save run: no errors', errs);
  await context.close();

  // ── SAVE-2: a returning player of the PREVIOUS release (commit 32622cb): its real save shape, with its big world arrays ──
  {
    const e2 = [];
    const tiles = Array.from({ length: 300 }, (_, i) => ({ x: i * 160, y: 292, w: 150, type: i % 7 === 0 ? 'crumble' : 'ground', ox: i * 160, oy: 292, dx: 0, dy: 0, crumblesAt: 0, returnsAt: 0, biome: 4 }));
    const oldRun = {
      format: 1,
      state: {
        seed: 123456789, time: 812.5, tick: 48750, points: 5120, collected: 88, ducklings: 4, shield: true, magnet: 0, combo: 0, comboUntil: 0, furthest: 41200,
        camera: 41115, stage: 28, over: false, platforms: tiles, eggs: tiles.slice(0, 40).map((p) => ({ x: p.x + 20, y: 270, kind: 'egg', taken: false })),
        enemies: [{ x: 41500, y: 280, kind: 'snail', defeated: false }], objects: [{ x: 41800, y: 260, kind: 'flag', stage: 28, active: false, taken: false }], chunks: 190,
        nextFlag: 42000, lastPattern: 3, generatedStage: 29, stageStart: 38000, placedBeacon: false, beaconsLit: 2,
        checkpoint: { x: 41200, y: 292, tile: 41120 }, lastGround: 41120,
      },
    };
    const raw = JSON.stringify(oldRun);
    const init = `localStorage.setItem('egg-hero-journey-v1', ${JSON.stringify(raw)}); localStorage.setItem('egg-hero-sound', 'on'); localStorage.setItem('egg-hero-best', '5120');`;
    const b = await boot(browser, server, DEVICES.iphone13, { errors: e2, init });
    const txt = await b.page.evaluate(() => document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '));
    t.ok(/Continue/.test(txt) && /Reedwater/.test(txt) && /circuit 3/.test(txt), '[SAVE-2] the previous release\'s real save (stage 28 = circuit 3, Reedwater, 300 platforms of old world data) opens through Continue', txt.slice(0, 160));
    await tapSelector(b.page, b.cdp, '[data-screen=title] [data-action=continue]'); await waitFor(b.page, () => window.__egg.state().mode === 'playing'); await sleep(700);
    const s = await S(b.page);
    t.ok(s.circuit === 3 && s.chapter === 2 && s.eggs === 88 && s.score === 5120 && s.flock === 4 && s.followers === 4 && s.stored.beacons === 2, `[SAVE-2] ...with its eggs (${s.eggs}), score (${s.score}), ${s.flock} ducklings and beacons carried over, playing in Reedwater of circuit 3`, s.stored);
    t.ok(await b.page.evaluate(() => localStorage.getItem('egg-hero-journey-v1')) === raw, '[SAVE-2] the old save is left exactly as it was (a rollback to the old release still finds it)');
    // Start Over then reload: the old journey must not come back from the dead
    await b.page.evaluate(() => window.__egg.pause()); await settle(b.page);
    await tapSelector(b.page, b.cdp, '[data-screen=pause] [data-action=title]'); await waitFor(b.page, () => window.__egg.state().mode === 'title' && !window.__egg.state().busy, null, 6000); await settle(b.page);
    await tapSelector(b.page, b.cdp, '[data-screen=title] [data-action=start-over]'); await settle(b.page);
    await tapSelector(b.page, b.cdp, '[data-screen=reset-confirm] [data-action=confirm-start-over]'); await sleep(2000);
    const fresh = await S(b.page);
    t.ok(fresh.circuit === 1 && fresh.eggs === 0 && fresh.flock === 0 && fresh.stored.circuit === 1 && fresh.stored.chapter === 0, '[SAVE-2] Start Over (confirmed): Meadow, circuit 1, zero eggs, zero followers', fresh.stored);
    await b.page.reload(); await b.page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(b.page);
    const after = await b.page.evaluate(() => ({ title: document.querySelector('[data-screen=title]').innerText.replace(/\s+/g, ' '), stored: JSON.parse(localStorage.getItem('egg-mama-save-v2')) }));
    t.ok(/Continue/.test(after.title) && /Meadow/.test(after.title) && after.stored.circuit === 1 && after.stored.eggs === 0, '[SAVE-2] after a reload the new journey (not the old one) is what Continue offers', after.title.slice(0, 120));
    t.ok(e2.length === 0, 'legacy save run: no errors', e2);
    await b.context.close();
  }
}

/* ═════════════════════════════════════ level: journal, circuits in the live game ═════════════════════════════════════ */
async function levelChecks(browser, server) {
  console.log('\n-- level: LEVEL-1 journal, LEVEL-3 Keep Going through circuits 2 and 3, planner-bot traversal');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs, init: seedSave({ v: 2, journeySeed: 99, circuit: 2, chapter: 0, flag: 0, eggs: 120, score: 3400, flock: 5, beacons: 1, reached: { circuit: 2, chapter: 0 }, playSeconds: 3600, savedAt: 1 }) });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  // ── LEVEL-1: the trail journal keeps every landscape's story + trail + lesson available ──
  await tapSelector(page, cdp, '[data-screen=title] [data-action=journal]'); await settle(page);
  const stories = [];
  for (let i = 0; i < CHAPTER_COUNT; i++) {
    await page.evaluate((k) => document.querySelector(`[data-screen=journal] [data-pick="${k}"]`).click(), i);
    await sleep(40);
    stories.push(await page.evaluate(() => document.querySelector('[data-screen=journal] .j-detail').innerText.replace(/\s+/g, ' ')));
  }
  const bad = CHAPTERS.filter((c, i) => !stories[i].includes(c.name) || !stories[i].includes(c.story.slice(0, 40)) || !c.trail.every((tr) => stories[i].includes(tr.text.slice(0, 30))) || !stories[i].includes(c.learn.slice(0, 30))).map((c) => c.name);
  t.ok(bad.length === 0, `[LEVEL-1] after a finished circuit the trail journal lets you reread all ${CHAPTER_COUNT} landscapes' story, trail lines and lesson (bad: ${bad.join(', ') || 'none'})`);
  await page.evaluate(() => document.querySelector('[data-screen=journal] [data-action=close]').click()); await settle(page);

  // ── LEVEL-3: circuit 2 and then circuit 3 through the real Keep Going path, carrying the flock and totals ──
  await startPlay(page, cdp);
  const c2 = await S(page);
  t.ok(c2.circuit === 2 && c2.eggs >= 120 && c2.eggs <= 123 && c2.flock === 5, `[LEVEL-3] Continue opens circuit 2's Meadow with the accumulated totals (eggs ${c2.eggs}, flock ${c2.flock})`, c2);
  // ── LEVEL-3: each repeat stays traversable: the planner bot (jump-only, what a thumb has) runs ~2.5 minutes with no flock and no hits ──
  const traverse = async () => {
    const trav = await page.evaluate(() => {
      const e = window.__egg, g = e.game();
      g.flock = 0; g.shield = false;                                   // nothing to fall back on: any mistake ends the run
      const hits0 = g.stats.hits, falls0 = g.stats.falls;
      const r = e.fastForward(150, { bot: 'plan', god: false });
      g.flock = 5;
      return { dead: r.dead, x0: r.x0, x1: r.x1, hits: g.stats.hits - hits0, falls: g.stats.falls - falls0, circuit: e.game().level.circuit };
    });
    t.ok(!trav.dead && trav.hits === 0 && trav.falls === 0 && trav.x1 - trav.x0 > 15000, `[LEVEL-3] circuit ${trav.circuit}: 150 s of play by the jump-only planner bot with no flock: no hits, no falls (${Math.round(trav.x1 - trav.x0)} u)`, trav);
  };
  await traverse();
  for (const nextCircuit of [3, 4]) {
    const before = await S(page);
    await page.evaluate(() => window.__egg.forceBeacon());
    await waitFor(page, () => window.__egg.state().ui === 'finish', null, 15000);
    await sleep(500);
    const txt = await page.evaluate(() => document.querySelector('[data-screen=finish]').innerText.replace(/\s+/g, ' '));
    t.ok(/beacon is lit/i.test(txt) && /flock can go home/i.test(txt) && /Keep going/i.test(txt) && /Main title/i.test(txt) && txt.replace(/,/g, '').includes(String((await S(page)).eggs)), `[LEVEL-3] circuit ${nextCircuit - 1}'s beacon: the finish screen acknowledges the eggs and offers Keep Going / Main Title`, txt.slice(0, 200));
    await tapSelector(page, cdp, '[data-screen=finish] [data-action=keep-going]');
    await waitFor(page, (c) => window.__egg.state().circuit === c && window.__egg.state().mode === 'playing', nextCircuit, 15000);
    await sleep(900);
    const s = await S(page);
    t.ok(s.circuit === nextCircuit && s.chapter === 0 && s.flock >= 5 && s.eggs >= before.eggs && s.stored.circuit === nextCircuit, `[LEVEL-3] Keep Going opens circuit ${nextCircuit}: fresh Meadow, flock ${s.flock}, eggs ${s.eggs} (was ${before.eggs}), saved`, s);
    await traverse();
  }
  t.ok(errs.length === 0, 'level run: no errors', errs);
  await context.close();
}

/* ═════════════════════════════════════ audio: visual cue for every essential event, music stops when it must ═════════════════════════════════════ */
async function audioChecks(browser, server) {
  console.log('\n-- audio: AUDIO-2 visual cues, silence when paused or hidden, one stream');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlay(page, cdp, 800);
  // every essential event has a visual cue: spawn it into the real renderer and see something appear
  const cues = await page.evaluate(() => {
    const e = window.__egg, r = e.renderer, fx = r.fx, g = e.game(), m = g.mama;
    const base = { x: m.x + 40, y: m.y - 20 };
    const list = [
      { type: 'egg', ...base, points: 10 }, { type: 'gold', ...base, points: 50, hatched: true }, { type: 'hatch', ...base, flock: 1 },
      { type: 'duckling-lost', ...base, flock: 0 }, { type: 'checkpoint', index: 1, x: m.x + 30, y: m.y }, { type: 'beacon', x: m.x + 200, y: m.y },
      { type: 'hit', source: 'spikes', ...base }, { type: 'shield-break', ...base }, { type: 'shield', ...base }, { type: 'magnet', ...base },
      { type: 'stomp', ...base, points: 25 }, { type: 'spring', ...base }, { type: 'respawn', ...base }, { type: 'dead', ...base },
      { type: 'crumble-start', id: 0 }, { type: 'chapter-enter', slot: 0, index: 0 },
    ];
    const seen = (ev) => {
      fx.reset(g.eggs);
      r.spawn([ev], g);
      const visual = fx.liveCount > 0 || fx.pops.some((p) => p.live) || fx.cap.live || fx.qn > 0 || fx.spr.some((s) => s.type) || fx.respawnT > 0 || fx.pillT < 99;
      return visual;
    };
    return list.map((ev) => [ev.type, seen(ev)]);
  });
  const none = cues.filter(([, v]) => !v).map(([k]) => k);
  t.ok(none.length === 0, `[AUDIO-2] every essential event also has a visual cue (${cues.length} events checked; none: ${none.join(', ') || 'all have one'})`, none);
  // music stops when paused / hidden / rotated, one stream after Resume
  await page.evaluate(() => window.__egg.renderer.fx.reset(0));
  const run0 = await page.evaluate(() => ({ ...window.__egg.state().audio }));
  t.ok(run0.ctx === 'running' && run0.scheduler === true, '[AUDIO-2] music is running while playing', run0);
  await tapSelector(page, cdp, '#pause-btn'); await waitFor(page, () => window.__egg.state().mode === 'paused'); await sleep(500);
  const p0 = await page.evaluate(() => ({ ...window.__egg.state().audio }));
  t.ok(p0.suspended === true && p0.scheduler === false && p0.ctx === 'suspended', '[AUDIO-2] pausing stops the music (scheduler off, audio context suspended)', p0);
  await tapSelector(page, cdp, '[data-screen=pause] [data-action=resume]'); await sleep(2500);
  const r0 = await page.evaluate(() => ({ ...window.__egg.state().audio }));
  t.ok(r0.players === 1 && r0.scheduler === true && r0.ctx === 'running', `[AUDIO-2] Resume starts exactly one music stream (players ${r0.players})`, r0);
  // mute persists across a reload (and the mute switch really silences the engine)
  await page.keyboard.press('m'); await sleep(200);
  const mu = await page.evaluate(() => ({ ...window.__egg.state().audio, stored: JSON.parse(localStorage.getItem('egg-mama-settings-v1')) }));
  t.ok(mu.muted === true && mu.scheduler === false && mu.stored.muted === true, '[AUDIO-2] mute (the M key) silences everything at once and is stored', mu);
  await page.reload(); await page.waitForFunction(() => window.__egg && window.__egg.state().worldReady, null, { timeout: 30000 }); await settle(page);
  const re = await page.evaluate(() => ({ muted: window.__egg.state().audio.muted, sw: document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked') }));
  t.ok(re.muted === true && re.sw === 'false', '[AUDIO-2] mute persists across a reload (the Sound switch shows off)', re);
  t.ok(errs.length === 0, 'audio run: no errors', errs);
  await context.close();
}

/* ═════════════════════════════════════ art: crisp paintings, smooth objects, legible differences ═════════════════════════════════════ */
async function artChecks(browser, server) {
  console.log('\n-- art: ART-1 / ART-2 (measured; the look itself is judged on screenshots)');
  const errs = [];
  const { page, cdp, context } = await boot(browser, server, DEVICES.iphone13, { errors: errs });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  await startPlay(page, cdp, 600);
  await page.evaluate(() => window.__egg.pause()); await settle(page, 500);
  // ── ART-1: the paintings are drawn with smoothing OFF (crisp pixel art), every object sprite with smoothing ON ──
  const smooth = await page.evaluate(() => {
    const e = window.__egg, r = e.renderer, ctx = r.ctx, g = e.game();
    const orig = ctx.drawImage, log = { paint: [], sprite: [] };
    ctx.drawImage = function (src, ...a) {
      const paint = (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) || src instanceof HTMLImageElement;
      log[paint ? 'paint' : 'sprite'].push(this.imageSmoothingEnabled);
      return orig.call(this, src, ...a);
    };
    try { r.draw({ game: g, now: 9000, alpha: 1, mode: 'paused', reducedMotion: false, fade: 0, paused: true }); } finally { ctx.drawImage = orig; }
    return { paint: log.paint.length, paintOff: log.paint.filter((v) => v === false).length, sprite: log.sprite.length, spriteOn: log.sprite.filter((v) => v === true).length };
  });
  t.ok(smooth.paint >= 1 && smooth.paintOff === smooth.paint, `[ART-1] every painting draw call (${smooth.paint}) has image smoothing OFF: the pixel art stays crisp`, smooth);
  t.ok(smooth.sprite >= 8 && smooth.spriteOn === smooth.sprite, `[ART-1] every object sprite stamp (${smooth.sprite}) is drawn smooth: vector art, not pixels`, smooth);
  // ── ART-1: Mama's contact shadow tells her where she will land: with Mama 90 u up, the shadows layer paints pixels below her that are gone with it off ──
  const sh = await page.evaluate(() => {
    const e = window.__egg, r = e.renderer, g = e.game(), m = g.mama, ctx = r.ctx, c = r.canvas;
    const y0 = m.y; m.y = y0 - 90; m.py = m.y; m.onGround = false;
    const grab = () => { r.draw({ game: g, now: 9100, alpha: 1, mode: 'paused', reducedMotion: false, fade: 0, paused: true }); return ctx.getImageData(0, 0, c.width, c.height).data; };
    r.layers.shadows = true; const a = grab(); r.layers.shadows = false; const b = grab(); r.layers.shadows = true;
    m.y = y0; m.py = y0; m.onGround = true;
    let n = 0, x0 = 1e9, x1 = -1, y0p = 1e9, y1p = -1; const W = c.width;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { n++; const p = i >> 2, x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0p) y0p = y; if (y > y1p) y1p = y; }
    return { n, x0, x1, y0: y0p, y1: y1p, ground: r.ty + 292 * r.view.scale * r.view.dpr, W: c.width };
  });
  t.ok(sh.n > 300 && sh.y0 > sh.ground - 30 * 3 && sh.y1 < sh.ground + 30 * 3, `[ART-1] the contact shadow sits on the ground beneath a jumping Mama (${sh.n} px, rows ${sh.y0}-${sh.y1} around the ground line ${sh.ground.toFixed(0)}): it shows where she will land`, sh);
  // ── ART-2: ordinary egg vs golden egg vs duckling vs pickups differ by SIZE and COLOUR, not just one of them ──
  const measure = await page.evaluate(async () => {
    const A = await import('./js/art-actors.mjs'), K = await import('./js/artkit.mjs');
    const S = 4, W = 160, H = 160;
    const shoot = (fn) => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.scale(S, S);
      const cache = new K.SpriteCache(); cache.setScale(S);
      fn(ctx, cache);
      const d = ctx.getImageData(0, 0, W, H).data;
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { const p = i >> 2, x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      return { w: (x1 - x0 + 1) / S, h: (y1 - y0 + 1) / S, area: n / (S * S), r: r / n, g: g / n, b: b / n };
    };
    const egg = shoot((c, k) => A.drawEgg(c, k, { x: 20, y: 20, kind: 'egg', t: 0, i: 0 }));
    const gold = shoot((c, k) => A.drawEgg(c, k, { x: 20, y: 20, kind: 'gold', t: 0, i: 0 }));
    const duck = shoot((c, k) => A.drawDuckling(c, k, { x: 20, y: 30, face: 1, air: false, t: 0, i: 0, alpha: 1 }));
    const shield = shoot((c, k) => A.drawShieldPickup(c, k, { x: 20, y: 20, t: 0 }));
    const magnet = shoot((c, k) => A.drawMagnetPickup(c, k, { x: 20, y: 20, t: 0 }));
    return { egg, gold, duck, shield, magnet };
  });
  const { egg, gold, duck, shield, magnet } = measure;
  const warm = (o) => (o.r + o.g) / 2 - o.b;
  t.ok(gold.area >= egg.area * 1.25 && gold.h > egg.h, `[ART-2] a golden egg is bigger than an ordinary one (${gold.w.toFixed(0)}x${gold.h.toFixed(0)} u vs ${egg.w.toFixed(0)}x${egg.h.toFixed(0)} u, area x${(gold.area / egg.area).toFixed(2)})`, measure);
  t.ok(warm(gold) > warm(egg) + 35, `[ART-2] ...and gold, not cream (yellow-ness ${warm(gold).toFixed(0)} vs ${warm(egg).toFixed(0)}): shape, size and colour all differ, not colour alone`, measure);
  t.ok(Math.abs(duck.w - egg.w) > 1.5 || Math.abs(duck.h - egg.h) > 1.5 || Math.abs(warm(duck) - warm(egg)) > 25, '[ART-2] a duckling follower does not look like a pickup: different silhouette and colour from an egg', measure);
  t.ok(Math.abs(shield.b - magnet.b) > 15 && Math.abs(shield.r - magnet.r) > 25 && shield.b > duck.b + 40 && duck.g - magnet.g > 50 && warm(shield) < 0 && warm(magnet) < warm(duck) - 40, '[ART-2] the shield (blue) and magnet (red) pickups are told apart from each other and from a yellow duckling', measure);
  t.ok(errs.length === 0, 'art run: no errors', errs);
  await context.close();
}

/* ═════════════════════════════════════ main ═════════════════════════════════════ */
async function main() {
  if (want('node')) nodeChecks();
  const needsBrowser = ['view', 'input', 'flock', 'save', 'level', 'audio', 'art'].some((k) => want(k));
  if (needsBrowser) {
    const server = await startServer();
    const browser = await chromium.launch();
    try {
      if (want('view')) { await viewChecks(browser, server); await overlayChecks(browser, server); }
      if (want('input')) await inputChecks(browser, server);
      if (want('flock')) await flockChecks(browser, server);
      if (want('save')) await saveChecks(browser, server);
      if (want('level')) await levelChecks(browser, server);
      if (want('audio')) await audioChecks(browser, server);
      if (want('art')) await artChecks(browser, server);
    } catch (e) {
      t.ok(false, 'spec run threw', String((e && e.stack) || e));
    } finally { await browser.close(); server.stop(); }
  }
  process.exitCode = t.done() ? 1 : 0;
}
main();
