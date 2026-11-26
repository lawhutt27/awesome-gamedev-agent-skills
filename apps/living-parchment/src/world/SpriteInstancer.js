// 2D-HD paper-cutout flora and props.
//
// Sprites are drawn procedurally into a color atlas (4 types x 3 biomes) and a matching glow
// atlas, then rendered as one InstancedMesh of upright cards. The vertex shader does Y-axis
// cylindrical billboarding toward the main camera, wind sway, the spring pop-in, the card
// flip used when the biome changes, and glues each card to the displaced terrain by reading
// the same height textures as the terrain. A customDepthMaterial runs the identical vertex
// code with alphaTest so every cutout casts a crisp shadow.
//
// FlowParticles (bottom of the file) animates small ink-wash glints along river splines.

import * as THREE from 'three';
import { BIOMES, BIOME_ORDER, SPRITE_TYPES } from './BiomeConfig.js';
import { HEIGHT_GLSL, PAGE_SIZE, WATER_Y } from '../terrain/TerrainShader.js';
import { mulberry32 } from '../terrain/ParchmentCanvas.js';

const CELL = 256;
const COLS = SPRITE_TYPES.length;
const ROWS = BIOME_ORDER.length;
export const MAX_SPRITES = 1500;

/** World height of each sprite type's card (cards are square). */
export const SPRITE_SIZE = [1.5, 0.78, 0.85, 0.95];

// ------------------------------------------------------------------ atlas drawing

function wobblyBlob(cx, cy, r, rand, lumps = 9, amount = 0.14) {
  const p = new Path2D();
  const n = 36;
  const ph = rand() * 10;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + amount * Math.sin(a * lumps * 0.5 + ph) * 0.6 + amount * (rand() - 0.5) * 0.5);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function poly(points) {
  const p = new Path2D();
  points.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/** Parts: { path, fill, ink = 2.6, detail?(ctx) } drawn border -> watercolor -> ink. */
function drawCutout(ctx, parts, rand, ink) {
  // 1. thin white paper-cutout border around the union of all parts
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#fbf6ea';
  ctx.fillStyle = '#fbf6ea';
  ctx.lineWidth = 14;
  for (const p of parts) {
    ctx.stroke(p.path);
    ctx.fill(p.path);
  }
  ctx.restore();
  // 2. watercolor fills with blotchy variation and a darker pooled edge
  for (const p of parts) {
    ctx.save();
    ctx.fillStyle = p.fill;
    ctx.fill(p.path);
    ctx.clip(p.path);
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,240,0.12)' : 'rgba(40,25,10,0.1)';
      ctx.beginPath();
      ctx.arc(rand() * CELL, rand() * CELL, 8 + rand() * 26, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(30,20,10,0.25)';
    ctx.lineWidth = 6;
    ctx.stroke(p.path);
    ctx.restore();
  }
  // 3. crisp Sumi ink outline + details
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  for (const p of parts) {
    if (p.ink === 0) continue;
    ctx.lineWidth = p.ink ?? 2.8;
    ctx.stroke(p.path);
  }
  for (const p of parts) p.detail?.(ctx);
  ctx.restore();
}

function drawTree(ctx, b, rand) {
  const s = b.sprites;
  const parts = [];
  const trunk = poly([
    [122, 252],
    [121, 170],
    [112, 150],
    [126, 158],
    [128, 128],
    [134, 160],
    [146, 146],
    [137, 172],
    [136, 252],
  ]);
  parts.push({ path: trunk, fill: s.trunk, ink: 2.4 });
  if (b.id === 'moonlitTide') {
    // layered pine tiers
    const tiers = [
      [150, 92, 200],
      [112, 74, 160],
      [76, 56, 118],
      [44, 38, 80],
    ];
    tiers.forEach(([y, hw, base], i) => {
      const j = () => (rand() - 0.5) * 6;
      parts.push({
        path: poly([
          [128 + j(), y - 46],
          [128 + hw + j(), base + j()],
          [128 + hw * 0.4, base - 8],
          [128, base + 4],
          [128 - hw * 0.4, base - 8],
          [128 - hw + j(), base + j()],
        ]),
        fill: s.canopy[i % s.canopy.length],
      });
    });
  } else {
    const blobs = [
      [128, 92, 62],
      [84, 122, 42],
      [172, 120, 44],
      [104, 62, 38],
      [156, 64, 36],
    ];
    blobs.forEach(([x, y, r], i) => {
      parts.push({
        path: wobblyBlob(x, y, r, rand, 7 + i, 0.16),
        fill: s.canopy[i % s.canopy.length],
        detail: (c) => {
          c.strokeStyle = 'rgba(20,15,8,0.5)';
          c.lineWidth = 1.4;
          for (let k = 0; k < 3; k++) {
            const a = rand() * Math.PI * 2;
            const rr = r * (0.3 + rand() * 0.4);
            c.beginPath();
            c.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 6 + rand() * 6, Math.PI * 1.1, Math.PI * 1.8);
            c.stroke();
          }
        },
      });
    });
  }
  drawCutout(ctx, parts, rand, b.ink);
}

function drawReeds(ctx, b, rand) {
  const s = b.sprites;
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const x0 = 70 + i * 22 + (rand() - 0.5) * 8;
    const lean = (rand() - 0.5) * 50;
    const top = 40 + rand() * 60;
    const w = 5 + rand() * 3;
    const p = new Path2D();
    p.moveTo(x0 - w, 254);
    p.quadraticCurveTo(x0 + lean * 0.3 - w, (254 + top) / 2, x0 + lean, top);
    p.quadraticCurveTo(x0 + lean * 0.3 + w, (254 + top) / 2, x0 + w, 254);
    p.closePath();
    parts.push({ path: p, fill: s.reed, ink: 1.8 });
    if (i % 2 === 0) {
      const hx = x0 + lean * 0.82;
      const hy = top + 26;
      const head = new Path2D();
      head.ellipse(hx, hy, 7, 20, Math.atan2(lean, 214) * 0.8, 0, Math.PI * 2);
      parts.push({ path: head, fill: s.reedHead, ink: 1.8 });
    }
  }
  drawCutout(ctx, parts, rand, b.ink);
}

function drawStone(ctx, b, rand) {
  const s = b.sprites;
  const j = () => (rand() - 0.5) * 10;
  const stone = poly([
    [86 + j(), 252],
    [80 + j(), 150],
    [92 + j(), 70],
    [122 + j(), 30],
    [154 + j(), 44],
    [172 + j(), 110],
    [176 + j(), 252],
  ]);
  const moss = wobblyBlob(110, 212, 34, rand, 6, 0.3);
  const parts = [
    {
      path: stone,
      fill: s.stone,
      detail: (c) => {
        c.strokeStyle = 'rgba(20,15,10,0.55)';
        c.lineWidth = 1.5;
        // cracks + carved spiral rune
        c.beginPath();
        c.moveTo(150, 60);
        c.lineTo(140, 96);
        c.lineTo(148, 120);
        c.stroke();
        c.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
          const r = 2 + a * 2.2;
          const x = 124 + Math.cos(a) * r;
          const y = 150 + Math.sin(a) * r;
          if (a === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
        // hatching on the shadow side
        for (let y = 80; y < 240; y += 7) {
          c.beginPath();
          c.moveTo(160, y);
          c.lineTo(170, y - 6);
          c.stroke();
        }
      },
    },
    { path: moss, fill: s.moss, ink: 1.6 },
  ];
  drawCutout(ctx, parts, rand, b.ink);
}

function drawLantern(ctx, glow, b, rand) {
  const s = b.sprites;
  // Stone toro: base, post, firebox, roof, finial.
  const parts = [
    { path: poly([[92, 254], [96, 232], [160, 232], [164, 254]]), fill: s.lanternBody },
    { path: poly([[112, 232], [114, 150], [142, 150], [144, 232]]), fill: s.lanternBody },
    { path: poly([[96, 150], [100, 140], [156, 140], [160, 150]]), fill: s.lanternBody },
    {
      path: poly([[102, 140], [102, 92], [154, 92], [154, 140]]),
      fill: s.lanternBody,
      detail: (c) => {
        c.fillStyle = s.lanternGlow;
        c.fillRect(112, 100, 32, 32);
        c.strokeStyle = b.ink;
        c.lineWidth = 2;
        c.strokeRect(112, 100, 32, 32);
        c.beginPath();
        c.moveTo(128, 100);
        c.lineTo(128, 132);
        c.stroke();
      },
    },
    { path: poly([[70, 94], [100, 70], [128, 58], [156, 70], [186, 94], [160, 90], [96, 90]]), fill: shade(s.lanternBody, 0.8) },
    { path: wobblyBlob(128, 50, 11, rand, 5, 0.1), fill: shade(s.lanternBody, 0.85) },
  ];
  drawCutout(ctx, parts, rand, b.ink);
  // Glow atlas: the window plus a soft halo.
  const g = glow.createRadialGradient(128, 116, 4, 128, 116, 46);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.35, 'rgba(255,210,140,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  glow.fillStyle = g;
  glow.fillRect(78, 66, 100, 100);
  glow.fillStyle = '#fff4d0';
  glow.fillRect(112, 100, 32, 32);
}

/** Build the color + glow atlases. Rows = biomes (BIOME_ORDER), columns = sprite types. */
export function buildAtlases(seed = 11) {
  const color = document.createElement('canvas');
  color.width = CELL * COLS;
  color.height = CELL * ROWS;
  const glow = document.createElement('canvas');
  glow.width = color.width;
  glow.height = color.height;
  const c = color.getContext('2d');
  const g = glow.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, glow.width, glow.height);
  BIOME_ORDER.forEach((id, row) => {
    const b = BIOMES[id];
    for (let col = 0; col < COLS; col++) {
      const rand = mulberry32(seed + row * 31 + col * 7);
      c.save();
      g.save();
      c.translate(col * CELL, row * CELL);
      g.translate(col * CELL, row * CELL);
      c.beginPath();
      c.rect(0, 0, CELL, CELL);
      c.clip();
      if (col === 0) drawTree(c, b, rand);
      else if (col === 1) drawReeds(c, b, rand);
      else if (col === 2) drawStone(c, b, rand);
      else drawLantern(c, g, b, rand);
      c.restore();
      g.restore();
    }
  });
  return { color, glow };
}

// ------------------------------------------------------------------ instanced cards

const SPRITE_VERTEX_COMMON = /* glsl */ `
${HEIGHT_GLSL}
attribute vec4 aSprite; // type, scale, spawn time, phase
uniform vec3 uCamPos;
uniform float uBiomeRow;
uniform float uFlip;
uniform float uTime;
vec2 lpFace() {
  vec2 d = uCamPos.xz - vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  float a = atan(d.x, d.y);
  return vec2(cos(a), sin(a));
}
vec3 lpRotY(vec3 p, vec2 cs) {
  return vec3(p.x * cs.x + p.z * cs.y, p.y, -p.x * cs.y + p.z * cs.x);
}
`;

const SPRITE_UV = /* glsl */ `
#include <uv_vertex>
{
  vec2 lpCell = vec2((aSprite.x + uv.x) / ${COLS.toFixed(1)}, (${(ROWS - 1).toFixed(1)} - uBiomeRow + uv.y) / ${ROWS.toFixed(1)});
  #ifdef USE_MAP
    vMapUv = lpCell;
  #endif
  #ifdef USE_EMISSIVEMAP
    vEmissiveMapUv = lpCell;
  #endif
}
`;

const SPRITE_BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
{
  float lpType = aSprite.x;
  float lpAge = max(uTime - aSprite.z, 0.0);
  float lpPop = 1.0 - exp(-6.5 * lpAge) * cos(12.0 * lpAge);
  float lpSway = lpType < 0.5 ? 0.07 : (lpType < 1.5 ? 0.13 : (lpType > 2.5 ? 0.02 : 0.0));
  float lpW = sin(uTime * 1.6 + aSprite.w) + 0.35 * sin(uTime * 3.7 + aSprite.w * 1.7);
  transformed.x += lpW * lpSway * position.y * position.y;
  transformed.x *= uFlip;
  transformed *= aSprite.y * lpPop;
  transformed = lpRotY(transformed, lpFace());
  vec2 lpUv = vec2(instanceMatrix[3].x / ${PAGE_SIZE.toFixed(1)} + 0.5, 0.5 - instanceMatrix[3].z / ${PAGE_SIZE.toFixed(1)});
  transformed.y += lpWorldY(lpUv) - 0.03 * aSprite.y;
}
`;

function patchSpriteShader(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${SPRITE_VERTEX_COMMON}`)
    .replace('#include <uv_vertex>', SPRITE_UV)
    .replace('#include <begin_vertex>', SPRITE_BEGIN);
}

export class SpriteInstancer {
  constructor(sharedUniforms, { anisotropy = 4 } = {}) {
    const atlases = buildAtlases();
    this.atlasCanvas = atlases.color;
    this.colorTex = new THREE.CanvasTexture(atlases.color);
    this.colorTex.colorSpace = THREE.SRGBColorSpace;
    this.colorTex.anisotropy = anisotropy;
    this.glowTex = new THREE.CanvasTexture(atlases.glow);
    this.glowTex.colorSpace = THREE.SRGBColorSpace;

    this.uniforms = {
      uHeightFrom: sharedUniforms.uHeightFrom,
      uHeightTo: sharedUniforms.uHeightTo,
      uMix: sharedUniforms.uMix,
      uNoise: sharedUniforms.uNoise,
      uTime: sharedUniforms.uTime,
      uCamPos: { value: new THREE.Vector3() },
      uBiomeRow: { value: 0 },
      uFlip: { value: 1 },
    };

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    this.spriteAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRITES * 4), 4);
    this.spriteAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSprite', this.spriteAttr);

    this.material = new THREE.MeshLambertMaterial({
      map: this.colorTex,
      emissiveMap: this.glowTex,
      emissive: new THREE.Color(1, 0.85, 0.6),
      emissiveIntensity: 0.35,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (s) => patchSpriteShader(s, this.uniforms);
    this.material.customProgramCacheKey = () => 'lp-sprite';

    this.depthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.colorTex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    this.depthMaterial.onBeforeCompile = (s) => patchSpriteShader(s, this.uniforms);
    this.depthMaterial.customProgramCacheKey = () => 'lp-sprite-depth';

    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX_SPRITES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // positions come from the shader
    this.mesh.count = 0;
    this.mesh.name = 'sprites';

    /** Plain-object state: {x, z, type, scale, phase, spawn}. The mesh is a view of this. */
    this.items = [];
    this._m = new THREE.Matrix4();
    this._flip = null; // biome flip animation
  }

  get count() {
    return this.items.length;
  }

  add(item) {
    if (this.items.length >= MAX_SPRITES) return false;
    this.items.push(item);
    this._write(this.items.length - 1);
    this.mesh.count = this.items.length;
    return true;
  }

  /** Remove sprites so only the first `n` remain (undo). */
  truncate(n) {
    this.items.length = Math.min(this.items.length, n);
    this.mesh.count = this.items.length;
  }

  /** Replace all sprites (undoing a Clear Page). Sprites restored this way skip the pop. */
  setAll(items) {
    this.items = items.slice(0, MAX_SPRITES);
    for (let i = 0; i < this.items.length; i++) this._write(i);
    this.mesh.count = this.items.length;
  }

  _write(i) {
    const it = this.items[i];
    this._m.makeTranslation(it.x, 0, it.z);
    this.mesh.setMatrixAt(i, this._m);
    const a = this.spriteAttr.array;
    a[i * 4] = it.type;
    a[i * 4 + 1] = it.scale;
    a[i * 4 + 2] = it.spawn;
    a[i * 4 + 3] = it.phase;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.spriteAttr.needsUpdate = true;
  }

  /** Start the paper-card flip that swaps sprite art to another biome row. */
  flipTo(row, glow) {
    this._flip = { t: 0, row, glow, from: this.material.emissiveIntensity };
  }

  setBiomeImmediate(row, glow) {
    this.uniforms.uBiomeRow.value = row;
    this.material.emissiveIntensity = glow;
  }

  update(dt, camera) {
    this.uniforms.uCamPos.value.copy(camera.position);
    const f = this._flip;
    if (f) {
      f.t = Math.min(1, f.t + dt / 0.55);
      if (f.t >= 0.5 && this.uniforms.uBiomeRow.value !== f.row) this.uniforms.uBiomeRow.value = f.row;
      this.uniforms.uFlip.value = Math.max(0.02, Math.abs(Math.cos(Math.PI * f.t)));
      this.material.emissiveIntensity = f.from + (f.glow - f.from) * f.t;
      if (f.t >= 1) {
        this.uniforms.uFlip.value = 1;
        this._flip = null;
      }
    }
  }
}

// ------------------------------------------------------------------ river flow particles

export const MAX_FLOW = 700;

export class FlowParticles {
  constructor() {
    this.positions = new Float32Array(MAX_FLOW * 3);
    this.alphas = new Float32Array(MAX_FLOW);
    this.river = new Int16Array(MAX_FLOW).fill(-1);
    this.s = new Float32Array(MAX_FLOW);
    this.speed = new Float32Array(MAX_FLOW);
    this.lateral = new Float32Array(MAX_FLOW);
    this.rivers = []; // {xs, zs, cum, total, first, count}
    this.used = 0;
    this.rand = mulberry32(99);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setDrawRange(0, 0);
    this.uniforms = {
      uColor: { value: new THREE.Color('#d9efe6') },
      uSize: { value: 55 },
      uPixelRatio: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio / max(-mv.z, 0.1);
          vAlpha = aAlpha;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p * vec2(1.0, 2.2));
          float a = smoothstep(0.5, 0.15, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a * 0.75);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.name = 'flow';
  }

  get riverCount() {
    return this.rivers.length;
  }

  /** Add a river from a UV polyline (page v down). Particles flow in drawing order. */
  addRiver(uvPath) {
    const n = uvPath.length;
    if (n < 2) return;
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    const cum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (uvPath[i].x - 0.5) * PAGE_SIZE;
      zs[i] = (uvPath[i].y - 0.5) * PAGE_SIZE;
      if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    }
    const total = cum[n - 1];
    const want = Math.min(MAX_FLOW - this.used, Math.max(6, Math.round(total * 9)));
    const r = { xs, zs, cum, total, first: this.used, count: want };
    const idx = this.rivers.length;
    this.rivers.push(r);
    for (let k = 0; k < want; k++) {
      const i = this.used + k;
      this.river[i] = idx;
      this.s[i] = this.rand() * total;
      this.speed[i] = 0.35 + this.rand() * 0.35;
      this.lateral[i] = (this.rand() - 0.5) * 0.18;
    }
    this.used += want;
    this.points.geometry.setDrawRange(0, this.used);
  }

  truncate(riverCount) {
    while (this.rivers.length > riverCount) {
      const r = this.rivers.pop();
      this.used = r.first;
    }
    this.points.geometry.setDrawRange(0, this.used);
  }

  setRivers(list) {
    this.truncate(0);
    for (const r of list) this.addRiver(r);
  }

  update(dt) {
    if (this.used === 0) return;
    const pos = this.positions;
    const y = WATER_Y + 0.015;
    for (let i = 0; i < this.used; i++) {
      const r = this.rivers[this.river[i]];
      let s = this.s[i] + this.speed[i] * dt;
      if (s > r.total) s -= r.total;
      this.s[i] = s;
      // binary search the segment
      let lo = 0;
      let hi = r.cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (r.cum[mid] < s) lo = mid;
        else hi = mid;
      }
      const seg = r.cum[hi] - r.cum[lo] || 1;
      const t = (s - r.cum[lo]) / seg;
      const dx = r.xs[hi] - r.xs[lo];
      const dz = r.zs[hi] - r.zs[lo];
      const l = Math.hypot(dx, dz) || 1;
      const lat = this.lateral[i];
      pos[i * 3] = r.xs[lo] + dx * t - (dz / l) * lat;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = r.zs[lo] + dz * t + (dx / l) * lat;
      this.alphas[i] = Math.sin((Math.PI * s) / r.total);
    }
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}
