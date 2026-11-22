/*
 * Egg Mama — turn a finished Builder into the Level the sim and renderer read.
 * Sorts every array by x (the renderer binary-searches them), makes id === index, and remaps the
 * checkpoint -> platform references.
 */

const xOf = {
  platforms: (p) => p.x,
  pickups: (p) => p.x,
  enemies: (e) => (e.kind === 'walker' ? e.x0 : e.cx - e.ax),
  hazards: (h) => h.x,
  springs: (s) => s.x,
};

function sortById(list, key) {
  const idx = list.map((_, i) => i);
  idx.sort((a, b) => key(list[a]) - key(list[b]) || a - b);
  return idx;
}

export function assemble(B, extra) {
  // platforms first (checkpoints refer to them)
  const pOrder = sortById(B.plats, xOf.platforms);
  const remap = new Map();
  const platforms = pOrder.map((oi, ni) => { remap.set(B.plats[oi].id, ni); return { ...B.plats[oi], id: ni }; });
  const checkpoints = B.cps.map((c, i) => ({ id: i, x: c.x, y: c.y, platform: remap.get(c.platform), ch: c.ch }));
  const pickups = sortById(B.picks, xOf.pickups).map((oi, ni) => ({ ...B.picks[oi], id: ni }));
  const enemies = sortById(B.enemies, xOf.enemies).map((oi, ni) => ({ ...B.enemies[oi], id: ni }));
  const hazards = sortById(B.hazards, xOf.hazards).map((oi, ni) => ({ ...B.hazards[oi], id: ni }));
  const springs = sortById(B.springs, xOf.springs).map((oi, ni) => ({ ...B.springs[oi], id: ni }));
  return { ...extra, platforms, pickups, enemies, hazards, springs, checkpoints };
}
