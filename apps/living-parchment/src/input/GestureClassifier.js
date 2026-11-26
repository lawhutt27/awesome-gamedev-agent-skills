// Gesture-to-world grammar.
//
// Pure stroke geometry (no DOM, no Three.js) lives at the top of this file so it can be
// unit-tested in Node. The bottom half binds @use-gesture/vanilla to the canvas and drives the
// camera rig (CameraRig.js): two-finger orbit / tilt and the pinch "Dimensional Fold".
//
// Stroke points are in parchment UV space (0..1 on both axes, v grows "down" the page, like
// canvas pixels) plus a parallel list of screen points in CSS pixels for tap detection.

export const DEFAULTS = {
  tapMaxScreen: 14, // px: a tap moves less than this on screen...
  tapMaxMs: 250, // ...and lasts less than this (longer still-presses also plant)
  flickMaxMs: 320, // short fast strokes that are too short to be a river plant a row
  minStroke: 0.07, // uv: minimum open-stroke length that carves a river
  minLoop: 0.14, // uv: minimum perimeter for a closed loop
  closeAbs: 0.07, // uv: start/end gap must be below this...
  closeRel: 0.3, // ...and below this fraction of the stroke's bounding-box size
  minArea: 0.0015, // uv^2: loops must enclose something
  cornerAngle: 48, // degrees: a turn sharper than this counts as a corner
  ruinCorners: 3, // corners needed for an angular (ruin) loop
};

// ---------------------------------------------------------------- basic geometry

export function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function bounds(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Signed shoelace area of a polygon (closed implicitly). */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a * 0.5;
}

export function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Resample a polyline to `n` points spaced evenly along its length. */
export function resample(pts, n) {
  if (pts.length === 0) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
  const total = pathLength(pts);
  if (total === 0) return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
  const step = total / (n - 1);
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let acc = 0;
  let prev = { x: pts[0].x, y: pts[0].y };
  for (let i = 1; i < pts.length && out.length < n; i++) {
    let cur = pts[i];
    let d = dist(prev, cur);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const q = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
  return out;
}

/** Chaikin corner cutting; keeps endpoints for open paths. */
export function smoothPath(pts, iterations = 2, closed = false) {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    if (p.length < 3) return p;
    const out = closed ? [] : [p[0]];
    const n = closed ? p.length : p.length - 1;
    for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    if (!closed) out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/**
 * Trim the overshoot of a nearly-closed stroke: look in the last 40% of the path for the point
 * closest to the start and cut there, so the closing seam does not read as a corner.
 */
export function trimClosure(pts) {
  if (pts.length < 8) return pts;
  const start = pts[0];
  let best = pts.length - 1;
  let bestD = dist(start, pts[best]);
  for (let i = Math.floor(pts.length * 0.6); i < pts.length; i++) {
    const d = dist(start, pts[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return pts.slice(0, best + 1);
}

/**
 * Find sharp corners on a path. Returns indices into the resampled path and the resampled
 * points themselves. For closed paths the window wraps around the seam.
 */
export function findCorners(pts, { closed = true, samples = 64, window = 3, angle = DEFAULTS.cornerAngle } = {}) {
  const ring = closed ? [...pts, pts[0]] : pts;
  const r = resample(ring, samples + (closed ? 1 : 0));
  if (closed) r.pop(); // last point duplicates the first
  const n = r.length;
  const turns = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ia = i - window;
    const ib = i + window;
    if (!closed && (ia < 0 || ib >= n)) continue;
    const a = r[(ia + n) % n];
    const b = r[i];
    const c = r[ib % n];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 === 0 || l2 === 0) continue;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
    turns[i] = (Math.acos(cos) * 180) / Math.PI;
  }
  // Non-maximum suppression over +-window samples.
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (turns[i] < angle) continue;
    let isMax = true;
    for (let k = -window; k <= window && isMax; k++) {
      if (k === 0) continue;
      const j = closed ? (i + k + n) % n : i + k;
      if (j < 0 || j >= n) continue;
      if (turns[j] > turns[i] || (turns[j] === turns[i] && j < i)) isMax = false;
    }
    if (isMax) corners.push(i);
  }
  return { corners, points: r, turns };
}

// ---------------------------------------------------------------- $1 unistroke recognizer
// Wobbrock, Wilson & Li (2007). Templates are generated procedurally; closed templates are
// matched at several start offsets and both winding directions, because a closed loop may be
// started anywhere.

const N1 = 64;
const SQUARE = 250;
const HALF_DIAG = 0.5 * Math.sqrt(2 * SQUARE * SQUARE);
const PHI = 0.5 * (-1 + Math.sqrt(5));
const ANGLE_RANGE = (45 * Math.PI) / 180;
const ANGLE_PRECISION = (2 * Math.PI) / 180;

function rotateBy(pts, a) {
  const c = centroid(pts);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return pts.map((p) => ({
    x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x,
    y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y,
  }));
}

function normalizeStroke(pts) {
  let p = resample(pts, N1);
  const c = centroid(p);
  p = rotateBy(p, -Math.atan2(c.y - p[0].y, c.x - p[0].x));
  const b = bounds(p);
  const sx = b.w || 1;
  const sy = b.h || 1;
  p = p.map((q) => ({ x: (q.x * SQUARE) / sx, y: (q.y * SQUARE) / sy }));
  const c2 = centroid(p);
  return p.map((q) => ({ x: q.x - c2.x, y: q.y - c2.y }));
}

function pathDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += dist(a[i], b[i]);
  return d / a.length;
}

function distanceAtAngle(pts, tpl, a) {
  return pathDistance(rotateBy(pts, a), tpl);
}

function distanceAtBestAngle(pts, tpl) {
  let a = -ANGLE_RANGE;
  let b = ANGLE_RANGE;
  let x1 = PHI * a + (1 - PHI) * b;
  let f1 = distanceAtAngle(pts, tpl, x1);
  let x2 = (1 - PHI) * a + PHI * b;
  let f2 = distanceAtAngle(pts, tpl, x2);
  while (Math.abs(b - a) > ANGLE_PRECISION) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = PHI * a + (1 - PHI) * b;
      f1 = distanceAtAngle(pts, tpl, x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = (1 - PHI) * a + PHI * b;
      f2 = distanceAtAngle(pts, tpl, x2);
    }
  }
  return Math.min(f1, f2);
}

function polygonTemplate(sides, n = 96) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * sides;
    const k = Math.floor(t);
    const f = t - k;
    const a0 = (k / sides) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((k + 1) / sides) * Math.PI * 2 - Math.PI / 2;
    pts.push({
      x: Math.cos(a0) * (1 - f) + Math.cos(a1) * f,
      y: Math.sin(a0) * (1 - f) + Math.sin(a1) * f,
    });
  }
  pts.push({ ...pts[0] });
  return pts;
}

function circleTemplate(n = 96) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  return pts;
}

/** Rotate the start point of a closed ring by `offset` samples. */
function cycle(pts, offset) {
  const ring = pts.slice(0, -1);
  const out = ring.slice(offset).concat(ring.slice(0, offset));
  out.push({ ...out[0] });
  return out;
}

let TEMPLATES = null;
function templates() {
  if (TEMPLATES) return TEMPLATES;
  const base = [
    { name: 'circle', pts: circleTemplate(), angular: false },
    { name: 'triangle', pts: polygonTemplate(3), angular: true },
    { name: 'square', pts: polygonTemplate(4), angular: true },
    { name: 'pentagon', pts: polygonTemplate(5), angular: true },
  ];
  TEMPLATES = [];
  for (const t of base) {
    for (const dir of [1, -1]) {
      const ring = dir === 1 ? t.pts : [...t.pts].reverse();
      for (let off = 0; off < 96; off += 12) {
        TEMPLATES.push({ name: t.name, angular: t.angular, pts: normalizeStroke(cycle(ring, off)) });
      }
    }
  }
  return TEMPLATES;
}

/** Recognize a closed stroke against circle / polygon templates. Returns {name, score, angular}. */
export function recognizeDollarOne(pts) {
  const p = normalizeStroke(pts);
  let best = null;
  let bestD = Infinity;
  for (const t of templates()) {
    const d = distanceAtBestAngle(p, t.pts);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return { name: best.name, angular: best.angular, score: 1 - bestD / HALF_DIAG };
}

// ---------------------------------------------------------------- classification

/**
 * Classify a finished stroke.
 * @param {{points:{x,y}[], screen:{x,y}[], duration:number}} stroke  points in UV, screen in px
 * @returns {{kind:'tap'|'flick'|'loop'|'ruin'|'river', points, polygon?, corners?, recognized?, length}}
 */
export function classifyStroke(stroke, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pts = stroke.points;
  const screenLen = pathLength(stroke.screen ?? []);
  const len = pathLength(pts);
  const base = { points: pts, length: len, screenLength: screenLen, duration: stroke.duration };

  if (pts.length < 2 || screenLen < o.tapMaxScreen) {
    return { ...base, kind: 'tap', quick: stroke.duration < o.tapMaxMs };
  }

  const b = bounds(pts);
  // People overshoot when closing a loop: measure the gap after trimming the overshoot.
  const ring = trimClosure(pts);
  const gap = dist(ring[0], ring[ring.length - 1]);
  const size = Math.max(b.w, b.h);
  const closed =
    len > o.minLoop && gap < o.closeAbs && gap < o.closeRel * size && Math.abs(polygonArea(ring)) > o.minArea;

  if (closed) {
    const { corners, points } = findCorners(ring, { closed: true, angle: o.cornerAngle });
    const recognized = recognizeDollarOne(ring);
    let angular = corners.length >= o.ruinCorners;
    // Borderline: two crisp corners but the shape clearly matches a polygon template.
    if (!angular && corners.length === 2 && recognized.angular && recognized.score > 0.82) angular = true;
    // A very clean circle never becomes a ruin, even if jitter produced corners.
    if (angular && recognized.name === 'circle' && recognized.score > 0.93 && corners.length < 4) angular = false;
    const polygon = angular ? corners.map((i) => points[i]) : null;
    return {
      ...base,
      kind: angular ? 'ruin' : 'loop',
      points: ring,
      polygon,
      corners: corners.length,
      recognized,
    };
  }

  if (len >= o.minStroke) return { ...base, kind: 'river' };
  return { ...base, kind: 'flick' };
}

// ---------------------------------------------------------------- pointer / gesture binding

/**
 * Binds drawing and camera gestures to `element`.
 *  - one finger / left mouse: draw a stroke (classified on release); at ground level it
 *    looks around instead, and a tap still plants
 *  - two fingers: pinch = Dimensional Fold (map <-> ground), twist = orbit, drag up/down = tilt
 *  - right / middle mouse or shift-drag: orbit + tilt; wheel: zoom
 *
 * `project(clientX, clientY)` must return {x, y} in parchment UV or null when off the page.
 * Handlers: onStart(uv, screen), onMove(uv, screen, velocityPxPerMs), onEnd(classification),
 * onCancel(), onCameraGesture(), onTap(classification) for taps at ground level, isPov().
 */
export class GestureClassifier {
  constructor(element, rig, project, handlers, GestureCtor, opts = {}) {
    this.el = element;
    this.rig = rig;
    this.project = project;
    this.h = handlers;
    this.opts = opts;
    this.stroke = null;
    this.pinching = false;
    this.mode = null; // 'draw' | 'orbit' | null

    element.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari fires its own pinch events; block them so the page never zooms.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }

    this.gesture = new GestureCtor(
      element,
      {
        onDrag: (s) => this._onDrag(s),
        onPinch: (s) => this._onPinch(s),
        onWheel: (s) => this._onWheel(s),
      },
      {
        drag: { threshold: 0, filterTaps: false, pointer: { buttons: [1, 2, 4], capture: true, keys: false } },
        pinch: { scaleBounds: { min: 0.05, max: 20 }, rubberband: false, pointer: { touch: true } },
        wheel: { eventOptions: { passive: false } },
        eventOptions: { passive: false },
      },
    );
  }

  destroy() {
    this.gesture.destroy();
  }

  _onDrag(s) {
    const e = s.event;
    if (s.first) {
      const orbitButton = e && (e.buttons & 2 || e.buttons & 4 || e.shiftKey);
      const pov = this.h.isPov?.() ?? false;
      if (this.pinching || s.touches > 1) this.mode = null;
      else if (orbitButton) this.mode = 'orbit';
      else this.mode = pov ? 'look' : 'draw';
      if (this.mode === 'draw') this._begin(s);
      if (this.mode === 'look') {
        this.look = { x: s.xy[0], y: s.xy[1], t0: s.timeStamp, dist: 0 };
        this.h.onCameraGesture?.();
      }
      if (this.mode === 'orbit') this.h.onCameraGesture?.();
      return;
    }
    if (this.mode === 'look') {
      // Ground level: one finger looks around; a tap still plants.
      const [dx, dy] = s.delta;
      this.look.dist += Math.abs(dx) + Math.abs(dy);
      if (!this.pinching && s.touches <= 1) this.rig.look(-dx * 0.005, -dy * 0.004);
      if (s.last) {
        const lk = this.look;
        this.mode = null;
        this.look = null;
        if (lk.dist < (this.opts.tapMaxScreen ?? DEFAULTS.tapMaxScreen) && !this.pinching) {
          const uv = this.project(lk.x, lk.y);
          if (uv) {
            const result = classifyStroke({ points: [uv], screen: [{ x: lk.x, y: lk.y }], duration: s.timeStamp - lk.t0 }, this.opts);
            this.h.onTap?.(result);
          }
        }
      }
      return;
    }
    if (this.pinching || s.touches > 1) {
      this._cancel();
      this.mode = null;
      return;
    }
    if (this.mode === 'orbit') {
      const [dx, dy] = s.delta;
      this.rig.orbit(-dx * 0.006, dy * 0.005);
      if (s.last) this.mode = null;
      return;
    }
    if (this.mode !== 'draw' || !this.stroke) return;
    const [x, y] = s.xy;
    this._add(x, y, s.timeStamp);
    if (s.last) this._finish(s.timeStamp);
  }

  _begin(s) {
    const [x, y] = s.xy;
    const uv = this.project(x, y);
    this.stroke = { points: [], screen: [], t0: s.timeStamp, last: null, onPage: !!uv };
    if (uv) {
      this.stroke.points.push(uv);
      this.stroke.screen.push({ x, y });
      this.stroke.last = { x, y, t: s.timeStamp };
    }
    this.h.onStart?.(uv, { x, y });
  }

  _add(x, y, t) {
    const st = this.stroke;
    const uv = this.project(x, y);
    if (!uv) return;
    const prev = st.last;
    if (prev && Math.abs(prev.x - x) + Math.abs(prev.y - y) < 1.5) return;
    let v = 0;
    if (prev) {
      const dt = Math.max(1, t - prev.t);
      v = Math.hypot(x - prev.x, y - prev.y) / dt;
    }
    st.points.push(uv);
    st.screen.push({ x, y });
    st.last = { x, y, t };
    this.h.onMove?.(uv, { x, y }, v);
  }

  _finish(t) {
    const st = this.stroke;
    this.stroke = null;
    this.mode = null;
    if (!st || st.points.length === 0) {
      this.h.onCancel?.();
      return;
    }
    const result = classifyStroke({ points: st.points, screen: st.screen, duration: t - st.t0 }, this.opts);
    this.h.onEnd?.(result);
  }

  _cancel() {
    if (this.stroke) {
      this.stroke = null;
      this.h.onCancel?.();
    }
  }

  _onPinch(s) {
    if (s.first) {
      this.pinching = true;
      this._cancel();
      this.mode = null;
      this.h.onCameraGesture?.();
      s.memo = { scale: s.da[0], angle: s.da[1], oy: s.origin[1] };
      return s.memo;
    }
    const m = s.memo;
    if (!m) return undefined;
    const [d, a] = s.da;
    if (d > 0 && m.scale > 0) this.rig.zoom(m.scale / d); // fingers apart = closer
    let dA = a - m.angle;
    if (dA > 180) dA -= 360;
    if (dA < -180) dA += 360;
    this.rig.orbit((dA * Math.PI) / 180, (s.origin[1] - m.oy) * 0.006);
    m.scale = d;
    m.angle = a;
    m.oy = s.origin[1];
    if (s.last) this.pinching = false;
    return m;
  }

  _onWheel(s) {
    s.event?.preventDefault?.();
    const dy = s.delta[1];
    if (dy) this.rig.zoom(Math.exp(dy * 0.0015));
  }
}
