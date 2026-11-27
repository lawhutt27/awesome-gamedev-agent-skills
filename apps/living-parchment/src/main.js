// Living Parchment World-Builder: scene, renderer, lighting, diorama rim and main loop.
//
// Phase 1: a mobile-locked page whose offscreen canvases displace a 160x160 terrain plane,
//          with pen-scratch foley while you draw.
// Phase 2: strokes are classified on release into terraced hills, rocky mountains, rivers or
//          planted paper-cutout flora, with three switchable biomes and a 10-step undo.
// Phase 3: the pinch "Dimensional Fold" from a flat map down to a walkable first-person view,
//          a screen-space ink-edge pass, projected cliff ink, .glb export and world links.
// Extras:  a tool rail (force hill / mountain / river / plant, erase, move the camera), an Options
//          panel (brush size, what to plant, camera presets, sun, display switches), redo,
//          random worlds, photos and a free desktop camera (orbit, tilt, pan, zoom).

import * as THREE from 'three';
import { createNoise2D, createNoise4D } from 'simplex-noise';
import { Gesture } from '@use-gesture/vanilla';

import { ParchmentCanvas, mulberry32 } from './terrain/ParchmentCanvas.js';
import {
  createSharedUniforms,
  createTerrainGeometry,
  createTerrainMaterial,
  createTerrainDepthMaterial,
  createRimGeometry,
  createRimMaterial,
  createRimDepthMaterial,
  heightToY,
  PAGE_SIZE,
  RIM_DEPTH,
  WATER_Y,
  WATER_H,
  HEIGHT_SCALE,
  createCliffInkTexture,
} from './terrain/TerrainShader.js';
import { GestureClassifier } from './input/GestureClassifier.js';
import { CameraRig, FOLD_DEFAULT, povWeight } from './input/CameraRig.js';
import { Thumbstick } from './input/Thumbstick.js';
import { InkEdgePass } from './render/InkEdgePass.js';
import { canonicalPoints, encodeWorld, decodeWorld, isWorldHash, simplify, BRUSH_SIZES } from './world/WorldSeed.js';
import { EXPORT_DEFAULTS, exportGLB, exportBundle, zipFiles, zipSingle, segmentsFor, spriteHeight } from './world/Exporter.js';
import { BIOMES, BIOME_ORDER, DEFAULT_BIOME, pickWeighted, terrainContext } from './world/BiomeConfig.js';
import { SpriteInstancer, FlowParticles, SPRITE_SIZE } from './world/SpriteInstancer.js';
import { PaperSynth } from './audio/PaperSynth.js';

const canvas = document.getElementById('scene');
const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
// ?quality=low trades sharpness for speed (software GPUs, CI, very old phones).
const lowQuality = new URLSearchParams(location.search).get('quality') === 'low';

// ------------------------------------------------------------------ options

// Options (kept per browser; none of them change what a shared link rebuilds except
// brush size and planting, which are stored with each stroke).
const OPTIONS_KEY = 'living-parchment-options';
const DEFAULT_OPTIONS = {
  tool: 'auto',
  sculpt: 'raise', // raise | lower | flatten (the Sculpt tool)
  size: 0, // BRUSH_SIZES code
  plant: 0, // 0 = by biome, else sprite type + 1
  ink: true,
  contours: true,
  wind: true,
  water: true,
  sound: true,
  sunAngle: 0,
  sunHeight: 1,
};
const opts = { ...DEFAULT_OPTIONS };
try {
  Object.assign(opts, JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}'));
} catch {
  /* storage unavailable or corrupt: defaults */
}
function saveOptions() {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
  } catch {
    /* storage unavailable */
  }
}
const brushScale = (code) => (BRUSH_SIZES[code] ?? BRUSH_SIZES[0]).scale;

// ------------------------------------------------------------------ renderer + scene

// The scene renders into the ink-edge pass's multisampled target, so the canvas itself needs no MSAA.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(lowQuality ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 120);
const rig = new CameraRig(camera);
rig.fit(camera.aspect);
const inkPass = new InkEdgePass(renderer, { samples: lowQuality ? 0 : 4 });

// ------------------------------------------------------------------ procedural noise

const rand = mulberry32(3);
const noise2D = createNoise2D(rand);
const noise4D = createNoise4D(rand);

/** Tileable 256² noise: R = low-freq relief, G = fine paper grain, B = water ripple. */
function makeNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;
  const torus = (u, v, f, o) => {
    const a = u * TAU;
    const b = v * TAU;
    const r = f / TAU;
    return noise4D(Math.cos(a) * r + o, Math.sin(a) * r + o, Math.cos(b) * r - o, Math.sin(b) * r - o);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const low = torus(u, v, 4, 0) * 0.6 + torus(u, v, 9, 3) * 0.4;
      const fine = torus(u, v, 40, 7) * 0.6 + torus(u, v, 90, 11) * 0.4;
      const rip = torus(u, v, 6, 21) * 0.65 + torus(u, v, 14, 5) * 0.35;
      const i = (y * size + x) * 4;
      data[i] = (low * 0.5 + 0.5) * 255;
      data[i + 1] = (fine * 0.5 + 0.5) * 255;
      data[i + 2] = (rip * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ offscreen page + textures

const parchment = new ParchmentCanvas({ noise2D, albedoSize: 1024, heightSize: 512 });
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const albedoTex = new THREE.CanvasTexture(parchment.albedoCanvas);
albedoTex.colorSpace = THREE.SRGBColorSpace;
albedoTex.anisotropy = Math.min(8, maxAniso);

const flowTex = new THREE.CanvasTexture(parchment.flowCanvas);
flowTex.colorSpace = THREE.NoColorSpace;

function makeHeightTexture(data) {
  const t = new THREE.DataTexture(data, parchment.H, parchment.H, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
const fromData = new Uint8Array(parchment.data.length);
fromData.set(parchment.data);
const heightFromTex = makeHeightTexture(fromData);
const heightToTex = makeHeightTexture(parchment.data);

const uniforms = createSharedUniforms({
  heightFrom: heightFromTex,
  heightTo: heightToTex,
  noise: makeNoiseTexture(),
  albedo: albedoTex,
  flow: flowTex,
});
const cliffInkTex = new THREE.CanvasTexture(createCliffInkTexture(noise2D));
cliffInkTex.colorSpace = THREE.NoColorSpace;
cliffInkTex.wrapS = cliffInkTex.wrapT = THREE.RepeatWrapping;
cliffInkTex.anisotropy = Math.min(4, maxAniso);
uniforms.uCliffInk.value = cliffInkTex;

// ------------------------------------------------------------------ terrain, rim, table

const terrain = new THREE.Mesh(createTerrainGeometry(), createTerrainMaterial(uniforms));
terrain.customDepthMaterial = createTerrainDepthMaterial(uniforms);
terrain.castShadow = true;
terrain.receiveShadow = true;
terrain.name = 'terrain';
scene.add(terrain);

const rim = new THREE.Mesh(createRimGeometry(), createRimMaterial(uniforms));
rim.customDepthMaterial = createRimDepthMaterial(uniforms);
rim.castShadow = true;
rim.receiveShadow = true;
rim.name = 'rim';
scene.add(rim);

function woodTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#d8d0c4';
  g.fillRect(0, 0, 512, 512);
  const r = mulberry32(5);
  for (let i = 0; i < 160; i++) {
    const y = r() * 512;
    g.strokeStyle = `rgba(60,40,25,${0.05 + r() * 0.12})`;
    g.lineWidth = 0.6 + r() * 2.4;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 3 + noise2D(x * 0.01, i) * 4);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.anisotropy = Math.min(8, maxAniso);
  return t;
}
const table = new THREE.Mesh(
  new THREE.PlaneGeometry(90, 90),
  new THREE.MeshStandardMaterial({ map: woodTexture(), color: BIOMES[DEFAULT_BIOME].table, roughness: 0.85 }),
);
table.rotation.x = -Math.PI / 2;
table.position.y = RIM_DEPTH - 0.002;
table.receiveShadow = true;
table.name = 'table';
scene.add(table);

// ------------------------------------------------------------------ lighting

const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.castShadow = true;
const shadowSize = lowQuality ? 1024 : coarse ? 1536 : 2048;
sun.shadow.mapSize.set(shadowSize, shadowSize);
const sc = sun.shadow.camera;
sc.left = -8;
sc.right = 8;
sc.top = 8;
sc.bottom = -8;
sc.near = 1;
sc.far = 40;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
scene.add(hemi);
scene.fog = new THREE.Fog(0x000000, 22, 48);
scene.background = new THREE.Color();

// ------------------------------------------------------------------ sprites, flow, audio

const sprites = new SpriteInstancer(uniforms, { anisotropy: Math.min(4, maxAniso) });
scene.add(sprites.mesh);
const flow = new FlowParticles();
flow.uniforms.uPixelRatio.value = renderer.getPixelRatio() * (window.innerHeight / 900);
scene.add(flow.points);
const synth = new PaperSynth();

/** UV polylines of every live river, parallel to flow.rivers (needed to undo Clear Page). */
let riverPaths = [];

// ------------------------------------------------------------------ biome state + transitions

let biome = BIOMES[DEFAULT_BIOME];
const T = {
  t: 1,
  dur: 1.2,
  from: null,
  to: null,
};
function biomeLook(b) {
  return {
    sunColor: new THREE.Color(b.sun.color),
    sunIntensity: b.sun.intensity,
    sunDir: new THREE.Vector3(...b.sun.dir).normalize(),
    sky: new THREE.Color(b.hemi.sky),
    ground: new THREE.Color(b.hemi.ground),
    hemiIntensity: b.hemi.intensity,
    bg: new THREE.Color(b.background),
    table: new THREE.Color(b.table),
    waterInk: new THREE.Color(b.waterInk),
    waterDeep: new THREE.Color(b.waterDeep),
    waterGlint: new THREE.Color(b.waterGlint),
    contour: new THREE.Color(b.contour),
    ink: new THREE.Color(b.ink),
  };
}
const look = biomeLook(biome); // the live, interpolated look
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function applyLook(l) {
  sun.color.copy(l.sunColor);
  sun.intensity = l.sunIntensity;
  _dir.copy(l.sunDir).normalize();
  // Options: swing the sun round the page and raise or lower it.
  _dir.applyAxisAngle(_up, (opts.sunAngle * Math.PI) / 180);
  _dir.y *= opts.sunHeight;
  _dir.normalize();
  sun.position.copy(_dir).multiplyScalar(14);
  hemi.color.copy(l.sky);
  hemi.groundColor.copy(l.ground);
  hemi.intensity = l.hemiIntensity;
  scene.background.copy(l.bg);
  scene.fog.color.copy(l.bg);
  table.material.color.copy(l.table);
  uniforms.uWaterInk.value.copy(l.waterInk);
  uniforms.uWaterDeep.value.copy(l.waterDeep);
  uniforms.uWaterGlint.value.copy(l.waterGlint);
  uniforms.uContour.value.copy(l.contour);
  inkPass.material.uniforms.uInk.value.copy(l.ink);
  uniforms.uSky.value.copy(l.sky);
  flow.uniforms.uColor.value.copy(l.waterGlint);
}
applyLook(look);
sprites.setBiomeImmediate(biome.row, biome.glow);

function stepBiome(dt) {
  if (T.t >= 1) return;
  T.t = Math.min(1, T.t + dt / T.dur);
  const k = T.t * T.t * (3 - 2 * T.t);
  const a = T.from;
  const b = T.to;
  look.sunColor.lerpColors(a.sunColor, b.sunColor, k);
  look.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * k;
  look.sunDir.lerpVectors(a.sunDir, b.sunDir, k);
  look.sky.lerpColors(a.sky, b.sky, k);
  look.ground.lerpColors(a.ground, b.ground, k);
  look.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * k;
  look.bg.lerpColors(a.bg, b.bg, k);
  look.table.lerpColors(a.table, b.table, k);
  look.waterInk.lerpColors(a.waterInk, b.waterInk, k);
  look.waterDeep.lerpColors(a.waterDeep, b.waterDeep, k);
  look.waterGlint.lerpColors(a.waterGlint, b.waterGlint, k);
  look.contour.lerpColors(a.contour, b.contour, k);
  look.ink.lerpColors(a.ink, b.ink, k);
  applyLook(look);
}

const biomeButtons = [...document.querySelectorAll('.stamp.biome')];
const biomeLabel = document.getElementById('biome-name');
let labelTimer = 0;
function setBiome(id, { quiet = false } = {}) {
  const next = BIOMES[id];
  if (!next || next === biome) return;
  biome = next;
  // Start from the current interpolated look so rapid switches stay smooth.
  T.from = Object.fromEntries(Object.entries(look).map(([k, v]) => [k, v.clone ? v.clone() : v]));
  T.to = biomeLook(next);
  T.t = 0;
  sprites.flipTo(next.row, next.glow);
  for (const btn of biomeButtons) btn.setAttribute('aria-checked', String(btn.dataset.biome === id));
  if (quiet) return;
  biomeLabel.textContent = next.name;
  biomeLabel.classList.add('show');
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => biomeLabel.classList.remove('show'), 1400);
  synth.rustle();
  scheduleAutosave();
}

// ------------------------------------------------------------------ terrain spring

const spring = { x: 1, v: 0, k: 170, zeta: 0.32, active: false };

/** Upload the new page state. `bouncy` uses an under-damped spring for the pop-up feel. */
function commitTerrain(bouncy) {
  // Start from whatever is on screen right now, so interrupted springs never jump.
  const m = uniforms.uMix.value;
  if (m !== 1) {
    const to = parchment.data;
    for (let i = 0; i < fromData.length; i++) fromData[i] = fromData[i] + (to[i] - fromData[i]) * m;
  } else {
    fromData.set(parchment.data);
  }
  parchment.compose();
  heightFromTex.needsUpdate = true;
  heightToTex.needsUpdate = true;
  spring.x = 0;
  spring.v = 0;
  spring.zeta = bouncy ? 0.32 : 0.95;
  spring.k = bouncy ? 170 : 60;
  spring.active = true;
  uniforms.uMix.value = 0;
  albedoDirty = true;
  flowTex.needsUpdate = true;
}

function stepSpring(dt) {
  if (!spring.active) return;
  const steps = 4;
  const h = dt / steps;
  const c = 2 * spring.zeta * Math.sqrt(spring.k);
  for (let i = 0; i < steps; i++) {
    const a = -spring.k * (spring.x - 1) - c * spring.v;
    spring.v += a * h;
    spring.x += spring.v * h;
  }
  if (Math.abs(spring.x - 1) < 0.0008 && Math.abs(spring.v) < 0.002) {
    spring.x = 1;
    spring.v = 0;
    spring.active = false;
  }
  uniforms.uMix.value = Math.max(0, Math.min(1.45, spring.x));
}

// ------------------------------------------------------------------ picking (ray-march the heightfield)

const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _p = new THREE.Vector3();

function terrainY(x, z) {
  const u = x / PAGE_SIZE + 0.5;
  const v = z / PAGE_SIZE + 0.5;
  return heightToY(parchment.sample(u, v));
}

/** Screen point (CSS px) -> page UV {x, y} on the displaced terrain, or null. */
function project(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  const { origin, direction } = raycaster.ray;
  if (direction.y >= -1e-4) return null;
  const yTop = HEIGHT_SCALE * 0.5 + 0.2;
  const yBot = WATER_Y - 0.05;
  let t0 = Math.max(0, (yTop - origin.y) / direction.y);
  const t1 = Math.min((yBot - origin.y) / direction.y, t0 + 60);
  const steps = 96;
  const dt = (t1 - t0) / steps;
  let prevT = t0;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + dt * i;
    _p.copy(direction).multiplyScalar(t).add(origin);
    if (_p.y <= terrainY(_p.x, _p.z)) {
      // bisection refine between prevT and t
      let a = prevT;
      let b = t;
      for (let k = 0; k < 8; k++) {
        const mid = (a + b) * 0.5;
        _p.copy(direction).multiplyScalar(mid).add(origin);
        if (_p.y <= terrainY(_p.x, _p.z)) b = mid;
        else a = mid;
      }
      _p.copy(direction).multiplyScalar(b).add(origin);
      const u = _p.x / PAGE_SIZE + 0.5;
      const v = _p.z / PAGE_SIZE + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      return { x: u, y: v };
    }
    prevT = t;
  }
  return null;
}

// ------------------------------------------------------------------ stroke handling

let albedoDirty = false;
let lastUv = null;
let elapsed = 0;
const undoBtn = document.getElementById('undo');
const hint = document.getElementById('hint');
let strokesMade = 0;

/** Replayable log of committed strokes (see WorldSeed.js). Undo pops it, Clear empties it. */
let worldLog = [];
/** What Undo took away, newest last: {type: 'entry', entry} | {type: 'clear'} | {type: 'batch', entries}. */
let redoStack = [];
const redoBtn = document.getElementById('redo');


function refreshUi() {
  undoBtn.disabled = !parchment.canUndo;
  redoBtn.disabled = redoStack.length === 0;
}

function onFirstStroke() {
  strokesMade++;
  if (strokesMade === 2) hint.classList.add('faded');
}

/**
 * Plant a cluster (tap), a short row (flick) or a row along a dragged path (row) of sprites.
 * `scale` is the brush size; `forced` is a sprite type, or -1 to choose by biome and ground.
 * Returns how many were planted.
 */
function plant(kind, pts, b, r, live, scale = 1, forced = -1) {
  if (!pts.length) return 0;
  const spots = [];
  if (kind === 'row' && pts.length > 1) {
    // Evenly spaced along the path, a little jitter either side.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = cum[cum.length - 1];
    const n = Math.max(2, Math.min(40, Math.round(total / (0.034 * scale)) + 1));
    let k = 0;
    for (let i = 0; i < n; i++) {
      const d = (i / (n - 1)) * total;
      while (k < cum.length - 2 && cum[k + 1] < d) k++;
      const t = (d - cum[k]) / Math.max(1e-9, cum[k + 1] - cum[k]);
      const p0 = pts[k];
      const p1 = pts[k + 1];
      spots.push({ x: p0.x + (p1.x - p0.x) * t + (r() - 0.5) * 0.012 * scale, y: p0.y + (p1.y - p0.y) * t + (r() - 0.5) * 0.012 * scale });
    }
  } else if (kind === 'flick' && pts.length > 1) {
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const p = pts[Math.round((i / (n - 1)) * (pts.length - 1))];
      spots.push({ x: p.x + (r() - 0.5) * 0.01, y: p.y + (r() - 0.5) * 0.01 });
    }
  } else {
    const c = pts[0];
    const n = 3 + Math.floor(r() * 4) + (scale > 1.2 ? 3 : 0);
    // Reed beds hug the channel: tighter clusters when the tap lands in water.
    const wet = terrainContext(parchment.sample(c.x, c.y), 0, parchment.sample(c.x, c.y, 2)) === 'water';
    const spread = (wet ? 0.35 : 1) * scale;
    spots.push({ x: c.x, y: c.y });
    for (let i = 1; i < n; i++) {
      const a = r() * Math.PI * 2;
      const d = (0.012 + r() * 0.03) * spread;
      spots.push({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d });
    }
  }
  const sizeK = scale === 1 ? 1 : Math.pow(scale, 0.45);
  let planted = 0;
  const marks = [];
  spots.forEach((s, i) => {
    if (s.x < 0.01 || s.x > 0.99 || s.y < 0.01 || s.y > 0.99) return;
    const h = parchment.sample(s.x, s.y, 3);
    const stone = parchment.sample(s.x, s.y, 1);
    const water = parchment.sample(s.x, s.y, 2);
    const ctx = terrainContext(h, stone, water);
    const picked = pickWeighted(b.weights[ctx], r());
    const type = forced >= 0 ? forced : picked;
    const ok = sprites.add({
      x: (s.x - 0.5) * PAGE_SIZE,
      z: (s.y - 0.5) * PAGE_SIZE,
      type,
      scale: SPRITE_SIZE[type] * (0.8 + r() * 0.4) * sizeK,
      phase: r() * 6.283,
      spawn: elapsed + i * (live ? 0.06 : 0.01),
    });
    if (ok) {
      planted++;
      if (ctx !== 'water') marks.push(s);
      if (live) synth.pop(i);
    }
  });
  if (marks.length) parchment.plantMarks(marks, b);
  return planted;
}

/** Distance from a page point to a polyline (page UV). */
function distToPath(p, path) {
  if (path.length === 1) return Math.hypot(p.x - path[0].x, p.y - path[0].y);
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return best;
}

/** Erase along `pts`: bare paper, no sprites, and river currents split around the gap. */
function eraseAlong(pts, radius) {
  const { path } = parchment.erase(pts, radius);
  const kept = sprites.items.filter((it) => distToPath({ x: it.x / PAGE_SIZE + 0.5, y: it.z / PAGE_SIZE + 0.5 }, path) > radius);
  if (kept.length !== sprites.count) sprites.setAll(kept);
  const next = [];
  for (const river of riverPaths) {
    let run = [];
    for (const q of river) {
      if (distToPath(q, path) > radius * 0.9) run.push(q);
      else {
        if (run.length > 2) next.push(run);
        run = [];
      }
    }
    if (run.length > 2) next.push(run);
  }
  riverPaths = next;
  flow.setRivers(riverPaths);
}

/**
 * Apply one log entry to the page. Live strokes also animate and make sound; replayed
 * strokes (from a shared link) are applied silently and the terrain is committed once at the end.
 * Every random choice comes from the entry's own seed, so replays rebuild the same world.
 */
function applyEntry(entry, live) {
  const b = BIOMES[BIOME_ORDER[entry.biome]] ?? biome;
  const r = mulberry32(entry.seed);
  const scale = brushScale(entry.size);
  parchment.rand = r;
  switch (entry.kind) {
    case 'loop': {
      const { area } = parchment.raiseHill(entry.points, b, scale);
      if (live) {
        commitTerrain(true);
        synth.thud(Math.sqrt(area) * 3);
      }
      return true;
    }
    case 'mountain': {
      parchment.raiseMountain(entry.points, b, scale);
      if (live) {
        commitTerrain(true);
        synth.thud(0.35);
        synth.knock();
      }
      return true;
    }
    case 'river': {
      const { path } = parchment.carveRiver(entry.points, b, scale);
      flow.addRiver(path);
      riverPaths.push(path);
      if (live) {
        commitTerrain(false);
        synth.splash();
      }
      return true;
    }
    case 'lake': {
      parchment.carveLake(entry.points, b, scale);
      if (live) {
        commitTerrain(false);
        synth.splash();
      }
      return true;
    }
    case 'road': {
      parchment.paveRoad(entry.points, b, scale);
      if (live) {
        commitTerrain(false);
        synth.rustle();
      }
      return true;
    }
    case 'raise':
    case 'lower':
    case 'flatten': {
      parchment.sculpt(entry.points, entry.kind, scale);
      if (live) {
        commitTerrain(entry.kind === 'raise');
        synth.rustle();
      }
      return true;
    }
    case 'erase': {
      eraseAlong(entry.points, 0.045 * scale);
      if (live) {
        commitTerrain(false);
        synth.rustle();
      }
      return true;
    }
    default:
      albedoDirty = true;
      return plant(entry.kind, entry.points, b, r, live, scale, (entry.plant ?? 0) - 1) > 0;
  }
}

/**
 * The tool rail can force what a stroke makes. Returns the (possibly re-kinded) result, or
 * null with a hint when the stroke can't make that thing.
 */
function forceKind(result, tool = opts.tool) {
  const tap = result.kind === 'tap';
  const pts = result.points;
  const enclosed = () => pts.length >= 4 && parchment._area(pts) > 0.0015;
  switch (tool) {
    case 'hill':
      if (result.kind === 'loop' || result.kind === 'mountain' || (!tap && enclosed())) return { ...result, kind: 'loop' };
      toast('Draw a shape to raise a hill.');
      return null;
    case 'mountain': {
      if (result.kind === 'mountain') return result;
      if (tap || !enclosed()) {
        toast('Draw a shape to raise a mountain.');
        return null;
      }
      // Simplify the outline into a few rocky ridges.
      let poly = simplify([...pts, pts[0]], 0.018).slice(0, -1);
      if (poly.length < 3) poly = simplify([...pts, pts[0]], 0.006).slice(0, -1);
      if (poly.length < 3) {
        toast('Draw a bigger shape to raise a mountain.');
        return null;
      }
      return { ...result, kind: 'mountain', polygon: poly };
    }
    case 'river':
      if (tap || result.length < 0.04) {
        toast('Drag a line to carve a river.');
        return null;
      }
      return { ...result, kind: 'river' };
    case 'lake':
      if (tap || !enclosed()) {
        toast('Draw a shape to fill a lake.');
        return null;
      }
      return { ...result, kind: 'lake' };
    case 'road':
      if (tap || result.length < 0.04) {
        toast('Drag a line to lay a road.');
        return null;
      }
      return { ...result, kind: 'road' };
    case 'sculpt':
      return { ...result, kind: opts.sculpt };
    case 'plant':
      return tap ? result : { ...result, kind: pts.length > 1 ? 'row' : 'tap' };
    case 'erase':
      return { ...result, kind: 'erase' };
    default:
      return result;
  }
}

/** Commit one log entry as an undoable step. Returns false if it changed nothing. */
function commitEntry(entry) {
  const meta = { sprites: sprites.count, rivers: flow.riverCount, kind: entry.kind, log: worldLog.length };
  if (entry.kind === 'erase') {
    // Erasing removes sprites and splits rivers in the middle of the lists: undo restores both.
    meta.clearedSprites = sprites.items.slice();
    meta.clearedRivers = riverPaths.slice();
  }
  parchment.beginStroke(); // no-op when the stroke already took its snapshot
  parchment.revertPreview();
  if (!applyEntry(entry, true)) {
    parchment.cancelStroke();
    albedoDirty = true;
    return false;
  }
  worldLog.push(entry);
  parchment.commitStroke(meta);
  onFirstStroke();
  refreshUi();
  scheduleAutosave();
  return true;
}

/** Apply a classified stroke to the world. Exposed for tests via window.__lp. */
function applyStroke(raw, { tool = opts.tool } = {}) {
  const result = forceKind(raw, tool);
  if (!result) {
    parchment.cancelStroke();
    albedoDirty = true;
    return null;
  }
  const source = result.kind === 'mountain' ? result.polygon : result.points;
  const entry = {
    kind: result.kind,
    biome: BIOME_ORDER.indexOf(biome.id),
    seed: (Math.random() * 0xffffffff) >>> 0,
    points: canonicalPoints(source, result.kind),
  };
  if (opts.size) entry.size = opts.size;
  if (opts.plant && (result.kind === 'tap' || result.kind === 'flick' || result.kind === 'row')) entry.plant = opts.plant;
  if (!commitEntry(entry)) return null;
  redoStack = [];
  refreshUi();
  return result.kind;
}

function undo() {
  const top = parchment.history.at(-1)?.meta;
  if (!top) return;
  // Remember what is being undone so Redo can replay it (strokes replay exactly from their seeds).
  const item =
    top.kind === 'clear'
      ? { type: 'clear' }
      : top.kind === 'batch'
        ? { type: 'batch', entries: worldLog.slice() }
        : worldLog[top.log]
          ? { type: 'entry', entry: worldLog[top.log] }
          : null;
  const meta = parchment.undo();
  if (meta.clearedSprites) sprites.setAll(meta.clearedSprites);
  else sprites.truncate(meta.sprites);
  if (meta.clearedRivers) {
    riverPaths = meta.clearedRivers.slice();
    flow.setRivers(riverPaths);
  } else {
    flow.truncate(meta.rivers);
    riverPaths.length = Math.min(riverPaths.length, meta.rivers);
  }
  if (meta.clearedLog) worldLog = meta.clearedLog.slice();
  else worldLog.length = Math.min(worldLog.length, meta.log);
  if (item) redoStack.push(item);
  commitTerrain(false);
  synth.rustle();
  refreshUi();
  scheduleAutosave();
}

function redo() {
  const item = redoStack.pop();
  if (!item) return;
  if (item.type === 'clear') clearPage({ keepRedo: true });
  else if (item.type === 'batch') applyBatch(item.entries, { keepRedo: true });
  else commitEntry(item.entry);
  synth.rustle();
  refreshUi();
}

function clearPage({ keepRedo = false } = {}) {
  if (sprites.count === 0 && flow.riverCount === 0 && worldLog.length === 0 && !parchment.canUndo) return;
  parchment.beginStroke();
  const meta = {
    kind: 'clear',
    sprites: sprites.count,
    rivers: flow.riverCount,
    log: worldLog.length,
    clearedSprites: sprites.items.slice(),
    clearedRivers: riverPaths.slice(),
    clearedLog: worldLog.slice(),
  };
  parchment.clear();
  sprites.truncate(0);
  flow.truncate(0);
  riverPaths = [];
  worldLog = [];
  parchment.commitStroke(meta);
  if (!keepRedo) redoStack = [];
  commitTerrain(false);
  synth.rustle(true);
  refreshUi();
  scheduleAutosave();
}

/** Replace the page with `entries` as one undoable step (Random). */
function applyBatch(entries, { keepRedo = false } = {}) {
  parchment.beginStroke();
  const meta = {
    kind: 'batch',
    sprites: sprites.count,
    rivers: flow.riverCount,
    log: worldLog.length,
    clearedSprites: sprites.items.slice(),
    clearedRivers: riverPaths.slice(),
    clearedLog: worldLog.slice(),
  };
  parchment.clear();
  sprites.truncate(0);
  flow.truncate(0);
  riverPaths = [];
  worldLog = [];
  for (const e of entries) if (applyEntry(e, false)) worldLog.push(e);
  parchment.commitStroke(meta);
  if (!keepRedo) redoStack = [];
  commitTerrain(true);
  synth.thud(0.6);
  onFirstStroke();
  hint.classList.add('faded');
  refreshUi();
  scheduleAutosave();
}

/** A random but tidy world: a few terraced hills, a mountain, a river or two and some planting. */
function randomEntries(seed = (Math.random() * 0xffffffff) >>> 0) {
  const r = mulberry32(seed);
  const bi = BIOME_ORDER.indexOf(biome.id);
  const u32 = () => (r() * 0xffffffff) >>> 0;
  const out = [];
  const push = (kind, pts) => out.push({ kind, biome: bi, seed: u32(), points: canonicalPoints(pts, kind) });
  const blob = (cx, cy, rad, n = 40) => {
    const ph = r() * 6.283;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + 0.18 * Math.sin(a * 2 + ph) + 0.1 * Math.sin(a * 3 + ph * 2);
      pts.push({ x: cx + Math.cos(a) * rad * w, y: cy + Math.sin(a) * rad * w * 0.85 });
    }
    return pts;
  };
  const hills = [];
  const hillCount = 2 + Math.floor(r() * 3);
  for (let i = 0; i < hillCount; i++) {
    const h = { x: 0.2 + r() * 0.6, y: 0.2 + r() * 0.6, r: 0.07 + r() * 0.08 };
    hills.push(h);
    push('loop', blob(h.x, h.y, h.r));
    if (r() < 0.65) push('loop', blob(h.x + (r() - 0.5) * h.r * 0.4, h.y + (r() - 0.5) * h.r * 0.4, h.r * 0.5));
  }
  // A river across the page, meandering.
  const rivers = 1 + (r() < 0.4 ? 1 : 0);
  for (let k = 0; k < rivers; k++) {
    const vertical = r() < 0.5;
    const base = 0.25 + r() * 0.5;
    const amp = 0.05 + r() * 0.08;
    const ph = r() * 6.283;
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      const t = 0.03 + (i / 30) * 0.94;
      const off = base + Math.sin(t * 7 + ph) * amp;
      pts.push(vertical ? { x: off, y: t } : { x: t, y: off });
    }
    push('river', pts);
  }
  // One or two rocky mountains on open ground, away from the hills.
  const mountains = 1 + (r() < 0.5 ? 1 : 0);
  for (let m = 0, tries = 0; m < mountains && tries < 20; tries++) {
    const c = { x: 0.15 + r() * 0.7, y: 0.15 + r() * 0.7 };
    const size = 0.08 + r() * 0.05;
    if (hills.some((h) => Math.hypot(h.x - c.x, h.y - c.y) < h.r + size + 0.02)) continue;
    const n = 5 + Math.floor(r() * 3);
    const ph = r() * 6.283;
    const corners = [];
    for (let i = 0; i < n; i++) {
      const a = ph + (i / n) * Math.PI * 2;
      const rad = size * (0.75 + r() * 0.45);
      corners.push({ x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad * 0.85 });
    }
    push('mountain', corners);
    hills.push({ x: c.x, y: c.y, r: size, rock: true });
    m++;
  }
  // Planting: on the hills and scattered.
  for (const h of hills) if (!h.rock) push('tap', [{ x: h.x, y: h.y }]);
  const scatter = 5 + Math.floor(r() * 5);
  for (let i = 0; i < scatter; i++) push('tap', [{ x: 0.08 + r() * 0.84, y: 0.08 + r() * 0.84 }]);
  return out;
}

function randomWorld(seed) {
  applyBatch(randomEntries(seed));
  toast('A new world. Undo brings the old one back.');
}

/** Rebuild a world from a decoded seed (shared link or autosave). Replaces the page. */
function loadWorld({ biome: biomeIndex, entries }) {
  parchment.reset();
  parchment.history.length = 0;
  parchment.pending = null;
  sprites.truncate(0);
  flow.truncate(0);
  riverPaths = [];
  worldLog = [];
  redoStack = [];
  for (const e of entries) if (applyEntry(e, false)) worldLog.push(e);
  const id = BIOME_ORDER[biomeIndex];
  if (id && id !== biome.id) setBiome(id, { quiet: true });
  commitTerrain(true);
  refreshUi();
  if (entries.length) hint.classList.add('faded');
}

// ------------------------------------------------------------------ save, share, export

const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const SAVE_KEY = 'living-parchment-world';
let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try {
      if (worldLog.length === 0) localStorage.removeItem(SAVE_KEY);
      else localStorage.setItem(SAVE_KEY, await encodeWorld(worldLog, BIOME_ORDER.indexOf(biome.id)));
    } catch {
      /* storage can be unavailable (private mode, sandbox); autosave is a convenience */
    }
  }, 500);
}

async function shareWorld() {
  if (!worldLog.length) {
    toast('Draw something first, then share it.');
    return null;
  }
  const code = await encodeWorld(worldLog, BIOME_ORDER.indexOf(biome.id));
  history.replaceState(null, '', `#${code}`);
  const embedded = window.top !== window;
  let copied = false;
  try {
    if (!embedded) {
      await navigator.clipboard.writeText(location.href);
      copied = true;
    }
  } catch {
    /* clipboard can be refused */
  }
  toast(
    copied
      ? 'Link copied. Anyone who opens it gets this world.'
      : embedded
        ? 'World saved into this page’s link. Use Share › Copy link to send it.'
        : 'World saved into the address bar. Copy the link to share it.',
    3600,
  );
  return code;
}

// Export panel settings (kept per browser). These are what a game map usually wants: real-world
// size, a water surface and no cardboard rim. Calling exportWorld() with no options keeps the
// plain diorama export (EXPORT_DEFAULTS).
const EXPORT_KEY = 'living-parchment-export';
const PANEL_EXPORT = { size: 100, height: 2, detail: 2, sprites: 'cards', trees: 'real', water: true, rim: false, maps: false };
const expOpts = { ...PANEL_EXPORT };
try {
  Object.assign(expOpts, JSON.parse(localStorage.getItem(EXPORT_KEY) || '{}'));
} catch {
  /* defaults */
}
function saveExportOptions() {
  try {
    localStorage.setItem(EXPORT_KEY, JSON.stringify(expOpts));
  } catch {
    /* storage unavailable */
  }
}

/** Save bytes as a file: the claude.ai `downloads` capability when present, else a link. */
async function saveFile(name, bytes, type) {
  const downloads = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (downloads) {
    // The viewer accepts .zip but not .glb, so a lone model goes inside a zip there.
    let fname = name;
    let data = bytes;
    if (!name.endsWith('.zip')) {
      fname = name.replace(/\.[^.]+$/, '') + '-' + name.split('.').pop() + '.zip';
      data = zipSingle(name, new Uint8Array(bytes));
    }
    try {
      await downloads.save({ filename: fname, data: new Blob([data]) });
      toast(fname === name ? `Saved ${name}.` : `Saved ${fname} (unzip it for the ${name.split('.').pop()}).`);
    } catch (err) {
      toast(err?.code === 'declined' ? 'Download cancelled.' : 'Downloads aren’t available here.');
    }
    return;
  }
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Saved ${name} (${Math.round(bytes.byteLength / 1024)} KB).`);
  } catch {
    toast('This page isn’t allowed to download files here.');
  }
}

/**
 * Export the world. With no options it is the plain diorama .glb; the panel passes its own
 * settings. Resolves to the .glb ArrayBuffer (and `files` when maps are on, via exportFiles).
 */
async function exportWorld({ download = true, ...overrides } = {}) {
  const o = { ...EXPORT_DEFAULTS, ...overrides };
  toast(o.maps ? 'Folding the map and its heightmaps…' : 'Folding the diorama into a .glb…', 8000);
  await new Promise((r) => setTimeout(r, 30)); // let the toast paint
  const args = { parchment, sprites, noise: uniforms.uNoise.value, biome };
  if (o.maps) {
    const files = await exportBundle(args, o);
    if (download) await saveFile('living-parchment-map.zip', zipFiles(files), 'application/zip');
    return files;
  }
  const buf = await exportGLB(args, o);
  if (download) await saveFile(overrides.size ? 'living-parchment-map.glb' : 'living-parchment.glb', buf, 'model/gltf-binary');
  return buf;
}

const exportPanel = document.getElementById('export-panel');
const exportBtn = document.getElementById('export');
function exportSummary() {
  const seg = segmentsFor(expOpts.detail);
  const tris = seg * seg * 2;
  const k = expOpts.size / PAGE_SIZE;
  // Tallest point on the page right now (mountains), and a typical full-grown tree.
  let top = 0.5;
  for (let j = 0; j <= 64; j++) for (let i = 0; i <= 64; i++) top = Math.max(top, parchment.sample(i / 64, j / 64));
  const peak = (top - 0.5) * HEIGHT_SCALE * k * expOpts.height;
  const tree = spriteHeight({ type: 0, scale: SPRITE_SIZE[0] }, k, expOpts.trees);
  const m = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const what = expOpts.maps ? 'a zip with map.glb, heightmaps, splat and colour maps' : 'one .glb file';
  const heights = top > 0.52 ? `highest ground ${m(peak)} m, trees about ${m(tree)} m` : `trees about ${m(tree)} m`;
  return `${expOpts.size} × ${expOpts.size} m, ${heights}, ${fmt(tris)} triangles. You get ${what}.`;
}
function applyExportOptions() {
  for (const g of exportPanel.querySelectorAll('.seg[data-exp]')) {
    for (const b of g.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === String(expOpts[g.dataset.exp])));
  }
  for (const c of exportPanel.querySelectorAll('input[type=checkbox][data-exp]')) c.checked = !!expOpts[c.dataset.exp];
  document.getElementById('export-summary').textContent = exportSummary();
}
function openExport(open = exportPanel.hidden) {
  if (open) openOptions(false);
  exportPanel.hidden = !open;
  exportBtn.setAttribute('aria-expanded', String(open));
  exportBtn.setAttribute('aria-pressed', String(open));
  if (open) applyExportOptions();
}
for (const g of exportPanel.querySelectorAll('.seg[data-exp]')) {
  for (const b of g.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const v = b.dataset.value;
      expOpts[g.dataset.exp] = g.dataset.exp === 'sprites' || g.dataset.exp === 'trees' ? v : Number(v);
      saveExportOptions();
      applyExportOptions();
    });
  }
}
for (const c of exportPanel.querySelectorAll('input[type=checkbox][data-exp]')) {
  c.addEventListener('change', () => {
    expOpts[c.dataset.exp] = c.checked;
    saveExportOptions();
    applyExportOptions();
  });
}
document.getElementById('export-close').addEventListener('click', () => openExport(false));
document.getElementById('export-go').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await exportWorld({ ...expOpts });
  } catch (err) {
    console.error(err);
    toast('Export failed. Try a lower detail.');
  } finally {
    btn.disabled = false;
  }
});

/** Save a picture of the current view as a PNG. Resolves to the Blob. */
async function takePhoto({ download = true } = {}) {
  // Read the canvas in the same task as a fresh render (the drawing buffer is not preserved).
  inkPass.render(scene, camera);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) {
    toast('Couldn’t take a photo here.');
    return null;
  }
  if (!download) return blob;
  const name = `living-parchment-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  const downloads = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (downloads) {
    try {
      await downloads.save({ filename: name, data: blob });
      toast('Photo saved.');
    } catch (err) {
      toast(err?.code === 'declined' ? 'Photo cancelled.' : 'Downloads aren’t available here.');
    }
    return blob;
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Photo saved.');
  } catch {
    toast('This page isn’t allowed to download files here.');
  }
  return blob;
}

// ------------------------------------------------------------------ input

const gestures = new GestureClassifier(
  canvas,
  rig,
  project,
  {
    onStart(uv) {
      synth.unlock();
      parchment.beginStroke();
      lastUv = uv;
    },
    onMove(uv, _s, v) {
      if (lastUv) {
        parchment.previewInk(lastUv, uv, v, biome);
        albedoDirty = true;
      }
      lastUv = uv;
      synth.scratch(v);
    },
    onEnd(result) {
      synth.lift();
      lastUv = null;
      applyStroke(result);
    },
    onTap(result) {
      synth.unlock();
      applyStroke(result);
    },
    onCancel() {
      synth.lift();
      lastUv = null;
      parchment.cancelStroke();
      albedoDirty = true;
    },
    onCameraGesture() {
      synth.unlock();
    },
    isPov: () => rig.pov,
    tool: () => opts.tool,
  },
  Gesture,
);

const stick = new Thumbstick(document.getElementById('stick'), rig.move);

// ------------------------------------------------------------------ UI

const foldBtn = document.getElementById('fold');
const foldLabel = document.getElementById('fold-label');
const helpPanel = document.getElementById('help-panel');
const optionsPanel = document.getElementById('options');
const optionsBtn = document.getElementById('options-btn');
const toolButtons = [...document.querySelectorAll('.tool-btn')];
const sculptModes = document.getElementById('sculpt-modes');
const widthModes = document.getElementById('width-modes');
const SCULPT_NAMES = { raise: 'Raise', lower: 'Lower', flatten: 'Flatten' };
function setSculpt(mode) {
  if (!SCULPT_NAMES[mode]) return;
  opts.sculpt = mode;
  for (const b of sculptModes.querySelectorAll('[data-sculpt]')) b.setAttribute('aria-checked', String(b.dataset.sculpt === mode));
  saveOptions();
}

function toggleFold() {
  synth.unlock();
  if (rig.goal.fold > 0.8) {
    rig.setFold(FOLD_DEFAULT);
    rig.goal.zoomK = 1;
  } else rig.setFold(1);
}
function openHelp(open = true) {
  helpPanel.hidden = !open;
  if (open) {
    document.querySelector('.help-card').scrollTop = 0;
    document.getElementById('help-close').focus({ preventScroll: true });
  } else document.getElementById('help').focus({ preventScroll: true });
}
function openOptions(open = optionsPanel.hidden) {
  if (open && !exportPanel.hidden) openExport(false);
  optionsPanel.hidden = !open;
  optionsBtn.setAttribute('aria-expanded', String(open));
  optionsBtn.setAttribute('aria-pressed', String(open));
}

const TOOL_NAMES = { auto: 'Draw', hill: 'Hill', mountain: 'Mountain', river: 'River', lake: 'Lake', road: 'Road', plant: 'Plant', sculpt: 'Sculpt', erase: 'Erase', move: 'Move' };
function setTool(id, { quiet = false } = {}) {
  if (!TOOL_NAMES[id]) return;
  opts.tool = id;
  for (const b of toolButtons) b.setAttribute('aria-checked', String(b.dataset.tool === id));
  sculptModes.hidden = id !== 'sculpt';
  widthModes.hidden = id !== 'river' && id !== 'road';
  if (!rig.pov) canvas.style.cursor = id === 'move' ? 'grab' : 'crosshair';
  saveOptions();
  if (!quiet) {
    biomeLabel.textContent = TOOL_NAMES[id];
    biomeLabel.classList.add('show');
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => biomeLabel.classList.remove('show'), 900);
  }
}

/** Push the display options into the renderer, shaders and audio. */
function applyOptions() {
  uniforms.uContourAmt.value = opts.contours ? 1 : 0;
  sprites.uniforms.uWind.value = opts.wind ? 1 : 0;
  flow.points.visible = opts.water;
  synth.muted = !opts.sound;
  applyLook(look);
  // Reflect state in the panel.
  for (const g of optionsPanel.querySelectorAll('.seg[data-opt]')) {
    for (const b of g.querySelectorAll('button')) b.setAttribute('aria-checked', String(Number(b.dataset.value) === opts[g.dataset.opt]));
  }
  for (const c of optionsPanel.querySelectorAll('input[type=checkbox][data-opt]')) c.checked = !!opts[c.dataset.opt];
  for (const b of widthModes.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === opts.size));
  document.getElementById('opt-sun-angle').value = String(opts.sunAngle);
  document.getElementById('opt-sun-height').value = String(opts.sunHeight);
}

/** Camera buttons (view pad, Options panel) and keys share these. */
function viewAction(name) {
  synth.unlock();
  switch (name) {
    case 'turn-left':
      rig.turn(Math.PI / 4);
      break;
    case 'turn-right':
      rig.turn(-Math.PI / 4);
      break;
    case 'tilt-up':
      rig.orbit(0, 0.2);
      break;
    case 'tilt-down':
      rig.orbit(0, -0.2);
      break;
    case 'zoom-in':
      rig.zoom(0.8);
      break;
    case 'zoom-out':
      rig.zoom(1.25);
      break;
    case 'reset':
      rig.resetView();
      break;
    default:
      rig.view(name); // top | tilt | low
  }
}

for (const btn of biomeButtons) {
  btn.addEventListener('click', () => {
    synth.unlock();
    setBiome(btn.dataset.biome);
  });
}
for (const btn of toolButtons) {
  btn.addEventListener('click', () => {
    synth.unlock();
    setTool(btn.dataset.tool);
  });
}
// River and Road show width chips: the same setting as Options > Brush size.
for (const b of widthModes.querySelectorAll('[data-size]')) {
  b.addEventListener('click', () => {
    opts.size = Number(b.dataset.size);
    saveOptions();
    applyOptions();
  });
}
for (const b of sculptModes.querySelectorAll('[data-sculpt]')) {
  b.addEventListener('click', () => {
    setSculpt(b.dataset.sculpt);
    if (opts.tool !== 'sculpt') setTool('sculpt');
  });
}
for (const btn of document.querySelectorAll('[data-view]')) {
  btn.addEventListener('click', () => viewAction(btn.dataset.view));
}
for (const g of optionsPanel.querySelectorAll('.seg[data-opt]')) {
  for (const b of g.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      opts[g.dataset.opt] = Number(b.dataset.value);
      saveOptions();
      applyOptions();
    });
  }
}
for (const c of optionsPanel.querySelectorAll('input[type=checkbox][data-opt]')) {
  c.addEventListener('change', () => {
    opts[c.dataset.opt] = c.checked;
    if (c.dataset.opt === 'sound' && c.checked) synth.unlock();
    saveOptions();
    applyOptions();
  });
}
for (const [id, key] of [
  ['opt-sun-angle', 'sunAngle'],
  ['opt-sun-height', 'sunHeight'],
]) {
  document.getElementById(id).addEventListener('input', (e) => {
    opts[key] = Number(e.target.value);
    applyLook(look);
  });
  document.getElementById(id).addEventListener('change', saveOptions);
}
document.getElementById('options-reset').addEventListener('click', () => {
  const tool = opts.tool;
  Object.assign(opts, DEFAULT_OPTIONS, { tool });
  saveOptions();
  applyOptions();
  toast('Options back to their defaults.');
});
const fsBtn = document.getElementById('fullscreen');
if (!document.fullscreenEnabled) fsBtn.hidden = true;
fsBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast('Full screen isn’t allowed here.');
  }
});
document.addEventListener('fullscreenchange', () => {
  fsBtn.textContent = document.fullscreenElement ? 'Leave full screen' : 'Full screen';
  setTimeout(onResize, 50);
});

undoBtn.addEventListener('click', () => {
  synth.unlock();
  undo();
});
redoBtn.addEventListener('click', () => {
  synth.unlock();
  redo();
});
document.getElementById('clear').addEventListener('click', () => {
  synth.unlock();
  clearPage();
});
foldBtn.addEventListener('click', toggleFold);
optionsBtn.addEventListener('click', () => openOptions());
document.getElementById('options-close').addEventListener('click', () => openOptions(false));
document.getElementById('random').addEventListener('click', () => {
  synth.unlock();
  randomWorld();
});
document.getElementById('photo').addEventListener('click', () => takePhoto());
document.getElementById('share').addEventListener('click', () => shareWorld());
exportBtn.addEventListener('click', () => openExport());
document.getElementById('help').addEventListener('click', () => openHelp(true));
document.getElementById('help-close').addEventListener('click', () => openHelp(false));
helpPanel.addEventListener('click', (e) => {
  if (e.target === helpPanel) openHelp(false);
});

// Held keys turn (Q/E) and tilt (R/F) smoothly; W A S D go to the thumbstick (walk or pan).
const held = new Set();
window.addEventListener('keydown', (e) => {
  if (!helpPanel.hidden) {
    if (e.key === 'Escape') openHelp(false);
    return;
  }
  if (e.target?.closest?.('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    undo();
  } else if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  } else if (e.key >= '1' && e.key <= '3') {
    setBiome(BIOME_ORDER[Number(e.key) - 1]);
  } else if (k === 'q' || k === 'e' || k === 'r' || k === 'f') {
    held.add(k);
  } else if (e.key === '+' || e.key === '=') {
    viewAction('zoom-in');
  } else if (e.key === '-' || e.key === '_') {
    viewAction('zoom-out');
  } else if (e.key === '0' || e.key === 'Home') {
    viewAction('reset');
  } else if (k === 'v') {
    toggleFold();
  } else if (k === 'o') {
    openOptions();
  } else if (k === 'p') {
    takePhoto();
  } else if (k === 'h' || e.key === '?') {
    openHelp(true);
  } else if (e.key === 'Escape' && !optionsPanel.hidden) {
    openOptions(false);
  } else if (e.key === 'Escape' && !exportPanel.hidden) {
    openExport(false);
  }
});
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());
setSculpt(SCULPT_NAMES[opts.sculpt] ? opts.sculpt : 'raise');
setTool(TOOL_NAMES[opts.tool] ? opts.tool : 'auto', { quiet: true });
applyOptions();

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  rig.fit(camera.aspect);
  inkPass.setSize();
  flow.uniforms.uPixelRatio.value = renderer.getPixelRatio() * (h / 900);
}
window.addEventListener('resize', onResize);
onResize();

// ------------------------------------------------------------------ main loop

function isWaterAt(x, z) {
  return parchment.sample(x / PAGE_SIZE + 0.5, z / PAGE_SIZE + 0.5) < WATER_H;
}

let wasPov = false;
const _sky = new THREE.Color();
const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(Math.max(timer.getDelta(), 0), 0.1);
  elapsed += dt;
  uniforms.uTime.value = elapsed;
  if (held.size) {
    const turn = (held.has('q') ? 1 : 0) - (held.has('e') ? 1 : 0);
    const tilt = (held.has('r') ? 1 : 0) - (held.has('f') ? 1 : 0);
    rig.orbit(turn * 1.6 * dt, tilt * 0.9 * dt);
  }
  rig.update(dt, terrainY, isWaterAt);
  const w = povWeight(rig.fold);
  // Fog follows the camera: a soft haze past the page from above, a horizon at ground level.
  scene.fog.near = rig.distance + 6 + (7 - rig.distance - 6) * w;
  scene.fog.far = rig.distance + 34 + (30 - rig.distance - 34) * w;
  inkPass.strength = opts.ink ? 0.3 + 0.6 * w : 0;
  if (rig.pov !== wasPov) {
    wasPov = rig.pov;
    stick.visible = wasPov;
    foldBtn.setAttribute('aria-pressed', String(wasPov));
    foldLabel.textContent = wasPov ? 'Map' : 'Walk';
    foldBtn.title = wasPov ? 'Fly back up to the map (V)' : 'Walk on the page (V)';
    canvas.style.cursor = wasPov || opts.tool === 'move' ? 'grab' : 'crosshair';
    document.body.classList.toggle('pov', wasPov);
  }
  stepSpring(dt);
  stepBiome(dt);
  // At ground level the dark room behind the table gives way to a soft, biome-tinted haze.
  _sky.copy(look.sky).multiplyScalar(0.62);
  scene.background.lerpColors(look.bg, _sky, w * 0.85);
  scene.fog.color.copy(scene.background);
  sprites.update(dt, camera);
  flow.update(dt);
  if (albedoDirty) {
    albedoTex.needsUpdate = true;
    albedoDirty = false;
  }
  inkPass.render(scene, camera);
});

// ------------------------------------------------------------------ start: shared link, else autosave

(async () => {
  try {
    if (isWorldHash(location.hash)) {
      loadWorld(await decodeWorld(location.hash));
      toast('Opened a shared world.');
      return;
    }
  } catch (err) {
    toast(`Couldn’t open that world link: ${err.message}`, 4000);
  }
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved && isWorldHash(saved)) loadWorld(await decodeWorld(saved));
  } catch {
    /* no saved world */
  }
  try {
    if (!localStorage.getItem('living-parchment-seen-help')) {
      localStorage.setItem('living-parchment-seen-help', '1');
      openHelp(true);
    }
  } catch {
    /* storage unavailable: skip the first-visit help */
  }
})();

// ------------------------------------------------------------------ debug / test hooks

window.renderer = renderer;
window.__lp = {
  renderer,
  scene,
  camera,
  rig,
  parchment,
  sprites,
  flow,
  synth,
  uniforms,
  spring,
  inkPass,
  stick,
  project,
  applyStroke,
  undo,
  redo,
  clearPage,
  randomWorld,
  randomEntries,
  takePhoto,
  setTool,
  viewAction,
  openOptions,
  applyOptions,
  opts,
  get redoStack() {
    return redoStack;
  },
  setBiome,
  shareWorld,
  exportWorld,
  openExport,
  expOpts,
  setSculpt,
  loadWorld,
  encodeWorld: () => encodeWorld(worldLog, BIOME_ORDER.indexOf(biome.id)),
  openHelp,
  get worldLog() {
    return worldLog;
  },
  get biome() {
    return biome.id;
  },
  get riverPaths() {
    return riverPaths;
  },
  terrainY,
  gestures,
};
