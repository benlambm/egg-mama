import { CHAPTERS, chapterIndex, loopNumber } from "./chapters.mjs";

export const HEIGHT = 288;
export const FLOOR = 246;
export const STEP = 1 / 120;
export const WALK = 151;
export const SPRINT = 218;
export const GRAVITY = 795;
export const JUMP = 301;
export const START = 43;
export const MAX_DUCKLINGS = 5;
const SAVE_FORMAT = 1;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const traveled = (run) => Math.floor((run.furthest - START) / 10);
export const runScore = (run) => run.points + traveled(run);

function random(run) {
  run.seed = (run.seed + 0x6d2b79f5) >>> 0;
  let value = Math.imul(run.seed ^ run.seed >>> 15, run.seed | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

function platform(run, x, y, w, type = "ground") {
  const tile = { x, y, w, type, ox: x, oy: y, dx: 0, dy: 0, crumblesAt: 0, returnsAt: 0, biome: chapterIndex(run.generatedStage) };
  run.platforms.push(tile);
  return tile;
}

function egg(run, x, y, kind = "egg") {
  run.eggs.push({ x, y, kind, taken: false });
}

function trail(run, x, y, count, spacing = 18) {
  for (let i = 0; i < count; i++) egg(run, x + i * spacing, y);
}

function arch(run, x, gap, fromY, toY) {
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    egg(run, x - 13 + t * (gap + 27), fromY + (toY - fromY) * t - 22 - Math.sin(t * Math.PI) * 30);
  }
}

function enemy(run, x, y, kind, roam) {
  run.enemies.push({ x, y, ox: x, oy: y, kind, roam, face: -1, defeated: false, phase: random(run) * 6.28 });
}

function object(run, x, y, kind, stage = run.generatedStage) {
  run.objects.push({ x, y, kind, stage, active: false, taken: false });
}

function flag(run, tile, offset = 36) {
  object(run, tile.x + offset, tile.y, "flag");
}

function playerAt(x, y, tile, invulnerability = 0) {
  return {
    x, y, vx: 0, vy: 0, face: 1, width: 15, height: 22, ground: tile,
    coyote: 0, jumpBuffer: 0, jumping: false, invulnerability, stride: 0,
  };
}

export function createRun(seed = Math.floor(Math.random() * 4294967296)) {
  const run = {
    seed, time: 0, tick: 0, points: 0, collected: 0, ducklings: 0, shield: false, magnet: 0,
    combo: 0, comboUntil: 0, furthest: START, camera: 0, stage: 0, over: false,
    platforms: [], eggs: [], enemies: [], objects: [], events: [], chunks: 0,
    nextFlag: 1780, lastPattern: -1, generatedStage: 0, stageStart: 0, placedBeacon: false, beaconsLit: 0,
  };

  const start = platform(run, -48, FLOOR, 286);
  run.player = playerAt(START, FLOOR, start);
  run.checkpoint = { x: START, y: FLOOR, tile: start };

  egg(run, 78, FLOOR - 20);
  egg(run, 102, FLOOR - 22, "gold");
  trail(run, 126, FLOOR - 20, 5);
  platform(run, 126, 195, 81, "ledge");
  trail(run, 143, 178, 4, 16);
  arch(run, 238, 53, FLOOR, 242);

  platform(run, 291, 242, 195);
  enemy(run, 377, 242, "beetle", 23);
  platform(run, 343, 189, 75, "ledge");
  trail(run, 359, 171, 3, 19);
  object(run, 462, 222, "shield");
  arch(run, 486, 57, 242, 230);

  platform(run, 543, 230, 191);
  trail(run, 587, 209, 4);
  object(run, 688, 230, "spring");
  platform(run, 620, 178, 67, "ledge");
  platform(run, 740, 153, 75, "ledge");
  egg(run, 777, 132, "gold");
  arch(run, 734, 53, 230, 246);

  const firstFlag = platform(run, 787, FLOOR, 226);
  flag(run, firstFlag);
  object(run, 894, FLOOR, "spikes");
  trail(run, 842, 223, 3, 15);
  egg(run, 945, 223, "gold");
  object(run, 970, 223, "magnet");

  run.lastGround = firstFlag;
  fillWorld(run, 900);
  return run;
}

function makeChunk(run) {
  const previous = run.lastGround;
  const edge = previous.x + previous.w;
  const chapter = CHAPTERS[chapterIndex(run.generatedStage)];
  const tier = clamp(Math.floor(run.generatedStage / 2), 0, 8);
  const atBoundary = edge - run.stageStart >= chapter.length;
  const finale = atBoundary && chapterIndex(run.generatedStage) === CHAPTERS.length - 1 && !run.placedBeacon;
  const entrance = atBoundary && !finale;
  const gap = entrance || finale ? 46 : Math.round(40 + random(run) * (24 + tier));
  const rises = [-14, -8, 0, 0, 11, 19];
  const heightChange = entrance || finale ? 0 : rises[Math.floor(random(run) * rises.length)];
  const y = clamp(previous.y + heightChange, 218, 251);
  const x = edge + gap;
  const w = entrance || finale ? 190 : Math.round(184 + random(run) * 42);

  if (entrance) {
    run.generatedStage++;
    run.stageStart = x;
    run.placedBeacon = false;
    run.nextFlag = x + 540;
  }
  const land = platform(run, x, y, w);
  run.lastGround = land;
  run.chunks++;
  arch(run, edge, gap, previous.y, y);

  if (entrance || finale) {
    object(run, x + (finale ? 71 : 31), y, finale ? "beacon" : "gate");
    trail(run, x + 57, y - 21, 6, 16);
    egg(run, x + w - 32, y - 21, "gold");
    if (finale) run.placedBeacon = true;
    return;
  }

  const firstChallenge = previous.x === run.stageStart && chapter.entrance !== undefined;
  let patternIndex = Math.floor(random(run) * chapter.patterns.length);
  if (chapter.patterns[patternIndex] === run.lastPattern) patternIndex = (patternIndex + 1) % chapter.patterns.length;
  const pattern = firstChallenge ? chapter.entrance : chapter.patterns[patternIndex];
  if (!firstChallenge && x + 39 >= run.nextFlag) {
    flag(run, land, 39);
    trail(run, x + 68, y - 21, 6, 15);
    run.nextFlag = x + 39 + 750;
    return;
  }

  run.lastPattern = pattern;
  switch (pattern) {
    case 0:
      trail(run, x + 33, y - 21, 7, 15);
      platform(run, x + 63, y - 55, 75, "ledge");
      trail(run, x + 78, y - 73, 3);
      object(run, x + w - 26, y - 20, "shield");
      break;
    case 1:
      enemy(run, x + 94, y, "beetle", 30 + tier);
      platform(run, x + 55, y - 47, 85, "ledge");
      trail(run, x + 74, y - 65, 4);
      egg(run, x + w - 29, y - 19);
      break;
    case 2:
      object(run, x + 90, y, "spikes");
      platform(run, x + 56, y - 52, 73, "moving");
      trail(run, x + 72, y - 72, 4, 15);
      trail(run, x + 131, y - 20, 3, 15);
      break;
    case 3:
      object(run, x + 51, y, "spring");
      platform(run, x + 57, y - 54, 56, "crumble");
      platform(run, x + 121, y - 100, 53, "ledge");
      egg(run, x + 149, y - 120, "gold");
      trail(run, x + 87, y - 22, 5, 15);
      break;
    case 4:
      enemy(run, x + 103, y - 44, "wasp", 37);
      trail(run, x + 38, y - 20, 6, 16);
      object(run, x + w - 28, y - 20, "magnet");
      break;
    case 5:
      enemy(run, x + 62, y, "beetle", 18);
      enemy(run, x + w - 47, y, "beetle", 17);
      platform(run, x + 62, y - 50, 69, "ledge");
      trail(run, x + 75, y - 69, 4, 14);
      break;
    case 7:
      platform(run, x + 27, y - 42, 36, "ledge");
      platform(run, x + 82, y - 51, 38, "ledge");
      platform(run, x + 141, y - 37, 35, "ledge");
      trail(run, x + 38, y - 61, 2, 15);
      trail(run, x + 93, y - 70, 2, 15);
      egg(run, x + 155, y - 56, "gold");
      trail(run, x + 63, y - 20, 4, 19);
      break;
    case 8:
      platform(run, x + 49, y - 45, 44, "crumble");
      platform(run, x + 113, y - 69, 52, "crumble");
      trail(run, x + 55, y - 65, 2, 15);
      egg(run, x + 138, y - 89, "gold");
      enemy(run, x + 122, y, "beetle", 29);
      break;
    case 9:
      platform(run, x + 49, y - 46, 67, "lift");
      platform(run, x + 133, y - 69, 47, "ledge");
      trail(run, x + 57, y - 22, 5, 17);
      egg(run, x + 154, y - 89, "gold");
      break;
  }
}

function fillWorld(run, rightEdge) {
  while (run.lastGround.x + run.lastGround.w < rightEdge) makeChunk(run);
}

function updatePlatforms(run) {
  for (const tile of run.platforms) {
    if (tile.type !== "moving" && tile.type !== "lift") continue;
    const wave = run.time * 1.55 + tile.ox / 137;
    const x = tile.ox + (tile.type === "lift" ? 0 : Math.sin(wave) * 21);
    const y = tile.oy + Math.cos(wave) * (tile.type === "lift" ? 19 : 5);
    tile.dx = x - tile.x;
    tile.dy = y - tile.y;
    tile.x = x;
    tile.y = y;
  }
}

function updateEnemies(run) {
  for (const foe of run.enemies) {
    if (foe.defeated) continue;
    const pace = foe.kind === "wasp" ? 1.9 : 1.45;
    const wave = run.time * pace + foe.phase;
    foe.x = foe.ox + Math.sin(wave) * foe.roam;
    foe.face = Math.cos(wave) >= 0 ? 1 : -1;
    if (foe.kind === "wasp") foe.y = foe.oy + Math.sin(wave * 1.53) * 10;
  }
}

function recover(run) {
  const saved = run.checkpoint;
  run.player = playerAt(saved.x, saved.y, saved.tile, 1.12);
  run.camera = Math.max(0, saved.x - 85);
}

function hit(run, causeX, pit = false) {
  const p = run.player;
  if (run.over || (!pit && p.invulnerability > 0)) return;
  run.combo = 0;
  if (run.shield) {
    run.shield = false;
    run.events.push({ kind: "shield-break", x: p.x, y: p.y - 13 });
  } else if (run.ducklings > 0) {
    run.ducklings--;
    run.events.push({ kind: "duckling-used", x: p.x, y: Math.min(p.y - 13, HEIGHT - 8) });
  } else {
    run.over = true;
    run.events.push({ kind: "hit", x: p.x, y: Math.min(p.y - 13, HEIGHT - 8) });
    run.events.push({ kind: "over" });
    return;
  }
  if (pit) {
    recover(run);
    run.events.push({ kind: "recover" });
  } else {
    p.invulnerability = 1.08;
    p.vx = causeX < p.x ? 158 : -158;
    p.vy = -166;
    p.coyote = 0;
    p.ground = null;
    p.jumping = false;
  }
}

function collectEggs(run, elapsed) {
  const p = run.player;
  for (const pickup of run.eggs) {
    if (pickup.taken || Math.abs(p.x - pickup.x) > 90) continue;
    const dx = p.x - pickup.x;
    const dy = p.y - p.height * 0.55 - pickup.y;
    if (run.magnet > 0 && Math.hypot(dx, dy) < 76) {
      pickup.x += dx * elapsed * 9;
      pickup.y += dy * elapsed * 9;
    }
    if (Math.abs(p.x - pickup.x) > 13 || Math.abs(p.y - 11 - pickup.y) > 17) continue;
    const gold = pickup.kind === "gold";
    pickup.taken = true;
    run.collected++;
    const hatched = gold && run.ducklings < MAX_DUCKLINGS;
    if (hatched) run.ducklings++;
    run.combo = (run.time <= run.comboUntil ? run.combo : 0) + 1;
    run.comboUntil = run.time + 1.25;
    const multiplier = clamp(1 + Math.floor((run.combo - 1) / 3), 1, 4);
    run.points += (gold ? 500 : 100) * multiplier;
    run.events.push({ kind: pickup.kind, x: pickup.x, y: pickup.y, combo: run.combo, multiplier, hatched });
  }
}

function touchObjects(run) {
  const p = run.player;
  for (const item of run.objects) {
    const distance = Math.abs(p.x - item.x);
    if (item.taken) continue;
    const boundary = item.kind === "gate" || item.kind === "beacon";
    if (boundary || item.kind === "flag") {
      const reached = boundary ? p.x >= item.x && p.x <= item.x + 107 : distance <= 23;
      if (item.active || item.x <= run.checkpoint.x || !reached || p.y > item.y + 1) continue;
      const safe = run.platforms.find((tile) => tile.type === "ground" && tile.y === item.y && item.x >= tile.x && item.x < tile.x + tile.w);
      if (!safe) continue;
      item.active = true;
      run.checkpoint = { x: item.x, y: item.y, tile: safe };
      if (item.kind === "gate") run.stage = item.stage;
      if (item.kind === "beacon") {
        run.beaconsLit = loopNumber(item.stage);
        run.points += 2500;
      }
      const kind = item.kind === "flag" ? "checkpoint" : item.kind;
      run.events.push({ kind, x: item.x, y: item.y - 26 });
      continue;
    }

    if (distance > 23) continue;
    if (item.kind === "spikes") {
      if (distance < 17 && p.y > item.y - 9 && p.y <= item.y + 2) hit(run, item.x);
      continue;
    }
    if (item.kind === "spring") {
      if (p.ground && distance < 13 && Math.abs(p.y - item.y) < 3) {
        p.vy = -420;
        p.ground = null;
        p.coyote = 0;
        p.jumping = false;
        item.pressedAt = run.time;
        run.events.push({ kind: "spring", x: item.x, y: item.y - 4 });
      }
      continue;
    }
    if (distance > 14 || Math.abs(p.y - 11 - item.y) > 17) continue;
    item.taken = true;
    if (item.kind === "shield") run.shield = true;
    if (item.kind === "magnet") run.magnet = 12;
    run.points += 100;
    run.events.push({ kind: item.kind, x: item.x, y: item.y });
  }
}

function hitEnemies(run, previousFeet) {
  const p = run.player;
  for (const foe of run.enemies) {
    if (foe.defeated || Math.abs(foe.x - p.x) > (foe.kind === "beetle" ? 16 : 14)) continue;
    const top = foe.y - (foe.kind === "beetle" ? 13 : 12);
    if (p.y < top || p.y - p.height > foe.y - 1) continue;
    if (previousFeet <= top + 3 && p.vy >= 0) {
      foe.defeated = true;
      run.points += 200;
      p.y = top;
      p.vy = -222;
      p.coyote = 0;
      p.ground = null;
      p.jumping = false;
      run.events.push({ kind: "stomp", x: foe.x, y: top });
    } else {
      hit(run, foe.x);
    }
  }
}

function movePlayer(run, controls, elapsed) {
  const p = run.player;
  const halfWidth = p.width / 2;
  const move = Number(controls.right) - Number(controls.left);
  const maxSpeed = controls.sprint ? SPRINT : WALK;

  if (p.ground && p.ground.crumblesAt > 0 && run.time >= p.ground.crumblesAt) p.ground = null;
  if (p.ground) {
    p.x += p.ground.dx;
    p.y += p.ground.dy;
    p.coyote = 0.096;
  }

  p.invulnerability = Math.max(0, p.invulnerability - elapsed);
  p.coyote = Math.max(0, p.coyote - elapsed);
  p.jumpBuffer = Math.max(0, p.jumpBuffer - elapsed);
  if (controls.jumpPressed) {
    p.jumpBuffer = 0.125;
    controls.jumpPressed = false;
  }

  const onIce = p.ground && CHAPTERS[p.ground.biome].ice;
  const acceleration = p.ground ? (onIce ? 960 : 1410) : 875;
  const friction = p.ground ? (onIce ? 365 : 1650) : 720;
  if (move) {
    p.face = move;
    p.vx += clamp(move * maxSpeed - p.vx, -acceleration * elapsed, acceleration * elapsed);
  } else {
    p.vx += clamp(-p.vx, -friction * elapsed, friction * elapsed);
  }

  if (p.jumpBuffer > 0 && p.coyote > 0) {
    p.vy = -JUMP;
    p.ground = null;
    p.coyote = 0;
    p.jumpBuffer = 0;
    p.jumping = true;
    run.events.push({ kind: "jump", x: p.x, y: p.y });
  } else if (p.jumping && !controls.jump && p.vy < -150) {
    p.vy = -150;
  }

  const priorX = p.x;
  const previousFeet = p.y;
  p.x = Math.max(Math.max(15, run.checkpoint.x - 620), p.x + p.vx * elapsed);
  p.vy = Math.min(500, p.vy + GRAVITY * elapsed);
  p.y += p.vy * elapsed;
  p.ground = null;

  for (const tile of run.platforms) {
    if (tile.type !== "ground" || previousFeet <= tile.y + 1 || previousFeet >= HEIGHT + 6) continue;
    if (p.x + halfWidth > tile.x && priorX + halfWidth <= tile.x) {
      p.x = tile.x - halfWidth;
      p.vx = 0;
    } else if (p.x - halfWidth < tile.x + tile.w && priorX - halfWidth >= tile.x + tile.w) {
      p.x = tile.x + tile.w + halfWidth;
      p.vx = 0;
    }
  }

  hitEnemies(run, previousFeet);
  if (run.over) return;

  if (p.vy >= 0) {
    let landing = null;
    for (const tile of run.platforms) {
      if (tile.returnsAt > 0 && run.time >= tile.returnsAt) tile.crumblesAt = tile.returnsAt = 0;
      if (tile.crumblesAt > 0 && run.time >= tile.crumblesAt) continue;
      if (p.x + halfWidth <= tile.x || p.x - halfWidth >= tile.x + tile.w) continue;
      if (previousFeet <= tile.y + 1.6 && p.y >= tile.y && (!landing || tile.y < landing.y)) landing = tile;
    }
    if (landing) {
      if (p.vy >= 120) run.events.push({ kind: "land", x: p.x, y: landing.y });
      p.y = landing.y;
      p.vy = 0;
      p.ground = landing;
      p.jumping = false;
      if (landing.type === "crumble" && landing.crumblesAt === 0) {
        landing.crumblesAt = run.time + 0.52;
        landing.returnsAt = run.time + 3.1;
      }
    }
  }

  p.stride += Math.abs(p.vx) * elapsed * 0.063;
  if (p.y > HEIGHT + 35) hit(run, p.x, true);
}

export function advance(run, controls, elapsed, viewWidth) {
  if (run.over) return;
  run.time += elapsed;
  run.tick++;
  fillWorld(run, Math.max(run.furthest, run.player.x) + Math.max(825, viewWidth + 290));
  updatePlatforms(run);
  updateEnemies(run);
  movePlayer(run, controls, elapsed);
  if (run.over) return;
  collectEggs(run, elapsed);
  touchObjects(run);
  if (run.over) return;
  run.magnet = Math.max(0, run.magnet - elapsed);
  const p = run.player;
  run.furthest = Math.max(run.furthest, p.x);
  const left = Math.max(0, run.checkpoint.x - 652);
  const target = Math.max(left, p.x - viewWidth * (viewWidth < 302 ? 0.31 : 0.34));
  run.camera += (target - run.camera) * Math.min(1, 8 * elapsed);
  if (run.tick % 90 !== 0) return;
  const discardBefore = left - 90;
  run.platforms = run.platforms.filter((tile) => tile.x + tile.w > discardBefore);
  run.eggs = run.eggs.filter((item) => !item.taken && item.x > discardBefore);
  run.enemies = run.enemies.filter((foe) => !foe.defeated && foe.x > discardBefore);
  run.objects = run.objects.filter((item) => !item.taken && item.x > discardBefore);
}


export function saveCheckpoint(run) {
  const { player, events, checkpoint, lastGround, ...state } = run;
  return {
    format: SAVE_FORMAT,
    state: { ...state, checkpoint: { x: checkpoint.x, y: checkpoint.y, tile: checkpoint.tile.ox }, lastGround: lastGround.ox },
  };
}

export function restoreCheckpoint(snapshot) {
  const state = snapshot?.state;
  if (snapshot?.format !== SAVE_FORMAT || !state) return null;
  if (![state.stage, state.generatedStage, state.ducklings, state.beaconsLit, state.collected, state.points].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  if (state.ducklings > MAX_DUCKLINGS || state.generatedStage < state.stage || state.over) return null;
  if (![state.platforms, state.eggs, state.enemies, state.objects].every(Array.isArray)) return null;
  const saved = state.checkpoint;
  if (!Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) return null;
  const tiles = state.platforms.map((tile) => ({ ...tile, dx: 0, dy: 0 }));
  const start = tiles.find((tile) => tile.ox === saved.tile && tile.type === "ground");
  const lastGround = tiles.find((tile) => tile.ox === state.lastGround && tile.type === "ground");
  if (!start || !lastGround) return null;
  return {
    ...state, platforms: tiles, eggs: state.eggs.map((item) => ({ ...item })),
    enemies: state.enemies.map((foe) => ({ ...foe })), objects: state.objects.map((item) => ({ ...item })),
    checkpoint: { x: saved.x, y: saved.y, tile: start }, lastGround,
    player: playerAt(saved.x, saved.y, start), camera: Math.max(0, saved.x - 85), events: [],
    combo: 0, comboUntil: 0,
  };
}
