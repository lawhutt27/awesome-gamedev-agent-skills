// Small procedural mesh helpers shared by the parts catalog and the sketch inflater.
// Every helper returns an indexed BufferGeometry with position and normal only, in rest-pose
// world space (metres), so pieces can be merged and skinned without further conversion.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export { V };

// Mesh density multiplier: 1 = the editor's detail; LOD exports rebuild at 0.6 and 0.35.
let DETAIL = 1;
export function setDetail(f) {
  DETAIL = f;
}
const dn = (n, min = 4) => Math.max(min, Math.round(n * DETAIL));

function finish(geo) {
  for (const name of Object.keys(geo.attributes)) if (name !== 'position') geo.deleteAttribute(name);
  let g = geo.index ? geo : mergeVertices(geo, 1e-5);
  g.computeVertexNormals();
  return g;
}
export { finish };

/**
 * Sweep an elliptical cross-section along a path. radii[i] = [ra, rb]: ra lies along B = T x N,
 * rb along N, where N is `up` made perpendicular to the tangent T. For a path going up +Y with
 * up = +Z, ra is the width (X) and rb the depth (Z). `round` closes each end with a dome
 * (otherwise a flat fan), so limbs and torsos end like clay rather than cut pipe.
 */
export function sweep(path, radii, { seg = 16, up = V(0, 0, 1), round = true, capStart = true, capEnd = true } = {}) {
  seg = dn(seg, 5);
  const pts = path.map((p) => p.clone());
  const rad = radii.map((r) => (Array.isArray(r) ? [...r] : [r, r]));
  const n = pts.length;
  const tangents = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    return b.clone().sub(a).normalize();
  });
  // Domed ends: extra rings past each end along the end tangent.
  const domeSteps = 4;
  const addDome = (atStart) => {
    const i = atStart ? 0 : n - 1;
    const t = tangents[i].clone().multiplyScalar(atStart ? -1 : 1);
    const [ra, rb] = rad[i];
    const len = Math.min(ra, rb);
    const rings = [];
    for (let s = 1; s <= domeSteps; s++) {
      const phi = (s / domeSteps) * (Math.PI / 2) * 0.92;
      rings.push({ p: pts[i].clone().addScaledVector(t, Math.sin(phi) * len), r: [ra * Math.cos(phi), rb * Math.cos(phi)], t: tangents[i] });
    }
    return atStart ? rings.reverse() : rings;
  };
  let rings = pts.map((p, i) => ({ p, r: rad[i], t: tangents[i] }));
  if (round && capStart) rings = [...addDome(true), ...rings];
  if (round && capEnd) rings = [...rings, ...addDome(false)];

  const positions = [];
  const index = [];
  let prevN = null;
  for (const ring of rings) {
    const T = ring.t;
    let N = up.clone().addScaledVector(T, -up.dot(T));
    if (N.lengthSq() < 1e-6) N = prevN ? prevN.clone() : Math.abs(T.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
    N.addScaledVector(T, -N.dot(T)).normalize();
    prevN = N;
    const B = T.clone().cross(N).normalize();
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const q = ring.p.clone().addScaledVector(B, Math.cos(a) * ring.r[0]).addScaledVector(N, Math.sin(a) * ring.r[1]);
      positions.push(q.x, q.y, q.z);
    }
  }
  const R = rings.length;
  for (let j = 0; j < R - 1; j++) {
    for (let k = 0; k < seg; k++) {
      const a = j * seg + k;
      const b = j * seg + ((k + 1) % seg);
      const c = (j + 1) * seg + k;
      const d = (j + 1) * seg + ((k + 1) % seg);
      index.push(a, c, b, b, c, d);
    }
  }
  const cap = (ringIdx, center, flip) => {
    const ci = positions.length / 3;
    positions.push(center.x, center.y, center.z);
    for (let k = 0; k < seg; k++) {
      const a = ringIdx * seg + k;
      const b = ringIdx * seg + ((k + 1) % seg);
      if (flip) index.push(ci, b, a);
      else index.push(ci, a, b);
    }
  };
  const first = rings[0];
  const last = rings[R - 1];
  if (capStart) cap(0, round ? first.p.clone().addScaledVector(first.t, -Math.min(...rings[domeSteps].r) * 0.08) : first.p, false);
  if (capEnd) cap(R - 1, round ? last.p.clone().addScaledVector(last.t, Math.min(...rings[R - 1 - domeSteps].r) * 0.08) : last.p, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** A smooth path through control points (Catmull-Rom), `count` samples. */
export function smoothPath(ctrl, count = 12) {
  if (ctrl.length < 3) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(ctrl[0].clone().lerp(ctrl[ctrl.length - 1], i / (count - 1)));
    return out;
  }
  return new THREE.CatmullRomCurve3(ctrl, false, 'centripetal').getPoints(count - 1);
}

/** Interpolate a radius profile [[t, ra, rb], ...] at t in 0..1. */
export function profileAt(profile, t) {
  for (let i = 0; i < profile.length - 1; i++) {
    const [t0, a0, b0] = profile[i];
    const [t1, a1, b1] = profile[i + 1];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      const s = u * u * (3 - 2 * u);
      return [a0 + (a1 - a0) * s, b0 + (b1 - b0) * s];
    }
  }
  const l = profile[profile.length - 1];
  return [l[1], l[2]];
}

/** Sweep along control points with a radius profile; the workhorse for limbs and bodies. */
export function limb(ctrl, profile, opts = {}) {
  const count = Math.max(2, dn(opts.count ?? 14, 3));
  const path = smoothPath(ctrl, count);
  const radii = path.map((_, i) => profileAt(profile, i / (count - 1)));
  return sweep(path, radii, opts);
}

export function ellipsoid(c, rx, ry, rz, { w = 22, h = 16 } = {}) {
  const g = new THREE.SphereGeometry(1, dn(w, 6), dn(h, 4));
  g.scale(rx, ry, rz);
  g.translate(c.x, c.y, c.z);
  return finish(g);
}

/** A box with rounded edges of radius r (half-sizes hx, hy, hz). */
export function roundedBox(c, hx, hy, hz, r, segs = 6) {
  const g = new THREE.BoxGeometry(2, 2, 2, dn(segs, 2), dn(segs, 2), dn(segs, 2));
  const pos = g.attributes.position;
  const h = V(hx, hy, hz);
  const inner = V(Math.max(hx - r, 0), Math.max(hy - r, 0), Math.max(hz - r, 0));
  const p = V(0, 0, 0);
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).multiply(h);
    const q = p.clone().clamp(inner.clone().negate(), inner);
    const d = p.clone().sub(q);
    if (d.lengthSq() > 1e-10) d.setLength(r);
    q.add(d);
    pos.setXYZ(i, q.x + c.x, q.y + c.y, q.z + c.z);
  }
  return finish(g);
}

/** A cone (or frustum with r1 > 0) from base to tip. */
export function cone(base, tip, r0, r1 = 0.002, seg = 14) {
  return sweep([base, tip], [r0, r1], { seg, round: false, up: Math.abs(tip.clone().sub(base).normalize().y) > 0.9 ? V(0, 0, 1) : V(0, 1, 0) });
}

export function torus(c, radius, tube, { axis = 'y', arc = Math.PI * 2, rotZ = 0 } = {}) {
  const g = new THREE.TorusGeometry(radius, tube, 10, 28, arc);
  if (axis === 'y') g.rotateX(Math.PI / 2);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(c.x, c.y, c.z);
  return finish(g);
}

/** A flat-ish rounded slab from a 2D outline (in the XY plane at z), thickness t. */
export function slab(outline, z, t) {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: true, bevelThickness: t * 0.4, bevelSize: t * 0.4, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, z - t / 2);
  return finish(g);
}

/** Mirror a geometry across x = 0 (flips winding so normals stay outward). */
export function mirrorX(geo) {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  g.computeVertexNormals();
  return g;
}
