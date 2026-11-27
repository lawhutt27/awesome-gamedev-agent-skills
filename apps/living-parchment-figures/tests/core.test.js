// Unit tests for the pure parts: skeleton, inflation, skinning, re-fitting, state and clips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { jointPositions, BONE_NAMES, DEFORM, SHAPE_DEFAULTS, figureHeight } from '../src/rig/Skeleton.js';
import { inflateOutline, classifyStroke, delaunay, pointInPolygon } from '../src/sketch/Inflate.js';
import { buildCharacter, refit, zigzagCorners, MORPHS } from '../src/build/Builder.js';
import { strokeRegions } from '../src/rig/Skinning.js';
import { defaultState, randomize, encodeState, decodeState, normalize, History, paletteVariants } from '../src/state/State.js';
import { buildClips, CLIP_NAMES } from '../src/rig/Animations.js';
import { crowdStates, buildExportRoot } from '../src/export/Exporter.js';
import { CATALOG, CATEGORY_ORDER } from '../src/body/PartsCatalog.js';

const circle = (cx, cy, r, n = 40) => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos((i / n) * Math.PI * 2) * r, y: cy + Math.sin((i / n) * Math.PI * 2) * r }));

test('default figure stands about 1.7 m tall (hair on top) with feet on the ground', () => {
  const J = jointPositions(SHAPE_DEFAULTS);
  const box = new THREE.Box3();
  for (const p of buildCharacter(defaultState('swap')).pieces) box.union(new THREE.Box3().setFromBufferAttribute(p.geo.attributes.position));
  assert.ok(box.max.y > 1.65 && box.max.y < 1.82, `top of head at ${box.max.y}`);
  assert.ok(box.min.y > -0.02 && box.min.y < 0.02, `soles at ${box.min.y}`);
  assert.ok(Math.abs(figureHeight(SHAPE_DEFAULTS) - box.max.y) < 0.05);
  assert.ok(J.LeftToeBase.y >= 0 && J.LeftToeBase.y < 0.05);
  assert.ok(J.LeftHand.x > 0, 'left hand is on +X when facing +Z');
});

test('inflating a circle gives a closed ball with outward normals', () => {
  const { geo, dmax } = inflateOutline(circle(0, 0, 0.1));
  assert.ok(Math.abs(dmax - 0.1) < 0.01);
  geo.computeBoundingBox();
  assert.ok(Math.abs(geo.boundingBox.max.z - 0.1) < 0.015, 'round cross-section');
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  let outward = 0;
  for (let i = 0; i < pos.count; i++) if (new THREE.Vector3().fromBufferAttribute(pos, i).dot(new THREE.Vector3().fromBufferAttribute(nrm, i)) > 0) outward++;
  assert.ok(outward / pos.count > 0.95, `outward ${outward}/${pos.count}`);
});

test('delaunay triangulates a square into two triangles', () => {
  const t = delaunay([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  assert.equal(t.length, 2);
  assert.ok(pointInPolygon({ x: 0.5, y: 0.5 }, circle(0.5, 0.5, 0.3)));
});

test('strokes are classified by shape', () => {
  assert.equal(classifyStroke([{ x: 0, y: 0 }]), 'dot');
  assert.equal(classifyStroke([...circle(0, 1, 0.1), { x: 0.1, y: 1 }]), 'loop');
  assert.equal(classifyStroke([{ x: 0, y: 1 }, { x: 0.2, y: 1.05 }, { x: 0.4, y: 1 }]), 'line');
  const zig = [];
  for (let i = 0; i <= 8; i++) zig.push({ x: i * 0.03, y: 1 + (i % 2) * 0.06 });
  assert.ok(zigzagCorners(zig).length >= 3);
});

test('strokes find their body region', () => {
  const J = jointPositions(SHAPE_DEFAULTS);
  assert.deepEqual(strokeRegions(circle(0, 1.6, 0.1), J), ['head']);
  assert.deepEqual(strokeRegions([{ x: 0.3, y: 1.42 }, { x: 0.5, y: 1.42 }, { x: 0.65, y: 1.42 }], J), ['leftArm']);
});

test('drawings follow the shape sliders and come back unchanged', () => {
  const J0 = jointPositions(SHAPE_DEFAULTS);
  const J1 = jointPositions({ ...SHAPE_DEFAULTS, legs: 0.6, height: 1.2 });
  const pts = [{ x: 0.5, y: 1.42 }, { x: 0.1, y: 0.5 }, { x: 0, y: 1.6 }];
  const there = refit(pts, J0, J1);
  assert.ok(there[1].y < 0.5, 'a knee point drops with shorter legs');
  const back = refit(there, J1, J0);
  back.forEach((p, i) => assert.ok(Math.hypot(p.x - pts[i].x, p.y - pts[i].y) < 0.01));
});

test('every catalog option builds, skins to valid bones and normalised weights', () => {
  for (const cat of CATEGORY_ORDER) {
    for (const key of Object.keys(CATALOG[cat].options)) {
      const s = defaultState('swap');
      s.parts[cat] = key;
      const { pieces } = buildCharacter(s);
      for (const p of pieces) {
        const w = p.geo.attributes.skinWeight;
        const idx = p.geo.attributes.skinIndex;
        for (let i = 0; i < w.count; i += 7) {
          const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
          assert.ok(Math.abs(sum - 1) < 1e-3, `${cat}/${key} weights sum ${sum}`);
          assert.ok(idx.getX(i) < BONE_NAMES.length);
        }
        assert.equal(p.geo.morphAttributes.position.length, MORPHS.length);
      }
    }
  }
});

test('random figures always have a body and stay in range', () => {
  for (let seed = 1; seed < 40; seed++) {
    const s = randomize(defaultState('swap'), seed);
    assert.notEqual(s.parts.torso, 'none');
    assert.notEqual(s.parts.head, 'none');
    assert.ok(buildCharacter(s).pieces.length > 5);
  }
});

test('share codes round-trip a figure', async () => {
  const s = randomize(defaultState('swap'), 3);
  s.strokes.push({ k: 'blob', p: [0, 1000, 100, 1100, 0, 1200, -100, 1100], c: '#b8342a', z: 'mid', m: true });
  const code = await encodeState(s);
  assert.match(code, /^c1\./);
  assert.deepEqual(await decodeState(code), normalize(s));
});

test('undo history', () => {
  const h = new History();
  const a = { n: 1 };
  h.push(a);
  assert.deepEqual(h.undo({ n: 2 }), { n: 1 });
  assert.deepEqual(h.redo({ n: 1 }), { n: 2 });
});

test('clips cover every animation and the custom pose', () => {
  const clips = buildClips(SHAPE_DEFAULTS, { LeftArm: [0, 0, 0.5, 0.866], hips: [0, 0, 0] });
  assert.deepEqual(clips.map((c) => c.name), [...CLIP_NAMES, 'Pose']);
  for (const c of clips) assert.ok(c.tracks.some((t) => t.name === 'Hips.position'));
});

test('export root merges into one skinned mesh with named shape keys', () => {
  const { group, mesh, clips } = buildExportRoot(defaultState('swap'));
  assert.ok(mesh.isSkinnedMesh);
  assert.equal(mesh.skeleton.bones.length, BONE_NAMES.length);
  assert.deepEqual(Object.keys(mesh.morphTargetDictionary), MORPHS);
  assert.ok(Array.isArray(mesh.material) && mesh.material.every((m) => m.name));
  assert.equal(group.getObjectByName('Hips').isBone, true);
  assert.equal(clips.length, CLIP_NAMES.length);
  assert.ok(DEFORM.every((b) => group.getObjectByName(b)));
});

test('crowds and palette variants differ from the original', () => {
  const s = defaultState('swap');
  const crowd = crowdStates(s, 6, 9);
  assert.equal(crowd.length, 6);
  assert.equal(new Set(crowd.map((c) => JSON.stringify(c.colors))).size > 1, true);
  assert.equal(paletteVariants(s).length, 4);
});
