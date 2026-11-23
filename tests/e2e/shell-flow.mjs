/*
 * SHELL flow check: click through every screen with real touch taps, saves, legacy migration, rotation, offline.
 *   node tests/e2e/shell-flow.mjs
 *
 * Talks to the page through window.__shell (see main.mjs). With the placeholder main.mjs the "game" is a fake run,
 * so this proves the SHELL (menus, save, settings, orientation, PWA); the integrator re-runs it against the real loop.
 */
import { DEVICES, SAVE_SAMPLE, boot, reporter, run, scrollState, scrollIsZero, settle, seedSave, shot, tap, swipe } from './shell-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEGACY = JSON.stringify({
  format: 1,
  state: {
    seed: 2718281828, time: 913.4, tick: 54804, points: 5120, collected: 88, ducklings: 4, shield: false, magnet: 0, combo: 0, comboUntil: 0,
    furthest: 9210, camera: 9100, stage: 28, over: false,
    platforms: [{ x: 787, y: 292, w: 226, type: 'ground', ox: 787, oy: 292, dx: 0, dy: 0, crumblesAt: 0, returnsAt: 0, biome: 2 }],
    eggs: [{ x: 1075, y: 240, kind: 'egg', taken: false }], enemies: [], objects: [{ x: 823, y: 292, kind: 'flag', stage: 28, active: true, taken: false }],
    chunks: 120, nextFlag: 9800, lastPattern: 4, generatedStage: 29, stageStart: 8900, placedBeacon: false, beaconsLit: 2,
    checkpoint: { x: 823, y: 292, tile: 787 }, lastGround: 787,
  },
});

const state = (page) => page.evaluate(() => ({ mode: window.__shell.mode, cur: window.__shell.ui.current, pauseHidden: document.getElementById('pause-btn').hidden }));
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; }, sel);
/** A real touch tap on a visible control inside the open screen. */
async function press(page, sel) { await page.locator(sel).first().tap({ timeout: 4000 }); await sleep(120); }
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && e.closest('[hidden]') === null; }, sel);

async function titleAndPause(t, browser, server) {
  const device = DEVICES.iphone13;
  const errors = [];
  const { context, page, cdp } = await boot(browser, server, device, { errors });

  // ── first visit: no save
  t.ok((await state(page)).cur === 'title' && (await state(page)).pauseHidden, 'first visit: title is up and the pause button is hidden');
  t.ok(await visible(page, '[data-screen=title] [data-action=play]'), 'no save: the big button says Play');
  t.ok(!(await visible(page, '[data-action=continue]')) && !(await visible(page, '[data-action=start-over]')), 'no save: no Continue, no Start over');
  for (const a of ['journal', 'help', 'sound']) t.ok(await visible(page, `[data-screen=title] [data-action=${a}]`), `title has ${a}`);
  t.ok(/EGG\s*MAMA/.test(await text(page, '.logo') || ''), 'logo reads EGG MAMA');
  t.ok(await page.evaluate(() => { const l = document.querySelector('[data-screen=title]'); return l.getAttribute('role') === 'dialog' && l.getAttribute('aria-modal') === 'true' && document.getElementById(l.getAttribute('aria-labelledby')) !== null; }), 'title is a labelled dialog');
  t.ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'play'), 'focus starts on the primary button');

  // ── journal from the title: all locked except the Meadow; close returns to the title
  await press(page, '[data-screen=title] [data-action=journal]');
  await settle(page);
  let s = await state(page);
  t.ok(s.cur === 'journal', 'Journal opens over the title');
  const jr = await page.evaluate(() => ({ chips: document.querySelectorAll('.chip-ch').length, locked: document.querySelectorAll('.chip-ch.locked').length, title: document.querySelector('.j-title strong').textContent }));
  t.ok(jr.chips === 13 && jr.locked === 12 && jr.title === 'Meadow', 'new journey: 13 landscapes, only the Meadow found', jr);
  await press(page, '[data-pick="7"]');
  t.ok(/not found yet|haven’t found/.test((await text(page, '.j-detail')) || '') && (await text(page, '.j-title strong')) === '???', 'a locked landscape shows a silhouette and "???", no spoilers');
  await shot(page, 'flow-journal-locked');
  await press(page, '[data-screen=journal] [data-action=close]');
  await settle(page);
  s = await state(page);
  t.ok(s.cur === 'title', 'Close returns to the title');

  // ── help: three tabs
  await press(page, '[data-screen=title] [data-action=help]');
  await settle(page);
  t.ok((await state(page)).cur === 'help', 'How to play opens');
  for (const [tab, firstHead] of [['eggs', 'Eggs'], ['helpers', 'Shell shield'], ['moves', 'Swipe up']]) {
    await press(page, `[data-tab=${tab}]`);
    t.ok(await page.evaluate(([tb, head]) => { const pane = document.querySelector(`[data-pane=${tb}]`); return !pane.hidden && pane.textContent.includes(head) && document.querySelector(`[data-tab=${tb}]`).getAttribute('aria-selected') === 'true'; }, [tab, firstHead]), `help tab "${tab}" shows its page`);
  }
  await page.keyboard.press('Escape');
  await settle(page);
  t.ok((await state(page)).cur === 'title', 'Esc closes How to play back to the title');

  // ── Play
  await press(page, '[data-screen=title] [data-action=play]');
  await settle(page);
  s = await state(page);
  t.ok(s.mode === 'playing' && s.cur === null && !s.pauseHidden, 'Play: no screen is up, the pause button shows', s);
  t.ok(JSON.parse((await stored(page, 'egg-mama-save-v2')) || 'null')?.chapter === 0, 'a new journey is saved to the v2 key');
  const sc0 = await scrollState(page);
  t.ok(scrollIsZero(sc0), 'page at (0,0) while playing');

  // ── pause menu
  await tap(cdp, { x: 400, y: 200 }, 50); await sleep(80);                    // a jump -> counters move
  await press(page, '#pause-btn');
  await settle(page);
  s = await state(page);
  t.ok(s.mode === 'paused' && s.cur === 'pause' && s.pauseHidden, 'pause button opens the pause menu');
  const pauseText = await text(page, '[data-screen=pause]');
  t.ok(/Paused/i.test(pauseText) && /Landscape 1 of 13/i.test(pauseText) && /Meadow/.test(pauseText) && /Circuit 1/i.test(pauseText), 'pause shows the landscape and circuit', pauseText);
  t.ok(/\d+%/.test(pauseText) && /(just started|min played)/.test(pauseText) && /eggs/i.test(pauseText) && /score/i.test(pauseText) && /flock/i.test(pauseText), 'pause shows journey percent, minutes played, eggs, score and flock', pauseText);
  t.ok(await page.evaluate(() => { const b = document.querySelector('.track'); return b.getAttribute('role') === 'progressbar' && Number.isFinite(Number(b.getAttribute('aria-valuenow'))); }), 'journey progress is an accessible progressbar');
  await shot(page, 'flow-pause');

  // sound + tap-to-jump switches persist
  const sw = async (a) => page.evaluate((x) => document.querySelector(`[data-screen=pause] [data-action=${x}]`).getAttribute('aria-checked'), a);
  t.ok((await sw('sound')) === 'true' && (await sw('tap-to-jump')) === 'true', 'defaults: sound on, tap-to-jump on');
  await press(page, '[data-screen=pause] [data-action=sound]');
  await press(page, '[data-screen=pause] [data-action=tap-to-jump]');
  t.ok((await sw('sound')) === 'false' && (await sw('tap-to-jump')) === 'false', 'both switches flip when tapped');
  const st = JSON.parse(await stored(page, 'egg-mama-settings-v1'));
  t.ok(st.muted === true && st.tapToJump === false, 'settings are saved', st);
  t.ok(await page.evaluate(() => window.__shell.input.tapToJump === false), 'tap-to-jump setting reaches the input');

  // journal from the pause menu returns to the pause menu
  await press(page, '[data-screen=pause] [data-action=journal]');
  await settle(page);
  t.ok((await state(page)).cur === 'journal' && (await text(page, '.j-title strong')) === 'Meadow', 'Journal opens from the pause menu (current landscape selected)');
  await press(page, '[data-screen=journal] [data-action=close]');
  await settle(page);
  t.ok((await state(page)).cur === 'pause', 'Close returns to the pause menu');
  await press(page, '[data-screen=pause] [data-action=help]');
  await page.keyboard.press('Escape');
  await settle(page);
  t.ok((await state(page)).cur === 'pause', 'help from pause: Esc returns to the pause menu (and does not resume)');

  // resume
  await press(page, '[data-screen=pause] [data-action=resume]');
  await settle(page);
  s = await state(page);
  t.ok(s.mode === 'playing' && s.cur === null && !s.pauseHidden, 'Resume returns to play');

  // keyboard P toggles and Esc in the pause menu resumes
  await page.keyboard.press('p'); await settle(page);
  t.ok((await state(page)).cur === 'pause', 'P pauses');
  await page.keyboard.press('Escape'); await settle(page);
  t.ok((await state(page)).mode === 'playing', 'Esc resumes from the pause menu');

  // main title keeps the save and offers Continue
  await press(page, '#pause-btn'); await settle(page);
  await press(page, '[data-screen=pause] [data-action=title]'); await settle(page);
  s = await state(page);
  t.ok(s.cur === 'title' && s.mode === 'title' && s.pauseHidden, 'Main title from the pause menu');
  t.ok(await visible(page, '[data-screen=title] [data-action=continue]') && await visible(page, '[data-screen=title] [data-action=start-over]'), 'with a save: Continue and Start over appear');
  t.ok(/Landscape 1 · Meadow · circuit 1/.test(await text(page, '[data-action=continue]')), 'Continue says where you will be', await text(page, '[data-action=continue]'));
  t.ok(await stored(page, 'egg-mama-save-v2') !== null, 'going to Main title kept the save');

  // dead + finish screens (placeholder debug keys)
  await press(page, '[data-screen=title] [data-action=continue]'); await settle(page);
  await page.keyboard.press('k'); await settle(page);
  s = await state(page);
  const deadText = await text(page, '[data-screen=dead]');
  t.ok(s.cur === 'dead' && /Oh no!/.test(deadText) && /Retry checkpoint/.test(deadText) && /Main title/.test(deadText), 'dead screen: Oh no!, results, Retry checkpoint + Main title', deadText);
  await shot(page, 'flow-dead');
  await press(page, '[data-screen=dead] [data-action=retry]'); await settle(page);
  t.ok((await state(page)).mode === 'playing', 'Retry checkpoint plays again');
  await page.keyboard.press('b'); await settle(page);
  const finText = await text(page, '[data-screen=finish]');
  t.ok((await state(page)).cur === 'finish' && /The beacon is lit!/.test(finText) && /whole flock can go home/.test(finText) && /Keep going/.test(finText) && /Main title/.test(finText), 'finish screen: beacon lit, flock goes home, Keep going / Main title', finText);
  await shot(page, 'flow-finish');
  await press(page, '[data-screen=finish] [data-action=keep-going]'); await settle(page);
  t.ok((await state(page)).mode === 'playing' && JSON.parse(await stored(page, 'egg-mama-save-v2')).circuit === 2 && JSON.parse(await stored(page, 'egg-mama-save-v2')).beacons === 1, 'Keep going starts circuit 2 and saves it (beacons 1)');

  t.ok(errors.length === 0, 'no console/page errors in this flow', errors);
  await context.close();
}

async function startOver(t, browser, server) {
  const device = DEVICES.small;
  const errors = [];
  const { context, page } = await boot(browser, server, device, { errors, init: seedSave(SAVE_SAMPLE) });
  const label = await text(page, '[data-action=continue]');
  t.ok(/Landscape 9 · Lantern Caverns · circuit 2/.test(label || ''), 'a saved journey shows "Landscape 9 · Lantern Caverns · circuit 2" on Continue', label);
  const before = await stored(page, 'egg-mama-save-v2');
  await press(page, '[data-action=start-over]'); await settle(page);
  let s = await state(page);
  const dlg = await text(page, '[data-screen=reset-confirm]');
  t.ok(s.cur === 'reset-confirm' && /Start over\?/.test(dlg) && /Keep my journey/.test(dlg) && /Yes, start over/.test(dlg), 'Start over asks first', dlg);
  t.ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'cancel-start-over'), 'the safe choice (keep) has the focus');
  t.ok(/42 eggs/.test(dlg) && /3 ducklings/.test(dlg), 'the dialog says what would be lost', dlg);
  await press(page, '[data-action=cancel-start-over]'); await settle(page);
  t.ok((await state(page)).cur === 'title' && (await stored(page, 'egg-mama-save-v2')) === before, 'Cancel keeps the save untouched');
  await press(page, '[data-action=start-over]'); await settle(page);
  await page.keyboard.press('Escape'); await settle(page);
  t.ok((await state(page)).cur === 'title' && (await stored(page, 'egg-mama-save-v2')) === before, 'Esc also cancels');
  await press(page, '[data-action=start-over]'); await settle(page);
  await press(page, '[data-action=confirm-start-over]'); await settle(page);
  const after = JSON.parse(await stored(page, 'egg-mama-save-v2'));
  t.ok(after.circuit === 1 && after.chapter === 0 && after.flag === 0 && after.eggs === 0 && after.score === 0 && after.flock === 0 && after.beacons === 0, 'confirming starts a new journey: Meadow, zero eggs, zero followers', after);
  t.ok(after.journeySeed !== SAMPLE_SEED, 'the new journey has a new route seed');
  t.ok(/Landscape 1 · Meadow · circuit 1/.test(await text(page, '[data-action=continue]') || ''), 'the title now offers the fresh Meadow');
  t.ok(errors.length === 0, 'no console/page errors', errors);
  await context.close();
}
const SAMPLE_SEED = SAVE_SAMPLE.journeySeed;

async function legacy(t, browser, server) {
  const device = DEVICES.iphone13;
  const errors = [];
  const { context, page } = await boot(browser, server, device, {
    errors,
    init: `if (!localStorage.getItem('egg-hero-journey-v1')) { localStorage.setItem('egg-hero-journey-v1', ${JSON.stringify(LEGACY)}); localStorage.setItem('egg-hero-sound', 'off'); localStorage.setItem('egg-hero-best', '12840'); }`,
  });
  const label = await text(page, '[data-action=continue]');
  t.ok(/Landscape 3 · Reedwater · circuit 3/.test(label || ''), 'legacy GitHub Pages save (stage 28) continues as "Landscape 3 · Reedwater · circuit 3"', label);
  const v2 = JSON.parse(await stored(page, 'egg-mama-save-v2'));
  t.ok(v2 && v2.eggs === 88 && v2.score === 5120 && v2.flock === 4 && v2.beacons === 2 && v2.circuit === 3 && v2.chapter === 2, 'eggs 88, score 5120, flock 4, beacons 2 carried over', v2);
  t.ok((await stored(page, 'egg-hero-journey-v1')) === LEGACY, 'the legacy key is untouched');
  t.ok(await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked')) === 'false', 'legacy egg-hero-sound=off keeps the sound muted');
  t.ok(/12,840/.test(await text(page, '[data-screen=title]') || ''), 'legacy best score (12,840) is shown');
  // the journal for that save has circuit 3 and reached landscape 3 -> 3 found
  await press(page, '[data-screen=title] [data-action=journal]'); await settle(page);
  t.ok(/Circuit 3/i.test(await text(page, '[data-screen=journal] .kicker') || ''), 'journal knows it is circuit 3');
  await context.close();

  // corrupt legacy data: ignored, game starts fresh with no crash
  for (const junk of ['{"format":1,"state":{"stage":"x"}}', '{{{', 'null', '{"format":2}']) {
    const errs = [];
    const c = await boot(browser, server, device, { errors: errs, init: `localStorage.setItem('egg-hero-journey-v1', ${JSON.stringify(junk)});` });
    t.ok(await visible(c.page, '[data-screen=title] [data-action=play]') && errs.length === 0, `corrupt legacy save ${junk.slice(0, 24)}: a plain "Play" title, no errors`, errs);
    await c.context.close();
  }
  const errs2 = [];
  const bad = await boot(browser, server, device, { errors: errs2, init: `localStorage.setItem('egg-mama-save-v2', '{"v":2,"chapter":99}'); localStorage.setItem('egg-mama-settings-v1', '[1,2');` });
  t.ok(await visible(bad.page, '[data-screen=title] [data-action=play]') && errs2.length === 0, 'corrupt v2 save and settings: plain "Play" title, no errors', errs2);
  await bad.context.close();
}

async function persistence(t, browser, server) {
  const device = DEVICES.pixel7;
  const errors = [];
  const { context, page } = await boot(browser, server, device, { errors });
  await press(page, '[data-screen=title] [data-action=sound]');
  t.ok(await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked')) === 'false', 'title: sound switch turns off');
  await page.reload();
  await page.waitForFunction(() => window.__shell && window.__shell.ui);
  await settle(page);
  t.ok(await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked')) === 'false' && await page.evaluate(() => window.__shell.settings.muted === true), 'mute survives a reload');
  await page.keyboard.press('m');                                                  // M works on the title as well
  await sleep(100);
  t.ok(await page.evaluate(() => document.querySelector('[data-screen=title] [data-action=sound]').getAttribute('aria-checked')) === 'true', 'M key toggles the switch on the title');
  t.ok(errors.length === 0, 'no console/page errors', errors);
  await context.close();
}

async function orientation(t, browser, server) {
  const errors = [];
  // opening in portrait
  {
    const { context, page } = await boot(browser, server, DEVICES.portrait, { errors, init: seedSave(SAVE_SAMPLE) });
    const s = await state(page);
    t.ok(s.cur === 'rotate' && s.mode === 'rotate', 'opening in portrait shows the rotate prompt');
    const info = await page.evaluate(() => { const r = document.querySelector('[data-screen=rotate]'); return { phase: r.dataset.phase, text: r.innerText.replace(/\s+/g, ' ').trim(), label: document.getElementById(r.getAttribute('aria-labelledby'))?.textContent }; });
    t.ok(info.phase === 'prompt' && /Turn your phone sideways/.test(info.text) && !/Tap to continue/.test(info.text.replace(/All set!.*/, '')) , 'prompt text: "Turn your phone sideways"', info);
    const geo = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-screen=rotate] *')].filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('svg') || e.tagName === 'svg');
      const bad = els.filter((e) => { const r = e.getBoundingClientRect(); return r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5; }).map((e) => e.className || e.tagName);
      const phone = document.querySelector('.phone'), cs = getComputedStyle(phone);
      return { bad, anim: cs.animationName, w: innerWidth, h: innerHeight };
    });
    t.ok(geo.bad.length === 0 && geo.anim !== 'none', 'portrait: everything fits and the phone icon animates', geo);
    const sc = await scrollState(page);
    t.ok(scrollIsZero(sc) && sc.docH <= sc.ih && sc.docW <= sc.iw, 'portrait: no scroll, nothing larger than the viewport', sc);
    t.ok(await page.evaluate(() => { const c = document.getElementById('game').getBoundingClientRect(); return c.width === innerWidth && c.height === innerHeight; }), 'portrait: canvas still equals the viewport');
    await shot(page, 'flow-rotate-portrait');
    // turn sideways from the title: back to the title
    await page.setViewportSize({ width: 844, height: 390 }); await sleep(500);
    const back = await state(page);
    t.ok(back.cur === 'title' && back.mode === 'title', 'turning sideways from a portrait start returns to the title', back);
    await context.close();
  }
  // mid-run rotation, twice, preserving the run
  {
    const { context, page } = await boot(browser, server, DEVICES.iphone13, { errors, init: seedSave(SAVE_SAMPLE) });
    await press(page, '[data-action=continue]'); await settle(page);
    await page.keyboard.press('Space'); await page.keyboard.press('Space'); await sleep(900);
    await page.keyboard.press('Space'); await sleep(900);
    const snap = () => page.evaluate(() => ({ eggs: window.__shell.run.eggs, score: window.__shell.run.score, flock: window.__shell.run.flock, secs: window.__shell.run.playSeconds, save: JSON.stringify(window.__shell.save) }));
    for (let turn = 1; turn <= 2; turn++) {
      const before = await snap();
      await page.setViewportSize({ width: 390, height: 844 }); await sleep(600);
      let s = await state(page);
      t.ok(s.cur === 'rotate' && s.mode === 'rotate' && s.pauseHidden, `rotation ${turn}: turning upright pauses and shows the rotate prompt`, s);
      const frozen = await snap(); await sleep(700); const later = await snap();
      t.ok(later.secs === frozen.secs && later.eggs === before.eggs && later.score === before.score && later.flock === before.flock, `rotation ${turn}: the run is frozen while upright (position, eggs, score, flock preserved)`, { before, frozen, later });
      await page.setViewportSize({ width: 844, height: 390 }); await sleep(600);
      s = await state(page);
      const phase = await page.evaluate(() => document.querySelector('[data-screen=rotate]').dataset.phase);
      t.ok(s.cur === 'rotate' && phase === 'ready' && s.mode === 'rotate', `rotation ${turn}: landscape again shows "Tap to continue", the run does NOT restart by itself`, { s, phase });
      t.ok(/Tap to continue/.test(await text(page, '[data-screen=rotate]') || ''), `rotation ${turn}: the button says Tap to continue`);
      if (turn === 1) await shot(page, 'flow-rotate-ready');
      await press(page, '[data-action=rotate-continue]'); await sleep(450);
      s = await state(page);
      const after = await snap();
      t.ok(s.mode === 'playing' && s.cur === null && !s.pauseHidden && after.eggs - before.eggs <= 1 && after.save === before.save, `rotation ${turn}: a tap resumes the same run (eggs ${after.eggs}, flock ${after.flock}, same checkpoint save)`, { s, before, after });
    }
    // rotating while paused returns to the pause menu rather than resuming
    await page.keyboard.press('p'); await sleep(450);
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);
    await page.setViewportSize({ width: 844, height: 390 }); await sleep(500);
    const s2 = await state(page);
    t.ok(s2.mode === 'rotate' || s2.mode === 'paused', 'rotating while paused does not silently resume play', s2);
    await context.close();
  }
  t.ok(errors.length === 0, 'no console/page errors', errors);
}

async function a11yAndMotion(t, browser, server) {
  const errors = [];
  const device = DEVICES.small;
  const { context, page } = await boot(browser, server, device, { errors, init: seedSave(SAVE_SAMPLE) });
  // every screen is a labelled dialog and announces itself
  for (const [name, data] of [['title', { save: SAVE_SAMPLE }], ['pause', { circuit: 1, chapter: 3 }], ['dead', {}], ['finish', {}], ['rotate', { phase: 'prompt' }], ['journal', {}], ['help', {}], ['reset-confirm', {}]]) {
    await page.evaluate(([n, d]) => { window.__shell.setMode(n === 'title' ? 'title' : 'paused'); window.__shell.ui.show(n, d); }, [name, data]);
    await settle(page, 380);
    const r = await page.evaluate((n) => {
      const el = document.querySelector(`[data-screen=${n}]`);
      const labEl = document.getElementById(el.getAttribute('aria-labelledby'));
      const lab = labEl && { textContent: labEl.getAttribute('aria-label') || labEl.textContent };
      const live = document.querySelector('.sr-only[aria-live]');
      const inside = el.contains(document.activeElement);
      return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), label: lab && lab.textContent.trim(), live: live && live.textContent, inside, focus: document.activeElement && (document.activeElement.dataset.action || document.activeElement.dataset.tab || document.activeElement.tagName) };
    }, name);
    t.ok(r.role === 'dialog' && r.modal === 'true' && !!r.label && r.inside, `${name}: role=dialog, aria-modal, labelled "${r.label}", focus moved inside (${r.focus})`, r);
    t.ok(!!r.live && r.live.length > 0, `${name}: announced in the aria-live region ("${r.live}")`, r);
  }
  // Tab never leaves the open dialog
  await page.evaluate(() => { window.__shell.ui.show('pause', { circuit: 1, chapter: 3 }); }); await settle(page);
  let leaked = 0;
  for (let i = 0; i < 20; i++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => document.querySelector('[data-screen=pause]').contains(document.activeElement)))) leaked++; }
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Shift+Tab'); if (!(await page.evaluate(() => document.querySelector('[data-screen=pause]').contains(document.activeElement)))) leaked++; }
  t.ok(leaked === 0, 'Tab / Shift+Tab cycle inside the dialog and never escape');
  await page.evaluate(() => { window.__shell.ui.show('title', { save: null }); }); await settle(page);
  t.ok(await page.evaluate(() => { const l = document.querySelectorAll('button[aria-label], button'); return [...document.querySelectorAll('[data-screen=title] button')].every((b) => (b.textContent || '').trim().length > 0 || b.getAttribute('aria-label')); }), 'every button has an accessible name');
  t.ok(await page.evaluate(() => document.getElementById('pause-btn').getAttribute('aria-label') === 'Pause'), 'pause button is labelled "Pause"');
  await context.close();

  // fullscreen button hides itself where the API does not exist (iPhone Safari)
  {
    const c = await boot(browser, server, DEVICES.iphone13, { errors, init: `for (const k of ['fullscreenEnabled', 'webkitFullscreenEnabled']) Object.defineProperty(Document.prototype, k, { get() { return false; }, configurable: true });` });
    t.ok(!(await visible(c.page, '[data-action=fullscreen]')), 'no Full screen button when the browser cannot do it');
    await c.context.close();
  }
  // reduced motion
  {
    const c = await boot(browser, server, DEVICES.iphone13, { errors });
    await c.page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(100);
    const r = await c.page.evaluate(() => ({ logo: getComputedStyle(document.querySelector('.logo')).animationName, fade: getComputedStyle(document.querySelector('[data-screen=title]')).transitionDuration }));
    t.ok(r.logo === 'none' && /^0s/.test(r.fade), 'prefers-reduced-motion: the logo bob and the screen fades are off', r);
    await c.context.close();
  }
  t.ok(errors.length === 0, 'no console/page errors', errors);
}

async function offline(t, browser, server) {
  const errors = [];
  const { context, page } = await boot(browser, server, DEVICES.iphone13, { errors, search: '?sw' });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    return { scope: reg.scope, active: !!reg.active, keys };
  });
  t.ok(info.active && info.keys.some((k) => k.startsWith('egg-mama-')), 'the service worker installs and creates the versioned cache', info);
  // everything in FILES must be cached
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DOCS } = await import('./shell-lib.mjs');
  const swSource = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const files = [...swSource.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const cached = await page.evaluate(async () => { const c = await caches.open((await caches.keys()).find((k) => k.startsWith('egg-mama-'))); return (await c.keys()).map((r) => new URL(r.url).pathname); });
  const missing = files.filter((f) => !cached.some((c) => c === new URL(f, 'http://x/').pathname || (f === './' && c === '/')));
  t.ok(missing.length === 0, `all ${files.length} listed files were precached`, missing);
  t.ok(cached.some((c) => c.endsWith('assets/meadow.webp')), 'the Meadow painting was kept the first time it was used');
  t.ok(!cached.some((c) => c.endsWith('assets/frostline.webp')), 'backgrounds not yet used are NOT forced into the install');
  // ask the worker to fetch the rest
  await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; r.active.postMessage({ type: 'warm' }); });
  let n = 0;
  for (let i = 0; i < 60 && n < 13; i++) { await sleep(250); n = await page.evaluate(async () => { const c = await caches.open((await caches.keys()).find((k) => k.startsWith('egg-mama-'))); return (await c.keys()).filter((r) => r.url.includes('/assets/')).length; }); }
  t.ok(n === 13, `'warm' keeps all 13 paintings (${n})`);
  // go offline and reload
  await context.setOffline(true);
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  await page.reload();
  await page.waitForFunction(() => window.__shell && window.__shell.ui, null, { timeout: 15000 });
  await settle(page);
  const st = await state(page);
  t.ok(st.cur === 'title', 'offline reload: the game opens on the title');
  const bgOk = await page.evaluate(() => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = 'assets/ridge.webp'; }));
  t.ok(bgOk > 1000, 'offline: a painting that was never visited before loads from the copy', bgOk);
  t.ok(failed.length === 0, 'offline reload made no failing requests', failed);
  await press(page, '[data-action=play]'); await settle(page);
  t.ok((await state(page)).mode === 'playing', 'offline: you can play');
  await context.setOffline(false);
  t.ok(errors.length === 0, 'no console/page errors', errors);
  await context.close();
}

run(async (browser, server) => {
  const t = reporter('SHELL flow');
  await titleAndPause(t, browser, server);
  await startOver(t, browser, server);
  await legacy(t, browser, server);
  await persistence(t, browser, server);
  await orientation(t, browser, server);
  await a11yAndMotion(t, browser, server);
  await offline(t, browser, server);
  return t.done();
});
