// Unit tests for Phase 3 logic: the Dimensional Fold camera rig, the thumbstick and world seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CameraRig,
  fovForFold,
  povWeight,
  fitDistance,
  FOV_MIN,
  FOV_MAX,
  FOLD_DEFAULT,
  EYE_HEIGHT,
  PAGE_LIMIT,
  SPAWN_BACK,
  PAN_LIMIT,
  VIEW_PRESETS,
} from '../src/input/CameraRig.js';
import { stickVector } from '../src/input/Thumbstick.js';
import {
  simplify,
  canonicalPoints,
  encodeBytes,
  decodeBytes,
  toBase32,
  fromBase32,
  encodeWorld,
  decodeWorld,
  isWorldHash,
  quantize,
  dequantize,
} from '../src/world/WorldSeed.js';

function fakeCamera(aspect = 4 / 3) {
  return {
    aspect,
    fov: 35,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    target: null,
    lookAt(x, y, z) { this.target = { x, y, z }; },
    updateProjectionMatrix() {},
  };
}

function run(rig, seconds, ...args) {
  for (let t = 0; t < seconds; t += 1 / 60) rig.update(1 / 60, ...args);
}

test('fold maps linearly to fov 15°..65° and ground weight only near the end', () => {
  assert.equal(fovForFold(0), FOV_MIN);
  assert.equal(fovForFold(1), FOV_MAX);
  assert.equal(fovForFold(FOLD_DEFAULT), 35);
  assert.equal(fovForFold(2), FOV_MAX);
  assert.equal(povWeight(0), 0);
  assert.equal(povWeight(FOLD_DEFAULT), 0);
  assert.equal(povWeight(1), 1);
  assert.ok(povWeight(0.8) > 0 && povWeight(0.8) < 1);
});

test('fitDistance backs off for narrow screens and narrow fov', () => {
  assert.ok(fitDistance(35, 0.46) > fitDistance(35, 1.33));
  assert.ok(fitDistance(15, 1.33) > fitDistance(35, 1.33));
});

test('pinch out walks the camera down to eye height on the terrain', () => {
  const cam = fakeCamera();
  const rig = new CameraRig(cam);
  const ground = () => 0.4;
  run(rig, 1, ground);
  assert.ok(Math.abs(cam.fov - 35) < 0.01);
  const high = cam.position.y;
  assert.ok(high > 5, `map camera is high (${high})`);
  rig.zoom(0.1); // fingers far apart
  run(rig, 3, ground);
  assert.equal(rig.goal.fold, 1);
  assert.ok(rig.pov);
  assert.ok(Math.abs(cam.fov - FOV_MAX) < 0.1);
  assert.ok(Math.abs(cam.position.y - (0.4 + EYE_HEIGHT)) < 0.02, `eye at ${cam.position.y}`);
  rig.zoom(10); // pinch in: back up to the tabletop, then dolly out
  assert.ok(Math.abs(rig.goal.fold - FOLD_DEFAULT) < 1e-9);
  assert.ok(rig.goal.zoomK > 1);
  rig.zoom(10); // keep going: flatten to the top-down map
  run(rig, 3, ground);
  assert.equal(rig.goal.fold, 0);
  assert.equal(rig.goal.zoomK, rig.limits.zoomMax);
  assert.ok(Math.abs(cam.fov - FOV_MIN) < 0.1);
  assert.ok(cam.position.y > high, 'top-down map is higher still');
});

test('walking moves forward along the view, slows in water and stays on the page', () => {
  const cam = fakeCamera();
  const rig = new CameraRig(cam, { fold: 1 });
  rig.goal.fold = 1;
  run(rig, 0.1);
  const z0 = rig.walker.z;
  rig.move.y = 1; // forward; yaw 0 looks toward -Z
  run(rig, 1);
  const dry = z0 - rig.walker.z;
  assert.ok(dry > 1.2 && dry < 1.6, `walked ${dry}`);
  const z1 = rig.walker.z;
  run(rig, 1, () => 0, () => true);
  const wet = z1 - rig.walker.z;
  assert.ok(wet < dry * 0.6, `wading ${wet}`);
  run(rig, 20);
  assert.equal(rig.walker.z, -PAGE_LIMIT);
  rig.move.y = 0;
  rig.move.x = 1;
  run(rig, 20);
  assert.equal(rig.walker.x, PAGE_LIMIT);
});

test('look turns the walker and clamps pitch; orbit becomes look at ground level', () => {
  const cam = fakeCamera();
  const rig = new CameraRig(cam, { fold: 1 });
  run(rig, 0.1);
  rig.look(0.5, 10);
  assert.equal(rig.walker.goalPitch, 0.9);
  rig.orbit(0.25, 0);
  assert.ok(Math.abs(rig.walker.goalYaw - 0.75) < 1e-9);
  run(rig, 1);
  assert.ok(Math.abs(rig.walker.yaw - 0.75) < 1e-3);
});

test('map orbit clamps tilt; the walker waits at the near edge facing the same way', () => {
  const cam = fakeCamera();
  const rig = new CameraRig(cam);
  rig.orbit(0.3, 10);
  assert.equal(rig.goal.pitch, rig.limits.pitchMax);
  rig.orbit(0, -10);
  assert.equal(rig.goal.pitch, rig.limits.pitchMin);
  rig.goal.yaw = 0;
  run(rig, 2);
  assert.ok(Math.abs(rig.walker.x - rig.target.x) < 1e-3);
  assert.equal(rig.walker.z, Math.min(rig.target.z + SPAWN_BACK, PAGE_LIMIT)); // yaw 0 looks toward -Z
  assert.ok(Math.abs(rig.walker.yaw - rig.yaw) < 1e-9);
});

test('zoom is one chain: dolly in, then walk; dolly out, then flatten', () => {
  const rig = new CameraRig(fakeCamera());
  rig.zoom(Math.exp(-0.5)); // a little closer: dolly only
  assert.equal(rig.goal.fold, FOLD_DEFAULT);
  assert.ok(Math.abs(rig.goal.zoomK - Math.exp(-0.5)) < 1e-9);
  rig.zoom(Math.exp(-5)); // all the way in: hits the dolly limit, then folds down to walk
  assert.equal(rig.goal.zoomK, rig.limits.zoomMin);
  assert.equal(rig.goal.fold, 1);
  rig.zoom(Math.exp(0.1)); // a little out from walking only lifts the fold
  assert.ok(rig.goal.fold < 1 && rig.goal.fold > FOLD_DEFAULT);
  assert.equal(rig.goal.zoomK, rig.limits.zoomMin);
});

test('map pans across the table, relative to the view, within limits', () => {
  const cam = fakeCamera();
  const rig = new CameraRig(cam);
  run(rig, 0.2);
  const z0 = rig.target.z;
  rig.panWorld(0, 1); // forward at yaw 0 is -Z
  run(rig, 2);
  assert.ok(Math.abs(rig.target.z - (z0 - 1)) < 1e-3, `target z ${rig.target.z}`);
  rig.goal.yaw = Math.PI / 2;
  run(rig, 2);
  rig.panWorld(1, 0); // right at yaw 90° is -Z as well
  run(rig, 2);
  assert.ok(Math.abs(rig.target.z - (z0 - 2)) < 1e-2, `target z ${rig.target.z}`);
  rig.panWorld(100, 100);
  assert.ok(Math.abs(rig.goal.panX) <= PAN_LIMIT && Math.abs(rig.goal.panZ) <= PAN_LIMIT);
  // keys pan on the map
  rig.resetView();
  run(rig, 3);
  rig.move.y = 1;
  run(rig, 0.5);
  assert.ok(rig.target.z < z0 - 0.5, 'W slides the map view forward');
  rig.move.y = 0;
});

test('tilt reaches nearly edge-on and straight down; presets and reset', () => {
  const rig = new CameraRig(fakeCamera());
  rig.orbit(0, -10);
  assert.ok(rig.goal.pitch <= 0.12);
  rig.orbit(0, 10);
  assert.ok(rig.goal.pitch >= 1.55);
  rig.view('low');
  assert.equal(rig.goal.pitch, VIEW_PRESETS.low);
  rig.goal.fold = 1;
  rig.view('top'); // leaves walking first
  assert.equal(rig.goal.fold, FOLD_DEFAULT);
  assert.equal(rig.goal.pitch, VIEW_PRESETS.top);
  rig.goal.yaw = Math.PI * 4 + 0.3;
  rig.goal.zoomK = 0.5;
  rig.resetView();
  assert.deepEqual([rig.goal.yaw, rig.goal.pitch, rig.goal.zoomK, rig.goal.panX, rig.goal.panZ], [0, 1.05, 1, 0, 0]);
});

test('thumbstick vector: dead zone, unit clamp, screen-up is forward', () => {
  assert.deepEqual(stickVector(0, 0), { x: 0, y: 0 });
  assert.deepEqual(stickVector(2, 0), { x: 0, y: 0 }); // inside the dead zone
  const up = stickVector(0, -48);
  assert.ok(Math.abs(up.y - 1) < 1e-9 && Math.abs(up.x) < 1e-9);
  const far = stickVector(300, 0);
  assert.ok(Math.abs(far.x - 1) < 1e-9);
  const half = stickVector(24, 0);
  assert.ok(half.x > 0.4 && half.x < 0.5);
});

test('RDP simplify keeps corners and drops collinear points', () => {
  const line = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0.5 }));
  assert.equal(simplify(line).length, 2);
  const L = [...line.slice(0, 25), ...Array.from({ length: 25 }, (_, i) => ({ x: line[24].x, y: 0.5 + i / 49 }))];
  const s = simplify(L);
  assert.equal(s.length, 3);
});

test('canonical points sit on the quantization grid', () => {
  const pts = canonicalPoints([{ x: 0.123456, y: 0.98765 }], 'tap');
  assert.equal(pts[0].x, dequantize(quantize(0.123456)));
  assert.equal(canonicalPoints([{ x: 0.123456, y: 0.98765 }], 'tap')[0].x, pts[0].x);
});

test('base32 round-trips arbitrary bytes and stays a plain #name', () => {
  const bytes = new Uint8Array(257).map((_, i) => (i * 37 + 11) & 255);
  const s = toBase32(bytes);
  assert.match(s, /^[a-z2-7]+$/);
  assert.deepEqual(fromBase32(s), bytes);
  assert.throws(() => fromBase32('ab_c'));
});

const ENTRIES = [
  { kind: 'loop', biome: 0, seed: 123456789, points: canonicalPoints([{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.25 }, { x: 0.3, y: 0.4 }], 'loop') },
  { kind: 'ruin', biome: 1, seed: 42, points: canonicalPoints([{ x: 0.6, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.7, y: 0.7 }], 'ruin') },
  { kind: 'river', biome: 2, seed: 0xffffffff, points: canonicalPoints([{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.7 }, { x: 0.9, y: 0.85 }], 'river') },
  { kind: 'tap', biome: 0, seed: 7, points: canonicalPoints([{ x: 0.5, y: 0.5 }], 'tap') },
  { kind: 'flick', biome: 1, seed: 8, points: canonicalPoints([{ x: 0.3, y: 0.3 }, { x: 0.33, y: 0.31 }], 'flick') },
];

test('binary world format round-trips every stroke kind', () => {
  const out = decodeBytes(encodeBytes(ENTRIES, 2));
  assert.equal(out.biome, 2);
  assert.deepEqual(out.entries, ENTRIES);
  assert.throws(() => decodeBytes(new Uint8Array([1, 2, 3, 4, 5])), /Not a Living Parchment world/);
});

test('world links round-trip (compressed when possible) and are recognised', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...ENTRIES[i % ENTRIES.length], seed: i }));
  const hash = await encodeWorld(many, 1);
  assert.ok(isWorldHash(`#${hash}`));
  assert.match(hash, /^w1[zr][a-z2-7]+$/);
  const back = await decodeWorld(`#${hash}`);
  assert.equal(back.biome, 1);
  assert.deepEqual(back.entries, many);
  assert.equal(isWorldHash('#about'), false);
  await assert.rejects(decodeWorld('#w1xabc'));
});

test('zipSingle writes a valid stored zip with the right CRC', async () => {
  const { zipSingle, crc32 } = await import('../src/world/Exporter.js');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const data = new TextEncoder().encode('hello parchment');
  const zip = zipSingle('a.glb', data);
  const v = new DataView(zip.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(new TextDecoder().decode(zip.slice(30, 35)), 'a.glb');
  assert.deepEqual(zip.slice(35, 35 + data.length), data);
  const end = zip.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint32(end + 16, true), 35 + data.length); // central directory offset
});
