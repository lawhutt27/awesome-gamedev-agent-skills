// Living Parchment World-Builder: scene, renderer, lighting, diorama rim and main loop.
//
// Phase 1: a mobile-locked page whose offscreen canvases displace a 160x160 terrain plane,
//          with pen-scratch foley while you draw.
// Phase 2: strokes are classified on release into terraced hills, stone ruins, rivers or
//          planted paper-cutout flora, with three switchable biomes and a 10-step undo.

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
  HEIGHT_SCALE,
} from './terrain/TerrainShader.js';
import { GestureClassifier, OrbitRig } from './input/GestureClassifier.js';
import { BIOMES, BIOME_ORDER, DEFAULT_BIOME, pickWeighted, terrainContext } from './world/BiomeConfig.js';
import { SpriteInstancer, FlowParticles, SPRITE_SIZE } from './world/SpriteInstancer.js';
import { PaperSynth } from './audio/PaperSynth.js';

const canvas = document.getElementById('scene');
const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
// ?quality=low trades sharpness for speed (software GPUs, CI, very old phones).
const lowQuality = new URLSearchParams(location.search).get('quality') === 'low';

// ------------------------------------------------------------------ renderer + scene

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowQuality, powerPreference: 'high-performance' });
renderer.setPixelRatio(lowQuality ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 120);
const rig = new OrbitRig(camera);
rig.fit(camera.aspect);
rig.update(1);

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
  applyLook(look);
}

const biomeButtons = [...document.querySelectorAll('.stamp.biome')];
const biomeLabel = document.getElementById('biome-name');
let labelTimer = 0;
function setBiome(id) {
  const next = BIOMES[id];
  if (!next || next === biome) return;
  biome = next;
  // Start from the current interpolated look so rapid switches stay smooth.
  T.from = Object.fromEntries(Object.entries(look).map(([k, v]) => [k, v.clone ? v.clone() : v]));
  T.to = biomeLook(next);
  T.t = 0;
  sprites.flipTo(next.row, next.glow);
  for (const btn of biomeButtons) btn.setAttribute('aria-checked', String(btn.dataset.biome === id));
  biomeLabel.textContent = next.name;
  biomeLabel.classList.add('show');
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => biomeLabel.classList.remove('show'), 1400);
  synth.rustle();
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
  const t1 = (yBot - origin.y) / direction.y;
  const steps = 56;
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

function refreshUi() {
  undoBtn.disabled = !parchment.canUndo;
}

function onFirstStroke() {
  strokesMade++;
  if (strokesMade === 2) hint.classList.add('faded');
}

/** Plant a cluster (tap) or a row (flick) of sprites. Returns how many were planted. */
function plant(result) {
  const pts = result.points;
  if (!pts.length) return 0;
  const spots = [];
  const r = Math.random;
  if (result.kind === 'flick' && pts.length > 2) {
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
    const type = pickWeighted(biome.weights[ctx], r());
    const ok = sprites.add({
      x: (s.x - 0.5) * PAGE_SIZE,
      z: (s.y - 0.5) * PAGE_SIZE,
      type,
      scale: SPRITE_SIZE[type] * (0.8 + r() * 0.4),
      phase: r() * 6.283,
      spawn: elapsed + i * 0.06,
    });
    if (ok) {
      planted++;
      if (ctx !== 'water') marks.push(s);
      synth.pop(i);
    }
  });
  if (marks.length) parchment.plantMarks(marks, biome);
  return planted;
}

/** Apply a classified stroke to the world. Exposed for tests via window.__lp. */
function applyStroke(result) {
  const meta = { sprites: sprites.count, rivers: flow.riverCount, kind: result.kind };
  parchment.revertPreview();
  switch (result.kind) {
    case 'loop': {
      const { area } = parchment.raiseHill(result.points, biome);
      commitTerrain(true);
      synth.thud(Math.sqrt(area) * 3);
      break;
    }
    case 'ruin': {
      parchment.buildRuin(result.polygon, biome);
      commitTerrain(true);
      synth.thud(0.35);
      synth.knock();
      break;
    }
    case 'river': {
      const { path } = parchment.carveRiver(result.points, biome);
      flow.addRiver(path);
      riverPaths.push(path);
      commitTerrain(false);
      synth.splash();
      break;
    }
    default: {
      if (plant(result) === 0) {
        parchment.cancelStroke();
        albedoDirty = true;
        return null;
      }
      albedoDirty = true;
    }
  }
  parchment.commitStroke(meta);
  onFirstStroke();
  refreshUi();
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
  commitTerrain(false);
  synth.rustle();
  refreshUi();
}

function clearPage() {
  if (sprites.count === 0 && flow.riverCount === 0 && !parchment.canUndo) return;
  parchment.beginStroke();
  const meta = {
    kind: 'clear',
    sprites: sprites.count,
    rivers: flow.riverCount,
    clearedSprites: sprites.items.slice(),
    clearedRivers: riverPaths.slice(),
  };
  parchment.clear();
  sprites.truncate(0);
  flow.truncate(0);
  riverPaths = [];
  parchment.commitStroke(meta);
  commitTerrain(false);
  synth.rustle(true);
  refreshUi();
}

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
    onCancel() {
      synth.lift();
      lastUv = null;
      parchment.cancelStroke();
      albedoDirty = true;
    },
    onCameraGesture() {
      synth.unlock();
    },
  },
  Gesture,
);

// ------------------------------------------------------------------ UI

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
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (e.key >= '1' && e.key <= '3') {
    setBiome(BIOME_ORDER[Number(e.key) - 1]);
  }
});

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  rig.fit(camera.aspect);
  flow.uniforms.uPixelRatio.value = renderer.getPixelRatio() * (h / 900);
}
window.addEventListener('resize', onResize);
onResize();

// ------------------------------------------------------------------ main loop

const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(Math.max(timer.getDelta(), 0), 0.1);
  elapsed += dt;
  uniforms.uTime.value = elapsed;
  rig.update(dt);
  stepSpring(dt);
  stepBiome(dt);
  sprites.update(dt, camera);
  flow.update(dt);
  if (albedoDirty) {
    albedoTex.needsUpdate = true;
    albedoDirty = false;
  }
  renderer.render(scene, camera);
});

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
  project,
  applyStroke,
  undo,
  clearPage,
  setBiome,
  get biome() {
    return biome.id;
  },
  get riverPaths() {
    return riverPaths;
  },
  terrainY,
  gestures,
};
