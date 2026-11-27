// Living Parchment: Figures. Wiring for the stage, the tabs and every tool.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { InkEdgePass } from './render/InkEdgePass.js';
import { Figure, EXPRESSIONS } from './view/Figure.js';
import { World } from './view/World.js';
import { Thumbstick } from './input/Thumbstick.js';
import { CATALOG, CATEGORY_ORDER, SLOTS, SLOT_LABELS, SKIN_TONES, INKS, optionLabel } from './body/PartsCatalog.js';
import { SHAPE_DEFAULTS, SHAPE_RANGES, jointPositions, figureHeight, boneSegments, DEFORM } from './rig/Skeleton.js';
import { CLIP_NAMES } from './rig/Animations.js';
import { refit, zigzagCorners } from './build/Builder.js';
import { classifyStroke, resample } from './sketch/Inflate.js';
import {
  STYLES,
  STAT_NAMES,
  defaultState,
  normalize,
  clone,
  randomize,
  paletteVariants,
  encodeState,
  decodeState,
  History,
  saveLocal,
  loadLocal,
  loadLibrary,
  saveLibrary,
} from './state/State.js';
import { exportGLB, exportLODs, exportCrowd, download, safeName, triangleCount, DETAIL_LEVELS } from './export/Exporter.js';
import { photo, spriteSheets, turntableGif, characterCard } from './export/Media.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LOW = params.get('quality') === 'low';

// ------------------------------------------------------------------ renderer and stage

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW ? 1 : 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
window.renderer = renderer;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 80);
const ink = new InkEdgePass(renderer, { samples: LOW ? 0 : 4 });
ink.setSize();

scene.add(new THREE.HemisphereLight('#fff6e4', '#8a7556', 1.6));
const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
sun.position.set(2.5, 5, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(LOW ? 512 : 2048, LOW ? 512 : 2048);
sun.shadow.camera.left = -2.5;
sun.shadow.camera.right = 2.5;
sun.shadow.camera.top = 3;
sun.shadow.camera.bottom = -1;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const floor = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#e2d0a8', roughness: 1 }));
floor.receiveShadow = true;
floor.name = 'Floor';
scene.add(floor);

const figure = new Figure(scene);
const world = new World({ scene, figure, camera });
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 0.6;
controls.maxDistance = 12;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

// Mannequin guide for sketching: soft capsules along the bones.
const guide = new THREE.Group();
guide.name = 'Guide';
scene.add(guide);
const guideMat = new THREE.MeshBasicMaterial({ color: '#6c7f96', transparent: true, opacity: 0.22, depthWrite: false });
function rebuildGuide() {
  guide.clear();
  const J = jointPositions(state.shape);
  const segs = boneSegments(J);
  const k = state.shape.height;
  const radius = { Head: 0.11, Hips: 0.12, Spine: 0.11, Spine1: 0.12, Spine2: 0.13, Neck: 0.04 };
  for (const name of DEFORM) {
    if (/Shoulder|ToeBase/.test(name)) continue;
    const [a, b] = segs[name];
    const len = a.distanceTo(b);
    let r = (radius[name] ?? (/UpLeg/.test(name) ? 0.065 : /Leg/.test(name) ? 0.05 : /Foot/.test(name) ? 0.04 : /Hand/.test(name) ? 0.035 : 0.04)) * k;
    if (name === 'Head') r = len * 0.5;
    const geo = name === 'Head' ? new THREE.SphereGeometry(r, 20, 14) : new THREE.CapsuleGeometry(r, Math.max(0.001, len), 6, 12);
    const m = new THREE.Mesh(geo, guideMat);
    m.position.copy(a).lerp(b, 0.5);
    if (name !== 'Head') m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.renderOrder = 2;
    guide.add(m);
  }
}

// ------------------------------------------------------------------ state

let state = defaultState('swap');
const history = new History();
let tab = 'parts';
let tool = 'auto';
let sculptOp = 'grow';
let inkColor = '#b8342a';
let brush = 'normal';
let partCat = 'head';
let mode = 'build'; // 'build' | 'pose' | 'world'
let clipBeforeSketch = 'Idle';
const BRUSH_MM = { fine: { tube: 16, dot: 12 }, normal: { tube: 30, dot: 22 }, bold: { tube: 55, dot: 40 } };

function rebuild() {
  figure.rebuild(state);
  rebuildGuide();
  guide.visible = tab === 'sketch' && $('guide').checked && mode === 'build';
  applyStyle();
}

/** Record an undo step, change the state, rebuild and save. */
function commit(mutate, { record = true } = {}) {
  if (record) history.push(state);
  mutate(state);
  rebuild();
  saveLocal(state);
  refreshUI();
}

function setState(next, { record = true } = {}) {
  commit((s) => {
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, normalize(next));
  }, { record });
}

function undo() {
  const prev = history.undo(state);
  if (prev) {
    state = normalize(prev);
    rebuild();
    saveLocal(state);
    refreshUI();
  }
}
function redo() {
  const next = history.redo(state);
  if (next) {
    state = normalize(next);
    rebuild();
    saveLocal(state);
    refreshUI();
  }
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ style and camera

function applyStyle() {
  const st = STYLES[state.style] ?? STYLES.ink;
  scene.background = new THREE.Color(st.bg);
  floor.material.color.set(st.floor);
  ink.strength = st.ink === 0 ? 0.9 : st.ink;
  ink.material.uniforms.uInk.value.set(st.outline ?? '#1b1a16');
  document.body.classList.toggle('dark', state.style === 'chalk');
  floor.visible = !world.active;
}

let cameraPlaced = false;
/** Fit the whole figure into the part of the screen the bars and panels leave free. */
function frameCamera(front = false) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const h = figureHeight(state.shape);
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const desktop = W >= 900;
  const top = 64;
  const bottom = mode !== 'build' ? 80 : desktop ? 96 : Math.min(H * 0.38, 330) + 66;
  const free = Math.max(0.3, (H - top - bottom) / H);
  const span = h * 1.12 + 0.1;
  const armSpan = Math.max(2 * jointPositions(state.shape).LeftHand_End.x + 0.12, h * 0.6);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const freeW = desktop && mode === 'build' ? (W - 400) / W : 0.92;
  const dist = Math.max(span / free / 2 / Math.tan(vfov / 2), armSpan / freeW / 2 / Math.tan(hfov / 2));
  const visH = 2 * dist * Math.tan(vfov / 2);
  const target = new THREE.Vector3(0, h * 0.5 - ((bottom - top) / 2 / H) * visH, 0);
  let dir = front ? new THREE.Vector3(0, 0, 1) : camera.position.clone().sub(controls.target).normalize();
  // First framing (or a camera left looking up from under the floor): a friendly three-quarter view.
  if (!front && (!cameraPlaced || dir.y < -0.2 || !isFinite(dir.x))) dir = new THREE.Vector3(0.45, 0.1, 1).normalize();
  cameraPlaced = true;
  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(dir, dist);
  controls.update();
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.setViewOffset(w, h, w >= 900 && !world.active && mode !== 'pose' ? 180 : 0, 0, w, h);
  camera.updateProjectionMatrix();
  ink.setSize();
  inkCanvas.width = Math.round(w * devicePixelRatio);
  inkCanvas.height = Math.round(h * devicePixelRatio);
}

// ------------------------------------------------------------------ tabs and panels

function showTab(next) {
  const prev = tab;
  tab = next;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${tab}`;
  $('sketch-rail').hidden = tab !== 'sketch';
  if (tab === 'sketch' && prev !== 'sketch') {
    clipBeforeSketch = figure.clipName === 'TPose' ? clipBeforeSketch : figure.clipName;
    figure.setClip('TPose', true);
    frameCamera(true);
  } else if (prev === 'sketch' && tab !== 'sketch') {
    figure.setClip(clipBeforeSketch);
  }
  guide.visible = tab === 'sketch' && $('guide').checked;
  updateControls();
  refreshUI();
}

function updateControls() {
  const drawing = tab === 'sketch' && tool !== 'look';
  controls.enabled = mode === 'build' && !drawing;
  // While drawing, the right mouse button and two fingers still turn the view.
  if (drawing && mode === 'build') {
    controls.enabled = true;
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  } else {
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  if (mode !== 'build') controls.enabled = mode === 'pose';
}

const SKETCH_TIPS = {
  auto: 'Draw over the mannequin. Loops puff up, lines become limbs, taps make dots, zigzags make spikes.',
  blob: 'Every stroke puffs into a rounded shape. Draw on a part to add a bump.',
  tube: 'Every stroke becomes a limb, tail or horn. Draw across a part to lay a stripe on it.',
  dot: 'Tap to add eyes, buttons, spots or a nose.',
  spikes: 'Zigzag for hair, fur, spines or a crown.',
  sculpt: 'Tap a part to change it. Works on drawn parts and swapped parts.',
  paint: 'Tap a part to paint it with the ink colour.',
  erase: 'Tap a part to remove it.',
  look: 'Drag to turn the figure. Pick a drawing tool to keep sketching.',
};

function buildSwatches(el, colors, current, onPick, { custom = true } = {}) {
  el.innerHTML = '';
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', `Colour ${c}`);
    b.setAttribute('aria-pressed', String(c.toLowerCase() === current?.toLowerCase()));
    b.onclick = () => onPick(c);
    el.appendChild(b);
  }
  if (custom) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current ?? '#000000';
    input.title = 'Any colour';
    input.onchange = () => onPick(input.value);
    el.appendChild(input);
  }
}

function refreshUI() {
  $('undo').disabled = !history.canUndo;
  $('redo').disabled = !history.canRedo;
  // Sketch
  for (const b of document.querySelectorAll('#sketch-rail .tool-btn')) b.setAttribute('aria-checked', String(b.dataset.tool === tool));
  $('sketch-tip').textContent = SKETCH_TIPS[tool];
  $('sculpt-ops').hidden = tool !== 'sculpt';
  for (const b of document.querySelectorAll('#sculpt-ops button')) b.setAttribute('aria-checked', String(b.dataset.op === sculptOp));
  for (const b of document.querySelectorAll('#brush-size button')) b.setAttribute('aria-checked', String(b.dataset.size === brush));
  buildSwatches($('ink-swatches'), [...new Set([...INKS.slice(0, 13), state.colors.skin])], inkColor, (c) => {
    inkColor = c;
    refreshUI();
  });
  refreshKit();
  // Parts
  const cats = $('part-cats');
  cats.innerHTML = '';
  for (const c of CATEGORY_ORDER) {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c === partCat));
    b.dataset.cat = c;
    b.innerHTML = `${CATALOG[c].label}<span class="cur">${state.parts[c] === 'none' ? '' : optionLabel(state.parts[c])}</span>`;
    b.onclick = () => {
      partCat = c;
      refreshUI();
    };
    cats.appendChild(b);
  }
  const opts = $('part-options');
  opts.innerHTML = '';
  for (const key of Object.keys(CATALOG[partCat].options)) {
    const b = document.createElement('button');
    b.textContent = optionLabel(key);
    b.dataset.option = key;
    b.setAttribute('aria-pressed', String(state.parts[partCat] === key));
    b.onclick = () => {
      if (state.parts[partCat] === key) return;
      commit((s) => {
        s.parts[partCat] = key;
        delete s.tweak[partCat];
      });
    };
    opts.appendChild(b);
  }
  // Shape
  for (const [k] of Object.entries(SHAPE_RANGES)) {
    const input = document.querySelector(`#shape-sliders input[data-k='${k}']`);
    if (input && document.activeElement !== input) {
      input.value = state.shape[k];
      input.nextElementSibling.value = fmtShape(k, state.shape[k]);
    }
  }
  // Colors
  const styles = $('styles');
  styles.innerHTML = '';
  for (const [k, st] of Object.entries(STYLES)) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.style === k));
    b.textContent = st.label;
    b.onclick = () => commit((s) => (s.style = k));
    styles.appendChild(b);
  }
  const variants = $('variants');
  variants.innerHTML = '';
  for (const v of paletteVariants(state)) {
    const b = document.createElement('button');
    b.className = 'variant';
    b.style.background = `linear-gradient(90deg, ${v.colors.top} 0 34%, ${v.colors.bottom} 34% 67%, ${v.colors.accent} 67%)`;
    b.title = 'Apply this palette';
    b.onclick = () =>
      commit((s) => {
        s.colors = v.colors;
        s.paint = v.paint;
      });
    variants.appendChild(b);
  }
  const slots = $('slot-colors');
  slots.innerHTML = '';
  for (const slot of SLOTS) {
    const row = document.createElement('div');
    row.className = 'slot-row';
    row.innerHTML = `<span>${SLOT_LABELS[slot]}</span><div class="swatches"></div>`;
    const list = slot === 'skin' ? SKIN_TONES : INKS;
    buildSwatches(row.querySelector('.swatches'), list, state.colors[slot], (c) => commit((s) => (s.colors[slot] = c)));
    slots.appendChild(row);
  }
  $('paint-reset').hidden = !Object.keys(state.paint).length;
  // Motion
  const clips = $('clips');
  clips.innerHTML = '';
  for (const name of ['TPose', ...CLIP_NAMES, ...(state.pose ? ['Pose'] : [])]) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    const cur = tab === 'sketch' ? clipBeforeSketch : figure.clipName;
    b.setAttribute('aria-checked', String(cur === name));
    b.textContent = name === 'TPose' ? 'T-pose' : name === 'Pose' ? 'My pose' : name;
    b.onclick = () => {
      figure.setClip(name);
      refreshUI();
    };
    clips.appendChild(b);
  }
  const faces = $('faces');
  faces.innerHTML = '';
  for (const name of Object.keys(EXPRESSIONS)) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(figure.expression === name));
    b.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    b.onclick = () => {
      figure.setExpression(name);
      refreshUI();
    };
    faces.appendChild(b);
  }
  // Card
  const c = state.card;
  for (const [id, key] of [
    ['card-name', 'name'],
    ['card-role', 'role'],
    ['card-bio', 'bio'],
  ]) {
    if (document.activeElement !== $(id)) $(id).value = c[key] ?? '';
  }
  STAT_NAMES.forEach((_, i) => {
    const input = document.querySelector(`#card-stats input[data-i='${i}']`);
    if (input && document.activeElement !== input) {
      input.value = c.stats[i];
      input.nextElementSibling.value = c.stats[i];
    }
  });
}

function fmtShape(k, v) {
  if (k === 'height') return `${(figureHeight({ ...state.shape, height: Number(v) })).toFixed(2)} m`;
  if (k === 'belly') return `${Math.round(v * 100)}%`;
  return `${Math.round(v * 100)}%`;
}

function makeSlider(container, { label, min, max, step, value, data, onInput, onChange, fmt }) {
  const row = document.createElement('label');
  row.className = 'slider';
  row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output>${fmt(value)}</output>`;
  const input = row.querySelector('input');
  for (const [k, v] of Object.entries(data)) input.dataset[k] = v;
  let started = false;
  input.addEventListener('input', () => {
    if (!started) {
      started = true;
      history.push(state);
    }
    onInput(Number(input.value));
    input.nextElementSibling.value = fmt(input.value);
  });
  input.addEventListener('change', () => {
    started = false;
    onChange?.(Number(input.value));
    saveLocal(state);
    refreshUI();
  });
  container.appendChild(row);
  return input;
}

const SHAPE_LABELS = { height: 'Height', head: 'Head', build: 'Build', arms: 'Arms', legs: 'Legs', belly: 'Belly' };
let shapeTimer = 0;
for (const [k, [lo, hi]] of Object.entries(SHAPE_RANGES)) {
  makeSlider($('shape-sliders'), {
    label: SHAPE_LABELS[k],
    min: lo,
    max: hi,
    step: 0.01,
    value: state.shape[k],
    data: { k },
    fmt: (v) => fmtShape(k, v),
    onInput: (v) => {
      state.shape[k] = v;
      // Rebuilding is cheap but not free: coalesce fast slider drags.
      cancelAnimationFrame(shapeTimer);
      shapeTimer = requestAnimationFrame(rebuild);
    },
  });
}
STAT_NAMES.forEach((name, i) => {
  makeSlider($('card-stats'), {
    label: name,
    min: 0,
    max: 10,
    step: 1,
    value: 5,
    data: { i },
    fmt: (v) => String(v),
    onInput: (v) => (state.card.stats[i] = v),
  });
});

// ------------------------------------------------------------------ kitbash library

function refreshKit() {
  const list = $('kit-list');
  const lib = loadLibrary();
  list.innerHTML = lib.length ? '' : '<span class="empty">Nothing saved yet. Draw something, name it and press Save.</span>';
  lib.forEach((item, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'kit-item';
    const add = document.createElement('button');
    add.textContent = `+ ${item.name}`;
    add.title = 'Add to this figure';
    add.onclick = () => {
      commit((s) => s.strokes.push(...clone(item.strokes)));
      toast(`Added ${item.name}`);
    };
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete ${item.name}`);
    del.onclick = () => {
      const l = loadLibrary();
      l.splice(i, 1);
      saveLibrary(l);
      refreshKit();
    };
    wrap.append(add, del);
    list.appendChild(wrap);
  });
  $('kit-save').disabled = !state.strokes.length;
}

$('kit-save').onclick = () => {
  if (!state.strokes.length) return;
  const name = $('kit-name').value.trim() || `Drawing ${loadLibrary().length + 1}`;
  const lib = loadLibrary();
  lib.push({ name, strokes: clone(state.strokes) });
  saveLibrary(lib);
  $('kit-name').value = '';
  refreshKit();
  toast(`Saved "${name}" to My parts`);
};

// ------------------------------------------------------------------ sketching

const inkCanvas = $('ink');
const inkCtx = inkCanvas.getContext('2d');
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
let drawing = null;

function setRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

function planePoint(e) {
  setRay(e);
  // Draw on the plane through the figure facing the camera.
  const n = camera.getWorldDirection(new THREE.Vector3()).negate();
  n.y = 0;
  if (n.lengthSq() < 1e-4) n.set(0, 0, 1);
  plane.setFromNormalAndCoplanarPoint(n.normalize(), new THREE.Vector3(0, 0, 0));
  const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (!p) return null;
  // Strokes live in the figure's front plane: rotate back if the view is turned.
  const yaw = Math.atan2(n.x, n.z);
  p.applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  return p;
}

function drawInk() {
  inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  if (!drawing || drawing.screen.length < 1) return;
  const dpr = devicePixelRatio;
  inkCtx.strokeStyle = inkColor;
  inkCtx.fillStyle = inkColor;
  inkCtx.lineCap = 'round';
  inkCtx.lineJoin = 'round';
  inkCtx.lineWidth = (brush === 'fine' ? 3 : brush === 'normal' ? 5 : 8) * dpr;
  inkCtx.globalAlpha = 0.85;
  inkCtx.beginPath();
  drawing.screen.forEach(([x, y], i) => (i ? inkCtx.lineTo(x * dpr, y * dpr) : inkCtx.moveTo(x * dpr, y * dpr)));
  inkCtx.stroke();
  if (drawing.screen.length === 1) {
    const [x, y] = drawing.screen[0];
    inkCtx.beginPath();
    inkCtx.arc(x * dpr, y * dpr, inkCtx.lineWidth, 0, Math.PI * 2);
    inkCtx.fill();
  }
}

/** Does a front-plane point sit on the figure? Returns the hit or null. */
function surfaceHit(x, y) {
  raycaster.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
  return figure.pick(raycaster);
}

function finishStroke() {
  const pts = drawing.points;
  drawing = null;
  drawInk();
  if (!pts.length) return;
  let kind = classifyStroke(pts);
  const span = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const long = pts.length > 1 && (span > 0.02 || pts.length > 3);
  if (tool === 'blob') kind = pts.length > 3 ? 'loop' : 'dot';
  if (tool === 'tube') kind = long ? 'line' : 'dot';
  if (tool === 'dot') kind = 'dot';
  if (tool === 'spikes') kind = 'spikes';
  if (tool === 'auto' && kind === 'line' && zigzagCorners(pts).length >= 3) kind = 'spikes';
  const k = { loop: 'blob', line: 'tube', dot: 'dot', spikes: 'spikes' }[kind];
  let p = pts;
  if (k === 'dot') {
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
    p = [{ x: cx, y: cy }];
  } else if (k === 'blob') {
    p = resample(pts, Math.min(48, Math.max(12, pts.length)), true);
  } else {
    p = resample(pts, Math.min(40, Math.max(6, pts.length * 2)));
  }
  // Surface or free-standing: most of the stroke lying on the figure means "draw on it".
  const samples = k === 'dot' ? p : resample(p, 10, k === 'blob');
  const onBody = samples.filter((q) => surfaceHit(q.x, q.y)).length / samples.length;
  const z = k === 'dot' ? (onBody > 0 ? 'surf' : 'mid') : k === 'blob' ? (onBody > 0.95 && state.strokes.length + countParts() > 0 ? 'surf' : 'mid') : onBody >= 0.7 ? 'surf' : 'mid';
  // Store against the default body so the drawing follows the shape sliders.
  const J = jointPositions(state.shape);
  const J0 = jointPositions(SHAPE_DEFAULTS);
  const base = refit(p, J, J0);
  const flat = [];
  for (const q of base) flat.push(Math.round(q.x * 1000), Math.round(q.y * 1000));
  const mm = BRUSH_MM[brush];
  const stroke = { k, p: flat, c: inkColor, z, m: $('mirror').checked };
  if (k === 'tube' || k === 'spikes') stroke.r = Math.round(mm.tube / state.shape.height);
  if (k === 'dot') stroke.r = Math.round(mm.dot / state.shape.height);
  commit((s) => s.strokes.push(stroke));
}

function countParts() {
  return Object.values(state.parts).filter((v) => v !== 'none').length;
}

function editAt(e) {
  setRay(e);
  const hit = figure.pick(raycaster);
  if (!hit) return false;
  const ref = hit.object.userData.ref;
  if (tool === 'erase') {
    commit((s) => {
      if (ref.stroke !== undefined) s.strokes.splice(ref.stroke, 1);
      else s.parts[ref.cat] = 'none';
    });
    return true;
  }
  if (tool === 'paint') {
    commit((s) => {
      if (ref.stroke !== undefined) s.strokes[ref.stroke].c = inkColor;
      else s.paint[ref.cat] = inkColor;
    });
    return true;
  }
  if (tool === 'sculpt') {
    const f = { grow: ['s', 1.15], shrink: ['s', 1 / 1.15], puff: ['d', 1.25], flatten: ['d', 1 / 1.25] }[sculptOp];
    commit((s) => {
      const target = ref.stroke !== undefined ? s.strokes[ref.stroke] : (s.tweak[ref.cat] ??= {});
      // Puff and flatten on a tube or dot change its thickness instead.
      const key = ref.stroke !== undefined && f[0] === 'd' && target.k !== 'blob' ? 'r' : f[0];
      const cur = target[key] ?? (key === 'r' ? 30 : 1);
      target[key] = Math.round(Math.max(key === 'r' ? 4 : 0.3, Math.min(key === 'r' ? 200 : 3, cur * f[1])) * 1000) / 1000;
    });
    return true;
  }
  return false;
}

canvas.addEventListener('pointerdown', (e) => {
  if (mode === 'pose') return poseDown(e);
  if (mode !== 'build' || tab !== 'sketch' || tool === 'look') return;
  if (e.button !== 0 || !e.isPrimary) return;
  if (['erase', 'paint', 'sculpt'].includes(tool)) {
    editAt(e);
    return;
  }
  const p = planePoint(e);
  if (!p) return;
  drawing = { id: e.pointerId, points: [{ x: p.x, y: p.y }], screen: [[e.clientX, e.clientY]] };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  drawInk();
});
canvas.addEventListener('pointermove', (e) => {
  if (mode === 'pose') return poseMove(e);
  if (!drawing || e.pointerId !== drawing.id) return;
  const p = planePoint(e);
  if (!p) return;
  const last = drawing.points[drawing.points.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) < 0.004) return;
  drawing.points.push({ x: p.x, y: p.y });
  drawing.screen.push([e.clientX, e.clientY]);
  drawInk();
});
const endDraw = (e) => {
  if (mode === 'pose') return poseUp(e);
  if (!drawing || e.pointerId !== drawing.id) return;
  if (e.type === 'pointercancel') {
    drawing = null;
    drawInk();
    return;
  }
  finishStroke();
};
canvas.addEventListener('pointerup', endDraw);
canvas.addEventListener('pointercancel', endDraw);
// A second finger cancels the stroke in progress (it is a view gesture).
canvas.addEventListener('pointerdown', (e) => {
  if (drawing && e.pointerId !== drawing.id) {
    drawing = null;
    drawInk();
  }
});

// ------------------------------------------------------------------ pose mode

const handleGroup = new THREE.Group();
scene.add(handleGroup);
const handleMat = new THREE.MeshBasicMaterial({ color: '#b8342a', transparent: true, opacity: 0.85, depthTest: false });
const handleMeshes = {};
for (const key of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head']) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), handleMat);
  m.renderOrder = 10;
  m.userData.handle = key;
  handleMeshes[key] = m;
  handleGroup.add(m);
}
handleGroup.visible = false;
let poseDrag = null;

function placeHandles() {
  const h = figure.handles();
  for (const [k, m] of Object.entries(handleMeshes)) m.position.copy(h[k]);
}

function enterPose() {
  mode = 'pose';
  document.body.classList.add('mode-pose');
  $('pose-bar').hidden = false;
  figure.startPose();
  handleGroup.visible = true;
  guide.visible = false;
  placeHandles();
  resize();
  frameCamera(false);
  updateControls();
}

function exitPose(save) {
  if (save) {
    const pose = figure.capturePose();
    figure.clipName = 'Pose';
    commit((s) => (s.pose = pose));
  }
  mode = 'build';
  document.body.classList.remove('mode-pose');
  $('pose-bar').hidden = true;
  handleGroup.visible = false;
  figure.stopPose();
  resize();
  updateControls();
  refreshUI();
}

function poseDown(e) {
  setRay(e);
  const hit = raycaster.intersectObjects(Object.values(handleMeshes), false)[0];
  if (!hit) return;
  e.stopPropagation();
  controls.enabled = false;
  const key = hit.object.userData.handle;
  const n = camera.getWorldDirection(new THREE.Vector3()).negate();
  poseDrag = { id: e.pointerId, key, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.object.position.clone()) };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
}
function poseMove(e) {
  if (!poseDrag || e.pointerId !== poseDrag.id) return;
  setRay(e);
  const p = raycaster.ray.intersectPlane(poseDrag.plane, new THREE.Vector3());
  if (!p) return;
  figure.reach(poseDrag.key, p);
  placeHandles();
}
function poseUp(e) {
  if (!poseDrag || e.pointerId !== poseDrag.id) return;
  poseDrag = null;
  controls.enabled = true;
}

$('pose-btn').onclick = enterPose;
$('pose-done').onclick = () => exitPose(true);
$('pose-cancel').onclick = () => exitPose(false);
$('pose-reset').onclick = () => {
  figure.state = { ...figure.state, pose: null };
  figure.startPose();
  placeHandles();
};

// ------------------------------------------------------------------ world mode

const walk = { x: 0, y: 0 };
const stick = new Thumbstick($('stick'), walk);
let shiftDown = false;
window.addEventListener('keydown', (e) => e.key === 'Shift' && (shiftDown = true));
window.addEventListener('keyup', (e) => e.key === 'Shift' && (shiftDown = false));

function enterWorld() {
  mode = 'world';
  document.body.classList.add('mode-world');
  $('world-bar').hidden = false;
  stick.visible = true;
  guide.visible = false;
  world.enter();
  applyStyle();
  resize();
  updateControls();
}
function exitWorld() {
  world.exit();
  mode = 'build';
  document.body.classList.remove('mode-world');
  $('world-bar').hidden = true;
  stick.visible = false;
  applyStyle();
  resize();
  frameCamera(false);
  updateControls();
  refreshUI();
}
$('world-btn').onclick = enterWorld;
$('world-exit').onclick = exitWorld;
$('world-stage').onclick = () => world.resetStage();
$('world-file').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    await world.loadFile(f);
    toast(`Walking in ${f.name}`);
  } catch (err) {
    toast(`Could not open that file: ${err.message}`);
  }
  e.target.value = '';
};
$('world-save').onclick = async () => {
  const glb = await world.exportScene(state);
  toast((await download(glb, `${safeName(state.card.name)}_scene.glb`, 'model/gltf-binary')) || 'Saved the world and your figure as one .glb');
};

// ------------------------------------------------------------------ export dialog

const app = { renderer, scene, camera, ink, figure, floor, rendering: false };

function exStatus(msg) {
  $('ex-status').textContent = msg;
}
function updateTris() {
  const d = DETAIL_LEVELS[$('ex-detail').value];
  $('ex-tris').textContent = `${Math.round(triangleCount(state, d)).toLocaleString()} triangles`;
}
async function busy(label, fn) {
  exStatus(`${label}…`);
  for (const b of document.querySelectorAll('#export button')) b.disabled = true;
  await new Promise((r) => setTimeout(r, 30));
  try {
    await fn();
  } catch (err) {
    console.warn(err);
    exStatus(`Something went wrong: ${err.message}`);
    return;
  } finally {
    for (const b of document.querySelectorAll('#export button')) b.disabled = false;
  }
}
const base = () => safeName(state.card.name);
const glbOpts = () => ({ detail: DETAIL_LEVELS[$('ex-detail').value], animations: $('ex-anims').checked });

$('export-btn').onclick = () => {
  $('export').hidden = false;
  exStatus('');
  updateTris();
};
$('export-close').onclick = () => ($('export').hidden = true);
$('ex-detail').onchange = updateTris;
$('ex-glb').onclick = () =>
  busy('Building .glb', async () => {
    exStatus((await download(await exportGLB(state, glbOpts()), `${base()}.glb`, 'model/gltf-binary')) || 'Saved. In Blender: File, Import, glTF 2.0 (.glb/.gltf).');
  });
$('ex-vrm').onclick = () =>
  busy('Building VRM', async () => {
    exStatus((await download(await exportGLB(state, { ...glbOpts(), vrm: true }), `${base()}.vrm`, 'model/gltf-binary')) || 'Saved a VRM 1.0 avatar with humanoid bones and face expressions.');
  });
$('ex-lods').onclick = () =>
  busy('Building three levels of detail', async () => {
    exStatus((await download(await exportLODs(state, { animations: $('ex-anims').checked }), `${base()}_LODs.zip`, 'application/zip')) || 'Saved high, medium and low detail .glb files in one zip.');
  });
$('ex-crowd').onclick = () =>
  busy('Building the crowd', async () => {
    const n = Number($('ex-crowd-n').value);
    exStatus((await download(await exportCrowd(state, n, Date.now() % 100000, glbOpts()), `${base()}_crowd_${n}.zip`, 'application/zip')) || `Saved ${n} look-alike figures, each a rigged .glb.`);
  });
$('ex-sprites').onclick = () =>
  busy('Rendering sprite sheets', async () => {
    const zip = await spriteSheets(app, state, { directions: Number($('ex-dirs').value), cell: Number($('ex-cell').value) });
    exStatus((await download(zip, `${base()}_sprites.zip`, 'application/zip')) || 'Saved one sheet per animation plus atlas.json.');
  });
$('ex-link').onclick = () =>
  busy('Making a link', async () => {
    const code = await encodeState(state);
    const embedded = window.top !== window || /claudeusercontent|claude\.ai/.test(location.hostname);
    if (embedded) {
      // Inside the Artifact the page address is not one you can share, so copy the code itself.
      try {
        await navigator.clipboard.writeText(code);
        showCode(code);
        exStatus('Figure code copied. Paste it into Figure code, here or in the offline file, to open this exact figure.');
      } catch {
        showCode(code);
      }
      return;
    }
    const url = `${location.origin}${location.pathname}#c=${code}`;
    window.history.replaceState(null, '', `#c=${code}`);
    try {
      await navigator.clipboard.writeText(url);
      exStatus('Link copied. Anyone who opens it gets this exact figure.');
    } catch {
      exStatus('The link is in the address bar now.');
    }
  });
function showCode(code) {
  const box = $('ex-code');
  box.value = code;
  box.select();
  exStatus('Copy this figure code. Paste it into Figure code, here or in the offline file, to open this exact figure.');
}
$('ex-open-code').onclick = () =>
  busy('Opening the figure', async () => {
    const raw = $('ex-code').value.trim();
    const code = raw.includes('#c=') ? raw.split('#c=').pop() : raw;
    if (!code) return exStatus('Paste a figure code first.');
    try {
      setState(await decodeState(code));
      frameCamera(true);
      exStatus('Opened the figure from its code.');
    } catch {
      exStatus('That code could not be read.');
    }
  });
$('ex-photo').onclick = () =>
  busy('Taking a photo', async () => {
    exStatus((await download(await photo(app), `${base()}.png`, 'image/png')) || 'Saved a photo.');
  });
$('ex-gif').onclick = () =>
  busy('Spinning the turntable', async () => {
    exStatus((await download(await turntableGif(app, state), `${base()}_turntable.gif`, 'image/gif')) || 'Saved a turntable GIF.');
  });
$('ex-card').onclick = () =>
  busy('Drawing the card', async () => {
    exStatus((await download(await characterCard(app, state), `${base()}_card.png`, 'image/png')) || 'Saved the character card.');
  });

// ------------------------------------------------------------------ card inputs

for (const [id, key] of [
  ['card-name', 'name'],
  ['card-role', 'role'],
  ['card-bio', 'bio'],
]) {
  $(id).addEventListener('focus', () => history.push(state));
  $(id).addEventListener('input', () => {
    state.card[key] = $(id).value;
    saveLocal(state);
  });
  $(id).addEventListener('change', refreshUI);
}
$('card-download').onclick = async () => {
  const note = await download(await characterCard(app, state), `${base()}_card.png`, 'image/png');
  if (note) toast(note, 4000);
};

// ------------------------------------------------------------------ remaining controls

for (const b of document.querySelectorAll('.tab')) b.onclick = () => showTab(b.dataset.tab);
for (const b of document.querySelectorAll('#sketch-rail .tool-btn'))
  b.onclick = () => {
    tool = b.dataset.tool;
    if (tool !== 'look' && tab === 'sketch') frameCamera(true);
    updateControls();
    refreshUI();
  };
for (const b of document.querySelectorAll('#sculpt-ops button'))
  b.onclick = () => {
    sculptOp = b.dataset.op;
    refreshUI();
  };
for (const b of document.querySelectorAll('#brush-size button'))
  b.onclick = () => {
    brush = b.dataset.size;
    refreshUI();
  };
$('guide').onchange = () => (guide.visible = tab === 'sketch' && $('guide').checked);
$('springy').onchange = () => (figure.secondary = $('springy').checked);
$('shape-reset').onclick = () => commit((s) => (s.shape = { ...SHAPE_DEFAULTS }));
$('paint-reset').onclick = () => commit((s) => (s.paint = {}));
$('undo').onclick = undo;
$('redo').onclick = redo;
$('random').onclick = () => {
  setState(randomize(state, Date.now()));
  toast('A new figure. Undo brings the last one back.');
};
$('help-btn').onclick = () => ($('help').hidden = false);
$('help-close').onclick = () => ($('help').hidden = true);
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (e.key === 'Escape') {
    for (const id of ['export', 'help']) $(id).hidden = true;
    if (mode === 'pose') exitPose(false);
    if (mode === 'world') exitWorld();
  }
});
window.addEventListener('resize', () => {
  resize();
  if (mode === 'build') frameCamera(tab === 'sketch');
});

// ------------------------------------------------------------------ start

function begin(next, startTab) {
  state = normalize(next);
  rebuild();
  saveLocal(state);
  $('start').hidden = true;
  resize();
  frameCamera(false);
  showTab(startTab);
}

$('start-sketch').onclick = () => {
  begin(defaultState('sketch'), 'sketch');
  toast('Draw a loop for the body, another for the head, lines for arms.', 4200);
};
$('start-swap').onclick = () => begin(randomize(defaultState('swap'), Date.now()), 'parts');
$('start-continue').onclick = () => begin(loadLocal(), 'parts');

async function boot() {
  resize();
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('c')) {
    try {
      begin(await decodeState(hash.get('c')), 'parts');
      toast('Opened a shared figure');
      return;
    } catch {
      toast('That link could not be read');
    }
  }
  state = defaultState('swap');
  rebuild();
  frameCamera(false);
  showTab('parts');
  $('start').hidden = false;
  $('start-continue').hidden = !loadLocal();
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  if (app.rendering) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  figure.update(dt);
  if (mode === 'world') world.update(dt, walk, shiftDown);
  else controls.update();
  if (mode === 'pose') placeHandles();
  ink.render(scene, camera);
}

boot();
frame();
window.__figures = { get state() { return state; }, figure, world, camera, THREE, commit, setState, showTab, exportGLB, encodeState };
