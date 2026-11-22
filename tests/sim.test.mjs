import assert from "node:assert/strict";
import test from "node:test";
import { T, jumpDistance } from "../docs/js/tuning.mjs";
import { createGame, startRun, act, step, drainEvents, snapshotCarry, chapterSlotAt, chapterIndexAt } from "../docs/js/sim.mjs";

/** A tiny hand-built level: ground, a gap, ground, a golden egg, a flag, the gate. */
function tiny(extra = {}) {
  const g = T.groundY;
  return {
    chapter: 0, circuit: 1, seed: 1, start: { x: 60, y: g }, endX: 900,
    platforms: [
      { id: 0, kind: "ground", x: 0, y: g, w: 400, h: 120 },
      { id: 1, kind: "ground", x: 450, y: g, w: 600, h: 120 },
    ],
    pickups: [{ id: 0, kind: "egg", x: 150, y: g - 22 }, { id: 1, kind: "gold", x: 200, y: g - 22 }],
    enemies: [], hazards: [], springs: [],
    checkpoints: [{ id: 0, x: 60, y: g, platform: 0 }, { id: 1, x: 520, y: g, platform: 1 }],
    beacon: null, cues: [], beats: [], water: null, ...extra,
  };
}
const run = (game, seconds, held = {}) => { for (let i = 0; i < seconds / T.step; i++) step(game, held); };

test("Mama eases into the gentle roll and holds cruise speed", () => {
  const game = createGame(tiny());
  startRun(game);
  run(game, 0.3);
  assert.ok(game.mama.vx > 0 && game.mama.vx < T.cruise, "still easing in");
  run(game, 2);
  assert.ok(Math.abs(game.mama.vx - T.cruise) < 0.5);
  assert.ok(game.mama.onGround);
});

const longRoad = () => tiny({ platforms: [{ id: 0, kind: "ground", x: 0, y: T.groundY, w: 4000, h: 120 }], pickups: [], checkpoints: [{ id: 0, x: 60, y: T.groundY, platform: 0 }] });

test("swipes: push speeds up, brake backs up, then the roll returns", () => {
  const game = createGame(longRoad());
  startRun(game); run(game, 2);
  act(game, "push"); run(game, 0.6);
  assert.equal(Math.round(game.mama.vx), T.push);
  run(game, T.steerSeconds + 0.5);
  assert.ok(Math.abs(game.mama.vx - T.cruise) < 1);
  act(game, "brake"); run(game, 0.5);
  assert.ok(game.mama.vx < 0, "backing up");
  run(game, T.steerSeconds + 0.6);
  assert.ok(Math.abs(game.mama.vx - T.cruise) < 1, "back to the gentle roll");
});

test("a jump clears a gap inside the generator's limits", () => {
  const game = createGame(tiny());
  startRun(game); run(game, 3);
  const edge = 400;
  assert.ok(jumpDistance() > T.maxGapEasy + 20);
  // jump when she is a few units before the edge
  let jumped = false;
  for (let i = 0; i < 6 / T.step && !jumped; i++) {
    if (!jumped && game.mama.x > edge - 14) { act(game, "jump"); jumped = true; }
    step(game, {});
  }
  run(game, 1.2);
  assert.ok(game.mama.onGround && game.mama.ground.id === 1, "landed on the far island");
  assert.equal(game.stats.falls, 0);
});

test("without a jump she falls and, with no ducklings, the attempt ends", () => {
  const game = createGame(tiny({ pickups: [] }));
  startRun(game);
  run(game, 8);
  assert.equal(game.status, "dead");
});

test("shield absorbs the next hit, then a duckling, then the attempt ends", () => {
  const g = T.groundY;
  const level = tiny({ hazards: [{ id: 0, kind: "spikes", x: 230, y: g, w: 40 }] });
  const game = createGame(level, { flock: 1 });
  game.shield = true;
  startRun(game);
  game.mama.invuln = 0;
  game.mama.x = 235; game.mama.y = g;
  run(game, 0.05);
  assert.equal(game.shield, false);
  assert.equal(game.flock, 1, "shield went first");
  game.mama.invuln = 0; game.mama.x = 235; game.mama.y = g; game.mama.onGround = true;
  run(game, 0.05);
  assert.equal(game.flock, 0, "then a duckling");
  assert.equal(game.status, "running");
  assert.ok(game.mama.invuln > 1, "recovery window");
  game.mama.invuln = 0; game.mama.x = 235; game.mama.y = g; game.mama.onGround = true;
  run(game, 0.05);
  assert.equal(game.status, "dead");
});

test("only golden eggs hatch ducklings, capped at five, and eggs still count", () => {
  const g = T.groundY;
  const pick = [{ id: 0, kind: "egg", x: 100, y: g - 20 }];
  for (let i = 0; i < 7; i++) pick.push({ id: i + 1, kind: "gold", x: 100, y: g - 20 });
  const game = createGame(tiny({ pickups: pick }), { eggs: 0, score: 0, flock: 0 });
  startRun(game);
  game.mama.x = 100; game.mama.invuln = 5;
  run(game, 0.05);
  assert.equal(game.eggs, 8);
  assert.equal(game.flock, T.maxFlock);
  assert.equal(game.score, T.scoreEgg + 7 * T.scoreGold);
  const events = drainEvents(game);
  assert.equal(events.filter((e) => e.type === "hatch").length, T.maxFlock);
  assert.equal(events.filter((e) => e.type === "gold").length, 7);
  assert.deepEqual(snapshotCarry(game), { eggs: 8, score: game.score, flock: T.maxFlock });
});

test("checkpoint flag, survivable fall returns to it", () => {
  const game = createGame(tiny(), { flock: 2 });
  startRun(game);
  game.mama.x = 530; game.mama.y = T.groundY; game.mama.ground = game.platforms[1];
  run(game, 0.1);
  assert.equal(game.checkpoint, 1);
  game.mama.x = 420; game.mama.y = T.groundY; game.mama.onGround = false; game.mama.vy = 0;  // over the gap
  run(game, 1.2);
  assert.equal(game.flock, 1);
  assert.equal(game.status, "running");
  assert.ok(Math.abs(game.mama.x - 520) < 60 && game.mama.onGround, "back on safe footing at the flag");
});

test("crumbling ledge gives way after the delay", () => {
  const g = T.groundY;
  const level = tiny();
  level.platforms.push({ id: 2, kind: "crumble", x: 100, y: g - 50, w: 120, h: 14 });
  const game = createGame(level);
  startRun(game);
  game.mama.x = 150; game.mama.y = g - 120; game.mama.vy = 0; game.mama.onGround = false;
  run(game, 0.4);
  assert.equal(game.mama.ground?.id, 2);
  run(game, T.crumbleDelay + 0.2);
  assert.equal(game.platforms[2].state, "fall");
});

test("lifts carry Mama", () => {
  const g = T.groundY;
  const level = tiny();
  level.platforms[0] = { id: 0, kind: "ground", x: 0, y: g, w: 100, h: 120 };
  level.platforms.push({ id: 2, kind: "lift", x: 140, y: g - 60, w: 160, h: 14, motion: { axis: "y", amp: 40, period: 4, phase: 0 } });
  const game = createGame(level);
  startRun(game);
  game.mama.x = 200; game.mama.y = g - 200; game.mama.vy = 0; game.mama.onGround = false; game.mama.vx = 0;
  run(game, 0.8);
  assert.equal(game.mama.ground?.id, 2);
  const y0 = game.mama.y;
  run(game, 0.5);
  assert.notEqual(Math.round(game.mama.y), Math.round(y0), "rides the lift");
});

test("same inputs, same game (deterministic)", () => {
  const play = () => {
    const game = createGame(tiny({ enemies: [{ id: 0, kind: "walker", x0: 200, x1: 300, y: T.groundY, speed: 40, phase: 0.3 }] }), { flock: 3 });
    startRun(game);
    for (let i = 0; i < 1500; i++) { if (i % 200 === 100) act(game, "jump"); step(game, {}); }
    return JSON.stringify([game.mama.x, game.mama.y, game.eggs, game.score, game.flock, game.status]);
  };
  assert.equal(play(), play());
});

test("one continuous world: crossing a landscape boundary just emits chapter-enter and keeps rolling", () => {
  const level = tiny({ platforms: [{ id: 0, kind: "ground", x: 0, y: T.groundY, w: 4000, h: 120 }], pickups: [], checkpoints: [{ id: 0, x: 60, y: T.groundY, platform: 0, ch: 0 }],
    chapters: [{ index: 0, x0: 0, x1: 300, flag: 0 }, { index: 1, x0: 300, x1: 600, flag: 0 }, { index: 2, x0: 600, x1: 4000, flag: 0 }], endX: 3900 });
  assert.equal(chapterSlotAt(level, 10), 0);
  assert.equal(chapterSlotAt(level, 300), 1);
  assert.equal(chapterIndexAt(level, 1000), 2);
  const game = createGame(level);
  startRun(game);
  const seen = [];
  for (let i = 0; i < 8 / T.step; i++) { step(game, {}); for (const e of drainEvents(game)) if (e.type === "chapter-enter") seen.push(e.index); }
  assert.deepEqual(seen, [1, 2]);
  assert.equal(game.status, "running");
  // restoring from the middle of the world starts in the right landscape and doesn't re-announce it
  const later = createGame(level, {}, { checkpoint: 0 });
  assert.equal(later.slot, 0);
});
