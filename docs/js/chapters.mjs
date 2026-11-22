/*
 * Egg Mama — the 13 landscapes.
 *
 * Pure data (no browser code). Used by the level generator (what to build and
 * how long), the renderer (palette, backgrounds, creature species, weather),
 * the audio (which song), and the menus (names, story cues, journal).
 *
 * The 13 background paintings in docs/assets are KEPT as pixel art. Everything
 * the player touches is drawn smooth on top of them using these palettes.
 */
import { T } from './tuning.mjs';

// palette order: sky, light, top, fringe, soil, rock, shadow, outline, accent
const pal = ([sky, light, top, fringe, soil, rock, shadow, outline, accent], water = null) =>
  ({ sky, light, top, fringe, soil, rock, shadow, outline, accent, water });

export const CHAPTERS = [
  {
    id: "meadow", name: "Meadow", bg: "assets/meadow.webp", song: "meadow",
    seconds: 72, // target time of a clean main-route run at cruise (see T.paceBands)
    story: "A storm scattered Mama’s clutch across the valley! The first golden egg is just up the path.",
    learn: "Find the first golden egg, then jump a single wide gap by following the egg arc.",
    tip: "Swipe up to jump",
    palette: pal(["#249ae4", "#c2e677", "#7fc54b", "#469942", "#895035", "#ac6844", "#54343b", "#253749", "#ffd67d"]),
    skin: { ground: "grass", ledge: "leaf", walker: "snail", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "pollen", dark: false, fog: 0,
  },
  {
    id: "clover-mill", name: "Clover Mill", bg: "assets/clover-mill.webp", song: "clover-mill",
    seconds: 76,
    story: "Eggs tumbled into the clover. The mill’s weather vane points downriver, so Mama follows.",
    learn: "Read a patrolling snail, then choose when to jump into the second egg trail.",
    tip: "Land on a snail to bounce",
    palette: pal(["#70c6cb", "#ebec92", "#aabc52", "#749447", "#a37545", "#ce9c58", "#6d4e42", "#354635", "#ffe8a7"]),
    skin: { ground: "grass", ledge: "plank", walker: "snail", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "pollen", dark: false, fog: 0,
  },
  {
    id: "reedwater", name: "Reedwater", bg: "assets/reedwater.webp", song: "reedwater",
    seconds: 80,
    story: "Floodwater covers the path. Hop the stepping logs, and spot the next landing before you leave this one.",
    learn: "Cross stepping ledges above the flood, always looking one landing ahead.",
    tip: "Look for the next log",
    palette: pal(["#73aeba", "#a5e1a5", "#5eaf79", "#3b815f", "#4d6355", "#728366", "#384858", "#26394d", "#ffc0b9"], "#4f8fb0"),
    skin: { ground: "mud", ledge: "log", walker: "snail", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "mist", dark: false, fog: 0.15, water: true,
  },
  {
    id: "orchard", name: "Orchard Heights", bg: "assets/orchard.webp", song: "orchard",
    seconds: 85,
    story: "The wind blew eggs up into the branches! Springy mushrooms can bounce Mama up to the highest ledges.",
    learn: "Use a spring to reach an egg in the branches, then steer back onto the lower path.",
    tip: "Springs launch you high",
    palette: pal(["#d0a3c5", "#f1d19f", "#96bd75", "#638c5e", "#a46963", "#c48371", "#744c63", "#49334e", "#ffbfcb"]),
    skin: { ground: "grass", ledge: "branch", walker: "caterpillar", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "petals", dark: false, fog: 0,
  },
  {
    id: "amber-quarry", name: "Amber Quarry", bg: "assets/amber-quarry.webp", song: "amber-quarry",
    seconds: 98,
    story: "Eggshell flecks lead across the old quarry. Cracked ledges don’t hold for long, so keep hopping!",
    learn: "Recognize a cracked ledge and jump again before it gives way.",
    tip: "Cracked ledges crumble",
    palette: pal(["#79b3c1", "#ffe297", "#dabb69", "#aa864d", "#946749", "#bf945c", "#66515e", "#4b3e54", "#fff2b6"]),
    skin: { ground: "stone", ledge: "stone", walker: "beetle", flyer: "hawk", hazard: "stone", spring: "coil" },
    fx: "dust", dark: false, fog: 0,
  },
  {
    id: "fogwood", name: "Fogwood", bg: "assets/fogwood.webp", song: "fogwood",
    seconds: 102,
    story: "The trail disappears in the mist, but a golden shell glints between the pines. Mind the moths!",
    learn: "Read a flying moth’s path and choose a safe crossing. The landing stays visible in the mist.",
    tip: "Moths float up and down",
    palette: pal(["#78a49c", "#b3dead", "#6db282", "#3e7762", "#4f6554", "#768574", "#374754", "#233b43", "#d9fae0"]),
    skin: { ground: "mud", ledge: "log", walker: "snail", flyer: "moth", hazard: "thorn", spring: "mushroom" },
    fx: "mist", dark: false, fog: 0.45,
  },
  {
    id: "canyon", name: "Ember Canyon", bg: "assets/canyon.webp", song: "canyon",
    seconds: 106,
    story: "Canyon gusts split the trail in two. Look for solid ground beyond the spikes.",
    learn: "Chain a gap and a spike crossing, with room to recover between them.",
    tip: "Spikes hurt. Jump them",
    palette: pal(["#fca463", "#ffcb76", "#e18b48", "#ba5a39", "#9c4938", "#c56e46", "#60333f", "#422336", "#ffe99f"]),
    skin: { ground: "stone", ledge: "stone", walker: "beetle", flyer: "hawk", hazard: "stone", spring: "coil" },
    fx: "embers", dark: false, fog: 0,
  },
  {
    id: "glass-coast", name: "Glass Coast", bg: "assets/glass-coast.webp", song: "glass-coast",
    seconds: 110,
    story: "The tide pushed eggs onto the cliffs. Ride the lifts to reach them!",
    learn: "Board a moving lift and time your exit onto a coastal ledge.",
    tip: "Jump off the lift at the top",
    palette: pal(["#65bed0", "#ddf4b2", "#84c7a1", "#52a384", "#779695", "#b5c8b1", "#526d80", "#2d5369", "#ffffcf"], "#3fb4d6"),
    skin: { ground: "sand", ledge: "plank", walker: "crab", flyer: "gull", hazard: "urchin", spring: "coil" },
    fx: "spray", dark: false, fog: 0, water: true,
  },
  {
    id: "lantern-caverns", name: "Lantern Caverns", bg: "assets/lantern-caverns.webp", song: "lantern-caverns",
    seconds: 114,
    story: "The cave cuts under the ridge. Crystal light shows the eggs on the ledges.",
    learn: "Step from a moving lift onto a crumbling ledge, then leave it in time.",
    tip: "Lift, then crumble. Keep moving",
    palette: pal(["#353071", "#86f1e7", "#6d98b0", "#565082", "#584370", "#8564a5", "#3d3159", "#221d42", "#f6bcfd"]),
    skin: { ground: "crystal", ledge: "crystal", walker: "beetle", flyer: "bat", hazard: "crystal", spring: "coil" },
    fx: "fireflies", dark: true, fog: 0,
  },
  {
    id: "frostline", name: "Frostline", bg: "assets/frostline.webp", song: "frostline",
    seconds: 126,
    story: "Ice makes the climb slippery. Brake early and leave room before each edge.",
    learn: "Anticipate an icy stopping distance while lining up successive jumps.",
    tip: "Swipe left early to brake",
    palette: pal(["#83c8eb", "#f1fcff", "#bee8f4", "#75b8d1", "#558cad", "#90c8dc", "#425d85", "#29415b", "#fdedcc"]),
    skin: { ground: "ice", ledge: "ice", walker: "mite", flyer: "owl", hazard: "crystal", spring: "cloud" },
    fx: "snow", dark: false, fog: 0, ice: true,
  },
  {
    id: "ridge", name: "Moonridge", bg: "assets/ridge.webp", song: "ridge",
    seconds: 132,
    story: "The moon is up and the beacon is dark. Its base is just beyond the old bridge.",
    learn: "Read an enemy patrol while choosing where to land from a moving platform.",
    tip: "Watch the patrol, then land",
    palette: pal(["#4542a2", "#8fe6de", "#418f91", "#306f80", "#524777", "#786397", "#34355e", "#232648", "#edbcff"]),
    skin: { ground: "stone", ledge: "stone", walker: "beetle", flyer: "owl", hazard: "thorn", spring: "mushroom" },
    fx: "fireflies", dark: true, fog: 0.1,
  },
  {
    id: "dawnbridge", name: "Dawnbridge", bg: "assets/dawnbridge.webp", song: "dawnbridge",
    seconds: 138,
    story: "The bridge is broken in places. Carry the clutch across before the sun clears the ridge.",
    learn: "Cross a run of broken spans, naming the next two landings from each safe approach.",
    tip: "Plan two landings ahead",
    palette: pal(["#e7a0a0", "#ffe1ad", "#c2ae84", "#9d7772", "#845a6d", "#b68480", "#684761", "#44334e", "#ffe1c5"]),
    skin: { ground: "brick", ledge: "brick", walker: "beetle", flyer: "moth", hazard: "stone", spring: "coil" },
    fx: "clouds", dark: false, fog: 0.1,
  },
  {
    id: "beacon-summit", name: "Beacon Summit", bg: "assets/beacon-summit.webp", song: "beacon-summit",
    seconds: 144,
    story: "There’s the beacon! Touch it to light the way home for the whole flock.",
    learn: "Combine springs, lifts, and timed jumps on the final climb, then light the beacon.",
    tip: "Touch the beacon!",
    palette: pal(["#b9cfb9", "#fff0ae", "#acce8a", "#7c9f74", "#767487", "#ab9e99", "#545470", "#343954", "#fff0ae"]),
    skin: { ground: "cloud", ledge: "cloud", walker: "beetle", flyer: "hawk", hazard: "crystal", spring: "cloud" },
    fx: "clouds", dark: false, fog: 0, beacon: true,
  },
];

export const CHAPTER_COUNT = CHAPTERS.length;           // 13
export const CIRCUIT_STORY =
  "The beacon is still shining. Mama leads the flock back through the valley to look for more eggs.";

/** Seconds band [lo, hi] a clean run of chapter `index` (0-based) must fall in. */
export function paceBand(index) {
  return index < 4 ? T.paceBands.early : index < 9 ? T.paceBands.middle : T.paceBands.late;
}

/**
 * "Effective difficulty" 0..20 that levelgen scales its demands with.
 * Chapter order is the main ramp; each repeat circuit starts a bit harder than
 * the last but is capped so every jump stays inside what touch controls can do.
 */
export function difficulty(chapter, circuit = 1) {
  return Math.min(20, chapter + (circuit - 1) * 4);
}

export const chapterById = (id) => CHAPTERS.find((c) => c.id === id);
