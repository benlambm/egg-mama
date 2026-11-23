#!/usr/bin/env node
/*
 * Egg Mama — level report.
 *
 *   node tools/level-report.mjs                      circuit 1, journey seed 20261122
 *   node tools/level-report.mjs --circuit 2 --journey 7
 *   node tools/level-report.mjs --seed 123456        use a level seed directly (instead of --journey)
 *   node tools/level-report.mjs --bot                also play every segment with the planner bot (jump-only) and
 *                                                    report measured clean times and any failure (about 10 s)
 *   node tools/level-report.mjs --acts               print only the per-act difficulty trace
 *   node tools/level-report.mjs --json               machine-readable
 *
 * The FELT report (what a child feels from the BUILT geometry; tests/felt.mjs never looks at the generator's curves):
 *
 *   node tools/level-report.mjs --felt [--journeys 20] [--circuits 1,2]
 *        per landscape, averaged over the journeys x circuits: required events a minute (whole landscape, and the live acts
 *        without breathers and flag stations), chains (mean size, share in chains of 3+), takeoff windows (min / median),
 *        simultaneous demands, seconds from a flag to its hardest event, the longest wait for a required event (mean of the
 *        maxima, worst) and its p90, the longest quiet stretch counting optional activity, the biggest beat share, the
 *        number of distinct beat types; plus the Spearman of the density ramp and the lowest landscape-to-landscape ratio.
 *   node tools/level-report.mjs --felt --bots [--journeys 3]
 *        adds the clear rates (per landscape, flag to flag, no flock) of a button-mashing toddler and of a calm but sloppy
 *        planner bot (80 ms of unnoticed latency, +-80 ms jitter)
 *   node tools/level-report.mjs --listing 4 [--journey N] [--circuit C]
 *        the beat-by-beat listing of landscape 4 (1-based): every act, every beat with its start time, its required events,
 *        its optional activity and the flags, so a designer can read the landscape like a score
 *
 * Prints a per-landscape table (length, clean time, acts, flags, jumps, gaps, enemies by kind, spikes, springs, lifts,
 * movers, crumbles, golden eggs, eggs, difficulty at start / middle / end, demand) and a per-act trace of the
 * difficulty the generator asked for next to the demand measured from the geometry.
 */
import { T, jumpDistance } from '../docs/js/tuning.mjs';
import { CHAPTERS, difficulty, paceBand } from '../docs/js/chapters.mjs';
import { generateLevel, levelSeed } from '../docs/js/levelgen.mjs';
import { measureDemand, eventsIn } from '../docs/js/levels/demand.mjs';
import { jumpWindow } from '../docs/js/levels/phys.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const circuit = Number(opt('circuit', 1));
const journey = Number(opt('journey', 20261122));
const seed = opt('seed', null) !== null ? Number(opt('seed')) >>> 0 : levelSeed(journey, circuit);
const C = T.cruise;

/* ───────── --felt and --listing (aggregate / designer views) ───────── */
const NAMES = CHAPTERS.map((c) => c.name);
const fmt = (v, d = 1, w = 6) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);
if (opt('felt', false)) {
  const { feltSummary, feltOf } = await import('../tests/felt.mjs');
  const J = Number(opt('journeys', 20));
  const circuits = String(opt('circuits', '1,2')).split(',').map(Number);
  for (const cir of circuits) {
    const t0 = performance.now();
    const levels = Array.from({ length: J }, (_, j) => generateLevel({ circuit: cir, seed: levelSeed(900 + j * 7919, cir) }));
    const genMs = (performance.now() - t0) / J;
    const sum = feltSummary(levels);
    console.log(`\nFELT  circuit ${cir}  ${J} journeys  (generation ${genMs.toFixed(0)} ms each)`);
    console.log('#  landscape        ev/min  live/min  chain  ch3%  winMin winMed  combo%  flag>hard  gapMax(mean/worst)  gapP90  optGap(worst)  topBeat%  distinct');
    sum.lands.forEach((l, i) => console.log([String(i + 1).padStart(2), NAMES[i].padEnd(15), fmt(l.density, 2), fmt(l.liveDensity, 2, 8), fmt(l.chainMean, 2), fmt(100 * l.chain3, 0, 5), fmt(l.worst.winMin, 2), fmt(l.winMed, 2), fmt(100 * (l.comboShare || 0), 0, 6), fmt(l.flagToHardest, 1, 8), `${fmt(l.gapMax, 1)}/${fmt(l.worst.gapMax, 1)}`.padStart(18), fmt(l.gapP90, 1), fmt(l.worst.optGapMax, 1, 12), fmt(100 * l.worst.topShare, 0, 8), String(l.minDistinct).padStart(6)].join('  ')));
    console.log(`Spearman(density, landscape) = ${sum.spearman.toFixed(3)}; lowest landscape / previous = ${sum.minRatio.toFixed(2)}; Meadow ${sum.density[0].toFixed(1)} -> Summit ${sum.density[12].toFixed(1)} required events a minute`);
    const top = sum.lands.map((l) => Object.entries(l.tally).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => `${n} ${(v / l.runs).toFixed(1)}`).join(', '));
    console.log('most common beats per landscape (a landscape has about 19-29 beats):');
    top.forEach((t, i) => console.log(`  ${NAMES[i].padEnd(15)} ${t}`));
    void feltOf;
  }
  if (opt('bots', false)) {
    const { clearRates } = await import('../tests/bot.mjs');
    const BJ = Math.min(J, Number(opt('botjourneys', 3)));
    for (const kind of ['mash', 'sloppy']) {
      const ok = new Array(13).fill(0), runs = new Array(13).fill(0);
      const t0 = performance.now();
      for (const cir of circuits) for (let j = 0; j < BJ; j++) {
        const r = clearRates(generateLevel({ circuit: cir, seed: levelSeed(900 + j * 7919, cir) }), { kind, trials: kind === 'mash' ? 6 : 1, seed: 11 + j });
        r.ok.forEach((v, i) => { ok[i] += v; runs[i] += r.runs[i]; });
      }
      console.log(`\n${kind === 'mash' ? 'button-mashing toddler' : 'calm but sloppy bot (80 ms latency, +-80 ms jitter)'}: share of flag-to-flag segments cleared with no flock (${BJ} journeys x circuits ${circuits.join(',')}, ${((performance.now() - t0) / 1000).toFixed(0)} s)`);
      console.log('  ' + ok.map((v, i) => `${NAMES[i].split(' ')[0]} ${(100 * v / runs[i]).toFixed(0)}%`).join('  '));
      console.log(`  overall ${(100 * ok.reduce((a, b) => a + b, 0) / runs.reduce((a, b) => a + b, 0)).toFixed(0)}%`);
    }
  }
  process.exit(0);
}
if (opt('listing', false)) {
  const { requiredEvents, optionalActivity } = await import('../tests/felt.mjs');
  const ch = Number(opt('listing', 1)) - 1;
  const seedL = opt('seed', null) !== null ? Number(opt('seed')) >>> 0 : levelSeed(journey, circuit);
  const lv = generateLevel({ circuit, seed: seedL });
  const ev = requiredEvents(lv), opts = optionalActivity(lv);
  const x0 = lv.chapters[ch].x0;
  const flags = lv.checkpoints.filter((c) => c.ch === ch).map((c) => c.x);
  console.log(`${NAMES[ch]}  (circuit ${circuit}, seed ${seedL}): ${((lv.chapters[ch].x1 - x0) / C).toFixed(0)} s, ${flags.length} flags\n`);
  for (const a of lv.acts.filter((q) => q.ch === ch)) {
    console.log(`== ${a.id} (${a.role})  ${((a.x0 - x0) / C).toFixed(0)}s .. ${((a.x1 - x0) / C).toFixed(0)}s`);
    a.beats.forEach((b, i) => {
      const bx = a.beatX[i], nx = a.beatX[i + 1] ?? a.x1;
      const n = ev.filter((e) => e.x >= bx && e.x < nx), o = opts.filter((x) => x >= bx && x < nx).length;
      const fl = flags.some((f) => f >= bx - 300 && f < nx);
      console.log(`  ${String(Math.round((bx - x0) / C)).padStart(4)}s  ${b.padEnd(16)} ${String(Math.round((nx - bx) / C)).padStart(3)}s   required ${n.length} ${n.length ? '(' + [...new Set(n.map((e) => e.kind))].join(', ') + ')' : ''}  optional ${o}${fl ? '   [flag]' : ''}`);
    });
  }
  process.exit(0);
}

const t0 = performance.now();
const level = generateLevel({ circuit, seed });
const genMs = performance.now() - t0;

/* ───────── per-landscape numbers ───────── */
const kind = (k) => (k === 'ground' ? 'ground' : 'ledge');
const main = level.platforms.filter((p) => !p.o);
const isDyn = (p) => !!p.motion && !(p.kind === 'ledge' && p.motion.amp <= 10);       // Reedwater's logs only bob
function requiredJumps(x0, x1) {
  let n = 0, gaps = 0;
  const ps = main.filter((p) => !isDyn(p) && p.x + p.w >= x0 - 400 && p.x <= x1 + 400);
  for (let i = 0; i + 1 < ps.length; i++) {
    const p = ps[i], q = ps[i + 1];
    if (p.x + p.w < x0 || p.x + p.w >= x1) continue;
    const gap = q.x - (p.x + p.w), rise = p.y - q.y;
    if (gap > 0 || rise > T.stepUp) { n++; if (gap > 0) gaps++; }
  }
  // lifts and movers need a jump on and a jump off
  for (const p of main) if (isDyn(p) && p.x >= x0 && p.x < x1) n += 2;
  return { jumps: n, gaps };
}

const rows = level.chapters.map((ch, i) => {
  const a = level.checkpoints[ch.flag].x;
  const b = i < 12 ? level.checkpoints[level.chapters[i + 1].flag].x : level.beacon.x;
  const inR = (x) => x >= ch.x0 && x < ch.x1;
  const walkers = level.enemies.filter((e) => e.kind === 'walker' && inR(e.x0)).length;
  const flyers = level.enemies.filter((e) => e.kind === 'flyer' && inR(e.cx)).length;
  const { jumps, gaps } = requiredJumps(ch.x0, ch.x1);
  const acts = level.acts.filter((x) => x.ch === i);
  const dm = measureDemand(level, ch.x0 + 1000, ch.x1 - 800);
  const [lo, hi] = paceBand(i);
  const L = ch.x1 - ch.x0;
  // how much of the landscape is quiet: further than 450 u (~4 s) from anything to do (jump, enemy, hazard, lift, spring)
  const ev = eventsIn(level, ch.x0, ch.x1).map((e) => e.x);
  for (const q of level.springs) if (inR(q.x)) ev.push(q.x);
  ev.sort((p, q) => p - q);
  let quiet = 0, prev = ch.x0;
  for (const x of [...ev, ch.x1]) { quiet += Math.max(0, x - prev - 900); prev = x; }
  return {
    quietPct: Math.round((100 * quiet) / L),
    landscape: i + 1, name: CHAPTERS[i].name, lengthU: Math.round(L), cleanS: +((b - a) / C).toFixed(1), band: [lo, hi],
    acts: acts.length, flags: level.checkpoints.filter((c) => c.ch === i).length, jumps, gaps,
    walkers, flyers, spikes: level.hazards.filter((h) => inR(h.x)).length, springs: level.springs.filter((s) => inR(s.x)).length,
    lifts: main.filter((p) => p.kind === 'lift' && inR(p.x)).length, movers: main.filter((p) => p.kind === 'mover' && inR(p.x)).length,
    crumbles: level.platforms.filter((p) => p.kind === 'crumble' && inR(p.x)).length,
    golds: level.pickups.filter((q) => q.kind === 'gold' && inR(q.x)).length,
    eggs: level.pickups.filter((q) => q.kind === 'egg' && inR(q.x)).length,
    shields: level.pickups.filter((q) => q.kind === 'shield' && inR(q.x)).length, magnets: level.pickups.filter((q) => q.kind === 'magnet' && inR(q.x)).length,
    d0: difficulty(i, circuit, 0), dMid: difficulty(i, circuit, 0.5), d1: difficulty(i, circuit, 1), demand: +dm.mean.toFixed(1),
  };
});

const actRows = level.acts.map((a) => {
  const m = measureDemand(level, a.x0, a.x1);
  return { ch: a.ch, id: a.id, role: a.role, seconds: +((a.x1 - a.x0) / C).toFixed(0), d0: a.d0, d1: a.d1, score: +m.score.toFixed(1), events: m.n, peak: +m.peak.toFixed(1), chain: m.chain, density: +m.density.toFixed(2) };
});

/* ───────── optional: play every segment ───────── */
let bot = null;
if (opt('bot', false)) {
  const { playLevel, segmentsOf } = await import('../tests/bot.mjs');
  const segs = segmentsOf(level);
  const per = new Array(13).fill(0), fails = [];
  for (const s of segs) {
    const r = playLevel(level, { startCheckpoint: s.from, stopAtCheckpoint: s.to ?? undefined, allowSteer: false, tOffset: s.from * 1.37 % 11 });
    if (!r.ok) fails.push({ segment: s.from, landscape: s.ch + 1, x: Math.round(r.x), reason: r.reason });
    per[s.ch] += s.to === null ? (level.beacon.x - s.x0) / C : r.clean;
  }
  bot = { segments: segs.length, fails, clean: per.map((v) => +v.toFixed(1)), totalMin: +(per.reduce((s, v) => s + v, 0) / 60).toFixed(1) };
  rows.forEach((r, i) => { r.botCleanS = bot.clean[i]; });
}

if (opt('json', false)) {
  console.log(JSON.stringify({ circuit, seed, genMs: +genMs.toFixed(0), landscapes: rows, acts: actRows, bot }, null, 1));
  process.exit(0);
}

/* ───────── print ───────── */
const pad = (v, n, right = false) => { const s = String(v); return right ? s.padEnd(n) : s.padStart(n); };
const bar = (v, max = 20, width = 24) => '#'.repeat(Math.max(0, Math.round((Math.min(v, max) / max) * width)));

if (!opt('acts', false)) {
  console.log(`Egg Mama world  circuit ${circuit}  seed ${seed}  generated in ${genMs.toFixed(0)} ms  ${level.platforms.length} platforms  ${level.pickups.length} pickups  ${level.enemies.length} enemies  ${level.hazards.length} spikes  ${level.springs.length} springs  ${level.checkpoints.length} flags  endX ${level.endX}`);
  console.log(`default cruise ${C} u/s, flat jump ${jumpDistance().toFixed(0)} u; every landscape is paced by chapters.seconds (clean time = distance / cruise, jump-only)\n`);
  const head = ['#', 'landscape', 'len u', 'clean s', '(band)', 'acts', 'flags', 'jumps', 'gaps', 'walk', 'fly', 'spk', 'spr', 'lift', 'mov', 'crum', 'gold', 'eggs', 'shld', 'magn', 'd0', 'dmid', 'd1', 'demand', 'quiet%'];
  if (bot) head.splice(5, 0, 'bot s');
  console.log(head.join('  '));
  for (const r of rows) {
    const cells = [pad(r.landscape, 1), pad(r.name, 15, true), pad(r.lengthU, 6), pad(r.cleanS, 7), pad(`${r.band[0]}-${r.band[1]}`, 9, true)];
    if (bot) cells.push(pad(r.botCleanS, 6));
    cells.push(pad(r.acts, 4), pad(r.flags, 5), pad(r.jumps, 5), pad(r.gaps, 4), pad(r.walkers, 4), pad(r.flyers, 3), pad(r.spikes, 3), pad(r.springs, 3), pad(r.lifts, 4), pad(r.movers, 3), pad(r.crumbles, 4), pad(r.golds, 4), pad(r.eggs, 5), pad(r.shields, 4), pad(r.magnets, 4), pad(r.d0.toFixed(1), 4), pad(r.dMid.toFixed(1), 4), pad(r.d1.toFixed(1), 4), pad(r.demand, 6), pad(r.quietPct, 6));
    console.log(cells.join('  '));
  }
  const tot = rows.reduce((s, r) => s + r.cleanS, 0);
  console.log(`\ncircuit clean time ${(tot / 60).toFixed(1)} min (window ${T.journeyMinutes[0]}-${T.journeyMinutes[1]} min)` + (bot ? `; planner bot: ${bot.segments} segments, ${bot.fails.length} failed, total ${bot.totalMin} min` : ''));
  if (bot && bot.fails.length) console.log('FAILED segments:', JSON.stringify(bot.fails));
  console.log('');
}

console.log('per-act difficulty trace: d = the difficulty the generator asked for (start->end of the act), score = demand measured from the geometry\n');
console.log(['ch', 'act', 'role', 's', 'd0', 'd1', 'score', 'n', 'peak', 'chain', 'dens', ''].join('  '));
for (const a of actRows) {
  console.log([pad(a.ch + 1, 2), pad(a.id, 17, true), pad(a.role, 9, true), pad(a.seconds, 3), pad(a.d0.toFixed(1), 4), pad(a.d1.toFixed(1), 4), pad(a.score, 5), pad(a.events, 3), pad(a.peak, 5), pad(a.chain, 2), pad(a.density, 4), bar(a.score)].join('  '));
}
void eventsIn; void jumpWindow;
