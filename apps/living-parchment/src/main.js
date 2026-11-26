// Living Parchment World-Builder: scene, renderer, lighting, diorama rim and main loop.
//
// Phase 1: a mobile-locked page whose offscreen canvases displace a 160x160 terrain plane,
//          with pen-scratch foley while you draw.
// Phase 2: strokes are classified on release into terraced hills, stone ruins, rivers or
//          planted paper-cutout flora, with three switchable biomes and a 10-step undo.
// Phase 3: the pinch "Dimensional Fold" from a flat map down to a walkable first-person view,
//          a screen-space ink-edge pass, projected cliff ink, .glb export and world links.

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
import { canonicalPoints, encodeWorld, decodeWorld, isWorldHash } from './world/WorldSeed.js';
import { exportGLB, zipSingle } from './world/Exporter.js';
import { BIOMES, BIOME_ORDER, DEFAULT_BIOME, pickWeighted, terrainContext } from './world/BiomeConfig.js';
import { SpriteInstancer, FlowParticles, SPRITE_SIZE } from './world/SpriteInstancer.js';
import { PaperSynth } from './audio/PaperSynth.js';

const canvas = document.getElementById('scene');
const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
// ?quality=low trades sharpness for speed (software GPUs, CI, very old phones).
const lowQuality = new URLSearchParams(location.search).get('quality') === 'low';

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

function applyLook(l) {
  sun.color.copy(l.sunColor);
  sun.intensity = l.sunIntensity;
  _dir.copy(l.sunDir).normalize();
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

function refreshUi() {
  undoBtn.disabled = !parchment.canUndo;
}

function onFirstStroke() {
  strokesMade++;
  if (strokesMade === 2) hint.classList.add('faded');
}

/** Plant a cluster (tap) or a row (flick) of sprites. Returns how many were planted. */
function plant(kind, pts, b, r, live) {
  if (!pts.length) return 0;
  const spots = [];
  if (kind === 'flick' && pts.length > 1) {
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const p = pts[Math.round((i / (n - 1)) * (pts.length - 1))];
      spots.push({ x: p.x + (r() - 0.5) * 0.01, y: p.y + (r() - 0.5) * 0.01 });
    }
  } else {
    const c = pts[0];
    const n = 3 + Math.floor(r() * 4);
    // Reed beds hug the channel: tighter clusters when the tap lands in water.
    const wet = terrainContext(parchment.sample(c.x, c.y), 0, parchment.sample(c.x, c.y, 2)) === 'water';
    const spread = wet ? 0.35 : 1;
    spots.push({ x: c.x, y: c.y });
    for (let i = 1; i < n; i++) {
      const a = r() * Math.PI * 2;
      const d = (0.012 + r() * 0.03) * spread;
      spots.push({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d });
    }
  }
  let planted = 0;
  const marks = [];
  spots.forEach((s, i) => {
    if (s.x < 0.01 || s.x > 0.99 || s.y < 0.01 || s.y > 0.99) return;
    const h = parchment.sample(s.x, s.y, 3);
    const stone = parchment.sample(s.x, s.y, 1);
    const water = parchment.sample(s.x, s.y, 2);
    const ctx = terrainContext(h, stone, water);
    const type = pickWeighted(b.weights[ctx], r());
    const ok = sprites.add({
      x: (s.x - 0.5) * PAGE_SIZE,
      z: (s.y - 0.5) * PAGE_SIZE,
      type,
      scale: SPRITE_SIZE[type] * (0.8 + r() * 0.4),
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

/**
 * Apply one log entry to the page. Live strokes also animate and make sound; replayed
 * strokes (from a shared link) are applied silently and the terrain is committed once at the end.
 * Every random choice comes from the entry's own seed, so replays rebuild the same world.
 */
function applyEntry(entry, live) {
  const b = BIOMES[BIOME_ORDER[entry.biome]] ?? biome;
  const r = mulberry32(entry.seed);
  parchment.rand = r;
  switch (entry.kind) {
    case 'loop': {
      const { area } = parchment.raiseHill(entry.points, b);
      if (live) {
        commitTerrain(true);
        synth.thud(Math.sqrt(area) * 3);
      }
      return true;
    }
    case 'ruin': {
      parchment.buildRuin(entry.points, b);
      if (live) {
        commitTerrain(true);
        synth.thud(0.35);
        synth.knock();
      }
      return true;
    }
    case 'river': {
      const { path } = parchment.carveRiver(entry.points, b);
      flow.addRiver(path);
      riverPaths.push(path);
      if (live) {
        commitTerrain(false);
        synth.splash();
      }
      return true;
    }
    default:
      albedoDirty = true;
      return plant(entry.kind, entry.points, b, r, live) > 0;
  }
}

/** Apply a classified stroke to the world. Exposed for tests via window.__lp. */
function applyStroke(result) {
  const meta = { sprites: sprites.count, rivers: flow.riverCount, kind: result.kind, log: worldLog.length };
  parchment.beginStroke(); // no-op when the stroke already took its snapshot
  parchment.revertPreview();
  const source = result.kind === 'ruin' ? result.polygon : result.points;
  const entry = {
    kind: result.kind,
    biome: BIOME_ORDER.indexOf(biome.id),
    seed: (Math.random() * 0xffffffff) >>> 0,
    points: canonicalPoints(source, result.kind),
  };
  if (!applyEntry(entry, true)) {
    parchment.cancelStroke();
    albedoDirty = true;
    return null;
  }
  worldLog.push(entry);
  parchment.commitStroke(meta);
  onFirstStroke();
  refreshUi();
  scheduleAutosave();
  return result.kind;
}

function undo() {
  const meta = parchment.undo();
  if (!meta) return;
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
  commitTerrain(false);
  synth.rustle();
  refreshUi();
  scheduleAutosave();
}

function clearPage() {
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
  commitTerrain(false);
  synth.rustle(true);
  refreshUi();
  scheduleAutosave();
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

async function exportWorld({ download = true } = {}) {
  toast('Folding the diorama into a .glb…', 8000);
  await new Promise((r) => setTimeout(r, 30)); // let the toast paint
  const buf = await exportGLB({ parchment, sprites, noise: uniforms.uNoise.value, biome });
  if (download) {
    // Inside the claude.ai viewer, pages save files through the `downloads` capability, which
    // accepts .zip but not .glb; everywhere else a normal download link works.
    const downloads = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
    if (downloads) {
      try {
        const zip = zipSingle('living-parchment.glb', new Uint8Array(buf));
        await downloads.save({ filename: 'living-parchment-glb.zip', data: new Blob([zip]) });
        toast('Saved living-parchment-glb.zip (unzip it for the .glb).');
      } catch (err) {
        toast(err?.code === 'declined' ? 'Download cancelled.' : 'Downloads aren’t available here.');
      }
      return buf;
    }
    try {
      const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'living-parchment.glb';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Saved living-parchment.glb (${Math.round(buf.byteLength / 1024)} KB).`);
    } catch {
      toast('This page isn’t allowed to download files here.');
    }
  }
  return buf;
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
  },
  Gesture,
);

const stick = new Thumbstick(document.getElementById('stick'), rig.move);

// ------------------------------------------------------------------ UI

const foldBtn = document.getElementById('fold');
const foldLabel = document.getElementById('fold-label');
const helpPanel = document.getElementById('help-panel');
function toggleFold() {
  synth.unlock();
  rig.setFold(rig.goal.fold > 0.8 ? FOLD_DEFAULT : 1);
}
function openHelp(open = true) {
  helpPanel.hidden = !open;
  if (open) {
    document.querySelector('.help-card').scrollTop = 0;
    document.getElementById('help-close').focus({ preventScroll: true });
  } else document.getElementById('help').focus({ preventScroll: true });
}

for (const btn of biomeButtons) {
  btn.addEventListener('click', () => {
    synth.unlock();
    setBiome(btn.dataset.biome);
  });
}
undoBtn.addEventListener('click', () => {
  synth.unlock();
  undo();
});
document.getElementById('clear').addEventListener('click', () => {
  synth.unlock();
  clearPage();
});
foldBtn.addEventListener('click', toggleFold);
document.getElementById('share').addEventListener('click', () => shareWorld());
document.getElementById('export').addEventListener('click', () => exportWorld());
document.getElementById('help').addEventListener('click', () => openHelp(true));
document.getElementById('help-close').addEventListener('click', () => openHelp(false));
helpPanel.addEventListener('click', (e) => {
  if (e.target === helpPanel) openHelp(false);
});
window.addEventListener('keydown', (e) => {
  if (!helpPanel.hidden) {
    if (e.key === 'Escape') openHelp(false);
    return;
  }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    undo();
  } else if (e.key >= '1' && e.key <= '3') {
    setBiome(BIOME_ORDER[Number(e.key) - 1]);
  } else if (k === 'v') {
    toggleFold();
  } else if (k === 'h' || e.key === '?') {
    openHelp(true);
  }
});

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
  rig.update(dt, terrainY, isWaterAt);
  const w = povWeight(rig.fold);
  // Fog follows the camera: a soft haze past the page from above, a horizon at ground level.
  scene.fog.near = rig.distance + 6 + (7 - rig.distance - 6) * w;
  scene.fog.far = rig.distance + 34 + (30 - rig.distance - 34) * w;
  inkPass.strength = 0.3 + 0.6 * w;
  if (rig.pov !== wasPov) {
    wasPov = rig.pov;
    stick.visible = wasPov;
    foldBtn.setAttribute('aria-pressed', String(wasPov));
    foldLabel.textContent = wasPov ? 'Map' : 'Walk';
    foldBtn.title = wasPov ? 'Fly back up to the map (V)' : 'Walk on the page (V)';
    canvas.style.cursor = wasPov ? 'grab' : 'crosshair';
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
  clearPage,
  setBiome,
  shareWorld,
  exportWorld,
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
