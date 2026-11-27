// Automatic skin weights: each vertex follows the bones it sits closest to.
//
// For every vertex we measure the distance to each candidate bone's segment and weight by an
// inverse power of it, keeping the strongest four. A high power gives crisp, almost rigid parts
// with a short blend across each joint, which suits the chunky paper-clay look and keeps an
// elbow from dragging the whole arm. Pieces that should never bend (a hat, an eye, a button)
// pass `rigid` and get one bone at full weight.

import * as THREE from 'three';
import { BONE_NAMES, DEFORM, REGIONS, boneSegments } from './Skeleton.js';

const tmp = new THREE.Vector3();
const ab = new THREE.Vector3();

/** Distance from p to segment [a, b]. */
export function segmentDistance(p, a, b) {
  ab.subVectors(b, a);
  const len2 = ab.lengthSq();
  let t = len2 > 0 ? tmp.subVectors(p, a).dot(ab) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  tmp.copy(a).addScaledVector(ab, t);
  return tmp.distanceTo(p);
}

/**
 * Add skinIndex / skinWeight attributes to `geo`.
 * candidates: deforming bone names the piece may follow; rigid: one bone name instead.
 */
export function applySkin(geo, joints, { candidates = DEFORM, rigid = null, power = 6 } = {}) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  if (rigid) {
    const bi = BONE_NAMES.indexOf(rigid);
    for (let i = 0; i < n; i++) {
      skinIndex[i * 4] = bi;
      skinWeight[i * 4] = 1;
    }
  } else {
    const segs = boneSegments(joints);
    const list = candidates.filter((c) => segs[c]).map((name) => ({ name, bi: BONE_NAMES.indexOf(name), a: segs[name][0], b: segs[name][1] }));
    const p = new THREE.Vector3();
    const w = new Array(list.length);
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i);
      for (let j = 0; j < list.length; j++) {
        const d = segmentDistance(p, list[j].a, list[j].b);
        w[j] = { bi: list[j].bi, w: 1 / Math.pow(d + 0.015, power) };
      }
      w.sort((x, y) => y.w - x.w);
      const top = w.slice(0, 4);
      const sum = top.reduce((s, x) => s + x.w, 0);
      let kept = 0;
      for (let k = 0; k < top.length; k++) {
        const v = top[k].w / sum;
        if (v < 0.02) continue;
        skinIndex[i * 4 + kept] = top[k].bi;
        skinWeight[i * 4 + kept] = v;
        kept++;
      }
      // Renormalise after dropping the faint ones.
      let s = 0;
      for (let k = 0; k < 4; k++) s += skinWeight[i * 4 + k];
      for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] /= s;
    }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  return geo;
}

/**
 * Which body regions a drawn stroke belongs to (points in the front plane, z ignored).
 * Each point votes for the region of its nearest bone; a region with a clear majority wins,
 * otherwise every region with a fair share bends the stroke (a whole-body outline, say).
 */
export function strokeRegions(points, joints) {
  const segs = boneSegments(joints);
  const regionOf = {};
  for (const [region, names] of Object.entries(REGIONS)) for (const n of names) regionOf[n] ??= region;
  // Shoulders sit on the torso for voting purposes.
  regionOf.LeftShoulder = 'torso';
  regionOf.RightShoulder = 'torso';
  regionOf.Neck = 'torso';
  const votes = {};
  const p = new THREE.Vector3();
  const flat = (v) => new THREE.Vector3(v.x, v.y, 0);
  for (const q of points) {
    p.set(q.x, q.y, 0);
    let best = null;
    let bd = Infinity;
    for (const name of DEFORM) {
      const d = segmentDistance(p, flat(segs[name][0]), flat(segs[name][1]));
      if (d < bd) {
        bd = d;
        best = name;
      }
    }
    const r = regionOf[best];
    votes[r] = (votes[r] ?? 0) + 1;
  }
  const total = points.length || 1;
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] / total >= 0.7) return [ranked[0][0]];
  return ranked.filter(([, v]) => v / total >= 0.12).map(([r]) => r);
}

export function regionBones(regions) {
  const set = new Set();
  for (const r of regions) for (const b of REGIONS[r]) set.add(b);
  return [...set];
}
