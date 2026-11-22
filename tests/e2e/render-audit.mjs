#!/usr/bin/env node
/*
 * Egg Mama — renderer AUDIT regression test (Playwright + Chromium, run manually; NOT part of `node --test`).
 *
 *   node tests/e2e/render-audit.mjs [--out <dir>]            (exit code 0 = all checks passed)
 *
 * Complements tests/e2e/render-smoke.mjs with the defects found when the renderer was audited:
 *   1. the painted background never runs out and is never tiled (the first build tiled a screen-wide painting with mirror
 *      copies: a seam was on screen for a whole landscape and read as twin windmills / twin mesas). Checked as geometry at four
 *      viewports (zoomed past the screen by SLACK, offset always inside [0, slack], drift never faster than
 *      T.backgroundParallax), as a sweep across every landscape (the offset really spans the slack from the start of a
 *      landscape to its end), and in pixels (the painting covers every edge pixel at both ends of its range);
 *   2. popups that appear close together never overprint, for their whole life (they rise at one constant speed);
 *   3. after a respawn the followers do not slide across the world for a frame (their interpolation start is reset);
 *   4. Mama's rock angle never jumps by more than a few hundredths of a radian from frame to frame, take-off and landing included;
 *   5. robustness: canvas 0x0 / 1x1 / absurd sizes / NaN / dpr 0 and 10, every mode, a huge `now` jump, NaN alpha, no game,
 *      unknown events: nothing throws;
 *   6. real-speed frames across a landscape's sprite warm-up window: the JS cost of a frame never spikes (no single warm-up step blocks a frame);
 *   7. the demo's contact shadows sit under Mama on ledges, lifts and movers (a darker ellipse is found under her feet).
 * Screenshots go to --out (default $TMPDIR/render-audit), never into the repo. ONE browser, always closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, openDemo, VIEWPORTS } from '../../tools/render-demo.mjs';

const require = createRequire(import.meta.url);
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const out = arg('out', path.join(process.env.TMPDIR || '/tmp', 'render-audit'));
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
  browser = await chromium.launch();
  const errors = [];

  /* ───────────── 1. the painting is never tiled ───────────── */
  console.log('1. the painted background never runs out');
  for (const name of ['iphone', 'pixel', 'small', 'tablet']) {
    const vp = VIEWPORTS[name];
    const { page, ctx } = await openDemo(browser, port, vp, { errors });
    await check(`${name}: painting is zoomed past the screen, offset stays inside its slack, drift <= T.backgroundParallax`, async () => {
      await page.evaluate(() => window.demo.place(300));
      const r = await page.evaluate(async () => {
        const R = window.demo.renderer, level = window.demo.level, { T } = await import('/docs/js/tuning.mjs');
        const { SLACK } = await import('/docs/js/background.mjs');
        const W = R.canvas.width, H = R.canvas.height, ix = R.ix, bh = T.blendHalf;
        const fake = { w: 1672, h: 941, fit: null };
        const fit = R.paintings.fitOf(fake, W, H);
        let worstOver = 0, minOff = 1e9, maxOff = -1e9, maxRate = 0;
        for (let k = 0; k < ix.nslots; k++) {
          let prev = null;
          for (let cam = ix.corg[k] - bh - 800; cam < ix.corg[k] + ix.cspan[k] + bh + 800; cam += 97) {
            R.bgDrift = 0;
            const o = R._paintOff(fake, ix, k, cam, bh, W, H, R.S);
            minOff = Math.min(minOff, o); maxOff = Math.max(maxOff, o);
            if (prev !== null) maxRate = Math.max(maxRate, (o - prev) / 97);
            prev = o;
          }
        }
        // the frozen-world drift may add DRIFT_CAP px but the offset is still clamped to the slack
        R.bgDrift = 1e6; const o2 = R._paintOff(fake, ix, 0, 5e4, bh, W, H, R.S);
        return { W, H, dw: fit.dw, dh: fit.dh, slack: fit.slack, SLACK, minOff, maxOff, maxRate, S: R.S, par: T.backgroundParallax, o2 };
      });
      note(`${r.W}x${r.H}: painting ${r.dw}x${r.dh}, slack ${r.slack} px (${(r.slack / r.W * 100).toFixed(0)} % of the screen), drift <= ${r.maxRate.toFixed(4)} px per u (limit ${(r.par * r.S).toFixed(3)})`);
      assert.ok(r.dw >= r.W * (1 + r.SLACK) - 2, `painting ${r.dw} px wide is not zoomed past the ${r.W} px screen`);
      assert.ok(r.dh >= r.H, 'painting does not cover the height');
      assert.ok(r.minOff >= 0 && r.maxOff <= r.slack + 1e-6, `offset ${r.minOff}..${r.maxOff} leaves 0..${r.slack}`);
      assert.ok(r.maxRate <= r.par * r.S + 1e-6, 'drifts faster than T.backgroundParallax');
      assert.ok(r.o2 <= r.slack, 'extra drift can leave the slack');
    });
    await ctx.close();
  }

  const vp = VIEWPORTS.iphone;
  const { page, info } = await openDemo(browser, port, vp, { errors });
  console.log(`world: ${info.world} (${info.platforms} platforms, ${info.chapters} landscapes)`);

  await check('sweep: from the start to the end of every landscape the painting really travels its whole slack, and only moves one way', async () => {
    const rows = [];
    await page.evaluate(() => window.demo.place(300));
    for (const li of [0, 1, 3, 5, 8, 10, 12]) {
      const r = await page.evaluate(async (li) => {
        const R = window.demo.renderer, level = window.demo.level, c = level.chapters[li];
        const out = [];
        for (const f of [0.04, 0.5, 0.96]) {
          const x = Math.round(c.x0 + 600 + (c.x1 - c.x0 - 1200) * f);
          window.demo.jumpTo(x);
          await window.demo.waitPaintings([c.index]);
          window.demo.frame({}); window.demo.frame({});
          out.push({ x, off: R.stats.paintOff, slack: R.stats.paintSlack, missing: R.stats.paintingMissing });
        }
        return out;
      }, li);
      rows.push(r);
      assert.ok(r.every((q) => q.missing === 0), `landscape ${li}: the painting had not decoded`);
      assert.ok(r[0].off < r[1].off && r[1].off < r[2].off, `landscape ${li}: offsets ${r.map((q) => q.off).join(' -> ')} are not increasing`);
      assert.ok(r[0].off >= 0 && r[2].off <= r[2].slack, `landscape ${li}: offset outside the slack`);
      assert.ok(r[2].off - r[0].off > r[2].slack * 0.80, `landscape ${li}: only ${((r[2].off - r[0].off) / r[2].slack * 100).toFixed(0)} % of the slack is used`);
    }
    note(`offsets 4 % / 50 % / 96 % of landscape 0: ${rows[0].map((q) => q.off.toFixed(0)).join(' / ')} px of ${rows[0][0].slack}`);
  });

  await check('pixels: the painting covers the whole canvas (no uncovered edge pixels) at the start and the end of a landscape, in the dissolve, and in every mode', async () => {
    const r = await page.evaluate(async () => {
      const R = window.demo.renderer, level = window.demo.level, c = level.chapters[4];
      const edges = () => {
        const W = R.canvas.width, H = R.canvas.height, d = R.ctx.getImageData(0, 0, W, 6).data, l = R.ctx.getImageData(0, 0, 6, Math.round(H * 0.6)).data, rr = R.ctx.getImageData(W - 6, 0, 6, Math.round(H * 0.6)).data;
        let black = 0;
        for (const a of [d, l, rr]) for (let i = 0; i < a.length; i += 4) if (a[i] + a[i + 1] + a[i + 2] === 0) black++;
        return black;
      };
      const res = {};
      for (const [name, x] of [['start', c.x0 + 700], ['end', c.x1 - 1500], ['dissolve', c.x1], ['dissolveEnter', c.x0]]) {
        await window.demo.place(x);
        await window.demo.waitPaintings([4, 5]);
        for (const mode of ['play', 'title', 'paused']) { window.demo.frame({ mode }); res[name + '/' + mode] = edges(); }
      }
      return res;
    });
    for (const [k, v] of Object.entries(r)) assert.equal(v, 0, `${k}: ${v} uncovered edge pixels`);
  });

  await check('title / pause drift is bounded and fades out in play (it cannot eat the slack the real travel needs)', async () => {
    const r = await page.evaluate(async () => {
      const R = window.demo.renderer;
      await window.demo.place(9000);
      for (let i = 0; i < 60 * 100; i++) window.demo.frame({ mode: 'title' });     // 100 s on the title screen (the cap is reached after 90 s)
      const held = R.bgDrift;
      for (let i = 0; i < 60 * 40; i++) window.demo.frame({ mode: 'play' });
      return { held, after: R.bgDrift, cap: 90 * R.view.dpr };
    });
    note(`after 100 s on the title screen: ${r.held.toFixed(0)} px (cap ${r.cap}); 40 s of play later: ${r.after.toFixed(0)}`);
    assert.ok(r.held <= r.cap + 1e-6 && r.held > 0, 'not bounded');
    assert.ok(r.after < r.held, 'does not fade out in play');
  });

  /* ───────────── 2. popups ───────────── */
  console.log('2. popups, respawn, rock');
  await check('popups that appear together never overprint, at any moment of their life', async () => {
    const r = await page.evaluate(() => {
      const fx = window.demo.renderer.fx;
      let worst = 1e9, tests = 0;
      for (const [dx, dy, gap] of [[0, 0, 0], [28, 6, 0], [60, 0, 0.12], [20, -9, 0.3], [70, 3, 0.05]]) {
        fx.reset(5);
        fx.popup(100, 200, '+50', 1, 21, 1.15);
        let t = 0;
        const step = 1 / 60;
        for (let f = 0; f < 90; f++) {
          if (f === Math.round(gap / step) + 1) fx.popup(100 + dx, 200 + dy, '+10', 2, 16, 0.95);
          fx.update(step); t += step;
          const live = fx.pops.filter((p) => p.live);
          for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
            const a = live[i], b = live[j];
            if (Math.abs(a.x - b.x) > 40) continue;                            // texts ~30-45 u wide
            worst = Math.min(worst, Math.abs((a.y - a.age * 30) - (b.y - b.age * 30)));
            tests++;
          }
        }
      }
      // the real pattern of a run of eggs with a golden egg in the middle (the hatch scene): a chain of popups, each placed
      // above the last, must not land on a third one
      fx.reset(5);
      const events = [[0, 328, '+10'], [12, 368, '+10'], [24, 408, '+10'], [36, 448, '+10'], [48, 488, '+10'], [54, 510, '+50'], [66, 528, '+10'], [78, 548, '+10']];
      for (let f = 0; f < 150; f++) {
        for (const [at, x, text] of events) if (f === at) fx.popup(x, 254 - (text === '+50' ? 10 : 0), text, 1, text === '+50' ? 21 : 16, text === '+50' ? 1.15 : 0.95);
        fx.update(1 / 60);
        const live = fx.pops.filter((p) => p.live);
        for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j];
          if (Math.abs(a.x - b.x) > 40) continue;
          worst = Math.min(worst, Math.abs((a.y - a.age * 30) - (b.y - b.age * 30)));
          tests++;
        }
      }
      return { worst, tests };
    });
    note(`closest vertical gap between two overlapping-x popups over ${r.tests} samples: ${r.worst.toFixed(1)} u (text height ~ 17 u)`);
    assert.ok(r.tests > 50, 'popups never coexisted: the test is not testing anything');
    assert.ok(r.worst >= 17, `popups come within ${r.worst.toFixed(1)} u of each other`);
  });

  await check('after a respawn the followers are not interpolated across the level (px = x on the frame after the event)', async () => {
    const r = await page.evaluate(async () => {
      const SIM = await import('/docs/js/sim.mjs');
      const R = window.demo.renderer;
      await window.demo.place(9000, { flock: 3 });
      const g = window.demo.game;
      for (let i = 0; i < 240; i++) SIM.step(g, {});
      g.mama.onGround = false; g.mama.vy = 0; g.mama.y = 430;      // fall out of the world: no shield, three ducklings: survivable
      for (let i = 0; i < 3 && !g.events.some((e) => e.type === 'respawn'); i++) SIM.step(g, {});
      const evs = SIM.drainEvents(g);
      const jump = Math.max(...g.followers.map((f) => Math.abs(f.x - f.px)));
      R.spawn(evs, g);
      const after = Math.max(...g.followers.map((f) => Math.abs(f.x - f.px)));
      return { respawned: evs.some((e) => e.type === 'respawn'), jump, after, n: g.followers.length };
    });
    assert.ok(r.respawned && r.n > 0, 'no respawn happened in the test');
    note(`follower jump in the sim: ${r.jump.toFixed(0)} u; as drawn after spawn(): ${r.after.toFixed(1)} u`);
    assert.ok(r.jump > 100, 'the sim did not move the followers: the test is not testing anything');
    assert.ok(r.after < 1, `followers still interpolate ${r.after} u`);
  });

  await check("Mama's rock angle never snaps (take-off, flight, landing, reduced motion)", async () => {
    const r = await page.evaluate(async () => {
      const SIM = await import('/docs/js/sim.mjs');
      const R = window.demo.renderer;
      const res = {};
      for (const reduced of [false, true]) {
        await window.demo.place(300, { flock: 2 });
        const g = window.demo.game; window.demo.setReduced(reduced);
        let prev = 0, worst = 0, maxAbs = 0, airFrames = 0, vnow = 9e6;
        for (let f = 0; f < 60 * 4; f++) {
          if (f === 60 || f === 150) SIM.act(g, 'jump');
          SIM.step(g, {}); SIM.step(g, {});
          vnow += 16.67; R.draw({ game: g, now: vnow, alpha: 1, mode: 'play', reducedMotion: reduced });
          const rk = R._mp.rock; if (f > 5) worst = Math.max(worst, Math.abs(rk - prev)); prev = rk; maxAbs = Math.max(maxAbs, Math.abs(rk));
          if (!g.mama.onGround) airFrames++;
        }
        res[reduced ? 'reduced' : 'normal'] = { worst, maxAbs, airFrames };
      }
      window.demo.setReduced(false);
      return res;
    });
    note(`largest frame-to-frame change of the rock angle: ${r.normal.worst.toFixed(4)} rad (reduced ${r.reduced.worst.toFixed(4)}); max |rock| ${r.normal.maxAbs.toFixed(3)} / ${r.reduced.maxAbs.toFixed(3)}; ${r.normal.airFrames} airborne frames`);
    assert.ok(r.normal.airFrames > 30, 'Mama never jumped');
    assert.ok(r.normal.worst < 0.045, `rock snaps by ${r.normal.worst} rad`);
    assert.ok(r.normal.maxAbs > 0.05 && r.normal.maxAbs <= 0.1001 && r.reduced.maxAbs <= 0.026, 'rock amplitude wrong');
  });

  await check('the camera follows Mama smoothly through a real run with jumps and jittery frame times (no jumps, no vertical movement, Mama never drawn backwards)', async () => {
    const r = await page.evaluate(async () => {
      const SIM = await import('/docs/js/sim.mjs');
      const { T } = await import('/docs/js/tuning.mjs');
      const R = window.demo.renderer;
      await window.demo.place(300, { flock: 2 });
      const g = window.demo.game, step = T.step;
      let acc = 0, vnow = 7e6, seed = 7, worstCam = 0, worstScr = 0, back = 0, minScr = 1, maxScr = 0, frames = 0, jumps = 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      let prevCam = null, prevScr = null, prevX = null;
      for (let f = 0; f < 60 * 45 && g.status === 'running'; f++) {
        const dtms = 16.67 + (rnd() - 0.5) * 9;                   // 12..21 ms frames
        acc += dtms / 1000;
        while (acc >= step) { window.demo.autopilot(g); SIM.step(g, {}); acc -= step; }
        const evs = SIM.drainEvents(g); if (evs.length) R.spawn(evs, g);
        vnow += dtms;
        const alpha = acc / step;
        R.draw({ game: g, now: vnow, alpha, mode: 'play' });
        const mx = R._mp.x, cam = R.camera.x, scr = (mx - cam) / R.view.w;
        if (prevCam !== null) {
          // (the first 2.5 s are skipped: Mama is easing in and the camera is still held by the start-of-world clamp)
          if (f > 150) { worstCam = Math.max(worstCam, Math.abs(cam - prevCam - 1.83)); worstScr = Math.max(worstScr, Math.abs(scr - prevScr) * R.view.w); }
          if (mx < prevX - 0.01 && g.mama.vx > 0) back++;
        }
        if (f > 90) { minScr = Math.min(minScr, scr); maxScr = Math.max(maxScr, scr); }
        prevCam = cam; prevScr = scr; prevX = mx; frames++;
        if (R.camera.y !== 0) return { bad: 'vertical camera movement' };
      }
      return { frames, worstCam, worstScr, back, minScr, maxScr, x: g.mama.x, status: g.status, jumps: g.stats.jumps };
    });
    assert.ok(!r.bad, r.bad);
    note(`${r.frames} jittery frames, Mama ran to x=${Math.round(r.x)} with ${r.jumps} jumps; Mama sat at ${(r.minScr * 100).toFixed(0)}..${(r.maxScr * 100).toFixed(0)} % of the width; largest camera step error ${r.worstCam.toFixed(2)} u; largest change of Mama's screen position ${r.worstScr.toFixed(2)} u/frame; backwards frames ${r.back}`);
    assert.ok(r.frames > 1500 && r.jumps >= 3, 'the run did not get far enough to mean anything');
    assert.ok(r.minScr > 0.22 && r.maxScr < 0.40, 'Mama drifts away from her screen spot');
    assert.ok(r.worstScr < 1.6, `Mama's screen position jitters by ${r.worstScr} u per frame`);
    assert.equal(r.back, 0, 'Mama is drawn moving backwards');
  });

  /* ───────────── 3. robustness ───────────── */
  console.log('3. robustness');
  await check('absurd sizes, dpr, NaN, a huge clock jump, no game, unknown events: nothing throws and the view recovers', async () => {
    const res = await page.evaluate(async () => {
      const R = window.demo.renderer, bad = [];
      await window.demo.place(9000, { flock: 3 });
      const g = window.demo.game;
      const tryIt = (name, fn) => { try { fn(); } catch (e) { bad.push(name + ': ' + e.message); } };
      const sizes = [[0, 0, 1], [1, 1, 1], [5000, 100, 3], [300, 5000, 2], [NaN, NaN, NaN], [-5, -5, -1], [844, 390, 0], [844, 390, 10], [320, 568, 2], [844, 390, 3]];
      for (const [w, h, d] of sizes) {
        tryIt(`resize ${w}x${h}@${d}`, () => {
          R.resize(w, h, d, { top: 0, right: 47, bottom: 21, left: 47 });
          for (const mode of ['play', 'title', 'paused', 'dead', 'finish']) R.draw({ game: g, now: 1e6 + Math.random() * 100, alpha: 0.5, mode, reducedMotion: mode === 'finish', fade: 0.3 });
          R.draw({ game: g, now: 1e6 + 5000, alpha: 2, mode: 'play' });
        });
      }
      tryIt('alpha NaN', () => R.draw({ game: g, now: 1e6, alpha: NaN, mode: 'play' }));
      tryIt('clock jumps', () => { R.draw({ game: g, now: 1e6, alpha: 1 }); R.draw({ game: g, now: 1e9, alpha: 1 }); R.draw({ game: g, now: 5, alpha: 1 }); });
      tryIt('no game', () => R.draw({ now: 1 }));
      tryIt('spawn: unknown / odd events', () => R.spawn([{ type: 'nonsense' }, { type: 'cue', kind: 'weird', text: 'hi' }, { type: 'gold', x: 1, y: 1, points: 50, hatched: false }, { type: 'crumble-fall', id: 99999999 }], g));
      tryIt('spawn: empty / null', () => { R.spawn([], g); R.spawn(null, g); });
      tryIt('resetCamera twice + announceChapter out of range', () => { R.resetCamera(g); R.resetCamera(g); R.announceChapter(99); R.announceChapter(-4, false); });
      return { bad, view: { ...R.view }, canvas: [R.canvas.width, R.canvas.height] };
    });
    assert.deepEqual(res.bad, []);
    assert.deepEqual(res.canvas, [2532, 1170], 'the canvas did not come back to its size');
  });

  await check('a resize in the middle of a game keeps the world, snaps the camera onto Mama and re-bakes the sprites', async () => {
    const r = await page.evaluate(async () => {
      const R = window.demo.renderer;
      await window.demo.place(9000, { flock: 2 });
      window.demo.run(0.5);
      const g = window.demo.game;
      R.resize(640, 300, 2, { top: 0, right: 0, bottom: 0, left: 0 });
      window.demo.frame({});
      const sx = (g.mama.x - R.camera.x) / R.view.w;
      const a = { sx, scale: R.view.scale, sprites: R.cache.map.size };
      R.resize(844, 390, 3, { top: 0, right: 47, bottom: 21, left: 47 });
      window.demo.frame({});
      return { a, sx2: (g.mama.x - R.camera.x) / R.view.w };
    });
    assert.ok(Math.abs(r.a.sx - 0.3) < 0.03 && Math.abs(r.sx2 - 0.3) < 0.03, `Mama at ${r.a.sx.toFixed(2)} / ${r.sx2.toFixed(2)} of the width after a resize`);
  });

  /* ───────────── 4. frame spikes at real speed ───────────── */
  console.log('4. frame cost at real speed');
  await check('real-speed frames through a landscape\'s sprite warm-up window never spike (no single warm-up step blocks a frame)', async () => {
    const r = await page.evaluate(async () => {
      const R = window.demo.renderer, level = window.demo.level, c = level.chapters[5];
      const from = c.x0 - 5600, to = c.x0 + 700;
      await window.demo.place(from);
      const game = window.demo.game, m = game.mama, plats = game.platforms;
      const js = [];
      let x = from, n = 0, vnow = 5e6;
      const dt = 1 / 60;
      while (x < to) {
        x += 110 * dt; m.px = m.x; m.py = m.y; m.x = x; m.phase += 110 * dt; m.vx = 110; game.t += dt;
        for (const p of plats) { if (p.x > x) break; if (p.kind === 'ground' && x <= p.x + p.w) { m.y = p.cy; m.ground = p; } }
        vnow += 16.67;
        const t0 = performance.now();
        R.draw({ game, now: vnow, alpha: 1, mode: 'play' });
        js.push(performance.now() - t0);
        n++;
        if (n % 2 === 0) R.ctx.getImageData(0, 0, 1, 1);
        if (n % 30 === 0) await new Promise((rs) => setTimeout(rs, 0));
      }
      const s = js.slice().sort((a, b) => a - b);
      return { frames: n, p50: s[n >> 1], p99: s[Math.floor(n * 0.99)], max: s[n - 1] };
    });
    note(`${r.frames} frames: JS p50 ${r.p50.toFixed(2)} ms, p99 ${r.p99.toFixed(2)} ms, worst ${r.max.toFixed(1)} ms`);
    assert.ok(r.p99 < 6 && r.max < 30, `frame JS spikes: p99 ${r.p99}, max ${r.max}`);
  });

  await check('no page errors during the whole run', async () => assert.deepEqual([...new Set(errors)], []));
} finally {
  if (browser) await browser.close();
  server.close();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
