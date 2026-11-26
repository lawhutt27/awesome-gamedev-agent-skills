import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIOMES, BIOME_ORDER, pickWeighted, terrainContext, SPRITE_TYPES } from '../src/world/BiomeConfig.js';
import { scratchParams, fillPinkNoise } from '../src/audio/PaperSynth.js';
import { uvToWorld, worldToUv, heightToY, WATER_Y, WATER_H } from '../src/terrain/TerrainShader.js';

const HEX = /^#[0-9a-f]{6}$/i;

test('three biomes with complete palettes and weights', () => {
  assert.deepEqual(BIOME_ORDER, ['mossyRuin', 'autumnRidge', 'moonlitTide']);
  BIOME_ORDER.forEach((id, row) => {
    const b = BIOMES[id];
    assert.equal(b.row, row);
    for (const k of ['ink', 'hillWash', 'hillEdge', 'ruinStone', 'bankWash', 'waterInk', 'waterDeep', 'waterGlint', 'contour', 'background', 'table']) {
      assert.match(b[k], HEX, `${id}.${k}`);
    }
    for (const ctx of ['flat', 'hill', 'ruin', 'water']) {
      assert.equal(b.weights[ctx].length, SPRITE_TYPES.length);
      assert.ok(b.weights[ctx].reduce((a, c) => a + c, 0) > 0);
    }
    assert.equal(b.sun.dir.length, 3);
    assert.ok(b.sun.dir[1] > 0, 'sun above the page');
  });
  assert.ok(BIOMES.moonlitTide.glow > BIOMES.mossyRuin.glow, 'lanterns glow brighter at night');
});

test('pickWeighted respects weights and bounds', () => {
  assert.equal(pickWeighted([0, 1, 0], 0.5), 1);
  assert.equal(pickWeighted([1, 0, 0], 0.999), 0);
  assert.equal(pickWeighted([1, 1], 0), 0);
  assert.equal(pickWeighted([1, 1], 0.9999), 1);
  const counts = [0, 0, 0];
  for (let i = 0; i < 3000; i++) counts[pickWeighted([1, 2, 7], i / 3000)]++;
  assert.ok(Math.abs(counts[2] / 3000 - 0.7) < 0.01);
});

test('terrainContext maps height and masks to flora contexts', () => {
  assert.equal(terrainContext(0.5, 0, 0), 'flat');
  assert.equal(terrainContext(0.7, 0, 0), 'hill');
  assert.equal(terrainContext(0.62, 0.9, 0), 'ruin');
  assert.equal(terrainContext(0.35, 0, 1), 'water');
  assert.equal(terrainContext(0.5, 0, 0.6), 'water');
});

test('page <-> world mapping and water clamp', () => {
  const w = uvToWorld(0, 0);
  assert.deepEqual(w, { x: -5, z: -5 });
  const uv = worldToUv(2.5, -1);
  assert.ok(Math.abs(uv.x - 0.75) < 1e-9 && Math.abs(uv.y - 0.4) < 1e-9);
  assert.equal(heightToY(0.5), 0);
  assert.ok(heightToY(0.9) > 0.9);
  assert.equal(heightToY(0.1), WATER_Y);
  assert.ok(WATER_H === 0.42 && WATER_Y < 0);
});

test('pen scratch: silent when still, brighter and louder with speed', () => {
  assert.equal(scratchParams(0).gain, 0);
  const slow = scratchParams(0.3);
  const fast = scratchParams(2);
  assert.ok(fast.gain > slow.gain && fast.freq > slow.freq);
  assert.ok(scratchParams(50).gain <= 0.46);
});

test('pink noise is bounded and roughly zero-mean', () => {
  let s = 1;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const buf = fillPinkNoise(new Float32Array(48000), rand);
  let mean = 0;
  let max = 0;
  for (const v of buf) {
    mean += v;
    max = Math.max(max, Math.abs(v));
  }
  mean /= buf.length;
  assert.ok(max < 1, `peak ${max}`);
  assert.ok(Math.abs(mean) < 0.1, `mean ${mean}`);
});
