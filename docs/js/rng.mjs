/* Seeded random numbers. Deterministic: the same seed always gives the same route. */

/** mulberry32. Returns a function rand() -> [0,1). */
export function rng(seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rand.int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));      // inclusive both ends
  rand.range = (lo, hi) => lo + rand() * (hi - lo);
  rand.pick = (list) => list[Math.floor(rand() * list.length)];
  rand.chance = (p) => rand() < p;
  rand.shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
  return rand;
}

/** Hash several small integers into one 32-bit seed (journeySeed, circuit, chapter...). */
export function mixSeed(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= (p | 0) + 0x9e3779b9 + ((h << 6) >>> 0) + (h >>> 2);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
