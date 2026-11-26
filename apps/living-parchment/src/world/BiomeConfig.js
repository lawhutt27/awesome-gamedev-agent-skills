// Biome palettes. Colors are CSS hex strings so the 2D canvases and Three.js
// share one source; main.js converts them to THREE.Color where needed.
//
// Sprite type indices (columns of the sprite atlas):
//   0 = tree, 1 = reed, 2 = standing stone, 3 = lantern
export const SPRITE_TYPES = ['tree', 'reed', 'stone', 'lantern'];
export const TREE = 0;
export const REED = 1;
export const STONE = 2;
export const LANTERN = 3;

export const BIOMES = {
  mossyRuin: {
    id: 'mossyRuin',
    name: 'Mossy Ruin',
    row: 0,
    ink: '#1b1a16',
    inkWet: 'rgba(27, 26, 22, 0.85)',
    hillWash: '#7f9a55',
    hillEdge: '#4f6b33',
    ruinStone: '#8d8a7c',
    ruinMoss: '#5f7a3c',
    bankWash: '#6b8f8a',
    waterInk: '#2f5d66',
    waterDeep: '#173a45',
    waterGlint: '#d9efe6',
    contour: '#3a3424',
    tuft: '#4d6431',
    sun: { color: '#fff1d6', intensity: 2.6, dir: [-0.55, 1.0, 0.45] },
    hemi: { sky: '#e8efd8', ground: '#5a4a32', intensity: 0.9 },
    background: '#2a2a1f',
    table: '#3a2c1f',
    fog: { color: '#2a2a1f', near: 22, far: 48 },
    glow: 0.35,
    // Flora weights per terrain context: [tree, reed, stone, lantern]
    weights: {
      flat: [5, 2, 2, 1],
      hill: [7, 0, 2, 1],
      ruin: [1, 0, 5, 4],
      water: [0, 9, 1, 0],
    },
    sprites: {
      canopy: ['#5c7f3a', '#7fa04e', '#3f5f2a'],
      trunk: '#5a3f2a',
      reed: '#7d8f4a',
      reedHead: '#6a4a2a',
      stone: '#8f8c80',
      moss: '#6d8c3d',
      lanternBody: '#8a8678',
      lanternGlow: '#ffd27a',
    },
  },

  autumnRidge: {
    id: 'autumnRidge',
    name: 'Autumn Ridge',
    row: 1,
    ink: '#2a160e',
    inkWet: 'rgba(42, 22, 14, 0.85)',
    hillWash: '#c98a3e',
    hillEdge: '#9a4d22',
    ruinStone: '#9b8670',
    ruinMoss: '#a0642e',
    bankWash: '#8aa3a0',
    waterInk: '#3c6470',
    waterDeep: '#1f3b46',
    waterGlint: '#fbe7c4',
    contour: '#5a2e17',
    tuft: '#a35a24',
    sun: { color: '#ffd8a6', intensity: 2.8, dir: [0.7, 0.75, 0.35] },
    hemi: { sky: '#f7dcb4', ground: '#5c3a22', intensity: 0.85 },
    background: '#2d1f17',
    table: '#3f2617',
    fog: { color: '#2d1f17', near: 22, far: 48 },
    glow: 0.45,
    weights: {
      flat: [6, 2, 1, 1],
      hill: [8, 0, 1, 1],
      ruin: [2, 0, 4, 4],
      water: [0, 9, 1, 0],
    },
    sprites: {
      canopy: ['#d2662a', '#e39a3a', '#b8402a'],
      trunk: '#4a2c1c',
      reed: '#b49a4f',
      reedHead: '#6e3e1e',
      stone: '#a08c76',
      moss: '#b5702e',
      lanternBody: '#7a5b44',
      lanternGlow: '#ffb35a',
    },
  },

  moonlitTide: {
    id: 'moonlitTide',
    name: 'Moonlit Tide',
    row: 2,
    ink: '#0f1626',
    inkWet: 'rgba(15, 22, 38, 0.85)',
    hillWash: '#5f7d8f',
    hillEdge: '#34506a',
    ruinStone: '#7d8696',
    ruinMoss: '#4f6c7a',
    bankWash: '#5f86a8',
    waterInk: '#2a4f86',
    waterDeep: '#102a55',
    waterGlint: '#e6f0ff',
    contour: '#1f2c44',
    tuft: '#3e5a6e',
    sun: { color: '#b9cdf5', intensity: 1.5, dir: [0.35, 0.9, -0.6] },
    hemi: { sky: '#7f93c2', ground: '#1d2233', intensity: 0.7 },
    background: '#121726',
    table: '#1b1e2b',
    fog: { color: '#121726', near: 20, far: 44 },
    glow: 1.6,
    weights: {
      flat: [3, 3, 1, 3],
      hill: [5, 0, 2, 3],
      ruin: [1, 0, 3, 6],
      water: [0, 8, 0, 2],
    },
    sprites: {
      canopy: ['#3e5f73', '#5b7f92', '#2c465a'],
      trunk: '#2c2a33',
      reed: '#5b7a86',
      reedHead: '#2e3b4a',
      stone: '#7f8898',
      moss: '#4c6b78',
      lanternBody: '#5b5f6e',
      lanternGlow: '#ffe2a0',
    },
  },
};

export const BIOME_ORDER = ['mossyRuin', 'autumnRidge', 'moonlitTide'];
export const DEFAULT_BIOME = 'mossyRuin';

/** Weighted random pick from an array of weights; `r` is a uniform [0,1) sample. */
export function pickWeighted(weights, r) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  let t = r * total;
  for (let i = 0; i < weights.length; i++) {
    t -= weights[i];
    if (t < 0) return i;
  }
  return weights.length - 1;
}

/** Terrain context for flora choice, from height (0..1, 0.5 = paper level) and masks (0..1). */
export function terrainContext(h, stone, water) {
  if (h < 0.46 || water > 0.35) return 'water'; // channel and its wet banks
  if (stone > 0.4) return 'ruin';
  if (h > 0.56) return 'hill';
  return 'flat';
}
