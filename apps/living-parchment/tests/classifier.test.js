// Unit tests for the pure stroke geometry and classification (no DOM, no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStroke,
  findCorners,
  recognizeDollarOne,
  resample,
  pathLength,
  polygonArea,
  smoothPath,
  trimClosure,
  OrbitRig,
} from '../src/input/GestureClassifier.js';

const PX = 800; // pretend the page spans 800 CSS px on screen

function stroke(points, duration = 600) {
  return { points, screen: points.map((p) => ({ x: p.x * PX, y: p.y * PX })), duration };
}

function circle(cx, cy, r, n = 60, { wobble = 0, overshoot = 0, gap = 0, start = 0 } = {}) {
  const pts = [];
  const end = Math.PI * 2 * (1 + overshoot) - gap;
  for (let i = 0; i <= n; i++) {
    const a = start + (i / n) * end;
    const rr = r * (1 + wobble * Math.sin(a * 5));
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  return pts;
}

function polygon(cx, cy, r, sides, perSide = 15, jitter = 0, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * jitter;
  const pts = [];
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2;
    const a1 = ((k + 1) / sides) * Math.PI * 2;
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      pts.push({
        x: cx + (Math.cos(a0) * (1 - t) + Math.cos(a1) * t) * r + rnd(),
        y: cy + (Math.sin(a0) * (1 - t) + Math.sin(a1) * t) * r + rnd(),
      });
    }
  }
  pts.push({ ...pts[0] });
  return pts;
}

function meander(x0, y0, len, n = 50, amp = 0.03) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x0 + t * len, y: y0 + Math.sin(t * Math.PI * 3) * amp });
  }
  return pts;
}

test('geometry helpers', () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  assert.equal(Math.abs(polygonArea(sq)), 1);
  assert.equal(pathLength([...sq, sq[0]]), 4);
  const r = resample([{ x: 0, y: 0 }, { x: 1, y: 0 }], 11);
  assert.equal(r.length, 11);
  assert.ok(Math.abs(r[5].x - 0.5) < 1e-9);
  assert.equal(resample([{ x: 0.3, y: 0.3 }], 4).length, 4);
  const sm = smoothPath(meander(0, 0.5, 0.4, 10), 2, false);
  assert.deepEqual(sm[0], { x: 0, y: 0.5 });
  assert.ok(sm.length > 30);
});

test('trimClosure cuts an overshooting loop at its closest return to the start', () => {
  const pts = circle(0.5, 0.5, 0.1, 80, { overshoot: 0.2 });
  const trimmed = trimClosure(pts);
  assert.ok(trimmed.length < pts.length);
  const end = trimmed[trimmed.length - 1];
  assert.ok(Math.hypot(end.x - pts[0].x, end.y - pts[0].y) < 0.01);
});

test('corner finder: circles have none, polygons have one per vertex', () => {
  assert.equal(findCorners(circle(0.5, 0.5, 0.1)).corners.length, 0);
  assert.equal(findCorners(polygon(0.5, 0.5, 0.1, 4)).corners.length, 4);
  assert.equal(findCorners(polygon(0.5, 0.5, 0.1, 3)).corners.length, 3);
  assert.equal(findCorners(polygon(0.5, 0.5, 0.1, 5)).corners.length, 5);
});

test('$1 recognizer tells circles from polygons regardless of start point', () => {
  for (const start of [0, 1.3, 3.7]) {
    const r = recognizeDollarOne(circle(0.4, 0.4, 0.12, 60, { start }));
    assert.equal(r.name, 'circle', `start ${start}`);
    assert.ok(r.score > 0.85);
  }
  const sq = recognizeDollarOne(polygon(0.4, 0.4, 0.12, 4));
  assert.ok(sq.angular, `square recognized as ${sq.name}`);
  const tri = recognizeDollarOne(polygon(0.4, 0.4, 0.12, 3));
  assert.equal(tri.name, 'triangle');
});

test('closed round loop -> terraced hill', () => {
  const r = classifyStroke(stroke(circle(0.5, 0.5, 0.12, 60, { wobble: 0.05 })));
  assert.equal(r.kind, 'loop');
  assert.equal(r.polygon, null);
});

test('loop that does not quite close (small gap) still counts', () => {
  const r = classifyStroke(stroke(circle(0.5, 0.5, 0.12, 60, { gap: 0.25 })));
  assert.equal(r.kind, 'loop');
});

test('loop that overshoots its start still counts and is trimmed', () => {
  const pts = circle(0.5, 0.5, 0.12, 70, { overshoot: 0.15 });
  const r = classifyStroke(stroke(pts));
  assert.equal(r.kind, 'loop');
  assert.ok(r.points.length < pts.length);
});

test('angular loops (>= 3 sharp corners) -> ruin with a polygon footprint', () => {
  for (const sides of [3, 4, 5]) {
    const r = classifyStroke(stroke(polygon(0.5, 0.5, 0.12, sides, 15, 0.004)));
    assert.equal(r.kind, 'ruin', `${sides} sides`);
    assert.equal(r.polygon.length, sides);
  }
});

test('open meandering stroke -> river', () => {
  const r = classifyStroke(stroke(meander(0.1, 0.5, 0.6)));
  assert.equal(r.kind, 'river');
});

test('a big open arc that ends far from its start is a river, not a loop', () => {
  const r = classifyStroke(stroke(circle(0.5, 0.5, 0.15, 60, { gap: Math.PI * 0.8 })));
  assert.equal(r.kind, 'river');
});

test('tap: tiny movement -> tap; quick flag follows the 250 ms rule', () => {
  const quick = classifyStroke(stroke([{ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }], 120));
  assert.equal(quick.kind, 'tap');
  assert.equal(quick.quick, true);
  const slow = classifyStroke(stroke([{ x: 0.5, y: 0.5 }], 900));
  assert.equal(slow.kind, 'tap');
  assert.equal(slow.quick, false);
});

test('short flick (moves, but too short for a river) -> flick', () => {
  const r = classifyStroke(stroke(meander(0.5, 0.5, 0.04, 8, 0.002), 150));
  assert.equal(r.kind, 'flick');
});

test('tiny closed scribble below the loop minimum is not a hill', () => {
  const r = classifyStroke(stroke(circle(0.5, 0.5, 0.012, 30)));
  assert.notEqual(r.kind, 'loop');
  assert.notEqual(r.kind, 'ruin');
});

test('thresholds can be overridden', () => {
  const r = classifyStroke(stroke(meander(0.1, 0.5, 0.06)), { minStroke: 0.2 });
  assert.equal(r.kind, 'flick');
});

test('OrbitRig clamps tilt and zoom and converges with damping', () => {
  const cam = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    lookAt() {},
  };
  const rig = new OrbitRig(cam);
  rig.orbit(0, 10);
  assert.equal(rig.goal.pitch, rig.limits.pitchMax);
  rig.orbit(0, -10);
  assert.equal(rig.goal.pitch, rig.limits.pitchMin);
  rig.zoom(100);
  assert.equal(rig.goal.distance, rig.limits.distMax);
  rig.zoom(0.0001);
  assert.equal(rig.goal.distance, rig.limits.distMin);
  for (let i = 0; i < 200; i++) rig.update(1 / 60);
  assert.ok(Math.abs(rig.distance - rig.limits.distMin) < 1e-3);
  const d = Math.hypot(cam.position.x, cam.position.y, cam.position.z);
  assert.ok(Math.abs(d - rig.distance) < 1e-6);
  rig.fit(0.5); // portrait phone pulls the camera back
  assert.ok(rig.distance > 15.5);
});
