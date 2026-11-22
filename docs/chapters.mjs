const chapters = [
  {
    name: "Meadow", asset: "meadow", length: 1013, patterns: [0, 1, 0, 3],
    story: "A storm scattered Mama’s clutch. The first golden egg is just up the path.",
    terrain: ["#249ae4", "#c2e677", "#7fc54b", "#469942", "#895035", "#ac6844", "#54343b", "#253749", "#ffd67d"],
  },
  {
    name: "Clover Mill", asset: "clover-mill", length: 680, patterns: [0, 4, 1], entrance: 4,
    story: "Eggs are caught in the clover. The mill’s weather vane points downriver.",
    terrain: ["#70c6cb", "#ebec92", "#aabc52", "#749447", "#a37545", "#ce9c58", "#6d4e42", "#354635", "#ffe8a7"],
  },
  {
    name: "Reedwater", asset: "reedwater", length: 720, patterns: [7, 2, 7, 4], entrance: 7,
    story: "Floodwater covers the path. Follow the eggs across the stepping ledges.",
    terrain: ["#73aeba", "#a5e1a5", "#5eaf79", "#3b815f", "#4d6355", "#728366", "#384858", "#26394d", "#ffc0b9"],
  },
  {
    name: "Orchard Heights", asset: "orchard", length: 690, patterns: [3, 8, 0, 4], entrance: 3,
    story: "The wind sent eggs up into the branches. Springs reach the highest ledges.",
    terrain: ["#d0a3c5", "#f1d19f", "#96bd75", "#638c5e", "#a46963", "#c48371", "#744c63", "#49334e", "#ffbfcb"],
  },
  {
    name: "Amber Quarry", asset: "amber-quarry", length: 740, patterns: [8, 2, 5, 3], entrance: 8,
    story: "Eggshell flecks lead across the old quarry. Cracked ledges give way underfoot.",
    terrain: ["#79b3c1", "#ffe297", "#dabb69", "#aa864d", "#946749", "#bf945c", "#66515e", "#4b3e54", "#fff2b6"],
  },
  {
    name: "Fogwood", asset: "fogwood", length: 730, patterns: [4, 7, 5, 9], entrance: 4,
    story: "The trail disappears in the mist. A golden shell glints between the pines.",
    terrain: ["#78a49c", "#b3dead", "#6db282", "#3e7762", "#4f6554", "#768574", "#374754", "#233b43", "#d9fae0"],
  },
  {
    name: "Ember Canyon", asset: "canyon", length: 830, patterns: [2, 5, 3, 8], entrance: 2,
    story: "The canyon gusts split the trail. Look for solid ground beyond the spikes.",
    terrain: ["#fca463", "#ffcb76", "#e18b48", "#ba5a39", "#9c4938", "#c56e46", "#60333f", "#422336", "#ffe99f"],
  },
  {
    name: "Glass Coast", asset: "glass-coast", length: 730, patterns: [7, 9, 2, 4], entrance: 9,
    story: "The tide has pushed eggs onto the cliffs. Ride a lift to reach them.",
    terrain: ["#65bed0", "#ddf4b2", "#84c7a1", "#52a384", "#779695", "#b5c8b1", "#526d80", "#2d5369", "#ffffcf"],
  },
  {
    name: "Lantern Caverns", asset: "lantern-caverns", length: 820, patterns: [8, 9, 8, 3], entrance: 8,
    story: "The cave cuts under the ridge. Crystal light reveals eggs on the ledges.",
    terrain: ["#353071", "#86f1e7", "#6d98b0", "#565082", "#584370", "#8564a5", "#3d3159", "#221d42", "#f6bcfd"],
  },
  {
    name: "Frostline", asset: "frostline", length: 790, patterns: [0, 7, 9, 2], entrance: 7, ice: true,
    story: "Ice makes the climb slippery. Brake early and leave room before each edge.",
    terrain: ["#83c8eb", "#f1fcff", "#bee8f4", "#75b8d1", "#558cad", "#90c8dc", "#425d85", "#29415b", "#fdedcc"],
  },
  {
    name: "Moonridge", asset: "ridge", length: 810, patterns: [4, 8, 9, 5], entrance: 9,
    story: "The moon is up and the summit beacon is dark. Its base is just beyond the old bridge.",
    terrain: ["#4542a2", "#8fe6de", "#418f91", "#306f80", "#524777", "#786397", "#34355e", "#232648", "#edbcff"],
  },
  {
    name: "Dawnbridge", asset: "dawnbridge", length: 800, patterns: [7, 9, 5, 8], entrance: 7,
    story: "The bridge is broken in places. Carry the clutch across before the sun clears the ridge.",
    terrain: ["#e7a0a0", "#ffe1ad", "#c2ae84", "#9d7772", "#845a6d", "#b68480", "#684761", "#44334e", "#ffe1c5"],
  },
  {
    name: "Beacon Summit", asset: "beacon-summit", length: 860, patterns: [9, 3, 8, 2], entrance: 3,
    story: "There’s the beacon. Reach it to light the way home for the whole flock.",
    terrain: ["#b9cfb9", "#fff0ae", "#acce8a", "#7c9f74", "#767487", "#ab9e99", "#545470", "#343954", "#fff0ae"],
  },
];

export const CHAPTERS = chapters.map(({ terrain, ...chapter }) => {
  const [sky, light, grass, fringe, soil, rock, shadow, outline, flower] = terrain;
  return { ...chapter, sky, light, grass, fringe, soil, rock, shadow, outline, flower };
});

export const chapterIndex = (stage) => stage % CHAPTERS.length;
export const loopNumber = (stage) => Math.floor(stage / CHAPTERS.length) + 1;
