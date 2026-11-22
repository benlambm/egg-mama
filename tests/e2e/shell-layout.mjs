/*
 * SHELL layout check: the page is a fixed game stage, and every menu screen fits the phone it is on.
 *   node tests/e2e/shell-layout.mjs [--shots]         (--shots also writes a screenshot of every screen)
 *
 * For each device (iPhone 13 844x390 @3x, Pixel 7 915x412, small 640x300 with toolbars, SE 568x320):
 *   - canvas rect == viewport rect, canvas pixels == css size x dpr (capped), no scroll anywhere
 *   - html/body are position:fixed with overscroll-behavior:none and touch-action:none
 *   - every screen: nothing outside the viewport, nothing clipped, nothing wider than its box, tap targets >= 44 px
 *   - the same again with simulated notch insets (controls must stay inside the safe area) and with a wide font
 */
import { DEVICES, SAVE_SAMPLE, boot, reporter, run, scrollState, scrollIsZero, show, shot, settle } from './shell-lib.mjs';

const WANT_SHOTS = process.argv.includes('--shots') || !!process.env.SHELL_SHOTS;
const CHAPTER_NAMES = ['Meadow', 'Clover Mill', 'Reedwater', 'Orchard Heights', 'Amber Quarry', 'Fogwood', 'Ember Canyon', 'Glass Coast', 'Lantern Caverns', 'Frostline', 'Moonridge', 'Dawnbridge', 'Beacon Summit'];

const SCREENS = [
  ['title', { save: SAVE_SAMPLE, best: { score: 12840, eggs: 61 } }],
  ['title-new', { save: null }],
  ['pause', { eggs: 1042, score: 123830, flock: 5, circuit: 12, chapter: 8, progress: 0.62, playSeconds: 83 * 3600 }],
  ['pause-short', { eggs: 0, score: 0, flock: 0, circuit: 1, chapter: 0, progress: 0, playSeconds: 12 }],
  ['dead', { eggs: 42, score: 1830, flock: 0, circuit: 2, chapter: 8, newBest: true }],
  ['finish', { eggs: 3111, score: 98700, flock: 5, circuit: 1 }],
  ['rotate-prompt', { phase: 'prompt' }],
  ['rotate-ready', { phase: 'ready' }],
  ['journal', { circuit: 1, chapter: 4, reached: { circuit: 1, chapter: 6 } }],
  ['journal-all', { circuit: 3, chapter: 12, reached: { circuit: 3, chapter: 12 } }],
  ['help-moves', {}],
  ['help-eggs', {}],
  ['help-helpers', {}],
  ['reset-confirm', { save: SAVE_SAMPLE }],
];

/** Open one of the SCREENS entries (some are sub-states of a screen). */
async function open(page, key, data) {
  const base = key.startsWith('title') ? 'title' : key.startsWith('pause') ? 'pause' : key.startsWith('rotate') ? 'rotate' : key.startsWith('journal') ? 'journal' : key.startsWith('help') ? 'help' : key;
  await show(page, base, data);
  if (key === 'help-eggs') { await page.click('[data-tab="eggs"]'); await settle(page, 80); }
  if (key === 'help-helpers') { await page.click('[data-tab="helpers"]'); await settle(page, 80); }
  return base;
}

/** Everything we can check about one open screen, evaluated in the page. */
const inspect = (page, name) => page.evaluate((name) => {
  const ui = window.__shell.ui, el = ui.el(name);
  const vw = innerWidth, vh = innerHeight, tol = 0.6;
  const ins = ui.insets();
  const out = { name, open: ui.current === name && el.classList.contains('is-open') && !el.hidden, problems: [], buttons: [], scrollAreas: [] };
  if (!out.open) { out.problems.push('screen is not open'); return out; }
  const R = (e) => e.getBoundingClientRect();
  const label = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''}${e.dataset && e.dataset.action ? '[' + e.dataset.action + ']' : ''}`;
  // the screen itself must not hide overflow
  if (el.scrollHeight > el.clientHeight + 1) out.problems.push(`screen content taller than the viewport: ${el.scrollHeight} > ${el.clientHeight}`);
  if (el.scrollWidth > el.clientWidth + 1) out.problems.push(`screen content wider than the viewport: ${el.scrollWidth} > ${el.clientWidth}`);
  for (const card of el.querySelectorAll('.card')) {
    if (card.scrollHeight > card.clientHeight + 1) out.problems.push(`card clips its content: ${label(card)} scrollHeight ${card.scrollHeight} > ${card.clientHeight}`);
    if (card.scrollWidth > card.clientWidth + 1) out.problems.push(`card clips its content sideways: ${label(card)} ${card.scrollWidth} > ${card.clientWidth}`);
  }
  for (const e of el.querySelectorAll('*')) {
    if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
    if (e.closest('.confetti') || e.closest('.sprite')) continue;
    const r = R(e);
    if (r.width === 0 && r.height === 0) continue;
    const scroller = e.closest('[data-scroll]');
    if (scroller && scroller !== e) continue;                         // content inside a scroll area may overflow by design
    if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) out.problems.push(`outside the viewport: ${label(e)} [${r.left.toFixed(1)},${r.top.toFixed(1)} → ${r.right.toFixed(1)},${r.bottom.toFixed(1)}] in ${vw}x${vh}`);
    // text-bearing boxes and layout containers must not be wider than themselves (decorative absolutes are exempt)
    if (e.matches('button, h1, h2, h3, h4, p, li, strong, b, small, .kicker, .chip, .chip-body, .btn-text, .help-text, .help-card, .j-title, .place, .journey-text, .tagline, .pause-grid, .pause-actions, .pause-stats, .btn-grid, .btn-row, .title-menu, .title-hero, .dead-grid, .confirm-body, .tabs, .journal-grid, .ch-grid')) {
      if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) out.problems.push(`content wider than its box: ${label(e)} ${e.scrollWidth} > ${e.clientWidth}`);
    }
  }
  for (const s of el.querySelectorAll('[data-scroll]')) {
    const r = R(s);
    out.scrollAreas.push({ name: label(s), scrolls: s.scrollHeight > s.clientHeight + 1, client: s.clientHeight, scroll: s.scrollHeight });
    if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) out.problems.push(`scroll area outside viewport: ${label(s)}`);
  }
  for (const b of el.querySelectorAll('button')) {
    if (b.offsetParent === null && getComputedStyle(b).position !== 'fixed') continue;     // hidden tab, etc.
    const r = R(b);
    if (r.width === 0) continue;
    out.buttons.push({ name: label(b), w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom });
  }
  out.insets = ins;
  return out;
}, name);

function checkButtons(t, res, tag, { insets } = {}) {
  const small = res.buttons.filter((b) => b.w < 43.5 || b.h < 43.5);
  t.ok(small.length === 0, `${tag}: every button is at least 44x44`, small.map((b) => `${b.name} ${b.w.toFixed(0)}x${b.h.toFixed(0)}`));
  if (insets) {
    const out = res.buttons.filter((b) => b.l < insets.left - 0.6 || b.r > insets.vw - insets.right + 0.6 || b.t < insets.top - 0.6 || b.b > insets.vh - insets.bottom + 0.6);
    t.ok(out.length === 0, `${tag}: every control stays inside the safe area`, out.map((b) => `${b.name} [${b.l.toFixed(0)},${b.t.toFixed(0)} → ${b.r.toFixed(0)},${b.b.toFixed(0)}]`));
  }
}

async function pageChecks(t, page, device) {
  const { w, h } = { w: device.viewport.width, h: device.viewport.height };
  const s = await scrollState(page);
  t.ok(scrollIsZero(s), `${device.label}: page scroll position is (0,0)`, s);
  t.ok(s.docH <= s.ih && s.bodyH <= s.ih && s.docW <= s.iw && s.bodyW <= s.iw, `${device.label}: nothing is taller/wider than the viewport`, s);
  t.ok(s.vvScale === 1 && s.vvTop === 0 && s.vvLeft === 0, `${device.label}: visual viewport is unzoomed and unpanned`, s);
  const c = await page.evaluate(() => {
    const cv = document.getElementById('game'), r = cv.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect();
    const cs = (e) => getComputedStyle(e);
    return {
      rect: [r.left, r.top, r.width, r.height], stage: [st.left, st.top, st.width, st.height], iw: innerWidth, ih: innerHeight, px: [cv.width, cv.height], dpr: devicePixelRatio,
      html: { pos: cs(document.documentElement).position, ob: cs(document.documentElement).overscrollBehaviorY, ta: cs(document.documentElement).touchAction, us: cs(document.documentElement).userSelect },
      body: { pos: cs(document.body).position, ob: cs(document.body).overscrollBehaviorY, ta: cs(document.body).touchAction, ov: cs(document.body).overflow },
      stageCss: { pos: cs(document.getElementById('stage')).position, ta: cs(document.getElementById('stage')).touchAction },
      kids: [...document.body.children].map((e) => e.id || e.tagName.toLowerCase()), stageKids: [...document.getElementById('stage').children].map((e) => e.id || e.tagName.toLowerCase()),
      viewport: document.querySelector('meta[name=viewport]').content,
    };
  });
  t.ok(c.rect[0] === 0 && c.rect[1] === 0 && Math.abs(c.rect[2] - w) < 0.01 && Math.abs(c.rect[3] - h) < 0.01, `${device.label}: canvas rect == viewport rect`, c.rect);
  t.ok(c.stage[0] === 0 && c.stage[1] === 0 && c.stage[2] === w && c.stage[3] === h, `${device.label}: #stage fills the viewport`, c.stage);
  const wantPx = [Math.round(w * c.dpr), Math.round(h * c.dpr)];
  const capped = w * h * c.dpr * c.dpr > 3.6e6;
  t.ok(capped ? (c.px[0] * c.px[1] <= 3.65e6 && c.px[0] >= w) : (c.px[0] === wantPx[0] && c.px[1] === wantPx[1]), `${device.label}: canvas pixels ${c.px.join('x')} (dpr ${c.dpr}${capped ? ', capped' : ''})`, { px: c.px, wantPx });
  t.ok(c.html.pos === 'fixed' && c.body.pos === 'fixed' && c.html.ob === 'none' && c.body.ob === 'none' && c.html.ta === 'none' && c.body.ta === 'none' && c.stageCss.ta === 'none', `${device.label}: html/body fixed, overscroll-behavior:none, touch-action:none`, c);
  t.ok(c.html.us === 'none', `${device.label}: text selection is off`, c.html.us);
  t.ok(c.body.ov === 'hidden', `${device.label}: body overflow hidden`, c.body.ov);
  t.ok(JSON.stringify(c.kids) === JSON.stringify(['stage', 'safe', 'SCRIPT']) || JSON.stringify(c.kids) === JSON.stringify(['stage', 'safe', 'script']), `${device.label}: the page holds nothing but #stage and #safe`, c.kids);
  t.ok(c.stageKids.filter((k) => k !== 'NOSCRIPT' && k !== 'noscript').join(',') === 'game,ui,pause-btn', `${device.label}: #stage holds canvas, #ui, #pause-btn`, c.stageKids);
  t.ok(/user-scalable=no/.test(c.viewport) && /viewport-fit=cover/.test(c.viewport) && /maximum-scale=1/.test(c.viewport), `${device.label}: viewport meta locks zoom and covers the notch`, c.viewport);
}

async function screenChecks(t, page, device, tag, insets) {
  for (const [key, data] of SCREENS) {
    const base = await open(page, key, data);
    const res = await inspect(page, base);
    t.ok(res.problems.length === 0, `${tag}: ${key} fits`, res.problems.slice(0, 4));
    checkButtons(t, res, `${tag}: ${key}`, { insets });
    if (WANT_SHOTS && !insets && !tag.includes('wide')) await shot(page, `${device.viewport.width}x${device.viewport.height}-${key}`);
    const sc = await scrollState(page);
    if (!scrollIsZero(sc)) t.ok(false, `${tag}: ${key} left the page scrolled`, sc);
  }
}

run(async (browser, server) => {
  const t = reporter('SHELL layout');
  const errors = [];

  for (const dev of ['iphone13', 'pixel7', 'small', 'se']) {
    const device = DEVICES[dev];
    const { context, page } = await boot(browser, server, device, { errors });
    await pageChecks(t, page, device);

    // title at boot, before anything has been shown through the test hook
    const sp = await page.evaluate(() => ({ cur: window.__shell.ui.current, pause: !document.getElementById('pause-btn').hidden }));
    t.ok(sp.cur === 'title' && sp.pause === false, `${device.label}: boots on the title with the pause button hidden`, sp);

    await screenChecks(t, page, device, device.label);

    // simulated notch (landscape iPhone: 47 left/right, 21 bottom): controls must stay inside the safe area.
    // (The SE has no notch, so that device is skipped.)
    if (dev !== 'se') {
    await page.evaluate(() => { const r = document.documentElement.style; r.setProperty('--sat', '0px'); r.setProperty('--sar', '47px'); r.setProperty('--sab', '21px'); r.setProperty('--sal', '47px'); });
    const ins = await page.evaluate(() => window.__shell.ui.insets());
    t.ok(ins.left === 47 && ins.right === 47 && ins.bottom === 21 && ins.top === 0, `${device.label}: ui.insets() reads the #safe probe`, ins);
    await screenChecks(t, page, device, `${device.label} + notch`, { ...ins, vw: device.viewport.width, vh: device.viewport.height });
    // the pause button hugs the top-right INSIDE the insets and is thumb sized
    await page.evaluate(() => { window.__shell.startRun(); });
    await settle(page);
    const pb = await page.evaluate(() => { const b = document.getElementById('pause-btn'), r = b.getBoundingClientRect(); return { hidden: b.hidden, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, ui: window.__shell.ui.current }; });
    t.ok(!pb.hidden && pb.ui === null, `${device.label}: pause button shows during play (no screen open)`, pb);
    t.ok(pb.w >= 48 && pb.h >= 48, `${device.label}: pause button is at least 48 px`, pb);
    t.ok(pb.r <= device.viewport.width - 47 + 0.5 && pb.t >= 0 && pb.r > device.viewport.width - 47 - 30, `${device.label}: pause button sits top-right inside the right inset`, pb);
    await page.evaluate(() => { const r = document.documentElement.style; for (const k of ['--sat', '--sar', '--sab', '--sal']) r.removeProperty(k); });
    }
    await context.close();
  }

  // every landscape name must fit the title/pause (longest names), on the smallest phone
  {
    const device = DEVICES.small;
    const { context, page } = await boot(browser, server, device, { errors });
    for (let i = 0; i < CHAPTER_NAMES.length; i++) {
      const save = { ...SAVE_SAMPLE, chapter: i, circuit: i % 2 ? 12 : 2 };
      for (const [name, data] of [['title', { save, best: { score: 999999, eggs: 99999 } }], ['pause', { eggs: 99999, score: 9999999, flock: 5, circuit: i % 2 ? 12 : 2, chapter: i, progress: i / 13, playSeconds: 4000 }]]) {
        await show(page, name, data);
        const res = await inspect(page, name);
        if (res.problems.length) t.ok(false, `landscape ${i + 1} ${CHAPTER_NAMES[i]}: ${name} fits`, res.problems.slice(0, 3));
      }
    }
    t.ok(true, 'all 13 landscape names fit the title and pause screens at 640x300');
    // every journal selection fits (the text may scroll, the box may not move)
    await show(page, 'journal', { circuit: 2, chapter: 12, reached: { circuit: 2, chapter: 12 } });
    const worst = [];
    for (let i = 0; i < 13; i++) {
      await page.click(`[data-pick="${i}"]`); await settle(page, 60);
      const res = await inspect(page, 'journal');
      if (res.problems.length) t.ok(false, `journal landscape ${i + 1} fits`, res.problems.slice(0, 3));
      worst.push(res.scrollAreas.map((a) => (a.scrolls ? `scrolls ${a.scroll - a.client}px` : 'fits')).join(','));
    }
    t.info(`journal detail pane at 640x300 per landscape: ${worst.join(' | ')}`);
    t.ok(true, 'all 13 journal pages stay inside the card at 640x300');
    await context.close();
  }

  // wide fallback font: the layout must survive a font that is much wider than any phone's
  {
    const device = DEVICES.small;
    const { context, page } = await boot(browser, server, device, { errors });
    await page.addStyleTag({ content: '* { font-family: "DejaVu Sans", Verdana, sans-serif !important; }' });
    await settle(page, 200);
    await screenChecks(t, page, device, `${device.label} + wide font`);
    await context.close();
  }

  t.ok(errors.length === 0, 'no console errors or page errors', errors.slice(0, 5));
  return t.done();
});
