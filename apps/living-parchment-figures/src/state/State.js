// The whole character as plain data: parts, colours, body shape, drawn strokes, pose and card.
// Everything else (meshes, skeleton, clips) is rebuilt from this, so it is what undo stores,
// what the share link carries and what autosave keeps.

import * as THREE from 'three';
import { CATALOG, CATEGORY_ORDER, DEFAULT_PARTS, EMPTY_PARTS, DEFAULT_COLORS, SKIN_TONES, INKS } from '../body/PartsCatalog.js';
import { SHAPE_DEFAULTS, SHAPE_RANGES } from '../rig/Skeleton.js';

export const VERSION = 1;

export const STYLES = {
  ink: { label: 'Ink & wash', ink: 0.55, toon: false, flat: false, bg: '#efe2c3', floor: '#e2d0a8' },
  paper: { label: 'Cut paper', ink: 0.85, toon: true, flat: true, bg: '#f3ead6', floor: '#d9c7a0' },
  woodblock: { label: 'Woodblock', ink: 0.95, toon: true, flat: false, bg: '#e8d9b5', floor: '#c9a978' },
  chalk: { label: 'Chalk', ink: 0.0, toon: true, flat: false, bg: '#2c3330', floor: '#3a4440', outline: '#f1ead8' },
};

export const STAT_NAMES = ['Strength', 'Agility', 'Wits', 'Charm'];

export function defaultCard() {
  return { name: 'Wanderer', role: 'Adventurer', bio: '', stats: [5, 5, 5, 5] };
}

/** A fresh character. mode 'sketch' starts from a bare mannequin, 'swap' from a dressed figure. */
export function defaultState(mode = 'swap') {
  return {
    v: VERSION,
    parts: mode === 'sketch' ? { ...EMPTY_PARTS } : { ...DEFAULT_PARTS },
    colors: { ...DEFAULT_COLORS },
    paint: {}, // per-category colour overrides from the Paint tool
    tweak: {}, // per-category { s: size, d: puff } from the Sculpt tool
    shape: { ...SHAPE_DEFAULTS },
    strokes: [],
    style: 'ink',
    pose: null,
    card: defaultCard(),
  };
}

export function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

/** Fill in anything an older or partial state is missing. */
export function normalize(raw) {
  const base = defaultState('swap');
  const s = { ...base, ...(raw ?? {}) };
  s.parts = { ...EMPTY_PARTS, ...(raw?.parts ?? base.parts) };
  for (const c of CATEGORY_ORDER) if (!(s.parts[c] in CATALOG[c].options)) s.parts[c] = 'none';
  s.colors = { ...DEFAULT_COLORS, ...(raw?.colors ?? {}) };
  s.shape = { ...SHAPE_DEFAULTS, ...(raw?.shape ?? {}) };
  for (const [k, [lo, hi]] of Object.entries(SHAPE_RANGES)) s.shape[k] = Math.max(lo, Math.min(hi, Number(s.shape[k]) || SHAPE_DEFAULTS[k]));
  s.strokes = Array.isArray(raw?.strokes) ? raw.strokes.filter((k) => k && Array.isArray(k.p)) : [];
  s.paint = raw?.paint ?? {};
  s.tweak = raw?.tweak ?? {};
  if (!(s.style in STYLES)) s.style = 'ink';
  s.card = { ...defaultCard(), ...(raw?.card ?? {}) };
  return s;
}

/** Small seeded generator so a crowd or a Random press can be replayed. */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

/** A whole random figure. Keeps drawn strokes and the card unless asked otherwise. */
export function randomize(state, seed = Date.now(), { keepStrokes = true } = {}) {
  const r = rng(seed);
  const s = clone(state);
  const weights = { none: 0.2 };
  for (const c of CATEGORY_ORDER) {
    const keys = Object.keys(CATALOG[c].options);
    let choices = keys;
    // The core body is always there; hats and extras are often skipped.
    if (['head', 'torso', 'legs', 'arms', 'eyes'].includes(c)) choices = keys.filter((k) => k !== 'none');
    if (['hat', 'extra'].includes(c) && r() < 0.45) {
      s.parts[c] = 'none';
      continue;
    }
    s.parts[c] = pick(r, choices);
    void weights;
  }
  if (s.parts.hands === 'none') s.parts.hands = 'mitten';
  if (s.parts.feet === 'none') s.parts.feet = 'shoes';
  s.colors.skin = pick(r, SKIN_TONES);
  const bright = INKS.filter((c) => !['#1d1712', '#f6efe0', '#e9dcc0'].includes(c));
  s.colors.top = pick(r, bright);
  s.colors.bottom = pick(r, bright);
  s.colors.hair = pick(r, ['#3b2a1e', '#1d1712', '#8a5a3b', '#d8a541', '#e0773a', '#c46d8e', '#e9dcc0', '#3b8fa8']);
  s.colors.accent = pick(r, bright);
  s.colors.shoes = pick(r, ['#4a3528', '#1d1712', '#3c4a6b', '#8c8a82', '#b8342a']);
  for (const [k, [lo, hi]] of Object.entries(SHAPE_RANGES)) {
    const t = (r() + r()) / 2; // lean to the middle
    s.shape[k] = Math.round((lo + (hi - lo) * t) * 100) / 100;
  }
  s.shape.height = Math.max(s.shape.height, 0.75);
  s.paint = {};
  s.tweak = {};
  if (!keepStrokes) s.strokes = [];
  return s;
}

/** Shift every colour's hue (and a little lightness) for palette variants. */
export function shiftPalette(colors, hueShift, light = 0) {
  const out = {};
  const c = new THREE.Color();
  const hsl = {};
  for (const [k, v] of Object.entries(colors)) {
    if (k === 'eyes' || k === 'white') {
      out[k] = v;
      continue;
    }
    c.set(v).getHSL(hsl);
    const shift = k === 'skin' ? hueShift * 0.15 : hueShift;
    c.setHSL((hsl.h + shift + 1) % 1, hsl.s, Math.max(0.08, Math.min(0.9, hsl.l + light)));
    out[k] = `#${c.getHexString()}`;
  }
  return out;
}

/** Four palette variants of a state (enemy tiers, teams). */
export function paletteVariants(state) {
  return [
    [0.33, 0],
    [0.5, -0.06],
    [0.67, 0],
    [0.12, 0.06],
  ].map(([h, l]) => ({ colors: shiftPalette(state.colors, h, l), paint: Object.fromEntries(Object.entries(state.paint).map(([k, v]) => [k, shiftPalette({ x: v }, h, l).x])) }));
}

// ---------------------------------------------------------------- share links

function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** State -> compact link code ("c1." + deflated JSON in base64url). */
export async function encodeState(state) {
  const json = new TextEncoder().encode(JSON.stringify(state));
  if (typeof CompressionStream === 'undefined') return `j1.${toBase64Url(json)}`;
  return `c1.${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

export async function decodeState(code) {
  const [tag, body] = code.split('.', 2);
  let bytes = fromBase64Url(body ?? '');
  if (tag === 'c1') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (tag !== 'j1') throw new Error('Unknown character link');
  return normalize(JSON.parse(new TextDecoder().decode(bytes)));
}

// ---------------------------------------------------------------- undo / redo

export class History {
  constructor(limit = 60) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }
  push(state) {
    this.past.push(JSON.stringify(state));
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(this.past.pop());
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(this.future.pop());
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}

// ---------------------------------------------------------------- browser storage

const SAVE_KEY = 'lp-figures-current';
const LIB_KEY = 'lp-figures-parts';

function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function saveLocal(state) {
  try {
    store()?.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {}
}

export function loadLocal() {
  try {
    const raw = store()?.getItem(SAVE_KEY);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Kitbash library: named sets of drawn strokes that can be added to any figure. */
export function loadLibrary() {
  try {
    return JSON.parse(store()?.getItem(LIB_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveLibrary(list) {
  try {
    store()?.setItem(LIB_KEY, JSON.stringify(list.slice(-40)));
  } catch {}
}
