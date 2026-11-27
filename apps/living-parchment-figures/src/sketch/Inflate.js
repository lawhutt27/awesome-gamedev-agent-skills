// Turn a drawn 2D outline into a rounded 3D shape ("inflation", after Igarashi's Teddy).
//
// The outline is resampled, the inside is filled with a grid of points, everything is
// Delaunay-triangulated and triangles outside the outline are dropped. Each vertex is then
// lifted off the drawing plane by a circular profile of its distance to the outline, front and
// back, so a circle becomes a ball and a long oval a sausage. Open strokes become tapered tubes.

import * as THREE from 'three';
import { V, sweep, smoothPath } from '../body/Geometry.js';

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToPolyline(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    let t = l2 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = a.x + abx * t - p.x;
    const dy = a.y + aby * t - p.y;
    best = Math.min(best, dx * dx + dy * dy);
  }
  return Math.sqrt(best);
}

export function pathLength(pts, closed = false) {
  let L = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) L += Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y);
  return L;
}

/** Evenly resample a polyline (closed or open) to n points. */
export function resample(pts, n, closed = false) {
  const L = pathLength(pts, closed);
  if (L === 0) return [pts[0]];
  const step = L / (closed ? n : n - 1);
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let acc = 0;
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs && out.length < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    while (acc + d >= step * out.length - 1e-12 && out.length < n) {
      const t = d ? (step * out.length - acc) / d : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    acc += d;
  }
  if (!closed) while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Bowyer-Watson Delaunay triangulation. Returns index triples into pts. */
export function delaunay(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20 + 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const all = [...pts, { x: cx - d, y: cy - d }, { x: cx + d, y: cy - d }, { x: cx, y: cy + d }];
  const n = pts.length;
  const circ = (a, b, c) => {
    const A = all[a];
    const B = all[b];
    const C = all[c];
    const D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    if (Math.abs(D) < 1e-14) return { x: 0, y: 0, r2: Infinity };
    const a2 = A.x * A.x + A.y * A.y;
    const b2 = B.x * B.x + B.y * B.y;
    const c2 = C.x * C.x + C.y * C.y;
    const x = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / D;
    const y = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / D;
    return { x, y, r2: (A.x - x) ** 2 + (A.y - y) ** 2 };
  };
  let tris = [{ v: [n, n + 1, n + 2], c: circ(n, n + 1, n + 2) }];
  for (let i = 0; i < n; i++) {
    const p = all[i];
    const bad = [];
    const keep = [];
    for (const t of tris) {
      if ((p.x - t.c.x) ** 2 + (p.y - t.c.y) ** 2 < t.c.r2) bad.push(t);
      else keep.push(t);
    }
    const edges = new Map();
    for (const t of bad) {
      for (let e = 0; e < 3; e++) {
        const a = t.v[e];
        const b = t.v[(e + 1) % 3];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      }
    }
    for (const [a, b] of edges.values()) keep.push({ v: [a, b, i], c: circ(a, b, i) });
    tris = keep;
  }
  return tris.filter((t) => t.v.every((x) => x < n)).map((t) => t.v);
}

/**
 * Inflate a closed outline (array of {x, y}, metres) into a closed mesh centred on plane z0.
 * depth scales the puff (1 = round cross-section).
 */
export function inflateOutline(outline, { z0 = 0, depth = 1, boundary = 56 } = {}) {
  let ring = resample(outline, boundary, true);
  if (polygonArea(ring) < 0) ring = ring.reverse();
  const h = pathLength(ring, true) / ring.length;
  const pts = ring.map((p) => ({ ...p, d: 0 }));
  // An inner ring keeps the rim smooth, then a grid fills the middle.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length];
    const b = ring[(i + 1) % ring.length];
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1;
    const q = { x: ring[i].x + (nx / l) * h * 0.45, y: ring[i].y + (ny / l) * h * 0.45 };
    if (pointInPolygon(q, ring) && distToPolyline(q, ring) > h * 0.3) pts.push({ ...q, d: distToPolyline(q, ring) });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const g = h * 0.95;
  for (let y = minY + g / 2; y < maxY; y += g) {
    for (let x = minX + g / 2; x < maxX; x += g) {
      const q = { x: x + (((Math.round(y / g) & 1) * g) / 2), y };
      if (!pointInPolygon(q, ring)) continue;
      const dd = distToPolyline(q, ring);
      if (dd > h * 0.85) pts.push({ ...q, d: dd });
    }
  }
  const tris = delaunay(pts).filter(([a, b, c]) => {
    const m = { x: (pts[a].x + pts[b].x + pts[c].x) / 3, y: (pts[a].y + pts[b].y + pts[c].y) / 3 };
    return pointInPolygon(m, ring);
  });
  const dmax = Math.max(...pts.map((p) => p.d), 1e-4);
  const lift = (d) => Math.sqrt(Math.max(0, d * (2 * dmax - d))) * depth;
  const nb = ring.length;
  const positions = [];
  // Front copy of every point, then back copy of the interior points (rim shared).
  for (const p of pts) positions.push(p.x, p.y, z0 + lift(p.d));
  const backIndex = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    if (i < nb) backIndex[i] = i;
    else {
      backIndex[i] = positions.length / 3;
      positions.push(pts[i].x, pts[i].y, z0 - lift(pts[i].d));
    }
  }
  const index = [];
  for (const [a, b, c] of tris) {
    // Delaunay output is unordered: make the front face point +Z.
    const cross = (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
    const [x, y, z] = cross > 0 ? [a, b, c] : [a, c, b];
    index.push(x, y, z);
    index.push(backIndex[x], backIndex[z], backIndex[y]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return { geo, dmax, rim: ring };
}

/** An open stroke as a tapered tube. pts: [{x, y, z}], radius in metres. */
export function tubeAlong(pts, radius) {
  const L = pathLength(pts);
  const n = Math.max(6, Math.min(40, Math.round(L / 0.02)));
  const flat = resample(pts, Math.min(n, 24));
  const ctrl = flat.map((p, i) => {
    // Carry z along by nearest original point.
    let best = pts[0];
    let bd = Infinity;
    for (const q of pts) {
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return V(p.x, p.y, best.z ?? 0);
  });
  const path = smoothPath(ctrl, n);
  const radii = path.map((_, i) => {
    const t = i / (path.length - 1);
    const taper = Math.min(1, 0.55 + Math.min(t, 1 - t) * 4);
    return radius * taper;
  });
  return sweep(path, radii, { seg: 12, up: V(0, 0, 1) });
}

/**
 * Classify a finished stroke in the front plane: 'dot' (a tap), 'loop' (ends meet) or 'line'.
 * Sizes are in metres on a 1.7 m figure.
 */
export function classifyStroke(pts) {
  if (pts.length < 2) return 'dot';
  const L = pathLength(pts);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const size = Math.max(maxX - minX, maxY - minY);
  if (L < 0.035 || size < 0.025) return 'dot';
  const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const area = Math.abs(polygonArea(pts));
  if (gap < Math.max(0.05, L * 0.18) && area > L * L * 0.012) return 'loop';
  return 'line';
}
