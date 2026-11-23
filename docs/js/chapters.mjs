/*
 * Egg Mama — the 13 landscapes.
 *
 * ONE continuous journey: the 13 landscapes dissolve into each other as Mama rolls on (no loading,
 * no gates, no cards that block play). A clean circuit takes about an hour (see `seconds`).
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
    seconds: 220, // target time of a clean main-route run at cruise 
    story: "A storm scattered Mama’s clutch across the valley! The first golden egg is just up the path.",
    learn: "Find the first golden egg, then jump a single wide gap by following the egg arc.",
    tip: "Swipe up to jump",
    palette: pal(["#249ae4", "#c2e677", "#7fc54b", "#469942", "#895035", "#ac6844", "#54343b", "#253749", "#ffd67d"]),
    skin: { ground: "grass", ledge: "leaf", walker: "snail", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "pollen", dark: false, fog: 0,
  },
  {
    id: "clover-mill", name: "Clover Mill", bg: "assets/clover-mill.webp", song: "clover-mill",
    seconds: 230,
    story: "Eggs tumbled into the clover. The mill’s weather vane points downriver, so Mama follows.",
    learn: "Read a patrolling snail, then choose when to jump into the second egg trail.",
    tip: "Land on a snail to bounce",
    palette: pal(["#70c6cb", "#ebec92", "#aabc52", "#749447", "#a37545", "#ce9c58", "#6d4e42", "#354635", "#ffe8a7"]),
    skin: { ground: "grass", ledge: "plank", walker: "snail", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "pollen", dark: false, fog: 0,
  },
  {
    id: "reedwater", name: "Reedwater", bg: "assets/reedwater.webp", song: "reedwater",
    seconds: 240,
    story: "Floodwater covers the path. Hop the stepping logs, and spot the next landing before you leave this one.",
    learn: "Cross stepping ledges above the flood, always looking one landing ahead.",
    tip: "Look for the next log",
    palette: pal(["#73aeba", "#a5e1a5", "#5eaf79", "#3b815f", "#4d6355", "#728366", "#384858", "#26394d", "#ffc0b9"], "#4f8fb0"),
    skin: { ground: "mud", ledge: "log", walker: "snail", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "mist", dark: false, fog: 0.15, water: true,
  },
  {
    id: "orchard", name: "Orchard Heights", bg: "assets/orchard.webp", song: "orchard",
    seconds: 250,
    story: "The wind blew eggs up into the branches! Springy mushrooms can bounce Mama up to the highest ledges.",
    learn: "Use a spring to reach an egg in the branches. Swipe in mid-air to steer: left drops you short, right carries you far. Then steer back onto the lower path.",
    tip: "Springs launch you high",
    palette: pal(["#d0a3c5", "#f1d19f", "#96bd75", "#638c5e", "#a46963", "#c48371", "#744c63", "#49334e", "#ffbfcb"]),
    skin: { ground: "grass", ledge: "branch", walker: "caterpillar", flyer: "bee", hazard: "thorn", spring: "mushroom" },
    fx: "petals", dark: false, fog: 0,
  },
  {
    id: "amber-quarry", name: "Amber Quarry", bg: "assets/amber-quarry.webp", song: "amber-quarry",
    seconds: 260,
    story: "Eggshell flecks lead across the old quarry. Cracked ledges don’t hold for long, so keep hopping!",
    learn: "Recognize a cracked ledge and jump again before it gives way.",
    tip: "Cracked ledges crumble",
    palette: pal(["#79b3c1", "#ffe297", "#dabb69", "#aa864d", "#946749", "#bf945c", "#66515e", "#4b3e54", "#fff2b6"]),
    skin: { ground: "stone", ledge: "stone", walker: "beetle", flyer: "hawk", hazard: "stone", spring: "coil" },
    fx: "dust", dark: false, fog: 0,
  },
  {
    id: "fogwood", name: "Fogwood", bg: "assets/fogwood.webp", song: "fogwood",
    seconds: 265,
    story: "The trail disappears in the mist, but a golden shell glints between the pines. Mind the moths!",
    learn: "Read a flying moth’s path and choose a safe crossing. The landing stays visible in the mist.",
    tip: "Moths float up and down",
    palette: pal(["#78a49c", "#b3dead", "#6db282", "#3e7762", "#4f6554", "#768574", "#374754", "#233b43", "#d9fae0"]),
    skin: { ground: "mud", ledge: "log", walker: "snail", flyer: "moth", hazard: "thorn", spring: "mushroom" },
    fx: "mist", dark: false, fog: 0.45,
  },
  {
    id: "canyon", name: "Ember Canyon", bg: "assets/canyon.webp", song: "canyon",
    seconds: 270,
    story: "Canyon gusts split the trail in two. Look for solid ground beyond the spikes.",
    learn: "Chain a gap and a spike crossing, with room to recover between them.",
    tip: "Spikes hurt. Jump them",
    palette: pal(["#fca463", "#ffcb76", "#e18b48", "#ba5a39", "#9c4938", "#c56e46", "#60333f", "#422336", "#ffe99f"]),
    skin: { ground: "stone", ledge: "stone", walker: "beetle", flyer: "hawk", hazard: "stone", spring: "coil" },
    fx: "embers", dark: false, fog: 0,
  },
  {
    id: "glass-coast", name: "Glass Coast", bg: "assets/glass-coast.webp", song: "glass-coast",
    seconds: 280,
    story: "The tide pushed eggs onto the cliffs. Ride the lifts to reach them!",
    learn: "Board a moving lift and time your exit onto a coastal ledge.",
    tip: "Jump off the lift at the top",
    palette: pal(["#65bed0", "#ddf4b2", "#84c7a1", "#52a384", "#779695", "#b5c8b1", "#526d80", "#2d5369", "#ffffcf"], "#3fb4d6"),
    skin: { ground: "sand", ledge: "plank", walker: "crab", flyer: "gull", hazard: "urchin", spring: "coil" },
    fx: "spray", dark: false, fog: 0, water: true,
  },
  {
    id: "lantern-caverns", name: "Lantern Caverns", bg: "assets/lantern-caverns.webp", song: "lantern-caverns",
    seconds: 290,
    story: "The cave cuts under the ridge. Crystal light shows the eggs on the ledges.",
    learn: "Step from a moving lift onto a crumbling ledge, then leave it in time.",
    tip: "Lift, then crumble. Keep moving",
    palette: pal(["#353071", "#86f1e7", "#6d98b0", "#565082", "#584370", "#8564a5", "#3d3159", "#221d42", "#f6bcfd"]),
    skin: { ground: "crystal", ledge: "crystal", walker: "beetle", flyer: "bat", hazard: "crystal", spring: "coil" },
    fx: "fireflies", dark: true, fog: 0,
  },
  {
    id: "frostline", name: "Frostline", bg: "assets/frostline.webp", song: "frostline",
    seconds: 295,
    story: "Frost has made the path slippery. Mama is slow to speed up or slow down on ice, so a swipe takes a moment to work.",
    learn: "On ice Mama is slow to speed up and slow to slow down. A push carries her farther if you swipe just before you jump or in mid-air, and a brake takes a long slide to work. Golden eggs wait for good steering.",
    tip: "Ice is slippery: swipes work slowly",
    palette: pal(["#83c8eb", "#f1fcff", "#bee8f4", "#75b8d1", "#558cad", "#90c8dc", "#425d85", "#29415b", "#fdedcc"]),
    skin: { ground: "ice", ledge: "ice", walker: "mite", flyer: "owl", hazard: "crystal", spring: "cloud" },
    fx: "snow", dark: false, fog: 0, ice: true,
  },
  {
    id: "ridge", name: "Moonridge", bg: "assets/ridge.webp", song: "ridge",
    seconds: 300,
    story: "The moon is up and the beacon is dark. Its base is just beyond the old bridge.",
    learn: "Read an enemy patrol while choosing where to land from a moving platform.",
    tip: "Watch the patrol, then land",
    palette: pal(["#4542a2", "#8fe6de", "#418f91", "#306f80", "#524777", "#786397", "#34355e", "#232648", "#edbcff"]),
    skin: { ground: "stone", ledge: "stone", walker: "beetle", flyer: "owl", hazard: "thorn", spring: "mushroom" },
    fx: "fireflies", dark: true, fog: 0.1,
  },
  {
    id: "dawnbridge", name: "Dawnbridge", bg: "assets/dawnbridge.webp", song: "dawnbridge",
    seconds: 310,
    story: "The bridge is broken in places. Carry the clutch across before the sun clears the ridge.",
    learn: "Cross a run of broken spans, naming the next two landings from each safe approach.",
    tip: "Plan two landings ahead",
    palette: pal(["#e7a0a0", "#ffe1ad", "#c2ae84", "#9d7772", "#845a6d", "#b68480", "#684761", "#44334e", "#ffe1c5"]),
    skin: { ground: "brick", ledge: "brick", walker: "beetle", flyer: "moth", hazard: "stone", spring: "coil" },
    fx: "clouds", dark: false, fog: 0.1,
  },
  {
    id: "beacon-summit", name: "Beacon Summit", bg: "assets/beacon-summit.webp", song: "beacon-summit",
    seconds: 320,
    story: "There’s the beacon! Touch it to light the way home for the whole flock.",
    learn: "Combine springs, lifts, and timed jumps on the final climb, then light the beacon.",
    tip: "Touch the beacon!",
    palette: pal(["#b9cfb9", "#fff0ae", "#acce8a", "#7c9f74", "#767487", "#ab9e99", "#545470", "#343954", "#fff0ae"]),
    skin: { ground: "cloud", ledge: "cloud", walker: "beetle", flyer: "hawk", hazard: "crystal", spring: "cloud" },
    fx: "clouds", dark: false, fog: 0, beacon: true,
  },
];

/** Little story beats along the trail (shown as small captions, re-readable in the journal). `at` = fraction of the landscape. */
const TRAIL = {
  "meadow": [[0.38, "Mama counts her eggs. Only one is home. The rest rolled away down the valley."], [0.70, "Golden eggs hatch into ducklings, and ducklings follow Mama. The more the merrier!"], [0.93, "A windmill turns on the hill. The next trail leads there."]],
  "clover-mill": [[0.35, "Clover everywhere. A lucky egg must be hiding in here."], [0.68, "The old mill wheel creaks. Its shadow points to the next field."], [0.93, "Reeds sway beyond the mill. The river is high today."]],
  "reedwater": [[0.35, "Frogs croak from the lily pads. They saw an egg float by."], [0.68, "The logs bob up and down. Steady, Mama."], [0.93, "The water drops. Dry land and apple blossoms ahead."]],
  "orchard": [[0.35, "Petals drift down like snow. Somewhere above, an egg glints."], [0.68, "The very highest branches hold the shiniest eggs."], [0.93, "The orchard ends at the old quarry wall."]],
  "amber-quarry": [[0.35, "The stone is warm and golden. Tap, tap goes the old crane."], [0.68, "Some ledges are older than they look."], [0.93, "Cool air rolls out of the pines ahead."]],
  "fogwood": [[0.35, "Fog muffles every sound. Mama listens for a tiny peep."], [0.68, "A moth lantern floats by. Follow its soft light."], [0.93, "The mist thins. It smells like warm dust and embers."]],
  "canyon": [[0.35, "Red walls, red sky. The canyon is hot, but Mama is brave."], [0.68, "The wind carries a salty smell. The sea must be near."], [0.93, "Gulls cry somewhere below. Almost to the coast."]],
  "glass-coast": [[0.35, "Waves sparkle like glass. A shell on the cliff holds a golden gleam."], [0.68, "The lifts hum in the sea breeze. Ride them up!"], [0.93, "The cliff ends at a dark cave mouth glowing blue."]],
  "lantern-caverns": [[0.35, "Crystals hum softly. Each one lights the way a little."], [0.68, "Echoes answer every peep. Mama is not alone in here."], [0.93, "Cold air from the far end. Frost sparkles on the stone."]],
  "frostline": [[0.35, "The ice is slick as a pond. Slow and steady, Mama."], [0.68, "Snow falls in big soft flakes. The ducklings love it."], [0.93, "Night is coming, and a pale moon rises over the ridge."]],
  "ridge": [[0.35, "Moonlight on the pines. Fireflies blink along the trail."], [0.68, "An owl watches from a branch. It hoots, but kindly."], [0.93, "Far ahead, an old stone bridge glows in the first light."]],
  "dawnbridge": [[0.35, "The old bridge has lost a few stones. Look before you leap."], [0.68, "The sun is nearly up. Pink clouds drift below the arches."], [0.93, "Above the clouds, a tiny tower on the highest peak."]],
  "beacon-summit": [[0.30, "The air is thin and bright. The beacon is close now."], [0.60, "Every duckling is still behind her. Mama smiles."], [0.88, "One last climb. Touch the beacon and light the way home."]],
};
for (const c of CHAPTERS) c.trail = (TRAIL[c.id] || []).map(([at, text]) => ({ at, text }));

export const CHAPTER_COUNT = CHAPTERS.length;           // 13
export const CIRCUIT_STORY =
  "The beacon is still shining. Mama leads the flock back through the valley to look for more eggs.";

/** Seconds band [lo, hi] a clean run through landscape `index` (0-based) must fall in: its target +-T.paceTolerance. */
export function paceBand(index) {
  const s = CHAPTERS[index].seconds;
  return [Math.round(s * (1 - T.paceTolerance)), Math.round(s * (1 + T.paceTolerance))];
}

/** Target seconds for one whole clean circuit (about an hour). */
export const JOURNEY_SECONDS = CHAPTERS.reduce((sum, c) => sum + c.seconds, 0);

/**
 * "Effective difficulty" 0..20 that levelgen scales its demands with.
 * It rises SLOWLY and continuously with distance: 0 at the very start, ~11 at the beacon in circuit 1,
 * so each minute of play is only a hair harder than the one before. `within` (0..1) is how far through
 * the landscape you are, so difficulty glides across landscape boundaries instead of stepping.
 * Each later circuit starts around where the previous one ended (a little easier than its end,
 * since levelgen also adds more variety), and is capped so every jump stays within thumb-sized reach.
 */
export function difficulty(chapter, circuit = 1, within = 0) {
  const progress = (chapter + within) / CHAPTERS.length;           // 0..1 through the circuit
  const base = 11 * Math.pow(progress, 0.92);                      // gentle, nearly linear
  return Math.min(20, base + (circuit - 1) * 4.5);
}

export const chapterById = (id) => CHAPTERS.find((c) => c.id === id);
