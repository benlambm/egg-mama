import { HEIGHT, MAX_DUCKLINGS } from "./engine.mjs";
import { CHAPTERS, chapterIndex } from "./chapters.mjs";

const INK = "#222439";
const SHELL = "#fff3ce";
const GOLD = "#ffd361";
const accent = "#dfedfb";
const crossSize = (s) => [[-s, 0, s * 2 + 1, 1], [0, -s, 1, s * 2 + 1]];

function rect(ctx, color, x, y, w, h) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function bits(ctx, color, shapes) {
  ctx.fillStyle = color;
  for (const [x, y, w, h] of shapes) ctx.fillRect(x, y, w, h);
}

function star(ctx, x, y, size, color = "#fff5aa") {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  bits(ctx, color, crossSize(size));
  rect(ctx, "#fff9da", 0, 0, 1, 1);
  ctx.restore();
}

function hash(n) {
  const product = Math.imul(n | 0, 1597334677) ^ 0x76de42c5;
  return ((product ^ product >>> 16) >>> 0) / 4294967296;
}

function eggSprite(ctx, x, y, golden = false, scale = 1) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(scale, scale);
  bits(ctx, golden ? "#754429" : "#6c543d", [[-2, -7, 4, 1], [-3, -6, 6, 2], [-4, -4, 8, 7], [-3, 3, 6, 2], [-2, 5, 4, 1]]);
  bits(ctx, golden ? "#ffc044" : "#f6cb80", [[-2, -6, 4, 2], [-3, -4, 6, 7], [-2, 3, 4, 2]]);
  bits(ctx, golden ? "#ffe590" : "#fff2cf", [[-2, -5, 3, 3], [-3, -3, 5, 4], [-2, 1, 4, 2]]);
  bits(ctx, "#fff9df", [[-2, -4, 1, 3], [-1, -3, 1, 1]]);
  if (golden) bits(ctx, "#da7c35", [[2, 0, 1, 3], [0, 3, 2, 1]]);
  ctx.restore();
}

function duckling(ctx, x, y, face = 1, time = 0, faint = false, scale = 1) {
  const foot = Math.floor(time * 9) % 2;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(face * scale, scale);
  const ink = faint ? "#34465d" : INK;
  const down = faint ? "#556881" : "#eeb448";
  const fluff = faint ? "#647891" : "#ffdd78";
  const shine = faint ? "#70849e" : "#fff0af";
  bits(ctx, ink, [[-1, -13, 5, 1], [-2, -12, 7, 4], [-6, -8, 14, 3], [-5, -5, 11, 3], [-3, -2, 7, 1]]);
  bits(ctx, down, [[-1, -12, 5, 5], [-5, -7, 10, 3], [-4, -4, 9, 2]]);
  bits(ctx, fluff, [[0, -12, 3, 4], [-1, -11, 5, 3], [-4, -7, 8, 3], [-5, -6, 3, 1]]);
  bits(ctx, shine, [[-4, -6, 2, 2], [-2, -5, 2, 1], [-3, -4, 6, 2], [0, -3, 3, 1]]);
  rect(ctx, ink, 2, -11, 1, 2);
  bits(ctx, faint ? "#556881" : "#f29552", [[5, -8, 2, 2], [-3 + foot, -2, 3, 2], [2 - foot, -2, 3, 2]]);
  ctx.restore();
}

function shield(ctx) {
  bits(ctx, INK, [[4, 2, 8, 1], [1, 3, 14, 8], [2, 11, 12, 1], [3, 12, 10, 1], [5, 13, 6, 1], [6, 14, 4, 1]]);
  bits(ctx, "#61d5de", [[4, 3, 8, 1], [2, 4, 12, 6], [3, 10, 10, 1], [4, 11, 8, 1], [6, 12, 4, 2]]);
  bits(ctx, "#2f91ad", [[9, 5, 4, 5], [8, 10, 4, 2], [8, 12, 2, 1]]);
  bits(ctx, "#d9fff2", [[7, 5, 2, 6], [5, 7, 6, 2]]);
}

function magnet(ctx) {
  bits(ctx, INK, [[0, 1, 6, 9], [10, 1, 6, 9], [1, 10, 14, 3], [2, 13, 12, 2], [4, 15, 8, 1]]);
  bits(ctx, "#ef698b", [[1, 2, 4, 8], [11, 2, 4, 8], [2, 9, 5, 3], [9, 9, 5, 3], [3, 11, 10, 2], [5, 13, 6, 2]]);
  bits(ctx, "#b24277", [[4, 7, 1, 4], [11, 8, 1, 4], [4, 12, 8, 1]]);
  bits(ctx, "#f5e6f9", [[1, 2, 4, 3], [11, 2, 4, 3]]);
}

function iconShape(ctx, name) {
  switch (name) {
    case "egg":
    case "gold":
      eggSprite(ctx, 8, 8, name === "gold");
      break;
    case "duckling":
    case "duckling-empty":
      duckling(ctx, 7, 15, 1, 0, name === "duckling-empty");
      break;
    case "shield":
      shield(ctx);
      break;
    case "magnet":
      magnet(ctx);
      break;
    case "trophy":
      bits(ctx, "#b47745", [[1, 3, 4, 6], [11, 3, 4, 6], [4, 8, 8, 2], [6, 9, 4, 5], [3, 13, 10, 2]]);
      bits(ctx, "#ffcc63", [[1, 3, 2, 5], [13, 3, 2, 5], [3, 1, 10, 2], [4, 3, 8, 5], [5, 8, 6, 2], [7, 10, 2, 3], [4, 13, 8, 1]]);
      bits(ctx, "#ffe5a1", [[4, 2, 2, 6], [1, 3, 3, 1], [12, 3, 3, 1]]);
      break;
    case "sound":
    case "sound-off":
      bits(ctx, accent, [[1, 6, 3, 4], [4, 5, 2, 6], [6, 3, 2, 10]]);
      if (name === "sound") bits(ctx, accent, [[10, 6, 1, 4], [12, 4, 1, 2], [13, 6, 1, 4], [12, 10, 1, 2]]);
      else bits(ctx, "#ffad9a", [[10, 6, 1, 1], [13, 6, 1, 1], [11, 7, 2, 2], [10, 9, 1, 1], [13, 9, 1, 1]]);
      break;
    case "play":
    case "play-dark":
      bits(ctx, name === "play-dark" ? "#332235" : accent, [[5, 3, 2, 10], [7, 4, 2, 8], [9, 5, 2, 6], [11, 6, 2, 4], [13, 7, 1, 2]]);
      break;
    case "pause":
      bits(ctx, accent, [[4, 3, 3, 10], [9, 3, 3, 10]]);
      break;
    case "fullscreen":
    case "fullscreen-off":
      ctx.save();
      if (name === "fullscreen-off") {
        ctx.translate(3, 3);
        ctx.scale(0.63, 0.63);
      }
      bits(ctx, accent, [[2, 2, 5, 2], [2, 4, 2, 3], [9, 2, 5, 2], [12, 4, 2, 3], [2, 9, 2, 3], [2, 12, 5, 2], [12, 9, 2, 3], [9, 12, 5, 2]]);
      ctx.restore();
      break;
    case "close":
      bits(ctx, accent, [[3, 3, 2, 2], [11, 3, 2, 2], [5, 5, 2, 2], [9, 5, 2, 2], [7, 7, 2, 2], [5, 9, 2, 2], [9, 9, 2, 2], [3, 11, 2, 2], [11, 11, 2, 2]]);
      break;
  }
}

export function paintIcon(canvas, name = canvas.dataset.icon) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (name === "mama") {
    drawMama(ctx, 11, 18, 0.57, 1, 0.1);
  } else {
    iconShape(ctx, name);
  }
}

const bodyRows = [
  [-4, 5], [-6, 7], [-7, 8], [-8, 9], [-8, 9], [-9, 10], [-9, 10], [-10, 10],
  [-10, 11], [-10, 11], [-11, 11], [-11, 12], [-11, 12], [-11, 12], [-11, 12],
  [-11, 12], [-11, 12], [-11, 12], [-10, 11], [-10, 11], [-9, 10], [-8, 9], [-6, 7], [-4, 5],
];

const mamaSprite = document.createElement("canvas");
mamaSprite.width = 34;
mamaSprite.height = 30;
const mamaContext = mamaSprite.getContext("2d");

function drawMama(ctx, x, y, scale, face, time, stride = 0, airborne = false, angle = 0) {
  mamaContext.clearRect(0, 0, mamaSprite.width, mamaSprite.height);
  paintMama(mamaContext, time, stride, airborne);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(x), Math.round(y));
  if (angle) {
    const pivot = Math.round(12 * scale);
    ctx.translate(0, -pivot - Math.round(Math.abs(angle) * 3));
    ctx.rotate(angle);
    ctx.translate(0, pivot);
  }
  ctx.scale(face, 1);
  ctx.drawImage(mamaSprite, -Math.round(20 * scale), -Math.round(28 * scale), Math.round(mamaSprite.width * scale), Math.round(mamaSprite.height * scale));
  ctx.restore();
}

function paintMama(ctx, time, stride, airborne) {
  const flutter = Math.round(Math.sin(time * 9) * 2);
  const gait = airborne ? 2 : stride ? Math.round(Math.sin(stride) * 3) : 0;
  ctx.save();
  ctx.translate(20, 28);
  bits(ctx, INK, [[-19, -19 + flutter, 11, 3], [-17, -17, 11, 3], [-15, -15, 9, 3], [-13, -13 + flutter, 5, 3]]);
  bits(ctx, "#ad497b", [[-17, -18 + flutter, 10, 2], [-16, -16, 10, 2], [-14, -14, 6, 1], [-12, -12 + flutter, 4, 1]]);
  bits(ctx, "#ed89a8", [[-16, -18 + flutter, 7, 1], [-14, -16, 5, 1]]);
  for (const [base, phase] of [[-8, gait], [2, -gait]]) {
    const top = -7 + (airborne ? -1 : Math.min(0, phase));
    const bx = base + phase;
    bits(ctx, INK, [[bx + 1, top, 6, 4], [bx, top + 3, 9, 4], [bx + 1, top + 7, 7, 1]]);
    bits(ctx, "#326c76", [[bx + 2, top + 1, 4, 3], [bx + 1, top + 4, 7, 3]]);
    bits(ctx, "#6bd6bc", [[bx + 2, top + 3, 5, 1], [bx + 1, top + 4, 3, 1]]);
  }

  for (let row = 0; row < bodyRows.length; row++) {
    const [left, right] = bodyRows[row];
    const ay = row - 27;
    rect(ctx, INK, left, ay, right - left, 1);
    if (row === 0 || row >= 23) continue;
    rect(ctx, row >= 19 ? "#eaa662" : "#f3c783", left + 1, ay, right - left - 2, 1);
    if (row < 21) {
      const shadow = row > 14 ? 4 + Math.floor((row - 15) / 2) : 2;
      rect(ctx, SHELL, left + 1, ay, right - left - shadow - 1, 1);
    }
  }
  bits(ctx, "#fffbe8", [[-4, -25, 6, 1], [-6, -24, 11, 2], [-7, -22, 9, 1], [-8, -21, 3, 1], [-8, -15, 2, 4]]);
  bits(ctx, "#94476e", [[-10, -20, 19, 3], [-9, -17, 19, 1]]);
  bits(ctx, "#eb7f9e", [[-9, -20, 17, 1], [-10, -19, 18, 1], [-9, -18, 16, 1]]);
  bits(ctx, "#ffc0bf", [[-8, -20, 11, 1], [-10, -17, 4, 1]]);
  const blink = time % 5.7 > 5.56;
  if (blink) {
    bits(ctx, INK, [[-1, -13, 4, 1], [7, -13, 3, 1]]);
  } else {
    bits(ctx, INK, [[-1, -15, 4, 5], [7, -15, 3, 4]]);
    bits(ctx, "#fff9ef", [[0, -15, 1, 2], [7, -15, 1, 1]]);
  }
  bits(ctx, "#ee9984", [[-4, -10, 4, 2], [8, -10, 3, 1]]);
  bits(ctx, "#8e584c", [[4, -10, 2, 1], [5, -11, 2, 1]]);
  bits(ctx, "#deb176", [[-8, -8, 3, 2], [-6, -6, 2, 1]]);
  ctx.restore();
}

function beetle(ctx, x, y, face, time, scale = 1) {
  const stride = Math.floor(time * 9) % 2;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(scale * face, scale);
  bits(ctx, INK, [[-10, -9, 22, 7], [-8, -12, 14, 3], [-5, -15, 9, 3], [7, -12, 3, 3], [10, -14, 2, 2], [-9, -2, 4, 2], [4, -2, 5, 2]]);
  bits(ctx, "#ca4863", [[-9, -8, 14, 5], [-7, -11, 12, 4], [-4, -14, 7, 3]]);
  bits(ctx, "#ed6873", [[-7, -10, 9, 4], [-4, -13, 6, 2]]);
  bits(ctx, "#ff9a80", [[-5, -11, 5, 1], [-6, -10, 2, 2]]);
  bits(ctx, "#98415a", [[-8, -6, 8, 2], [2, -8, 3, 5]]);
  bits(ctx, "#9faab8", [[5, -8, 6, 5], [7, -9, 3, 1]]);
  bits(ctx, "#fff4cb", [[7, -8, 2, 2], [10, -7, 1, 2]]);
  bits(ctx, INK, [[8, -7, 1, 1], [-10 + stride, -2, 4, 2], [3 + stride, -2, 4, 2], [-2 - stride, -2, 4, 1]]);
  ctx.restore();
}

function wasp(ctx, x, y, face, time) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(face, 1);
  const buzz = Math.floor(time * 24) % 2 ? 2 : 0;
  bits(ctx, "#437aab", [[-11, -14 - buzz, 6, 3], [-8, -12 - buzz, 8, 3], [-2, -17 + buzz, 6, 6]]);
  bits(ctx, "#ddf6eb", [[-10, -14 - buzz, 6, 2], [-6, -12 - buzz, 5, 2], [-1, -16 + buzz, 4, 5]]);
  bits(ctx, INK, [[-10, -9, 20, 6], [-8, -11, 15, 10], [-6, -2, 11, 2], [-12, -6, 4, 2], [3, -13, 2, 4], [6, -14, 1, 3]]);
  bits(ctx, "#f0b653", [[-9, -8, 17, 4], [-7, -10, 12, 8], [-5, -2, 8, 1]]);
  bits(ctx, "#795239", [[-6, -10, 2, 8], [-2, -10, 2, 8]]);
  bits(ctx, "#fff2bc", [[4, -8, 3, 4], [8, -7, 1, 2]]);
  rect(ctx, INK, 6, -7, 1, 2);
  ctx.restore();
}

function leaves(ctx, x, y, zone, bloom = false, tall = 1) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(tall, tall);
  bits(ctx, zone.outline, [[-1, -12, 3, 12], [-8, -9, 7, 3], [-6, -7, 6, 4], [1, -10, 7, 3], [0, -7, 6, 3], [-4, -3, 8, 2]]);
  bits(ctx, zone.fringe, [[-1, -11, 2, 11], [-7, -8, 5, 2], [-5, -6, 5, 3], [1, -9, 6, 2], [0, -6, 5, 2], [-4, -3, 7, 2]]);
  bits(ctx, zone.grass, [[-6, -8, 3, 1], [3, -9, 3, 1], [-4, -6, 3, 1], [0, -11, 1, 7]]);
  if (bloom) {
    bits(ctx, zone.outline, [[-2, -16, 5, 7], [-4, -14, 9, 3]]);
    bits(ctx, zone.flower, [[-1, -16, 3, 7], [-3, -14, 7, 3], [-2, -15, 5, 5]]);
    rect(ctx, "#ea8a56", -1, -14, 3, 3);
    rect(ctx, "#fff4cc", -2, -14, 2, 1);
  }
  ctx.restore();
}

function terrain(ctx, tile, time) {
  if (tile.crumblesAt && time >= tile.crumblesAt) return;
  const zone = CHAPTERS[tile.biome];
  const floating = tile.type !== "ground";
  const x = Math.round(tile.x);
  const y = Math.round(tile.y);
  const w = Math.round(tile.w);
  const h = floating ? 20 : HEIGHT - y + 2;
  const offset = tile.crumblesAt ? Math.round(Math.sin(time * 80)) : 0;

  ctx.save();
  ctx.translate(x + offset, y);
  ctx.beginPath();
  ctx.moveTo(0, 2);
  ctx.lineTo(3, 2);
  ctx.lineTo(3, 0);
  ctx.lineTo(w - 3, 0);
  ctx.lineTo(w - 3, 2);
  ctx.lineTo(w, 2);
  ctx.lineTo(w, h - (floating ? 4 : 0));
  if (floating) {
    ctx.lineTo(w - 5, h - 4);
    ctx.lineTo(w - 5, h);
    ctx.lineTo(5, h);
    ctx.lineTo(5, h - 4);
    ctx.lineTo(0, h - 4);
  } else {
    ctx.lineTo(0, h);
  }
  ctx.closePath();
  ctx.clip();

  rect(ctx, zone.outline, 0, 0, w, h);
  rect(ctx, zone.soil, 2, 2, w - 4, h - 4);
  rect(ctx, zone.shadow, 2, h - (floating ? 5 : 7), w - 4, floating ? 4 : 7);
  rect(ctx, zone.fringe, 1, 2, w - 2, 7);
  rect(ctx, zone.grass, 2, 1, w - 4, 5);
  rect(ctx, zone.light, 3, 1, w - 6, 1);

  for (let tx = 3; tx < w - 3; tx += 5) {
    const n = hash(tile.ox + tx);
    if (n > 0.66) rect(ctx, zone.light, tx, 2, 3, 1);
    if (n < 0.39) bits(ctx, zone.fringe, [[tx, 7, 4, 4], [tx + 1, 11, 2, 1]]);
    if (n > 0.55) rect(ctx, zone.grass, tx, 5, 3, 2);
  }
  for (let row = 0; row < Math.floor((h - 11) / 7); row++) {
    for (let tx = 4 + (row * 5) % 13; tx < w - 5; tx += 13) {
      const n = hash(tile.ox + tx + row * 37);
      const ty = 10 + row * 7 + Math.floor(n * 4);
      if (n > 0.42) {
        const rw = 3 + Math.floor(n * 6);
        bits(ctx, zone.shadow, [[tx + 1, ty + 1, rw, 3], [tx + 2, ty + 4, rw - 2, 1]]);
        bits(ctx, zone.rock, [[tx + 1, ty, rw - 2, 1], [tx, ty + 1, rw, 2], [tx + 1, ty + 3, rw - 2, 1]]);
      } else {
        bits(ctx, zone.shadow, [[tx, ty + 2, 2, 2], [tx + 3, ty + 4, 1, 1]]);
      }
    }
  }
  if (tile.type === "moving" || tile.type === "lift") {
    for (let tx = 10; tx < w - 9; tx += 12) {
      bits(ctx, "#374c5f", [[tx, 10, 8, 5], [tx + 2, 15, 4, 1]]);
      bits(ctx, "#80e2df", [[tx + 3, 11, 2, 3], [tx + 2, 12, 4, 1]]);
    }
  } else if (tile.type === "crumble") {
    for (let tx = 10; tx < w - 7; tx += 19) {
      bits(ctx, "#422e3b", [[tx, 3, 2, 4], [tx + 2, 7, 2, 3], [tx + 4, 9, 3, 2], [tx + 6, 10, 2, 6], [tx + 1, 10, 3, 1]]);
    }
  }
  ctx.restore();

  if (floating) {
    for (let tx = 16; tx < w - 9; tx += 23) {
      const random = hash(tile.ox + tx);
      if (random < 0.48) continue;
      bits(ctx, zone.outline, [[x + tx, y + h - 4, 3, 10], [x + tx - 2, y + h, 3, 3], [x + tx + 1, y + h + 4, 4, 2]]);
      bits(ctx, zone.fringe, [[x + tx + 1, y + h - 4, 1, 9], [x + tx - 2, y + h, 3, 1], [x + tx + 2, y + h + 4, 2, 1]]);
    }
  }
  for (let tx = 12; tx < w - 8; tx += 20) {
    const random = hash(tile.ox + tx * 3);
    if (random > 0.81) leaves(ctx, x + tx, y + 2, zone, random > 0.92, 0.64);
    else if (random > 0.23) bits(ctx, zone.grass, [[x + tx, y - 2, 1, 3], [x + tx - 2, y - 1, 4, 2], [x + tx + 2, y - 4, 1, 4]]);
  }
}

function drawObject(ctx, item, time) {
  const x = Math.round(item.x);
  const y = Math.round(item.y);

  if (item.kind === "spikes") {
    for (let offset = -15; offset <= 11; offset += 9) {
      const at = x + offset;
      bits(ctx, "#262b42", [[at, y - 3, 9, 3], [at + 1, y - 6, 7, 3], [at + 3, y - 10, 3, 4], [at + 4, y - 12, 1, 2]]);
      bits(ctx, "#b7d3ce", [[at + 2, y - 6, 4, 4], [at + 3, y - 9, 2, 3]]);
      bits(ctx, "#f2e7c1", [[at + 3, y - 7, 1, 4], [at + 4, y - 10, 1, 3]]);
    }
  } else if (item.kind === "spring") {
    const squash = item.pressedAt > 0 && time - item.pressedAt < 0.16 ? 3 : 0;
    bits(ctx, INK, [[x - 10, y - 5, 20, 5], [x - 7, y - 9, 14, 6], [x - 10, y - 15 + squash, 20, 6]]);
    bits(ctx, "#efa449", [[x - 8, y - 3, 16, 2], [x - 8, y - 13 + squash, 16, 3]]);
    bits(ctx, "#ffe07d", [[x - 8, y - 14 + squash, 16, 2], [x - 6, y - 8, 11, 1], [x - 4, y - 6, 10, 1]]);
  } else if (item.kind === "beacon") {
    if (item.active) {
      ctx.globalAlpha = 0.22 + Math.sin(time * 3.4) * 0.045;
      bits(ctx, "#ffe89a", [[x - 19, y - 53, 38, 20], [x - 13, y - 60, 26, 34], [x - 25, y - 47, 50, 8]]);
      ctx.globalAlpha = 1;
      star(ctx, x + 17, y - 48, 3);
      star(ctx, x - 14, y - 52, 2);
    }
    bits(ctx, INK, [[x - 13, y - 6, 26, 6], [x - 8, y - 31, 16, 27], [x - 12, y - 45, 24, 16], [x - 9, y - 49, 18, 4], [x - 5, y - 52, 10, 3]]);
    bits(ctx, "#b59f84", [[x - 11, y - 5, 22, 3], [x - 6, y - 28, 12, 23], [x - 10, y - 31, 20, 2], [x - 7, y - 48, 14, 2], [x - 4, y - 51, 8, 2]]);
    bits(ctx, "#6f6374", [[x - 5, y - 23, 11, 1], [x - 5, y - 15, 11, 1], [x, y - 10, 3, 4], [x - 1, y - 27, 2, 4]]);
    rect(ctx, item.active ? "#ffdf77" : "#6e627b", x - 9, y - 44, 18, 12);
    if (item.active) bits(ctx, "#fff6bd", [[x - 2, y - 42, 5, 8], [x - 5, y - 39, 11, 3]]);
  } else if (item.kind === "flag" || item.kind === "gate") {
    const sway = Math.floor(time * 7) % 3;
    const tint = item.active ? "#77e6ac" : item.kind === "gate" ? "#c597ec" : "#e57577";
    bits(ctx, INK, [[x - 2, y - 35, 4, 35], [x - 3, y - 38, 6, 5], [x + 1, y - 33, 17 + sway, 14], [x - 6, y - 4, 13, 4]]);
    bits(ctx, "#d4b27c", [[x - 1, y - 34, 2, 30], [x - 4, y - 3, 9, 2]]);
    bits(ctx, GOLD, [[x - 2, y - 37, 4, 3]]);
    bits(ctx, tint, [[x + 2, y - 32, 15 + sway, 7], [x + 2, y - 25, 11 + sway, 5]]);
    bits(ctx, "#fff2bf", [[x + 6, y - 28, 4, 4], [x + 7, y - 29, 2, 6]]);
  } else {
    const bob = Math.round(Math.sin(time * 4 + item.x) * 3);
    ctx.save();
    ctx.translate(x - 8, y + bob - 7);
    iconShape(ctx, item.kind);
    ctx.restore();
    if (Math.sin(time * 3 + x) > 0.6) star(ctx, x + 11, y - 8 + bob, 2, "#e5ffcd");
  }
}

function floatEgg(ctx, pickup, time, scale = 1) {
  const golden = pickup.kind === "gold";
  const phase = time * 4 + pickup.x * 0.035;
  const y = pickup.y + Math.sin(phase) * 2.5;
  if (golden) {
    ctx.globalAlpha = 0.17;
    rect(ctx, "#ffdf72", Math.round(pickup.x - 7 * scale), Math.round(y - 9 * scale), 14 * scale, 17 * scale);
    ctx.globalAlpha = 1;
    star(ctx, pickup.x + 8 * scale, y - 7 * scale, 2, "#ffef9e");
  }
  eggSprite(ctx, pickup.x, y, golden, scale);
  if (!golden && Math.sin(phase * 0.8) > 0.79) star(ctx, pickup.x + 6 * scale, y - 5 * scale, 1, "#fff3b4");
}

export class ArcadeView {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.backdrops = [];
    this.loadBackdrop(0);
    this.loadBackdrop(1);
    this.flockTrail = [];
    this.followedPlayer = null;
    this.width = 600;
    this.effects = [];
    this.zone = 0;
    this.previousZone = 0;
    this.blend = 1;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    new ResizeObserver(() => this.resize()).observe(viewport);
    this.resize();
  }

  resize() {
    const { width, height } = this.viewport.getBoundingClientRect();
    this.width = Math.round(width * HEIGHT / Math.max(1, height));
    this.canvas.width = this.width;
    this.canvas.height = HEIGHT;
    this.ctx.imageSmoothingEnabled = false;
  }

  reset(zone = 0) {
    this.effects = [];
    this.flockTrail = [];
    this.followedPlayer = null;
    this.loadBackdrop(zone);
    this.loadBackdrop((zone + 1) % CHAPTERS.length);
    this.previousZone = this.zone = zone;
    this.blend = 1;
  }

  loadBackdrop(index) {
    if (!this.backdrops[index]) {
      const image = new Image();
      image.src = new URL(`./assets/${CHAPTERS[index].asset}.webp`, import.meta.url);
      this.backdrops[index] = image;
    }
    return this.backdrops[index];
  }

  backdrop(index, camera) {
    const ctx = this.ctx;
    const image = this.loadBackdrop(index);
    if (!image.complete || !image.naturalWidth) {
      rect(ctx, CHAPTERS[index].sky, 0, 0, this.width, HEIGHT);
      return;
    }
    const tileWidth = Math.ceil(Math.max(this.width, HEIGHT * image.naturalWidth / image.naturalHeight));
    const tileHeight = Math.ceil(tileWidth * image.naturalHeight / image.naturalWidth);
    const offset = Math.floor(camera * 0.14 + Math.max(0, tileWidth - this.width) * 0.50);
    const y = Math.round((HEIGHT - tileHeight) * 0.21);
    let indexOnTape = Math.floor(offset / tileWidth);
    let x = indexOnTape * tileWidth - offset;
    while (x < this.width) {
      ctx.save();
      if (indexOnTape % 2) {
        ctx.translate(x + tileWidth, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(image, 0, y, tileWidth, tileHeight);
      } else {
        ctx.drawImage(image, x, y, tileWidth, tileHeight);
      }
      ctx.restore();
      x += tileWidth;
      indexOnTape++;
    }
  }

  scene(time, camera, zone, elapsed) {
    const requested = this.loadBackdrop(zone);
    this.loadBackdrop((zone + 1) % CHAPTERS.length);
    if (zone !== this.zone && requested.complete) {
      this.previousZone = this.zone;
      this.zone = zone;
      this.blend = 0;
    }
    this.blend = Math.min(1, this.blend + elapsed * 1.4);
    if (this.blend !== 1) {
      this.backdrop(this.previousZone, camera);
      this.ctx.globalAlpha = this.blend;
    }
    this.backdrop(this.zone, camera);
    this.ctx.globalAlpha = 1;
    if (!this.reducedMotion) {
      for (let i = 0; i < 26; i++) {
        const x = ((hash(i * 73) * this.width + time * (5 + i % 5) - camera * 0.25) % this.width + this.width) % this.width;
        const y = 90 + hash(i * 481) * 182 + Math.sin(time * 1.4 + i * 2) * 6;
        this.ctx.globalAlpha = 0.19 + Math.sin(time * 1.3 + i) * 0.13;
        rect(this.ctx, "#ffeeaa", Math.round(x), Math.round(y), i % 3 === 0 ? 2 : 1, 1);
      }
      this.ctx.globalAlpha = 1;
    }
  }

  attract(time, mobile) {
    const ctx = this.ctx;
    const w = this.width;
    const at = (ratio) => Math.round(w * ratio);
    const drawTime = this.reducedMotion ? 0 : time;
    this.scene(drawTime, 0, 0, 1);
    const mamaX = at(mobile ? 0.5 : 0.632);
    const mamaY = mobile ? 111 : 207;
    const meadow = CHAPTERS[0];

    const shelf = (a, y, b, type = "ledge") => terrain(ctx, { x: a, y, w: b, ox: a, type, biome: 0 }, drawTime);
    shelf(-22, 246, at(0.40) + 22, "ground");
    shelf(at(mobile ? 0.76 : 0.84), 240, at(0.23), "ground");
    shelf(at(mobile ? 0.19 : 0.47), mamaY, at(mobile ? 0.65 : 0.308));
    if (!mobile) {
      shelf(at(0.296), 181, at(0.125));
      shelf(at(0.829), 152, at(0.147));
      shelf(at(0.713), 263, at(0.09));
      drawObject(ctx, { x: at(0.934), y: 240, kind: "spring" }, drawTime);
    }

    leaves(ctx, at(mobile ? 0.28 : 0.50), mamaY + 1, meadow, true, 1.1);
    leaves(ctx, at(mobile ? 0.73 : 0.755), mamaY + 1, meadow, false, 0.97);
    leaves(ctx, at(0.94), 153, meadow, false, 1.15);
    leaves(ctx, at(0.185), 245, meadow, true, 1.03);

    for (let i = 0; i < 5; i++) {
      const x = mobile ? mamaX - 50 + i * 24 : at(0.71) + i * (w * 0.048);
      const y = mobile ? 70 - Math.sin(i / 4 * Math.PI) * 17 : 163 - (i * 7) - Math.sin(i / 4 * Math.PI) * 23;
      floatEgg(ctx, { x, y, kind: i === 3 ? "gold" : "egg" }, drawTime, mobile ? 1.07 : 1.25);
    }
    const bob = Math.round(Math.sin(drawTime * 3.1) * 2);
    ctx.globalAlpha = 0.27;
    rect(ctx, "#162238", mamaX - 19, mamaY - 2, 39, 3);
    ctx.globalAlpha = 1;
    for (let i = 2; i >= 1; i--) duckling(ctx, mamaX - (mobile ? 22 : 29) - i * (mobile ? 13 : 17), mamaY, 1, drawTime + i * 0.1, false, mobile ? 1.3 : 1.65);
    drawMama(ctx, mamaX, mamaY - 1 + bob, mobile ? 1.98 : 2.55, 1, drawTime, 0, false, Math.sin(drawTime * 1.5) * 0.07);
    star(ctx, mamaX - (mobile ? 31 : 56), mamaY - 53, mobile ? 2 : 3, "#ffeca2");
    star(ctx, mamaX + (mobile ? 34 : 38), mamaY - 24, 2, "#ffeeb6");
    if (!mobile) beetle(ctx, at(0.893) + Math.sin(drawTime * 1.7) * 7, 240, -1, drawTime, 1.29);
  }

  effect(event) {
    if (event.x === undefined) return;
    const particles = {
      egg: [7, "#ffe811"], gold: [12, "#ffb745"], shield: [13, "#84e9e6"], magnet: [12, "#ff91cf"],
      "duckling-used": [9, "#f8c472"], gate: [15, "#f4bdf8"], beacon: [25, "#fff189"], stomp: [9, "#ffe7b6"], hit: [11, "#ff9184"], jump: [5, "#f3d1a5"],
      land: [5, "#f3d1a5"], "shield-break": [12, "#81e9ed"], checkpoint: [15, "#a5ffb6"], spring: [7, "#ffdf9d"],
    };
    const [count, color] = particles[event.kind] ?? [0, "#fff"];
    const amount = this.reducedMotion ? Math.ceil(count / 3) : count;
    for (let i = 0; i < amount; i++) {
      const duration = 0.29 + Math.random() * 0.3;
      this.effects.push({
        x: event.x, y: event.y, vx: (Math.random() - 0.5) * 96, vy: -22 - Math.random() * 53, color, duration,
        time: duration, size: Math.random() > 0.63 ? 2 : 1,
      });
    }
    const label = event.kind === "gold" ? (event.hatched ? "+1 DUCKLING" : "GOLD BONUS") : event.kind === "stomp" ? "+200" :
      event.kind === "egg" && event.combo % 3 === 1 && event.multiplier > 1 ? `X${event.multiplier} COMBO` : "";
    if (label) this.effects.push({ x: event.x, y: event.y - 4, vx: 0, vy: -19, color: "#ffed9e", duration: 0.88, time: 0.88, label });
  }

  drawFlock(run) {
    const p = run.player;
    const trail = this.flockTrail;
    if (this.followedPlayer !== p) {
      this.followedPlayer = p;
      trail.length = 0;
      for (let i = 1; i <= MAX_DUCKLINGS * 7; i++) {
        const x = Math.max((p.ground?.x ?? p.x - 70) + 4, p.x - i * 2);
        trail.push({ x, y: p.y, face: p.face });
      }
    }

    const last = trail[0];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const steps = Math.floor(Math.hypot(dx, dy) / 2);
    for (let i = 1; i <= steps; i++) {
      trail.unshift({ x: last.x + dx * i / steps, y: last.y + dy * i / steps, face: p.face });
    }
    trail.length = Math.min(trail.length, MAX_DUCKLINGS * 7);
    for (let i = run.ducklings; i >= 1; i--) {
      const point = trail[i * 7 - 1];
      if (point) duckling(this.ctx, point.x, point.y, point.face, run.time + i * 0.09, false, 0.92);
    }
  }

  play(run, elapsed) {
    const ctx = this.ctx;
    const camera = Math.round(run.camera);
    const time = run.time;
    const visible = (x, w = 25) => x + w >= camera && x - 35 <= camera + this.width;
    this.scene(time, camera, chapterIndex(run.stage), elapsed);
    ctx.save();
    ctx.translate(-camera, 0);
    for (const tile of run.platforms) if (visible(tile.x, tile.w + 2)) terrain(ctx, tile, time);
    for (const item of run.objects) if (!item.taken && visible(item.x)) drawObject(ctx, item, time);
    for (const pickup of run.eggs) if (!pickup.taken && visible(pickup.x)) floatEgg(ctx, pickup, time);
    for (const foe of run.enemies) {
      if (foe.defeated || !visible(foe.x)) continue;
      if (foe.kind === "beetle") beetle(ctx, foe.x, foe.y, foe.face, time);
      else wasp(ctx, foe.x, foe.y, foe.face, time);
    }

    const p = run.player;
    this.drawFlock(run);
    if (!run.over && (this.reducedMotion || p.invulnerability === 0 || Math.floor(p.invulnerability * 14) % 2 === 0)) {
      if (run.shield || run.magnet > 0) {
        const px = Math.round(p.x);
        const py = Math.round(p.y - 12);
        const color = run.shield ? "#a3ffee" : "#ff8dc8";
        ctx.globalAlpha = 0.72;
        bits(ctx, color, [[px - 10, py - 17, 20, 1], [px - 15, py - 12, 1, 20], [px + 14, py - 12, 1, 20], [px - 10, py + 13, 20, 1], [px - 13, py - 15, 3, 1], [px + 10, py - 15, 3, 1], [px - 13, py + 11, 3, 1], [px + 10, py + 11, 3, 1]]);
        ctx.globalAlpha = 1;
      }
      const tilt = this.reducedMotion ? 0 : Math.sin(p.roll) * 0.27 + p.vx / 1650;
      drawMama(ctx, p.x, p.y, 1, p.face, time, Math.abs(p.vx) > 20 ? p.stride * 0.5 : 0, !p.ground, tilt);
    }

    for (const effect of this.effects) {
      effect.time -= elapsed;
      if (effect.time <= 0) continue;
      effect.x += effect.vx * elapsed;
      effect.y += effect.vy * elapsed;
      ctx.globalAlpha = Math.min(1, effect.time / effect.duration * 1.6);
      if (effect.label) {
        ctx.font = "8px Arcade, monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = INK;
        ctx.fillText(effect.label, Math.round(effect.x), Math.round(effect.y + 1));
        ctx.fillStyle = effect.color;
        ctx.fillText(effect.label, Math.round(effect.x), Math.round(effect.y));
      } else {
        effect.vy += elapsed * 150;
        rect(ctx, effect.color, Math.round(effect.x), Math.round(effect.y), effect.size, effect.size);
      }
    }
    ctx.globalAlpha = 1;
    this.effects = this.effects.filter((effect) => effect.time > 0);
    ctx.restore();
  }
}
