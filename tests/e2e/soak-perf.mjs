#!/usr/bin/env node
/*
 * Egg Mama — frame cost, long tasks and the adaptive-dpr safety net in the REAL loop (run by hand; NOT `node --test`).
 *
 *   node tests/e2e/soak-perf.mjs [--quick] [--throttle 6] [--sections A,B,C,D] [--landscapes 0,2,5,8,9,12]
 *
 * Real Chromium, SOFTWARE rasteriser (no GPU), iPhone 13 landscape 844x390 @3 = a 2532x1170 canvas, shared 4 cores: the absolute
 * numbers are this machine's, not a phone's. What carries over is the shape: which landscape is the expensive one, what in it costs,
 * what causes a hitch, and that the safety net reacts and does not oscillate.
 *
 *   A  frame cost per landscape (Meadow, Reedwater (water), Fogwood (mist), Lantern Caverns (dark), Frostline (ice), Summit): the real
 *      rAF loop with the autopilot (JS ms per frame and rAF-to-rAF p50/p95/max over 600 frames) and a bench of sim + draw + a 1-px
 *      read-back (the rasteriser's own work included), then a per-LAYER breakdown (each renderer layer switched off in turn).
 *   B  long tasks (PerformanceObserver 'longtask', >= 50 ms) while rolling through landscape changes at 1x (--cross 1,2,5 picks which; the
 *      run starts 6600 u before the edge and the first 5 s, the teleport's own cold start, are not counted) with preload and song prebuild
 *      as in play: how many, where (x relative to the landscape edge) and what they follow (renderer.preload, a song change, a slot
 *      change, a checkpoint save). Plus the cost of building every song cold (SONGS[id], and audio.playSong's compile).
 *   C  the adaptive-dpr net under CDP Emulation.setCPUThrottlingRate (default 6x) at 1x: it steps the resolution down, never oscillates,
 *      keeps the canvas equal to the stage, play carries on; then the throttle is lifted and it may step back up, one notch per ~30 s.
 *   D  the cold start of a landscape nobody preloaded (a teleport): the worst draw frames in the first second.
 * --profile adds a CPU sampling profile (0.5 ms) around each crossing in B and prints the three busiest stretches with their top functions
 *   (this is what showed drawWater at the top of the stack in Reedwater: the frame there is raster-bound, not JS-bound).
 * --quick runs A (3 landscapes, no breakdown except Reedwater), B (two crossings), C (30 s throttled) and D: about 5 minutes.
 */
import os from 'node:os';
import { chromium, startRepoServer, soakBoot, startPlaying, parseArgs, reporter, shot, sleep, pct, f1, longTasks } from './soak-lib.mjs';
import { CHAPTERS } from '../../docs/js/chapters.mjs';


/**
 * CPU-profile attribution of long tasks: a sampling profile (0.5 ms) of the main thread; every busy run (no idle sample for >= 40 ms) is
 * listed with its top self-time functions and its share of garbage collection.
 */
async function profileStart(cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
async function profileStop(cdp, minMs = 40) {
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const label = (n) => { const c = n.callFrame; const f = c.functionName || '(anonymous)'; return c.url ? `${f} ${c.url.split('/').slice(-1)[0]}:${c.lineNumber + 1}` : f; };
  const runs = [];
  let cur = null, tms = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]), dt = (profile.timeDeltas[i] || 0) / 1000;
    tms += dt;
    const idle = n.callFrame.functionName === '(idle)';
    if (idle) { if (cur) { runs.push(cur); cur = null; } continue; }
    if (!cur) cur = { start: tms - dt, ms: 0, fn: new Map() };
    cur.ms += dt; const k = label(n); cur.fn.set(k, (cur.fn.get(k) || 0) + dt);
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.ms >= minMs).map((r) => ({ ms: r.ms, at: r.start, top: [...r.fn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(0)}ms`) }));
}

const args = parseArgs();
const QUICK = !!args.quick;
const SECTIONS = String(args.sections ?? 'A,B,C,D').toUpperCase().split(',');
const on = (s) => SECTIONS.includes(s);
const RATE = args.throttle ?? 6;
const SEED = 20261123;
const ALL = [0, 2, 5, 8, 9, 12];
const SPOTS = String(args.landscapes ?? (QUICK ? '0,2,8' : ALL.join(','))).split(',').map(Number);
const t = reporter('frame cost, long tasks and the dpr net (software rasteriser, 844x390 @3)');
const errors = [];

const server = await startRepoServer();
const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
let failures = 1;
try {
  const { context, page, cdp } = await soakBoot(browser, server, { journeySeed: SEED, circuit: 1, errors, device: 'iphone13', driver: false });
  await page.evaluate(() => { window.__egg.adaptive().enabled = false; });
  // what the page itself costs to get going: the long tasks of the boot (world generation is one of them) before anything is touched
  const bootTasks = await longTasks(page);
  const bootGen = await page.evaluate(() => window.__egg.state().genMs);
  console.log(`  boot: the world took ${f1(bootGen)} ms to generate in the page (a phone is ~3x slower, behind the title screen); long tasks (>= 50 ms) from the page load until the title is up: ${bootTasks.length}${bootTasks.length ? ' [' + bootTasks.map((l) => f1(l.d) + ' ms at ' + Math.round(l.s)).join(', ') + ']' : ''}`);
  t.ok(bootTasks.length <= 3 && bootTasks.every((l) => l.d < 400), `the boot has at most a few long tasks, none over 400 ms (${bootTasks.map((l) => f1(l.d)).join(', ') || 'none'})`);
  // the cost of building every song's data cold, measured before anything has played (a fresh page)
  const songCost = await page.evaluate(() => {
    const out = [], S = window.__egg.SONGS;
    for (const id of Object.keys(S)) { const t0 = performance.now(); void S[id]; out.push({ id, build: +(performance.now() - t0).toFixed(1) }); }
    return out;
  });
  await startPlaying(page, cdp);
  await sleep(500);
  const st = () => page.evaluate(() => window.__egg.state());
  const x0Of = (i) => page.evaluate((k) => window.__egg.level().chapters[k].x0, i);
  const frames = (n) => page.waitForFunction((k) => window.__egg.perfStats().frames >= k, n, { timeout: 180000, polling: 200 });

  /* ───────── A ───────── */
  if (on('A')) {
    console.log('\n-- A. frame cost per landscape (real loop with the autopilot, then bench)');
    await page.evaluate(() => window.__egg.autoplay(true));
    const res = {};
    for (const i of SPOTS) {
      const name = CHAPTERS[i].name;
      const x0 = await x0Of(i);
      await page.evaluate((x) => window.__egg.teleport(x), x0 + 8000);
      await sleep(3500);                                                  // the painting decodes, the sprites bake
      await page.evaluate(() => window.__egg.resetPerf());
      await frames(600);
      const p = await page.evaluate(() => window.__egg.perfStats());
      const b = await page.evaluate(() => window.__egg.bench(300));
      const s = await st();
      res[i] = { p, b };
      console.log(`  ${String(i + 1).padStart(2)} ${name.padEnd(16)} real loop: JS ${p.busyP50}/${p.busyP95} ms, rAF gap ${p.gapP50}/${p.gapP95} ms (p50/p95) | bench: JS ${b.js.p50}/${b.js.p95}, with raster ${b.withRaster.p50}/${b.withRaster.p95} (max ${b.withRaster.max}) | on screen ${b.stats.platforms} platforms, ${b.stats.pickups} pickups, ${b.stats.enemies} enemies`);
      if (i === 2 || i === 8) await shot(page, `soak-perf-${i}`);
      t.ok(s.errors === 0 && !s.crashed, `${name}: no errors`);
      t.ok(p.busyP95 < 40, `${name}: the JS side of a frame stays small (p95 ${p.busyP95} ms)`);
      // breakdown by layer (still frame, 100 frames each)
      if (!QUICK || i === 2) {
        await page.evaluate(() => window.__egg.autoplay(false));
        const full = await page.evaluate(() => window.__egg.bench(100, { advance: false }));
        const L = await page.evaluate(() => Object.keys(window.__egg.renderer.layers));
        const cost = [];
        for (const layer of L) {
          await page.evaluate((k) => { window.__egg.renderer.layers[k] = false; }, layer);
          const r = await page.evaluate(() => window.__egg.bench(100, { advance: false }));
          await page.evaluate((k) => { window.__egg.renderer.layers[k] = true; }, layer);
          cost.push([layer, full.withRaster.p50 - r.withRaster.p50]);
        }
        cost.sort((a, b) => b[1] - a[1]);
        console.log(`     still frame p50 ${full.withRaster.p50} ms; what each layer costs (p50 saved by switching it off): ${cost.slice(0, 6).map(([k, v]) => `${k} ${f1(v)}`).join(', ')}`);
        res[i].layers = cost;
        await page.evaluate(() => window.__egg.autoplay(true));
      }
    }
    // the dissolve between two landscapes (+-520 u around an edge) draws two paintings, two skies of weather and two waters: what does it cost?
    if (on('A') && (args.dissolve !== false)) {
      console.log('  the dissolve (a still frame at the very middle of the edge INTO each landscape, against the same landscape mid-way):');
      await page.evaluate(() => window.__egg.autoplay(false));
      for (const i of SPOTS.filter((k) => k > 0)) {
        const x0 = await x0Of(i);
        const spot = async (x) => { await page.evaluate((v) => window.__egg.teleport(v), x); await sleep(1500); return page.evaluate(() => window.__egg.bench(120, { advance: false })); };
        const mid = await spot(x0 + 8000), edge = await spot(x0);
        const L = await page.evaluate(() => Object.keys(window.__egg.renderer.layers));
        const cost = [];
        for (const layer of L) {
          await page.evaluate((k) => { window.__egg.renderer.layers[k] = false; }, layer);
          const r = await page.evaluate(() => window.__egg.bench(100, { advance: false }));
          await page.evaluate((k) => { window.__egg.renderer.layers[k] = true; }, layer);
          cost.push([layer, edge.withRaster.p50 - r.withRaster.p50]);
        }
        cost.sort((a, b) => b[1] - a[1]);
        console.log(`    ${CHAPTERS[i].name.padEnd(16)} mid-landscape ${mid.withRaster.p50}/${mid.withRaster.p95} ms, at the edge ${edge.withRaster.p50}/${edge.withRaster.p95} ms (p50/p95): the dissolve adds ${f1(edge.withRaster.p50 - mid.withRaster.p50)} ms; layers at the edge: ${cost.slice(0, 5).map(([k, v]) => `${k} ${f1(v)}`).join(', ')}`);
        res[i].edge = edge;
      }
    }
    const worst = Object.entries(res).sort((a, b) => b[1].b.withRaster.p50 - a[1].b.withRaster.p50)[0];
    console.log(`  the heaviest frame here is ${CHAPTERS[worst[0]].name}: ${worst[1].b.withRaster.p50}/${worst[1].b.withRaster.p95} ms (p50/p95) against a 16.7 ms budget`);
    const vals = Object.entries(res);
    const over = vals.filter(([, r]) => r.b.withRaster.p50 > 16.7).map(([k, r]) => `${CHAPTERS[k].name} ${r.b.withRaster.p50} ms`);
    console.log(`  over the 16.7 ms budget at p50 on this software rasteriser: ${over.length ? over.join(', ') : 'none'}; rAF gap p95 per landscape: ${vals.map(([k, r]) => r.p.gapP95).join(' ')} ms`);
    // (thresholds leave room for this shared machine's +-20 % run-to-run noise; the printed numbers are the report)
    t.ok(vals.every(([, r]) => r.p.gapP50 < 20), `the real loop's typical frame is 60 fps in every landscape measured (rAF gap p50 ${vals.map(([, r]) => r.p.gapP50).join(' ')} ms)`);
    t.ok(vals.every(([, r]) => r.p.gapP95 < 40), `...and it never turns into a slideshow (worst rAF gap p95 ${Math.max(...vals.map(([, r]) => r.p.gapP95))} ms)`);
    t.ok(vals.every(([, r]) => r.b.withRaster.p50 < 20 && r.b.withRaster.p95 < 35), `a whole frame (sim + draw + raster read-back) costs under 20 ms at p50 and 35 ms at p95 everywhere (worst ${Math.max(...vals.map(([, r]) => r.b.withRaster.p50))} / ${Math.max(...vals.map(([, r]) => r.b.withRaster.p95))} ms)`);
    const edges = vals.filter(([, r]) => r.edge);
    if (edges.length) t.ok(edges.every(([, r]) => r.edge.withRaster.p95 < 50), `even the dissolve between two landscapes draws in under 50 ms at p95 (worst ${Math.max(...edges.map(([, r]) => r.edge.withRaster.p95))} ms)`);
  }

  /* ───────── B ───────── */
  if (on('B')) {
    console.log('\n-- B. long tasks while rolling through landscape changes at 1x');
    const sc = songCost.slice().sort((a, b) => b.build - a.build);
    console.log(`  building each song's data cold in a fresh page (SONGS[id]): the largest ${sc.slice(0, 4).map((s) => `${s.id} ${s.build} ms`).join(', ')}`);
    t.ok(sc[0].build < 50, `no single song takes 50 ms to build even cold (${sc[0].id} ${sc[0].build} ms)`);

    const targets = args.cross !== undefined ? String(args.cross).split(',').map(Number) : (QUICK ? [1, 2] : [1, 2, 5, 8, 9, 12]);
    const all = { n: 0, byCause: {}, list: [] };
    await page.evaluate(() => {
      const e = window.__egg, a = e.audio, r = e.renderer;
      window.__mk = [];
      const mark = (name, extra) => window.__mk.push({ name, at: performance.now(), ...extra });
      const op = r.preload.bind(r);
      r.preload = (i) => { mark('preload-start', { i }); const p = op(i); Promise.resolve(p).then(() => mark('preload-end', { i }), () => {}); return p; };
      const ps = a.playSong.bind(a);
      a.playSong = (id, o) => { const t0 = performance.now(); const x = ps(id, o); mark('song', { id, ms: +(performance.now() - t0).toFixed(1) }); return x; };
      const an = r.announceChapter ? r.announceChapter.bind(r) : null; if (an) r.announceChapter = (...q) => { mark('announce'); return an(...q); };
      window.__rec = { n: 0, wall: new Float64Array(30000), x: new Float32Array(30000), slot: new Int8Array(30000), ms: new Float32Array(30000) };
      (function loop(now) {
        const R = window.__rec, i = R.n, g = e.game();
        if (i < 30000) { R.wall[i] = now; R.x[i] = g.mama.x; R.slot[i] = g.slot; R.ms[i] = r.lastFrameMs; R.n++; }
        if (i > 0 && R.slot[i - 1] !== g.slot) mark('slot-change', { slot: g.slot });
        requestAnimationFrame(loop);
      })(performance.now());
    });
    for (const i of targets) {
      const x0 = await x0Of(i);
      if (args.profile) await profileStart(cdp);
      // a teleport lands in a landscape nobody preloaded: its cold start (section D) is not a landscape CHANGE, so let it pass first
      await page.evaluate((x) => { window.__egg.teleport(x); window.__egg.autoplay(true); }, x0 - 6600);
      await sleep(5000);
      await page.evaluate(() => { window.__mk.length = 0; window.__rec.n = 0; });
      const lt0 = (await longTasks(page)).length;
      const t0 = Date.now();
      while (true) {
        const s = await st();
        if (s.mama.x > x0 + 900 || Date.now() - t0 > 90000 || s.mode !== 'playing') break;
        await sleep(500);
      }
      const busy = args.profile ? (await profileStop(cdp, 40)).sort((a, b) => b.ms - a.ms).slice(0, 3) : [];
      const lts = (await longTasks(page)).slice(lt0);
      const info = await page.evaluate(() => ({ mk: window.__mk.slice(), n: window.__rec.n, wall: Array.from(window.__rec.wall.subarray(0, window.__rec.n)), x: Array.from(window.__rec.x.subarray(0, window.__rec.n)), ms: Array.from(window.__rec.ms.subarray(0, window.__rec.n)) }));
      const rows = [];
      for (const l of lts) {
        // skip the one caused by our own teleport (first second)
        const k = info.wall.findIndex((w) => w >= l.s);
        const x = k >= 0 ? info.x[k] : 0;
        const prior = info.mk.filter((m) => m.at <= l.s + l.d && m.at >= l.s - 150).sort((a, b) => b.at - a.at)[0];
        const cause = !prior ? 'unattributed' : prior.name === 'song' ? `song ${prior.id} (playSong ${prior.ms} ms)` : prior.name === 'preload-start' || prior.name === 'preload-end' ? `${prior.name} landscape ${prior.i}` : prior.name;
        rows.push({ d: l.d, off: Math.round(x - x0), cause, t: l.s });
      }
      const during = rows;
      for (const r of during) { all.n++; const key = r.cause.replace(/ landscape \d+| \(playSong.*\)|song .*/, (m) => (m.startsWith('song') ? 'song' : '')).trim() || r.cause; all.byCause[key] = (all.byCause[key] || 0) + 1; all.list.push({ into: CHAPTERS[i].name, ...r }); }
      const slow = []; for (let k = 1; k < info.n; k++) if (info.wall[k] - info.wall[k - 1] > 25) slow.push(`${(info.wall[k] - info.wall[k - 1]).toFixed(0)} ms at ${Math.round(info.x[k] - x0)} (draw ${f1(info.ms[k])} ms)`);
      const lavg = os.loadavg()[0];
      // where the dropped frames fall: before / during the preload of the next landscape, plain rolling, the dissolve (+-520 u), after it
      const zones = [['before preload', -1e9, -5720], ['preload + bake', -5720, -4600], ['rolling', -4600, -520], ['dissolve', -520, 520], ['after', 520, 1e9]];
      const zs = zones.map(([name, a, b]) => { let n = 0, bad = 0; for (let k = 1; k < info.n; k++) { const off = info.x[k] - x0; if (off >= a && off < b) { n++; if (info.wall[k] - info.wall[k - 1] > 25) bad++; } } return `${name} ${n ? (100 * bad / n).toFixed(1) : '-'}% of ${n}`; });
      const draws = info.ms.slice(60).filter((v) => v > 0).sort((a, b) => b - a);
      const songs = info.mk.filter((m) => m.name === 'song');
      console.log(`  into ${CHAPTERS[i].name.padEnd(16)} ${(info.n / 60).toFixed(0)} s: long tasks ${during.length}${during.length ? ' [' + during.map((r) => `${f1(r.d)} ms at ${r.off >= 0 ? '+' : ''}${r.off} u after ${r.cause}`).join('; ') + ']' : ''}; slow frames (> 25 ms) ${slow.length} of ${info.n}${slow.length ? ' (' + slow.slice(0, 5).join(', ') + ')' : ''}; machine load average ${f1(lavg)}; dropped-frame share by zone: ${zs.join(', ')}; renderer's own draw max ${f1(draws[0] || 0)} ms (p99 ${f1(pct(draws, 0.01))}); playSong calls ${songs.map((m) => m.id + ' ' + m.ms + 'ms').join(', ') || '-'}; markers ${info.mk.filter((m) => m.name !== 'song').map((m) => `${m.name}${m.i !== undefined ? ':' + m.i : ''}@${Math.round(info.x[Math.max(0, info.wall.findIndex((w) => w >= m.at))] - x0)}`).slice(0, 6).join(' ')}`);
      for (const b of busy) console.log(`     busiest stretch (--profile; a stretch can span several tasks and is mostly native raster '(program)') of ${b.ms.toFixed(0)} ms (profile): ${b.top.join('; ')}`);
      await shot(page, `soak-perf-cross-${i}`);
    }
    await page.evaluate(() => window.__egg.autoplay(false));
    console.log(`  long tasks over ${targets.length} landscape changes: ${all.n} (${JSON.stringify(all.byCause)})`);
    t.ok(all.n <= targets.length * 2, `at most two long tasks per landscape change (${all.n} over ${targets.length} changes)`, all.list.slice(0, 6));
    t.ok(all.list.every((r) => r.d < 250), `none of them is a freeze (under 250 ms) (longest ${f1(Math.max(0, ...all.list.map((r) => r.d)))} ms)`);
  }

  /* ───────── C ───────── */
  if (on('C')) {
    console.log(`\n-- C. the dpr safety net under a ${RATE}x CPU throttle`);
    await page.evaluate((x) => { window.__egg.teleport(x); window.__egg.setSpeed(1); window.__egg.autoplay(true); const a = window.__egg.adaptive(); a.enabled = true; a.i = 0; a.downs = 0; a.ups = 0; a.reset(); window.__egg.renderer.resize(844, 390, 3, window.__egg.ui.insets()); }, (await x0Of(2)) + 8000);
    await sleep(2000);
    const trace = [];
    const sample = async (label) => { const s = await st(); const row = { label, dpr: s.dpr, ema: s.adaptive.ema, downs: s.adaptive.downs, ups: s.adaptive.ups, canvas: `${s.canvas.w}x${s.canvas.h}`, viewDpr: s.view.dpr, mode: s.mode, errors: s.errors, wall: Date.now() }; trace.push(row); return row; };
    const base = await sample('before');
    console.log(`  before: dpr ${base.dpr}, smoothed frame ${base.ema} ms`);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
    const tT = Date.now();
    const limit = QUICK ? 30000 : 70000;
    while (Date.now() - tT < limit) {
      await sleep(2500);
      const r = await sample(`throttled ${Math.round((Date.now() - tT) / 1000)}s`);
      console.log(`  ${r.label.padEnd(16)} dpr ${r.dpr} (canvas ${r.canvas}), smoothed frame ${r.ema} ms, steps down ${r.downs} up ${r.ups}`);
    }
    const thr = await sample('end of throttle');
    t.ok(thr.downs >= 1 && thr.dpr < 3, `under ${RATE}x CPU throttle the resolution stepped down (3 -> ${thr.dpr}, ${thr.downs} step${thr.downs === 1 ? '' : 's'}; smoothed frame ${thr.ema} ms)`);
    const seqT = trace.map((r) => r.dpr);
    t.ok(seqT.every((v, i) => i === 0 || v <= seqT[i - 1]) && thr.ups === 0, `while the load lasts it only ever goes down (${[...new Set(seqT)].join(' -> ')}): no oscillation`);
    t.ok(trace.every((r) => r.canvas === `${Math.round(844 * r.viewDpr)}x${Math.round(390 * r.viewDpr)}`), 'the canvas equalled the stage at every resolution it used');
    t.ok(thr.mode === 'playing' && thr.errors === 0, 'play carried on through every resolution change');
    await shot(page, 'soak-perf-throttled');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    // lift it: the net may step up one notch per ~30 s of comfort, and must not bounce back down
    const tR = Date.now(), recover = [];
    const rlimit = QUICK ? 5000 : 100000;
    while (Date.now() - tR < rlimit) {
      await sleep(5000);
      const r = await sample(`released ${Math.round((Date.now() - tR) / 1000)}s`);
      recover.push(r);
      console.log(`  ${r.label.padEnd(16)} dpr ${r.dpr}, smoothed frame ${r.ema} ms, steps down ${r.downs} up ${r.ups}`);
    }
    if (!QUICK) {
      const fin = recover[recover.length - 1];
      t.ok(fin.ups >= 1 && fin.ups <= 4, `with the load gone it steps back up (${fin.ups} step${fin.ups === 1 ? '' : 's'} in ${rlimit / 1000} s, at most one per ~30 s)`);
      t.ok(fin.downs === thr.downs, `and does not bounce: no further step down after the throttle was lifted (${thr.downs} -> ${fin.downs})`);
    }
    await page.evaluate(() => { window.__egg.autoplay(false); window.__egg.adaptive().enabled = false; window.__egg.renderer.resize(844, 390, 3, window.__egg.ui.insets()); });
  }

  /* ───────── D ───────── */
  if (on('D')) {
    console.log('\n-- D. cold start of a landscape nobody preloaded (a teleport into Lantern Caverns)');
    await page.evaluate((x) => {
      const e = window.__egg, r = e.renderer;
      window.__cold = { ms: [], wall: [] };
      const d = r.draw.bind(r);
      r.draw = function (o) { const t0 = performance.now(); const v = d(o); window.__cold.ms.push(performance.now() - t0); window.__cold.wall.push(t0); return v; };
      window.__egg.teleport(x);              // (building the new Game object is a ~30 ms task of its own: the test's, not the player's)
    }, (await x0Of(8)) + 9000);
    await sleep(200);
    const lt0 = (await longTasks(page)).length;
    await sleep(2800);
    const cold = await page.evaluate(() => { const c = window.__cold; return { ms: c.ms.slice(0, 180), }; });
    await page.evaluate(() => window.__egg.autoplay(false));
    const lt = (await longTasks(page)).slice(lt0);
    const sorted = cold.ms.slice().sort((a, b) => b - a);
    console.log(`  first 3 s of draw() calls: worst ${sorted.slice(0, 5).map(f1).join(', ')} ms; median ${f1(pct(cold.ms, 0.5))}; long tasks ${lt.length}${lt.length ? ' (' + lt.map((l) => f1(l.d) + ' ms').join(', ') + ')' : ''}`);
    t.ok(sorted[0] < 150, `even a cold landscape draws its first frames without a freeze (worst draw call ${f1(sorted[0])} ms of JS)`);
  }

  const s = await st();
  t.ok(s.errors === 0 && errors.length === 0, 'no console, page or game errors', errors.slice(0, 3));
  failures = t.done();
  await context.close();
} catch (e) {
  console.error('\nUNCAUGHT:', e);
} finally {
  await browser.close();
  server.stop();
}
process.exitCode = failures ? 1 : 0;
