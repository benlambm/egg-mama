import assert from "node:assert/strict";
import test from "node:test";
import { CHAPTERS } from "../docs/chapters.mjs";
import { advance, createRun, MAX_DUCKLINGS, restoreCheckpoint, ROLL_SPEED, saveCheckpoint, START, STEP, WALK } from "../docs/engine.mjs";
import { SWIPE_JUMP_SECONDS, swipeDirection } from "../docs/gestures.mjs";

const controls = (extra = {}) => ({ autoRoll: true, left: false, right: false, jump: false, jumpPressed: false, sprint: false, ...extra });
const tick = (run, input) => advance(run, input, STEP, 620);

test("swipes distinguish steering, jumping, and short drags", () => {
  assert.equal(swipeDirection(8, -46, 340), "jump");
  assert.equal(swipeDirection(-25, -9, 280), "left");
  assert.equal(swipeDirection(50, 18, 700), "right");
  assert.equal(swipeDirection(10, -10, 280), null);
  assert.equal(swipeDirection(0, 80, 600), null);
});

test("Mama eases into a slow roll and can reverse or speed up", () => {
  const run = createRun(42);
  for (let i = 0; i < 90; i++) tick(run, controls());
  assert.ok(run.player.x > START + 35);
  assert.equal(run.player.vx, ROLL_SPEED);
  assert.notEqual(run.player.roll, 0);
  for (let i = 0; i < 55; i++) tick(run, controls({ left: true }));
  assert.equal(run.player.vx, -WALK);
  for (let i = 0; i < 45; i++) tick(run, controls({ right: true }));
  assert.equal(run.player.vx, WALK);
});

test("golden eggs alone hatch spare ducklings, and saves keep the flock", () => {
  const run = createRun(42);
  const input = controls();
  run.player.x = 78;
  tick(run, input);
  assert.equal(run.collected, 1);
  assert.equal(run.ducklings, 0);
  run.player.x = 102;
  tick(run, input);
  assert.equal(run.ducklings, 1);
  for (let i = 0; i < 6; i++) {
    run.eggs.push({ x: 102, y: 226, kind: "gold" });
    tick(run, input);
  }
  assert.equal(run.ducklings, MAX_DUCKLINGS);
  const restored = restoreCheckpoint(JSON.parse(JSON.stringify(saveCheckpoint(run))));
  assert.equal(restored.ducklings, MAX_DUCKLINGS);
  assert.equal(restored.collected, run.collected);
  assert.equal(restored.player.x, restored.checkpoint.x);
});

test("an upward swipe clears generated gaps at the default roll speed", () => {
  for (const seed of [0, 11, 42, 193]) {
    let run = createRun(seed);
    const input = controls();
    let heldUntil = 0;
    let milestone = false;
    for (let i = 0; i < 35000 && run.stage < CHAPTERS.length; i++) {
      // Isolate reachable terrain from timing-dependent hazards.
      for (const foe of run.enemies) foe.defeated = true;
      for (const item of run.objects) if (item.kind === "spikes" || item.kind === "spring") item.taken = true;
      const p = run.player;
      const ground = p.ground;
      if (ground?.type === "ground" && ground.x + ground.w - p.x < 13) {
        input.jumpPressed = true;
        heldUntil = run.time + SWIPE_JUMP_SECONDS;
      }
      input.jump = run.time < heldUntil;
      tick(run, input);
      assert.ok(!run.events.some(({ kind }) => kind === "hit" || kind === "duckling-used"), `seed ${seed} at chapter ${run.stage + 1}, x=${p.x}`);
      milestone ||= run.events.some(({ kind }) => kind === "beacon");
      if (run.events.some(({ kind }) => kind === "gate") && run.stage === 5) {
        run = restoreCheckpoint(JSON.parse(JSON.stringify(saveCheckpoint(run))));
      }
      run.events.length = 0;
    }
    assert.equal(run.stage, CHAPTERS.length);
    assert.equal(milestone, true);
  }
});
