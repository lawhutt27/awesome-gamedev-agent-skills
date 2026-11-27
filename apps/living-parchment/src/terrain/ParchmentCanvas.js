// Dual offscreen canvas pipeline.
//
//  albedoCanvas (1024²): warm parchment, watercolor washes and Sumi-ink lines. -> CanvasTexture
//  heightMask   (512²):  composed from two working canvases into one RGBA DataTexture:
//                          R = grass/moss mask, G = rock (mountain) mask, B = water mask,
//                          A = elevation (0.5 = paper level, >0.5 hills, <0.5 riverbeds)
//  flowCanvas   (256²):  river flow direction encoded as RG (0.5 = still) for the water shader.
//
// All coordinates passed in are parchment UV (0..1, v down the page like canvas pixels).
// The DataTexture rows are flipped so texture v=1 is the top of the page, matching the
// flipY=true CanvasTextures and the terrain plane's UVs.

import { smoothPath } from '../input/GestureClassifier.js';

export const HEIGHT_BASE = 128; // 0.5 in 8-bit
const HISTORY = 10;
const OFF = 8192; // shadow-blur trick offset in px

function makeCanvas(w, h = w, opts) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', opts);
  return { canvas: c, ctx };
}

/** Deterministic PRNG so the paper looks the same on every load. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export class ParchmentCanvas {
  constructor({ albedoSize = 1024, heightSize = 512, flowSize = 256, noise2D, seed = 7 } = {}) {
    this.A = albedoSize;
    this.H = heightSize;
    this.F = flowSize;
    this.noise2D = noise2D;
    this.rand = mulberry32(seed);

    ({ canvas: this.albedoCanvas, ctx: this.albedo } = makeCanvas(albedoSize));
    ({ canvas: this.heightCanvas, ctx: this.height } = makeCanvas(heightSize, heightSize, { willReadFrequently: true }));
    ({ canvas: this.maskCanvas, ctx: this.mask } = makeCanvas(heightSize, heightSize, { willReadFrequently: true }));
    ({ canvas: this.flowCanvas, ctx: this.flow } = makeCanvas(flowSize));

    /** RGBA8 composite for the DataTexture (mask RGB + height A), rows flipped. */
    this.data = new Uint8Array(heightSize * heightSize * 4);

    this.paperBase = makeCanvas(albedoSize).canvas;
    this._granulation = this._makeGranulation();
    this._paintPaper(this.paperBase.getContext('2d'));

    // Snapshot pool: HISTORY committed entries + 1 pending (pre-stroke) slot.
    this._pool = [];
    for (let i = 0; i < HISTORY + 1; i++) this._pool.push(this._makeSlot());
    this.history = []; // [{slot, meta}]
    this.pending = null;

    this.reset();
    this.compose();
  }

  // ------------------------------------------------------------------ state

  reset() {
    const a = this.albedo;
    a.globalCompositeOperation = 'copy';
    a.drawImage(this.paperBase, 0, 0);
    a.globalCompositeOperation = 'source-over';
    this.height.fillStyle = `rgb(${HEIGHT_BASE},${HEIGHT_BASE},${HEIGHT_BASE})`;
    this.height.fillRect(0, 0, this.H, this.H);
    this.mask.fillStyle = '#000';
    this.mask.fillRect(0, 0, this.H, this.H);
    this.flow.fillStyle = 'rgb(128,128,0)';
    this.flow.fillRect(0, 0, this.F, this.F);
  }

  _makeSlot() {
    return {
      albedo: makeCanvas(this.A).canvas,
      height: makeCanvas(this.H, this.H, { willReadFrequently: true }).canvas,
      mask: makeCanvas(this.H, this.H, { willReadFrequently: true }).canvas,
      flow: makeCanvas(this.F).canvas,
    };
  }

  _copyInto(slot) {
    const copy = (dst, src) => {
      const c = dst.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.drawImage(src, 0, 0);
      c.globalCompositeOperation = 'source-over';
    };
    copy(slot.albedo, this.albedoCanvas);
    copy(slot.height, this.heightCanvas);
    copy(slot.mask, this.maskCanvas);
    copy(slot.flow, this.flowCanvas);
  }

  _restoreFrom(slot) {
    const copy = (ctx, src) => {
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };
    copy(this.albedo, slot.albedo);
    copy(this.height, slot.height);
    copy(this.mask, slot.mask);
    copy(this.flow, slot.flow);
  }

  _freeSlot() {
    const used = new Set(this.history.map((h) => h.slot));
    if (this.pending) used.add(this.pending);
    return this._pool.find((s) => !used.has(s));
  }

  /** Snapshot the page before a stroke so it can be reverted (preview) or undone (history). */
  beginStroke() {
    if (this.pending) return;
    if (this.history.length >= HISTORY) this.history.shift(); // oldest slot becomes free
    this.pending = this._freeSlot();
    this._copyInto(this.pending);
  }

  /** Throw away live preview ink: restore the pre-stroke snapshot (keeps it pending). */
  revertPreview() {
    if (this.pending) this._restoreFrom(this.pending);
  }

  /** Abort the stroke entirely. */
  cancelStroke() {
    if (!this.pending) return;
    this._restoreFrom(this.pending);
    this.pending = null;
  }

  /** Keep the stroke: the pre-stroke snapshot becomes an undo step carrying `meta`. */
  commitStroke(meta = {}) {
    if (!this.pending) return;
    this.history.push({ slot: this.pending, meta });
    this.pending = null;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  /** Restore the page to before the last committed stroke. Returns that stroke's meta. */
  undo() {
    const entry = this.history.pop();
    if (!entry) return null;
    this._restoreFrom(entry.slot);
    return entry.meta;
  }

  /** Clear the page (undoable: call beginStroke first and commitStroke after). */
  clear() {
    this.reset();
  }

  /** Recompose the height/mask DataTexture bytes from the working canvases. */
  compose(target = this.data) {
    const H = this.H;
    const h = this.height.getImageData(0, 0, H, H).data;
    const m = this.mask.getImageData(0, 0, H, H).data;
    const row = H * 4;
    for (let y = 0; y < H; y++) {
      const src = y * row;
      const dst = (H - 1 - y) * row;
      for (let x = 0; x < row; x += 4) {
        target[dst + x] = m[src + x];
        target[dst + x + 1] = m[src + x + 1];
        target[dst + x + 2] = m[src + x + 2];
        target[dst + x + 3] = h[src + x];
      }
    }
    return target;
  }

  /** Bilinear sample of the composed data at page UV. channel 3 = height. Returns 0..1. */
  sample(u, v, channel = 3, data = this.data) {
    const H = this.H;
    const fx = Math.min(Math.max(u * H - 0.5, 0), H - 1.001);
    const fy = Math.min(Math.max((1 - v) * H - 0.5, 0), H - 1.001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const tx = fx - x0;
    const ty = fy - y0;
    const i00 = (y0 * H + x0) * 4 + channel;
    const i10 = i00 + 4;
    const i01 = i00 + H * 4;
    const i11 = i01 + 4;
    const a = data[i00] + (data[i10] - data[i00]) * tx;
    const b = data[i01] + (data[i11] - data[i01]) * tx;
    return (a + (b - a) * ty) / 255;
  }

  // ------------------------------------------------------------------ helpers

  _path(pts, scale, closed) {
    const p = new Path2D();
    p.moveTo(pts[0].x * scale, pts[0].y * scale);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x * scale, pts[i].y * scale);
    if (closed) p.closePath();
    return p;
  }

  /** Fill or stroke a path as a blurred "shadow" only (portable Gaussian blur for 2D canvas). */
  _soft(ctx, path, { color, blur, op = 'source-over', stroke = 0 }) {
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.translate(-OFF, 0);
    ctx.shadowOffsetX = OFF;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = blur;
    ctx.shadowColor = color;
    if (stroke > 0) {
      ctx.lineWidth = stroke;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000';
      ctx.stroke(path);
    } else {
      ctx.fillStyle = '#000';
      ctx.fill(path);
    }
    ctx.restore();
  }

  /** Watercolor wash: jittered multiply layers, darker pooled edge and pigment granulation. */
  _wash(path, color, alpha, { edge = 0.5, edgeWidth = 3, layers = 3, granulate = 0.35 } = {}) {
    const a = this.albedo;
    a.save();
    a.globalCompositeOperation = 'multiply';
    for (let i = 0; i < layers; i++) {
      a.save();
      a.translate((this.rand() - 0.5) * 4, (this.rand() - 0.5) * 4);
      a.fillStyle = rgba(color, alpha / layers + 0.04);
      a.fill(path);
      a.restore();
    }
    a.lineJoin = 'round';
    a.strokeStyle = rgba(color, edge);
    a.lineWidth = edgeWidth;
    a.filter = 'none';
    a.stroke(path);
    if (granulate > 0) {
      a.save();
      a.clip(path);
      a.globalAlpha = granulate;
      a.fillStyle = this._granulationPattern ?? (this._granulationPattern = a.createPattern(this._granulation, 'repeat'));
      a.fillRect(0, 0, this.A, this.A);
      a.restore();
    }
    a.restore();
  }

  /** Tapered Sumi brush line with a little dry-brush bristle texture. */
  _ink(pts, { color, width = 2.6, closed = false, taper = true, bristle = true, alpha = 1 }) {
    const a = this.albedo;
    const S = this.A;
    const n = pts.length;
    if (n < 2) return;
    a.save();
    a.lineCap = 'round';
    a.lineJoin = 'round';
    a.strokeStyle = color;
    a.globalAlpha = alpha;
    const passes = bristle ? 3 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const off = pass === 0 ? 0 : (pass === 1 ? 0.6 : -0.6) * width;
      a.globalAlpha = alpha * (pass === 0 ? 0.92 : 0.28);
      const wScale = pass === 0 ? 1 : 0.35;
      for (let i = 1; i < n; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const t = i / (n - 1);
        let w = width;
        if (taper && !closed) w *= 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
        w *= 0.85 + 0.3 * (this.noise2D(i * 0.13, pass * 3.1) * 0.5 + 0.5);
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const l = Math.hypot(dx, dy) || 1;
        const nx = (-dy / l) * off;
        const ny = (dx / l) * off;
        a.lineWidth = Math.max(0.6, w * wScale);
        a.beginPath();
        a.moveTo(p0.x * S + nx, p0.y * S + ny);
        a.lineTo(p1.x * S + nx, p1.y * S + ny);
        a.stroke();
      }
    }
    a.restore();
  }

  /** Offset a polyline along its normals by `d` (uv). */
  _offset(pts, d) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const w = typeof d === 'function' ? d(i / (pts.length - 1)) : d;
      out.push({ x: pts[i].x - (dy / l) * w, y: pts[i].y + (dx / l) * w });
    }
    return out;
  }

  // ------------------------------------------------------------------ live preview

  /** Live ink while the finger moves. `v` is pointer speed in px/ms (faster = thinner). */
  previewInk(p0, p1, v, biome) {
    const a = this.albedo;
    const S = this.A;
    const w = Math.max(1.3, Math.min(3.4, 3.6 - v * 1.4));
    a.save();
    a.strokeStyle = biome.inkWet;
    a.lineCap = 'round';
    a.lineWidth = w;
    a.beginPath();
    a.moveTo(p0.x * S, p0.y * S);
    a.lineTo(p1.x * S, p1.y * S);
    a.stroke();
    a.restore();
  }

  // ------------------------------------------------------------------ world strokes

  /**
   * Closed loop: raise a terraced hill. Loops inside hills stack (additive height).
   * `scale` is the brush size: lower or taller terraces.
   */
  raiseHill(points, biome, scale = 1) {
    const ring = smoothPath(points, 2, true);
    // Simplex micro-variation along the rim so terraces look sculpted, not lathe-turned.
    const seed = this.rand() * 100;
    const sculpted = this._offset([...ring, ring[0]], (t) => this.noise2D(t * 9, seed) * 0.007 + this.noise2D(t * 31, seed + 7) * 0.003);
    sculpted.pop();
    const H = this.H;
    const hp = this._path(sculpted, H, true);
    const step = Math.round(34 * scale); // ~0.13 of the 0..1 height range per terrace at scale 1
    this._soft(this.height, hp, { color: `rgb(${step},${step},${step})`, blur: H * 0.028, op: 'lighter' });
    this._soft(this.mask, hp, { color: 'rgb(255,0,0)', blur: H * 0.01, op: 'lighter' });

    const ap = this._path(ring, this.A, true);
    this._wash(ap, biome.hillWash, 0.32, { edge: 0.4, edgeWidth: 4 });
    // Hatching on the shadow side of the terrace (lower-right), clipped to a band inside the ring.
    this._hatch(ring, biome);
    this._ink([...ring, ring[0]], { color: biome.ink, width: 2.8, closed: true });
    return { area: this._area(ring) };
  }

  _hatch(ring, biome) {
    const a = this.albedo;
    const S = this.A;
    const path = this._path(ring, S, true);
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    cx /= ring.length;
    cy /= ring.length;
    a.save();
    a.clip(path);
    a.strokeStyle = rgba(biome.hillEdge, 0.35);
    a.lineWidth = 1.1;
    a.lineCap = 'round';
    for (let i = 0; i < ring.length; i += 4) {
      const p = ring[i];
      const dx = p.x - cx;
      const dy = p.y - cy;
      const l = Math.hypot(dx, dy) || 1;
      if ((dx + dy) / l < 0.35) continue; // only the side facing away from the light
      const len = 0.008 + this.rand() * 0.01;
      a.beginPath();
      a.moveTo(p.x * S, p.y * S);
      a.lineTo((p.x - (dx / l) * len) * S, (p.y - (dy / l) * len) * S);
      a.stroke();
    }
    a.restore();
  }

  _area(pts) {
    let s = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    return Math.abs(s * 0.5);
  }

  /**
   * Angular closed loop: a rocky mountain. Rings of the outline shrink toward a peak (each ring
   * jittered so the slopes break into crags), ridges run from every corner to the summit, and
   * the page gets rock wash, hachures down the slopes and a snow cap. `scale` = brush size.
   */
  raiseMountain(polygon, biome, scale = 1) {
    const H = this.H;
    const S = this.A;
    // Densify the outline and roughen it so the foot of the mountain is craggy, not straight.
    const base = [];
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const steps = Math.max(2, Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y) / 0.012));
      for (let k = 0; k < steps; k++) base.push({ x: p0.x + ((p1.x - p0.x) * k) / steps, y: p0.y + ((p1.y - p0.y) * k) / steps });
    }
    let cx = 0;
    let cy = 0;
    for (const p of polygon) {
      cx += p.x;
      cy += p.y;
    }
    cx /= polygon.length;
    cy /= polygon.length;
    const seed = this.rand() * 100;
    const ring = (s, rough) =>
      base.map((p, i) => {
        const t = i / base.length;
        const n = this.noise2D(t * 11, seed + s * 7) * rough + this.noise2D(t * 29, seed + s * 13) * rough * 0.4;
        const k = s * (1 + n);
        return { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k };
      });

    // Height: foothill pad, then stacked shrinking rings (additive) for a tall rocky peak.
    const RINGS = 9;
    const step = Math.max(6, Math.round(11 * scale));
    this._soft(this.height, this._path(ring(1, 0.06), H, true), { color: 'rgb(16,16,16)', blur: H * 0.008, op: 'lighter' });
    for (let i = 1; i <= RINGS; i++) {
      const s = 1 - i / (RINGS + 0.8);
      this._soft(this.height, this._path(ring(s, 0.14), H, true), { color: `rgb(${step},${step},${step})`, blur: H * 0.005, op: 'lighter' });
    }
    // Ridges from each corner up to the summit.
    for (const p of polygon) {
      const ridge = new Path2D();
      ridge.moveTo(p.x * H, p.y * H);
      ridge.lineTo((cx + (p.x - cx) * 0.45) * H, (cy + (p.y - cy) * 0.45) * H);
      ridge.lineTo(cx * H, cy * H);
      this._soft(this.height, ridge, { color: `rgb(${step},${step},${step})`, blur: H * 0.004, stroke: H * 0.01, op: 'lighter' });
    }
    this._soft(this.mask, this._path(ring(1, 0.06), H, true), { color: 'rgb(0,255,0)', blur: H * 0.004, op: 'lighter' });

    // Page: rock wash, hachures down the slopes, ridge lines, snow cap and a craggy ink outline.
    const foot = ring(1, 0.06);
    this._wash(this._path(foot, S, true), biome.rock, 0.42, { edge: 0.55, edgeWidth: 2.5, layers: 3, granulate: 0.6 });
    for (let i = 0; i < foot.length; i += 2) {
      const p = foot[i];
      const reach = 0.3 + this.rand() * 0.25;
      this._ink(
        [
          { x: p.x, y: p.y },
          { x: p.x + (cx - p.x) * reach, y: p.y + (cy - p.y) * reach },
        ],
        { color: biome.ink, width: 1, alpha: 0.32, bristle: false },
      );
    }
    for (const p of polygon) {
      this._ink(
        [
          { x: p.x, y: p.y },
          { x: cx + (p.x - cx) * 0.45 + (this.rand() - 0.5) * 0.006, y: cy + (p.y - cy) * 0.45 + (this.rand() - 0.5) * 0.006 },
          { x: cx, y: cy },
        ],
        { color: biome.ink, width: 1.8, alpha: 0.8 },
      );
    }
    const cap = ring(0.34, 0.22);
    const capPath = this._path(cap, S, true);
    const a = this.albedo;
    a.save();
    a.fillStyle = rgba(biome.snow, 0.92);
    a.fill(capPath);
    a.restore();
    this._ink([...cap, cap[0]], { color: biome.ink, width: 1.2, closed: true, alpha: 0.6 });
    this._ink([...foot, foot[0]], { color: biome.ink, width: 2.6, closed: true });
    return { area: this._area(polygon) };
  }

  /** Open stroke: carve a river channel, paint banks and record flow direction. `scale` = width. */
  carveRiver(points, biome, scale = 1) {
    const path = smoothPath(points, 2, false);
    const H = this.H;
    const S = this.A;
    const w = scale;
    const hp = this._path(path, H, false);
    // Banks (0.40) then a deeper core (0.29). source-over carves through hills as a gorge.
    this._soft(this.height, hp, { color: 'rgb(102,102,102)', blur: H * 0.012, stroke: H * 0.034 * w });
    this._soft(this.height, hp, { color: 'rgb(74,74,74)', blur: H * 0.008, stroke: H * 0.016 * w });
    this._soft(this.mask, hp, { color: 'rgb(0,0,255)', blur: H * 0.008, stroke: H * 0.03 * w, op: 'lighter' });

    // Flow direction (RG) along the path.
    const f = this.flow;
    const F = this.F;
    f.save();
    f.lineCap = 'round';
    f.lineWidth = F * 0.05 * w;
    for (let i = 1; i < path.length; i++) {
      const p0 = path[i - 1];
      const p1 = path[i];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const l = Math.hypot(dx, dy) || 1;
      // Encode flow in texture space: +x right, +y up the page (v grows upward in the shader).
      const r = Math.round(128 + (dx / l) * 127);
      const g = Math.round(128 - (dy / l) * 127);
      f.strokeStyle = `rgb(${r},${g},0)`;
      f.beginPath();
      f.moveTo(p0.x * F, p0.y * F);
      f.lineTo(p1.x * F, p1.y * F);
      f.stroke();
    }
    f.restore();

    // Watercolor: wide soft bank wash, then the water wash, then inked banks.
    const a = this.albedo;
    const ap = this._path(path, S, false);
    a.save();
    a.globalCompositeOperation = 'multiply';
    a.lineCap = 'round';
    a.lineJoin = 'round';
    a.strokeStyle = rgba(biome.bankWash, 0.3);
    a.lineWidth = S * 0.06 * w;
    a.stroke(ap);
    a.strokeStyle = rgba(biome.waterInk, 0.42);
    a.lineWidth = S * 0.032 * w;
    a.stroke(ap);
    a.strokeStyle = rgba(biome.waterDeep, 0.25);
    a.lineWidth = S * 0.012 * w;
    a.stroke(ap);
    a.restore();

    const half = (t) => 0.0165 * w * (0.85 + 0.3 * t);
    this._ink(this._offset(path, half), { color: biome.ink, width: 2.1 });
    this._ink(this._offset(path, (t) => -half(t)), { color: biome.ink, width: 2.1 });
    // Little current marks.
    for (let i = 4; i < path.length - 4; i += 9) {
      const seg = path.slice(i, i + 3);
      this._ink(this._offset(seg, (this.rand() - 0.5) * 0.012), {
        color: biome.ink,
        width: 1.1,
        alpha: 0.45,
        bristle: false,
      });
    }
    return { path };
  }

  /**
   * Eraser: rub the page back to bare paper along a stroke (or a dot for a tap): height to paper
   * level, masks and flow cleared, and the clean parchment restored under a soft edge.
   * `radius` is in page UV.
   */
  erase(points, radius = 0.05) {
    const H = this.H;
    const S = this.A;
    const F = this.F;
    const pts = points.length > 1 ? smoothPath(points, 2, false) : [points[0], { x: points[0].x + 1e-4, y: points[0].y }];
    const hp = this._path(pts, H, false);
    const width = radius * 2;
    this._soft(this.height, hp, { color: `rgb(${HEIGHT_BASE},${HEIGHT_BASE},${HEIGHT_BASE})`, blur: H * 0.01, stroke: H * width });
    this._soft(this.mask, hp, { color: '#000', blur: H * 0.006, stroke: H * width });
    this._soft(this.flow, this._path(pts, F, false), { color: 'rgb(128,128,0)', blur: F * 0.006, stroke: F * width });
    // Paper: a soft-edged brush shape on a scratch canvas, filled with the clean parchment.
    if (!this._scratch) this._scratch = makeCanvas(S);
    const { ctx: t } = this._scratch;
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, S, S);
    this._soft(t, this._path(pts, S, false), { color: '#000', blur: S * 0.012, stroke: S * width * 0.92 });
    t.globalCompositeOperation = 'source-in';
    t.drawImage(this.paperBase, 0, 0);
    t.globalCompositeOperation = 'source-over';
    this.albedo.drawImage(this._scratch.canvas, 0, 0);
    return { path: pts };
  }

  /** Closed loop: a still lake. The basin sinks below the water table, with an inked shore. */
  carveLake(points, biome, scale = 1) {
    const ring = smoothPath(points, 2, true);
    const H = this.H;
    const S = this.A;
    const hp = this._path(ring, H, true);
    const depth = Math.round(Math.max(40, 74 - 18 * (scale - 1))); // lower = deeper
    this._soft(this.height, hp, { color: 'rgb(104,104,104)', blur: H * 0.012 });
    // A bowl: the deep fill is the shore shrunk toward its centre (whichever way it was drawn)
    // and blurred wide, so the bed shelves down from the bank.
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    cx /= ring.length;
    cy /= ring.length;
    const inner = ring.map((p) => ({ x: cx + (p.x - cx) * 0.6, y: cy + (p.y - cy) * 0.6 }));
    this._soft(this.height, this._path(inner, H, true), { color: `rgb(${depth},${depth},${depth})`, blur: H * 0.025 });
    this._soft(this.mask, hp, { color: 'rgb(0,0,255)', blur: H * 0.006 });
    this._soft(this.flow, this._path(ring, this.F, true), { color: 'rgb(128,128,0)', blur: 2 });
    const ap = this._path(ring, S, true);
    const a = this.albedo;
    a.save();
    a.globalCompositeOperation = 'multiply';
    a.fillStyle = rgba(biome.bankWash, 0.32);
    a.lineWidth = S * 0.02;
    a.strokeStyle = rgba(biome.bankWash, 0.3);
    a.stroke(ap);
    a.fillStyle = rgba(biome.waterInk, 0.42);
    a.fill(ap);
    a.restore();
    this._ink([...ring, ring[0]], { color: biome.ink, width: 2.2, closed: true });
    // A few ripple marks.
    for (let i = 0; i < 4; i++) {
      const c = ring[Math.floor(this.rand() * ring.length)];
      const t = 0.3 + this.rand() * 0.4;
      const x = cx + (c.x - cx) * t;
      const y = cy + (c.y - cy) * t;
      this._ink(
        [
          { x: x - 0.012, y },
          { x, y: y - 0.003 },
          { x: x + 0.012, y },
        ],
        { color: biome.ink, width: 1, alpha: 0.4, bristle: false },
      );
    }
    return { area: this._area(ring) };
  }

  /**
   * Open stroke: a road. Each stretch is levelled across its width to the ground height at its
   * centre (cut on the uphill side, fill on the downhill side), so it follows hills and bridges
   * rivers as a causeway. Painted as a dirt track with dashed ink edges.
   */
  paveRoad(points, biome, scale = 1) {
    const path = smoothPath(points, 3, false);
    const H = this.H;
    const S = this.A;
    const width = 0.022 * scale;
    // Sample centre heights first, so later stretches don't read already-levelled ground.
    const hs = path.map((p) => {
      const d = this.height.getImageData(Math.min(H - 1, Math.max(0, Math.floor(p.x * H))), Math.min(H - 1, Math.max(0, Math.floor(p.y * H))), 1, 1).data;
      return Math.max(d[0], 112); // never below the water table: roads cross rivers on causeways
    });
    for (let i = 1; i < path.length; i++) {
      const seg = new Path2D();
      seg.moveTo(path[i - 1].x * H, path[i - 1].y * H);
      seg.lineTo(path[i].x * H, path[i].y * H);
      const h = Math.round((hs[i - 1] + hs[i]) / 2);
      this._soft(this.height, seg, { color: `rgb(${h},${h},${h})`, blur: H * 0.004, stroke: H * width });
      this._soft(this.mask, seg, { color: '#000', blur: H * 0.002, stroke: H * width * 0.9 });
    }
    const ap = this._path(path, S, false);
    const a = this.albedo;
    a.save();
    a.lineCap = 'round';
    a.lineJoin = 'round';
    a.strokeStyle = rgba(biome.road, 0.85);
    a.lineWidth = S * width * 0.95;
    a.stroke(ap);
    a.globalCompositeOperation = 'multiply';
    a.strokeStyle = rgba(biome.road, 0.35);
    a.lineWidth = S * width * 0.45;
    a.setLineDash([S * 0.006, S * 0.01]);
    a.stroke(ap);
    a.restore();
    const half = width * 0.5;
    this._ink(this._offset(path, half), { color: biome.ink, width: 1.2, alpha: 0.7, bristle: false });
    this._ink(this._offset(path, -half), { color: biome.ink, width: 1.2, alpha: 0.7, bristle: false });
    return { path };
  }

  /**
   * Sculpt along a stroke (or a dab for a tap): 'raise' and 'lower' nudge the ground up or down
   * a little each pass, 'flatten' levels it to the height where the stroke started.
   */
  sculpt(points, mode, scale = 1) {
    const H = this.H;
    const pts = points.length > 1 ? smoothPath(points, 2, false) : [points[0], { x: points[0].x + 1e-4, y: points[0].y }];
    const hp = this._path(pts, H, false);
    const width = H * 0.05 * scale;
    if (mode === 'flatten') {
      const p = pts[0];
      const d = this.height.getImageData(Math.min(H - 1, Math.max(0, Math.floor(p.x * H))), Math.min(H - 1, Math.max(0, Math.floor(p.y * H))), 1, 1).data;
      this._soft(this.height, hp, { color: `rgb(${d[0]},${d[0]},${d[0]})`, blur: H * 0.012, stroke: width });
    } else {
      const amt = Math.round(9 * Math.sqrt(scale));
      // 'difference' subtracts (|h - amt|), which is h - amt everywhere above the riverbeds.
      this._soft(this.height, hp, { color: `rgb(${amt},${amt},${amt})`, blur: H * 0.016, stroke: width, op: mode === 'lower' ? 'difference' : 'lighter' });
    }
    return { path: pts };
  }

  /** Small ink grass tufts / ground marks under planted sprites. */
  plantMarks(spots, biome) {
    const a = this.albedo;
    const S = this.A;
    a.save();
    a.strokeStyle = rgba(biome.tuft, 0.7);
    a.lineCap = 'round';
    a.lineWidth = 1.2;
    for (const p of spots) {
      a.fillStyle = rgba(biome.ink, 0.12);
      a.beginPath();
      a.ellipse(p.x * S, p.y * S, 6, 3, 0, 0, Math.PI * 2);
      a.fill();
      for (let k = 0; k < 3; k++) {
        const ox = (this.rand() - 0.5) * 10;
        a.beginPath();
        a.moveTo(p.x * S + ox, p.y * S + 2);
        a.lineTo(p.x * S + ox + (this.rand() - 0.5) * 4, p.y * S - 4 - this.rand() * 4);
        a.stroke();
      }
    }
    a.restore();
  }

  // ------------------------------------------------------------------ paper

  _makeGranulation() {
    const { canvas, ctx } = makeCanvas(128);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 900; i++) {
      const g = 150 + Math.floor(this.rand() * 90);
      ctx.fillStyle = `rgba(${g},${g},${g},${0.3 + this.rand() * 0.5})`;
      ctx.beginPath();
      ctx.arc(this.rand() * 128, this.rand() * 128, 0.4 + this.rand() * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    return canvas;
  }

  _paintPaper(ctx) {
    const S = this.A;
    const L = 512; // mottling resolution, upscaled
    const { canvas: low, ctx: lc } = makeCanvas(L);
    const img = lc.createImageData(L, L);
    const d = img.data;
    const n = this.noise2D;
    const base = [241, 228, 198];
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < L; x++) {
        const u = x / L;
        const v = y / L;
        const m =
          n(u * 3, v * 3) * 0.5 + n(u * 9 + 11, v * 9 - 3) * 0.3 + n(u * 31 - 7, v * 31 + 5) * 0.2; // -1..1
        const stain = Math.max(0, n(u * 2.2 + 40, v * 2.2 - 13) - 0.55) * 0.18;
        // Deckled edge: distance to the nearest edge, wobbled by noise along the edge.
        const e = Math.min(u, 1 - u, v, 1 - v);
        const along = u < 0.5 === v < 0.5 ? u + v : u - v;
        const wob = (n(along * 22, e * 3) * 0.5 + 0.5) * 0.012 + (n(along * 90, 4) * 0.5 + 0.5) * 0.004;
        const edge = e - wob;
        const burn = edge < 0.006 ? 0.55 : edge < 0.05 ? (1 - edge / 0.05) ** 2 * 0.22 : 0;
        const lum = 1 - 0.045 * m - stain * 0.5;
        // Stains and the scorched deckle edge blend toward sepia, not toward grey-olive.
        const k = Math.min(1, stain * 2.2 + burn * 2.4);
        const i = (y * L + x) * 4;
        d[i] = (base[0] * (1 - k) + 128 * k) * lum;
        d[i + 1] = (base[1] * (1 - k) + 84 * k) * lum;
        d[i + 2] = (base[2] * (1 - k) + 46 * k) * lum;
        d[i + 3] = 255;
      }
    }
    lc.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(low, 0, 0, S, S);

    // Paper fibers.
    ctx.lineCap = 'round';
    for (let i = 0; i < 2600; i++) {
      const x = this.rand() * S;
      const y = this.rand() * S;
      const len = 4 + this.rand() * 14;
      const ang = this.rand() * Math.PI * 2;
      const dark = this.rand() < 0.55;
      ctx.strokeStyle = dark ? `rgba(120,95,60,${0.04 + this.rand() * 0.05})` : `rgba(255,250,235,${0.08 + this.rand() * 0.1})`;
      ctx.lineWidth = 0.5 + this.rand() * 0.7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(
        x + Math.cos(ang + 0.5) * len * 0.5,
        y + Math.sin(ang + 0.5) * len * 0.5,
        x + Math.cos(ang) * len,
        y + Math.sin(ang) * len,
      );
      ctx.stroke();
    }

    // Illuminated-manuscript double frame, faint sepia.
    const frame = (inset, w, a) => {
      ctx.strokeStyle = `rgba(110,70,40,${a})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      const steps = 120;
      const pts = [];
      for (let s = 0; s < 4; s++) {
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          let u;
          let v;
          if (s === 0) [u, v] = [inset + t * (1 - 2 * inset), inset];
          else if (s === 1) [u, v] = [1 - inset, inset + t * (1 - 2 * inset)];
          else if (s === 2) [u, v] = [1 - inset - t * (1 - 2 * inset), 1 - inset];
          else [u, v] = [inset, 1 - inset - t * (1 - 2 * inset)];
          const j = n(u * 40 + s, v * 40) * 0.0012;
          pts.push([(u + j) * S, (v + j) * S]);
        }
      }
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      ctx.stroke();
    };
    frame(0.045, 2.2, 0.38);
    frame(0.055, 0.9, 0.3);
    // Corner rosettes.
    for (const [u, v] of [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ]) {
      ctx.fillStyle = 'rgba(160,50,35,0.55)';
      ctx.beginPath();
      ctx.arc(u * S, v * S, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(110,70,40,0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(u * S, v * S, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
