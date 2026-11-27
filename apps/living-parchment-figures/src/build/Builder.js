// State -> skinned pieces in the rest pose.
//
// Swap parts are built first (body, limbs, then the head and the face on its surface), then
// every drawn stroke in the order it was drawn, each one raycasting against what is already
// there so a loop drawn on a belly bulges out of it and a line drawn across a face sits on it.
// Strokes are stored against the default body and re-fitted bone by bone, so they follow the
// shape sliders. Every piece gets skin weights and the four face shape keys.

import * as THREE from 'three';
import { CATALOG, BUILD_ORDER } from '../body/PartsCatalog.js';
import { V, ellipsoid, cone, mirrorX, setDetail } from '../body/Geometry.js';
import { jointPositions, boneSegments, DEFORM, SHAPE_DEFAULTS } from '../rig/Skeleton.js';
import { applySkin, strokeRegions, regionBones, segmentDistance } from '../rig/Skinning.js';
import { inflateOutline, tubeAlong, resample, pathLength } from '../sketch/Inflate.js';

export const MORPHS = ['Blink', 'Smile', 'Frown', 'MouthOpen'];

// ------------------------------------------------------------ stroke re-fitting

/** Move 2D points drawn on one body onto another, keeping each point's place along its bone. */
export function refit(points, fromJ, toJ) {
  const segA = boneSegments(fromJ);
  const segB = boneSegments(toJ);
  const k = toJ.HeadTop_End.y / fromJ.HeadTop_End.y;
  const flat = (v) => new THREE.Vector3(v.x, v.y, 0);
  return points.map((p) => {
    const q = new THREE.Vector3(p.x, p.y, 0);
    let best = null;
    let bd = Infinity;
    for (const name of DEFORM) {
      const d = segmentDistance(q, flat(segA[name][0]), flat(segA[name][1]));
      if (d < bd) {
        bd = d;
        best = name;
      }
    }
    const [a, b] = segA[best].map(flat);
    const [a2, b2] = segB[best].map(flat);
    const ab = b.clone().sub(a);
    const t = ab.lengthSq() ? Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / ab.lengthSq())) : 0;
    const off = q.clone().sub(a.clone().addScaledVector(ab, t));
    const out = a2.clone().lerp(b2, t).addScaledVector(off, k);
    return { x: out.x, y: out.y };
  });
}

// ------------------------------------------------------------ stroke kinds

/** Corners where a line turns sharply: three or more make a zigzag (spikes). */
export function zigzagCorners(pts) {
  const L = pathLength(pts);
  if (L < 0.06) return [];
  const n = Math.max(8, Math.round(L / 0.012));
  const r = resample(pts, n);
  const corners = [];
  for (let i = 2; i < r.length - 2; i++) {
    const a = r[i - 2];
    const b = r[i];
    const c = r[i + 2];
    const d1 = Math.atan2(b.y - a.y, b.x - a.x);
    const d2 = Math.atan2(c.y - b.y, c.x - b.x);
    let turn = Math.abs(d2 - d1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > 1.3 && (!corners.length || Math.hypot(b.x - corners[corners.length - 1].x, b.y - corners[corners.length - 1].y) > 0.02)) corners.push(b);
  }
  return corners;
}

function spikesGeometry(pts, zAt, radius) {
  const s = pts[0];
  const e = pts[pts.length - 1];
  const dir = new THREE.Vector2(e.x - s.x, e.y - s.y).normalize();
  const nrm = new THREE.Vector2(-dir.y, dir.x);
  const corners = zigzagCorners(pts);
  const side = (p) => (p.x - s.x) * nrm.x + (p.y - s.y) * nrm.y;
  const sides = corners.map(side);
  const sorted = [...sides].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const majority = sides.filter((v) => v > median).length >= sides.length / 2 ? 1 : -1;
  const geos = [];
  const peaks = corners.filter((_, i) => Math.sign(sides[i] - median) === majority || sides.length < 3);
  const spacing = pathLength(pts) / Math.max(1, peaks.length) / 2;
  for (const p of peaks) {
    const t = (p.x - s.x) * dir.x + (p.y - s.y) * dir.y;
    const base = { x: s.x + dir.x * t, y: s.y + dir.y * t };
    const len = Math.hypot(p.x - base.x, p.y - base.y);
    if (len < 0.008) continue;
    geos.push(cone(V(base.x, base.y, zAt(base)), V(p.x, p.y, zAt(p)), Math.min(len * 0.45, Math.max(radius, spacing * 0.8))));
  }
  return geos;
}

// ------------------------------------------------------------ morph targets

function bbox(geo) {
  geo.computeBoundingBox();
  return geo.boundingBox;
}

/** Face shape keys: eyes close (Blink), mouths curve (Smile / Frown) and open (MouthOpen). */
function faceMorphs(geo, role) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const out = MORPHS.map(() => new Float32Array(n * 3));
  if (role === 'eye' || role === 'mouth') {
    const b = bbox(geo);
    const c = b.getCenter(new THREE.Vector3());
    const hw = Math.max(1e-4, (b.max.x - b.min.x) / 2);
    const hh = Math.max(1e-4, (b.max.y - b.min.y) / 2);
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i) - c.x;
      const y = pos.getY(i) - c.y;
      if (role === 'eye') {
        out[0][i * 3 + 1] = -y * 0.9 - hh * 0.25; // squash to a closed lid line
      } else {
        const u = x / hw;
        out[1][i * 3 + 1] = u * u * hw * 0.45 - hw * 0.12;
        out[2][i * 3 + 1] = -(u * u * hw * 0.45 - hw * 0.12);
        out[3][i * 3 + 1] = y * 1.4 - hh * 0.6;
      }
    }
  }
  return out;
}

function addMorphs(geo, role) {
  const deltas = faceMorphs(geo, role);
  geo.morphAttributes.position = deltas.map((d, i) => {
    const a = new THREE.Float32BufferAttribute(d, 3);
    a.name = MORPHS[i];
    return a;
  });
  geo.morphTargetsRelative = true;
  return geo;
}

// ------------------------------------------------------------ the build

function transformAround(geos, s = 1, d = 1) {
  if (s === 1 && d === 1) return;
  const box = new THREE.Box3();
  for (const g of geos) box.union(bbox(g));
  const c = box.getCenter(new THREE.Vector3());
  // Scale from the bottom-centre for bodies so feet stay on the ground, else from the middle.
  const m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(s, s, s * d)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  for (const g of geos) g.applyMatrix4(m);
}

/**
 * Build every piece. Returns { joints, pieces: [{ geo, color, name, ref }] } where ref is
 * { cat } for a catalog part or { stroke: index } for a drawn one.
 */
export function buildCharacter(state, { detail = 1 } = {}) {
  setDetail(detail);
  const J = jointPositions(state.shape);
  const J0 = jointPositions(SHAPE_DEFAULTS);
  const k = state.shape.height;
  const pieces = [];
  const hitMeshes = [];
  const ray = new THREE.Raycaster();
  const hitMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const surfaceZ = (x, y, fallback = null) => {
    ray.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObjects(hitMeshes, false)[0];
    return hit ? hit.point.z : fallback;
  };
  const headR = (J.HeadTop_End.y - J.Head.y) * 0.5;
  const ctx = { shape: state.shape, surfaceZ: (x, y) => surfaceZ(x, y, headR * 0.95) };
  const addHit = (geo) => {
    const m = new THREE.Mesh(geo, hitMat);
    m.updateMatrixWorld();
    hitMeshes.push(m);
  };

  for (const cat of BUILD_ORDER) {
    const key = state.parts[cat] ?? 'none';
    const builder = CATALOG[cat].options[key];
    if (!builder) continue;
    const raw = builder(J, ctx);
    const tw = state.tweak?.[cat];
    if (tw) transformAround(raw.map((p) => p.geo), tw.s ?? 1, tw.d ?? 1);
    const role = cat === 'eyes' ? 'eye' : cat === 'mouth' ? 'mouth' : null;
    for (const p of raw) {
      const color = state.paint?.[cat] ?? state.colors[p.slot] ?? '#888888';
      applySkin(p.geo, J, { candidates: p.candidates, rigid: p.rigid, power: p.power ?? 6 });
      addMorphs(p.geo, role);
      pieces.push({ geo: p.geo, color, slot: p.slot, name: cat, ref: { cat } });
      if (!['eyes', 'mouth'].includes(cat)) addHit(p.geo);
    }
  }

  const headC = J.Head.clone().lerp(J.HeadTop_End, 0.48);
  state.strokes.forEach((stroke, index) => {
    const raw = [];
    for (let i = 0; i < stroke.p.length; i += 2) raw.push({ x: stroke.p[i] / 1000, y: stroke.p[i + 1] / 1000 });
    const sets = [refit(raw, J0, J)];
    const cx = raw.reduce((s, p) => s + p.x, 0) / raw.length;
    if (stroke.m && Math.abs(cx) > 0.03) sets.push(refit(raw.map((p) => ({ x: -p.x, y: p.y })), J0, J));
    const r = Math.max(0.004, ((stroke.r ?? 30) / 1000) * k);
    const surf = stroke.z === 'surf';
    for (const pts of sets) {
      const geos = [];
      let role = null;
      const midX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const midY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const nearHead = Math.hypot(midX - headC.x, midY - headC.y) < headR * 1.1;
      if (stroke.k === 'blob') {
        const { geo, dmax } = inflateOutline(pts, { depth: stroke.d ?? 1 });
        const z0 = surf ? (surfaceZ(midX, midY, 0) ?? 0) - dmax * 0.45 * (stroke.d ?? 1) : 0;
        geo.translate(0, 0, z0);
        geos.push(geo);
      } else if (stroke.k === 'tube' || stroke.k === 'spikes') {
        const samples = resample(pts, Math.min(12, Math.max(2, pts.length)));
        const zs = samples.map((p) => (surf ? (surfaceZ(p.x, p.y, null) ?? null) : 0));
        const valid = zs.filter((z) => z !== null);
        const fallbackZ = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
        const zAt = (p) => {
          let bi = 0;
          let bd = Infinity;
          samples.forEach((q, i) => {
            const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
            if (d < bd) {
              bd = d;
              bi = i;
            }
          });
          return (zs[bi] ?? fallbackZ) + (surf ? r * 0.15 : 0);
        };
        if (stroke.k === 'spikes') geos.push(...spikesGeometry(pts, zAt, r));
        else geos.push(tubeAlong(pts.map((p) => ({ ...p, z: zAt(p) })), r));
        if (surf && nearHead && midY < headC.y) role = 'mouth';
      } else {
        const z = surf ? (surfaceZ(midX, midY, 0) ?? 0) : 0;
        geos.push(ellipsoid(V(midX, midY, z - r * 0.25), r, r, r * 0.7));
        if (surf && nearHead && midY >= headC.y - headR * 0.3) role = 'eye';
      }
      const regions = strokeRegions(pts, J);
      const candidates = regionBones(regions.length ? regions : ['torso']);
      const rigid = regions.length === 1 && regions[0] === 'head' ? 'Head' : null;
      for (const g of geos) {
        const tw = stroke.s ?? 1;
        if (tw !== 1) transformAround([g], tw, 1);
        applySkin(g, J, { candidates, rigid });
        addMorphs(g, role);
        pieces.push({ geo: g, color: stroke.c ?? '#b8342a', slot: null, name: `sketch_${index + 1}`, ref: { stroke: index } });
        addHit(g);
      }
    }
  });
  setDetail(1);
  return { joints: J, pieces };
}

/** Mirror helper re-exported for tests. */
export { mirrorX };
