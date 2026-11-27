// Swap-parts catalog: every option is a small procedural builder fitted to the skeleton, so a
// head, a torso or a pair of boots follows the body-shape sliders. A builder returns pieces:
//   { geo, slot, candidates? | rigid? }
// where slot names a colour (skin, top, bottom, hair, accent, shoes, eyes, white) and the bone
// fields decide skinning (see rig/Skinning.js).

import * as THREE from 'three';
import { V, limb, ellipsoid, roundedBox, cone, torus, sweep, mirrorX } from './Geometry.js';

export const SLOTS = ['skin', 'top', 'bottom', 'hair', 'accent', 'shoes', 'eyes', 'white'];

export const SLOT_LABELS = { skin: 'Skin', top: 'Top', bottom: 'Bottom', hair: 'Hair', accent: 'Accent', shoes: 'Shoes', eyes: 'Eyes', white: 'Whites' };

export const DEFAULT_COLORS = {
  skin: '#e7b48c',
  top: '#b8342a',
  bottom: '#3c4a6b',
  hair: '#3b2a1e',
  accent: '#d8a541',
  shoes: '#4a3528',
  eyes: '#1d1712',
  white: '#f6efe0',
};

export const SKIN_TONES = ['#f6d3b3', '#e7b48c', '#c98d62', '#9b6544', '#6b4330', '#9fc7a1', '#a9b8e0', '#d9a3c4'];
export const INKS = ['#1d1712', '#f6efe0', '#b8342a', '#e0773a', '#d8a541', '#7a9a3e', '#3e7a5e', '#3b8fa8', '#3c4a6b', '#6b4c8a', '#c46d8e', '#8a5a3b', '#4a3528', '#8c8a82', '#3b2a1e', '#e9dcc0'];

/** Head geometry plus the frame other face parts hang on. */
function headFrame(J) {
  const len = J.HeadTop_End.y - J.Head.y;
  const r = len * 0.5;
  return { r, C: V(0, J.Head.y + len * 0.48, J.Head.z + 0.005) };
}

const rigidHead = (geo, slot) => ({ geo, slot, rigid: 'Head' });

// ---------- Heads ----------
const HEADS = {
  none: () => [],
  round: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(ellipsoid(C, r, r, r * 0.96), 'skin')];
  },
  oval: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(ellipsoid(C, r * 0.86, r * 1.1, r * 0.92), 'skin')];
  },
  block: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(roundedBox(C, r * 0.95, r * 0.98, r * 0.88, r * 0.32), 'skin')];
  },
  bean: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(ellipsoid(C.clone().add(V(0, r * 0.12, 0)), r * 0.78, r * 1.22, r * 0.84), 'skin')];
  },
  cat: (J) => {
    const { r, C } = headFrame(J);
    const out = [rigidHead(ellipsoid(C, r * 1.02, r * 0.92, r * 0.92), 'skin')];
    for (const sx of [1, -1]) out.push(rigidHead(cone(C.clone().add(V(sx * r * 0.55, r * 0.55, 0)), C.clone().add(V(sx * r * 0.82, r * 1.32, 0)), r * 0.32), 'skin'));
    return out;
  },
  egg: (J) => {
    const { r, C } = headFrame(J);
    const g = limb([C.clone().add(V(0, -r * 0.95, 0)), C.clone().add(V(0, r * 0.95, 0))], [[0, r * 0.55, r * 0.55], [0.6, r * 1.12, r * 0.98], [1, r * 0.95, r * 0.9]], { count: 12, up: V(0, 0, 1) });
    return [rigidHead(g, 'skin')];
  },
};

// ---------- Eyes ----------
function eyeSpots(J, spread = 0.36, lift = 0.08) {
  const { r, C } = headFrame(J);
  return { r, C, y: C.y + r * lift, x: r * spread };
}

const EYES = {
  none: () => [],
  dots: (J, ctx) => {
    const { r, y, x } = eyeSpots(J);
    return [1, -1].map((sx) => rigidHead(ellipsoid(V(sx * x, y, ctx.surfaceZ(sx * x, y) - r * 0.04), r * 0.11, r * 0.14, r * 0.08), 'eyes'));
  },
  big: (J, ctx) => {
    const { r, y, x } = eyeSpots(J, 0.36, 0.1);
    const out = [];
    for (const sx of [1, -1]) {
      const z = ctx.surfaceZ(sx * x, y);
      out.push(rigidHead(ellipsoid(V(sx * x, y, z - r * 0.05), r * 0.21, r * 0.27, r * 0.1), 'white'));
      out.push(rigidHead(ellipsoid(V(sx * x * 0.94, y - r * 0.03, z + r * 0.03), r * 0.1, r * 0.13, r * 0.05), 'eyes'));
    }
    return out;
  },
  happy: (J, ctx) => {
    const { r, y, x } = eyeSpots(J);
    return [1, -1].map((sx) => {
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const a = Math.PI * (i / 6);
        const px = sx * x + Math.cos(a) * r * 0.16;
        const py = y - r * 0.05 + Math.sin(a) * r * 0.12;
        pts.push(V(px, py, ctx.surfaceZ(px, py) + r * 0.01));
      }
      return rigidHead(sweep(pts, pts.map(() => r * 0.035), { seg: 8 }), 'eyes');
    });
  },
  visor: (J, ctx) => {
    const { r, C, y } = eyeSpots(J);
    const z = ctx.surfaceZ(0, y);
    return [rigidHead(roundedBox(V(0, y, z - r * 0.08), r * 0.72, r * 0.17, r * 0.14, r * 0.08), 'accent')];
  },
  cyclops: (J, ctx) => {
    const { r, y } = eyeSpots(J);
    const z = ctx.surfaceZ(0, y);
    return [rigidHead(ellipsoid(V(0, y, z - r * 0.08), r * 0.32, r * 0.32, r * 0.14), 'white'), rigidHead(ellipsoid(V(0, y, z + r * 0.03), r * 0.14, r * 0.14, r * 0.06), 'eyes')];
  },
};

// ---------- Mouths ----------
const MOUTHS = {
  none: () => [],
  smile: (J, ctx) => {
    const { r, C } = headFrame(J);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (1 + i / 8);
      const px = Math.cos(a) * r * 0.26;
      const py = C.y - r * 0.32 + Math.sin(a) * r * 0.12;
      pts.push(V(px, py, ctx.surfaceZ(px, py) + r * 0.01));
    }
    return [rigidHead(sweep(pts, pts.map(() => r * 0.035), { seg: 8 }), 'eyes')];
  },
  open: (J, ctx) => {
    const { r, C } = headFrame(J);
    const y = C.y - r * 0.38;
    return [rigidHead(ellipsoid(V(0, y, ctx.surfaceZ(0, y) - r * 0.06), r * 0.16, r * 0.12, r * 0.08), 'eyes')];
  },
  fangs: (J, ctx) => {
    const { r, C } = headFrame(J);
    const y = C.y - r * 0.36;
    const out = [];
    for (const sx of [1, -1]) {
      const z = ctx.surfaceZ(sx * r * 0.14, y);
      out.push(rigidHead(cone(V(sx * r * 0.14, y, z - r * 0.02), V(sx * r * 0.14, y - r * 0.2, z + r * 0.02), r * 0.05), 'white'));
    }
    return out;
  },
};

// ---------- Hair ----------
function cap(C, r, scale = 1.08, theta = 0.56) {
  const g = new THREE.SphereGeometry(r * scale, 22, 12, 0, Math.PI * 2, 0, Math.PI * theta);
  g.rotateX(-0.32);
  g.translate(C.x, C.y + r * 0.02, C.z - r * 0.04);
  for (const n of ['uv', 'normal']) g.deleteAttribute(n);
  g.computeVertexNormals();
  return g;
}
const HAIR = {
  none: () => [],
  short: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(cap(C, r), 'hair')];
  },
  spiky: (J) => {
    const { r, C } = headFrame(J);
    const out = [rigidHead(cap(C, r, 1.06), 'hair')];
    const tips = [[0, 1.75, -0.1], [0.55, 1.45, 0.05], [-0.55, 1.45, 0.05], [0.4, 1.4, -0.6], [-0.4, 1.4, -0.6], [0.85, 1.05, -0.3], [-0.85, 1.05, -0.3], [0, 1.25, 0.55]];
    for (const [x, y, z] of tips) {
      const tip = C.clone().add(V(x * r, y * r, z * r));
      const base = C.clone().add(V(x * r * 0.45, y * r * 0.45, z * r * 0.45));
      out.push(rigidHead(cone(base, tip, r * 0.28), 'hair'));
    }
    return out;
  },
  bun: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(cap(C, r), 'hair'), rigidHead(ellipsoid(C.clone().add(V(0, r * 0.95, -r * 0.45)), r * 0.42, r * 0.38, r * 0.4), 'hair')];
  },
  long: (J) => {
    const { r, C } = headFrame(J);
    const back = limb([C.clone().add(V(0, r * 0.5, -r * 0.35)), C.clone().add(V(0, -r * 0.6, -r * 0.62)), C.clone().add(V(0, -r * 1.75, -r * 0.6))], [[0, r * 1.02, r * 0.55], [0.5, r * 1.0, r * 0.32], [1, r * 0.85, r * 0.16]], { count: 12, up: V(0, 0, 1) });
    return [rigidHead(cap(C, r, 1.08, 0.6), 'hair'), { geo: back, slot: 'hair', candidates: ['Head', 'HairBack'], power: 4 }];
  },
  mohawk: (J) => {
    const { r, C } = headFrame(J);
    const out = [];
    for (let i = 0; i < 5; i++) {
      const a = -0.35 + (i / 4) * 1.75; // from the forehead over the crown
      const dir = V(0, Math.cos(a), Math.sin(a) * -1 + 0.0).normalize();
      dir.set(0, Math.cos(a), -Math.sin(a));
      const base = C.clone().addScaledVector(dir, r * 0.85);
      const tip = C.clone().addScaledVector(dir, r * 1.55);
      out.push(rigidHead(cone(base, tip, r * 0.2), 'hair'));
    }
    return out;
  },
  afro: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(ellipsoid(C.clone().add(V(0, r * 0.4, -r * 0.42)), r * 1.32, r * 1.12, r * 1.02), 'hair')];
  },
};

// ---------- Hats ----------
function hatTop(J) {
  const { r, C } = headFrame(J);
  return { r, C, y: C.y + r * 0.72 };
}
const HATS = {
  none: () => [],
  wizard: (J) => {
    const { r, C, y } = hatTop(J);
    const brim = sweep([V(0, y - r * 0.02, C.z), V(0, y + r * 0.03, C.z)], [r * 1.6, r * 1.6], { round: false, up: V(0, 0, 1) });
    const tip = limb([V(0, y, C.z), V(0, y + r * 1.4, C.z - r * 0.2), V(0, y + r * 2.4, C.z - r * 0.9)], [[0, r * 0.98, r * 0.98], [0.6, r * 0.4, r * 0.4], [1, r * 0.04, r * 0.04]], { count: 14, up: V(0, 0, 1) });
    return [rigidHead(brim, 'accent'), rigidHead(tip, 'accent')];
  },
  tophat: (J) => {
    const { r, C, y } = hatTop(J);
    const brim = sweep([V(0, y - r * 0.02, C.z), V(0, y + r * 0.05, C.z)], [r * 1.35, r * 1.35], { round: false });
    const crown = sweep([V(0, y, C.z), V(0, y + r * 1.25, C.z)], [r * 0.82, r * 0.88], { round: false });
    const band = sweep([V(0, y + r * 0.05, C.z), V(0, y + r * 0.3, C.z)], [r * 0.85, r * 0.85], { round: false });
    return [rigidHead(brim, 'eyes'), rigidHead(crown, 'eyes'), rigidHead(band, 'accent')];
  },
  crown: (J) => {
    const { r, C, y } = hatTop(J);
    const out = [rigidHead(sweep([V(0, y - r * 0.05, C.z), V(0, y + r * 0.35, C.z)], [r * 0.9, r * 0.92], { round: false }), 'accent')];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const x = Math.sin(a) * r * 0.86;
      const z = C.z + Math.cos(a) * r * 0.86;
      out.push(rigidHead(cone(V(x, y + r * 0.3, z), V(x * 1.04, y + r * 0.85, z), r * 0.2), 'accent'));
    }
    return out;
  },
  cap: (J) => {
    const { r, C } = headFrame(J);
    const bill = roundedBox(V(0, C.y + r * 0.42, C.z + r * 1.05), r * 0.75, r * 0.05, r * 0.45, r * 0.04);
    return [rigidHead(cap(C, r, 1.12, 0.5), 'accent'), rigidHead(bill, 'accent')];
  },
  horns: (J) => {
    const { r, C } = headFrame(J);
    const out = [];
    for (const sx of [1, -1]) {
      const pts = [C.clone().add(V(sx * r * 0.6, r * 0.55, 0)), C.clone().add(V(sx * r * 1.15, r * 0.85, 0)), C.clone().add(V(sx * r * 1.3, r * 1.45, -r * 0.1))];
      out.push(rigidHead(limb(pts, [[0, r * 0.22, r * 0.22], [1, r * 0.03, r * 0.03]], { count: 12, up: V(0, 0, 1) }), 'white'));
    }
    return out;
  },
  beanie: (J) => {
    const { r, C } = headFrame(J);
    return [rigidHead(cap(C, r, 1.13, 0.52), 'accent'), rigidHead(ellipsoid(C.clone().add(V(0, r * 1.18, -r * 0.3)), r * 0.25, r * 0.25, r * 0.25), 'white')];
  },
};

// ---------- Torsos ----------
const TORSO_BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck'];
function torsoPiece(J, s, prof) {
  const k = s.height;
  const w = s.build;
  const bottom = V(0, J.Hips.y - 0.07 * k, 0);
  const top = V(0, J.Neck.y + 0.01 * k, 0);
  const belly = s.belly ?? 0;
  const profile = prof.map(([t, a, b]) => {
    const bump = belly * Math.exp(-Math.pow((t - 0.38) / 0.22, 2));
    return [t, (a + bump * 0.05) * k * w, (b + bump * 0.09) * k * Math.sqrt(w)];
  });
  const ctrl = [bottom, V(0, J.Spine.y, 0.004 * k), V(0, J.Spine2.y, 0.008 * k), top];
  return { geo: limb(ctrl, profile, { count: 16, up: V(0, 0, 1) }), slot: 'top', candidates: TORSO_BONES };
}
function neckPiece(J, s, slot = 'skin') {
  const k = s.height;
  return { geo: limb([J.Neck.clone(), J.Head.clone().add(V(0, 0.03 * k, 0))], [[0, 0.042 * k, 0.042 * k], [1, 0.038 * k, 0.04 * k]], { count: 6 }), slot, candidates: ['Neck', 'Head', 'Spine2'] };
}
const TORSOS = {
  none: () => [],
  regular: (J, ctx) => [torsoPiece(J, ctx.shape, [[0, 0.135, 0.1], [0.3, 0.13, 0.095], [0.7, 0.155, 0.1], [0.9, 0.13, 0.085], [1, 0.05, 0.05]]), neckPiece(J, ctx.shape)],
  slim: (J, ctx) => [torsoPiece(J, ctx.shape, [[0, 0.11, 0.08], [0.35, 0.095, 0.075], [0.7, 0.12, 0.08], [0.9, 0.105, 0.07], [1, 0.045, 0.045]]), neckPiece(J, ctx.shape)],
  hero: (J, ctx) => [torsoPiece(J, ctx.shape, [[0, 0.12, 0.095], [0.3, 0.11, 0.09], [0.72, 0.2, 0.12], [0.9, 0.17, 0.1], [1, 0.06, 0.06]]), neckPiece(J, ctx.shape)],
  barrel: (J, ctx) => [torsoPiece(J, ctx.shape, [[0, 0.15, 0.13], [0.4, 0.21, 0.18], [0.75, 0.19, 0.15], [0.92, 0.13, 0.1], [1, 0.05, 0.05]]), neckPiece(J, ctx.shape)],
  pear: (J, ctx) => [torsoPiece(J, ctx.shape, [[0, 0.18, 0.13], [0.35, 0.17, 0.13], [0.72, 0.13, 0.095], [0.9, 0.115, 0.08], [1, 0.045, 0.045]]), neckPiece(J, ctx.shape)],
  robot: (J, ctx) => {
    const k = ctx.shape.height;
    const w = ctx.shape.build;
    const chest = roundedBox(V(0, (J.Spine1.y + J.Neck.y) / 2, 0), 0.17 * k * w, ((J.Neck.y - J.Spine1.y) / 2) * 0.98, 0.11 * k, 0.03 * k);
    const waist = roundedBox(V(0, (J.Hips.y + J.Spine1.y) / 2 - 0.02 * k, 0), 0.13 * k * w, ((J.Spine1.y - J.Hips.y) / 2) * 0.9, 0.09 * k, 0.03 * k);
    return [
      { geo: chest, slot: 'top', candidates: ['Spine1', 'Spine2', 'Neck'] },
      { geo: waist, slot: 'accent', candidates: ['Hips', 'Spine'] },
      neckPiece(J, ctx.shape, 'accent'),
    ];
  },
};

// ---------- Arms ----------
function armPieces(J, s, side, { upper, lower, slotUpper = 'top', slotLower = 'skin', split = true }) {
  const k = s.height;
  const a = J[`${side}Arm`];
  const f = J[`${side}ForeArm`];
  const h = J[`${side}Hand`];
  const bones = [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`];
  const start = a.clone().lerp(J[`${side}Shoulder`], 0.35);
  if (!split) return [{ geo: limb([start, f, h], [...upper, ...lower].map(([t, r0, r1]) => [t, r0 * k, r1 * k]), { count: 16, up: V(0, 0, 1) }), slot: slotUpper, candidates: bones }];
  return [
    { geo: limb([start, f.clone().lerp(h, 0.08)], upper.map(([t, r0, r1]) => [t, r0 * k, r1 * k]), { count: 9, up: V(0, 0, 1) }), slot: slotUpper, candidates: bones },
    { geo: limb([f.clone().lerp(a, 0.06), h], lower.map(([t, r0, r1]) => [t, r0 * k, r1 * k]), { count: 9, up: V(0, 0, 1) }), slot: slotLower, candidates: bones },
  ];
}
const bothSides = (fn) => (J, ctx) => [...fn(J, ctx, 'Left'), ...fn(J, ctx, 'Right')];
const ARMS = {
  none: () => [],
  tee: bothSides((J, ctx, side) => armPieces(J, ctx.shape, side, { upper: [[0, 0.058, 0.058], [1, 0.05, 0.05]], lower: [[0, 0.04, 0.04], [1, 0.034, 0.032]] })),
  sleeves: bothSides((J, ctx, side) => armPieces(J, ctx.shape, side, { upper: [[0, 0.056, 0.056], [1, 0.046, 0.046]], lower: [[0, 0.046, 0.046], [0.85, 0.05, 0.05], [1, 0.054, 0.054]], slotLower: 'top' })),
  noodle: bothSides((J, ctx, side) => armPieces(J, ctx.shape, side, { upper: [[0, 0.028, 0.028], [1, 0.026, 0.026]], lower: [[0, 0.026, 0.026], [1, 0.024, 0.024]], slotUpper: 'skin' })),
  strong: bothSides((J, ctx, side) =>
    armPieces(J, ctx.shape, side, {
      upper: [[0, 0.07, 0.07], [0.5, 0.075, 0.068], [1, 0.05, 0.05]],
      lower: [[0, 0.05, 0.05], [0.35, 0.06, 0.055], [1, 0.04, 0.035]],
      slotUpper: 'skin',
    }),
  ),
  robot: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const bones = [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`];
    const a = J[`${side}Arm`];
    const f = J[`${side}ForeArm`];
    const h = J[`${side}Hand`];
    return [
      { geo: sweep([a.clone().lerp(f, 0.12), f.clone().lerp(a, 0.12)], [0.04 * k, 0.04 * k], { round: false }), slot: 'top', candidates: bones },
      { geo: sweep([f.clone().lerp(h, 0.12), h.clone().lerp(f, 0.1)], [0.036 * k, 0.036 * k], { round: false }), slot: 'top', candidates: bones },
      { geo: ellipsoid(a, 0.055 * k, 0.055 * k, 0.055 * k), slot: 'accent', rigid: `${side}Arm` },
      { geo: ellipsoid(f, 0.045 * k, 0.045 * k, 0.045 * k), slot: 'accent', rigid: `${side}ForeArm` },
    ];
  }),
};

// ---------- Hands ----------
const HANDS = {
  none: () => [],
  mitten: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const h = J[`${side}Hand`];
    const e = J[`${side}Hand_End`];
    const c = h.clone().lerp(e, 0.45);
    const sx = side === 'Left' ? 1 : -1;
    return [
      { geo: ellipsoid(c, Math.abs(e.x - h.x) * 0.55, 0.03 * k, 0.045 * k), slot: 'skin', rigid: `${side}Hand` },
      { geo: ellipsoid(c.clone().add(V(-sx * 0.01 * k, 0.005 * k, 0.04 * k)), 0.028 * k, 0.018 * k, 0.018 * k), slot: 'skin', rigid: `${side}Hand` },
    ];
  }),
  ball: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const c = J[`${side}Hand`].clone().lerp(J[`${side}Hand_End`], 0.4);
    return [{ geo: ellipsoid(c, 0.05 * k, 0.05 * k, 0.05 * k), slot: 'skin', rigid: `${side}Hand` }];
  }),
  gloves: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const h = J[`${side}Hand`];
    const e = J[`${side}Hand_End`];
    const c = h.clone().lerp(e, 0.45);
    return [
      { geo: ellipsoid(c, Math.abs(e.x - h.x) * 0.6, 0.035 * k, 0.05 * k), slot: 'white', rigid: `${side}Hand` },
      { geo: sweep([h.clone().lerp(J[`${side}ForeArm`], 0.12), h.clone().lerp(e, 0.05)], [0.05 * k, 0.05 * k], { round: false }), slot: 'white', rigid: `${side}Hand` },
    ];
  }),
  claws: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const h = J[`${side}Hand`];
    const e = J[`${side}Hand_End`];
    const sx = side === 'Left' ? 1 : -1;
    const palm = h.clone().lerp(e, 0.3);
    const out = [{ geo: ellipsoid(palm, 0.04 * k, 0.03 * k, 0.04 * k), slot: 'skin', rigid: `${side}Hand` }];
    for (const dz of [-0.025, 0, 0.025]) out.push({ geo: cone(palm.clone().add(V(sx * 0.025 * k, 0, dz * k)), e.clone().add(V(sx * 0.02 * k, -0.02 * k, dz * 1.3 * k)), 0.014 * k), slot: 'white', rigid: `${side}Hand` });
    return out;
  }),
};

// ---------- Legs ----------
function legPiece(J, s, side, ctrlFrom, ctrlTo, prof, slot) {
  const k = s.height;
  const w = Math.sqrt(s.build);
  const bones = [`${side}UpLeg`, `${side}Leg`, `${side}Foot`];
  return { geo: limb([ctrlFrom, ctrlTo], prof.map(([t, a, b]) => [t, a * k * w, b * k * w]), { count: 10, up: V(0, 0, 1) }), slot, candidates: bones };
}
function pelvis(J, s, slot = 'bottom') {
  const k = s.height;
  const w = s.build;
  return { geo: ellipsoid(V(0, J.Hips.y - 0.035 * k, 0), 0.15 * k * w, 0.085 * k, 0.1 * k * Math.sqrt(w)), slot, candidates: ['Hips', 'Spine'] };
}
function legsWith(upperProf, lowerProf, slotUpper, slotLower) {
  return (J, ctx) => {
    const out = [pelvis(J, ctx.shape)];
    for (const side of ['Left', 'Right']) {
      const u = J[`${side}UpLeg`];
      const l = J[`${side}Leg`];
      const f = J[`${side}Foot`];
      out.push(legPiece(J, ctx.shape, side, u.clone().add(V(0, 0.02, 0)), l.clone().lerp(f, 0.06), upperProf, slotUpper));
      out.push(legPiece(J, ctx.shape, side, l.clone().lerp(u, 0.06), f.clone().add(V(0, 0.02 * ctx.shape.height, 0)), lowerProf, slotLower));
    }
    return out;
  };
}
const LEGS = {
  none: () => [],
  trousers: legsWith([[0, 0.078, 0.082], [1, 0.058, 0.062]], [[0, 0.058, 0.062], [1, 0.05, 0.052]], 'bottom', 'bottom'),
  shorts: legsWith([[0, 0.08, 0.084], [1, 0.068, 0.07]], [[0, 0.046, 0.05], [0.4, 0.05, 0.054], [1, 0.036, 0.038]], 'bottom', 'skin'),
  strong: legsWith([[0, 0.1, 0.1], [0.5, 0.09, 0.09], [1, 0.064, 0.066]], [[0, 0.062, 0.066], [0.4, 0.066, 0.07], [1, 0.048, 0.05]], 'bottom', 'bottom'),
  skinny: legsWith([[0, 0.05, 0.052], [1, 0.04, 0.042]], [[0, 0.04, 0.042], [1, 0.032, 0.034]], 'bottom', 'bottom'),
  robe: (J, ctx) => {
    const k = ctx.shape.height;
    const w = ctx.shape.build;
    const top = V(0, J.Spine.y, 0);
    const bottom = V(0, J.LeftFoot.y + 0.04 * k, 0);
    const geo = limb([top, bottom], [[0, 0.14 * k * w, 0.1 * k], [0.25, 0.16 * k * w, 0.115 * k], [1, 0.25 * k * w, 0.17 * k]], { count: 12, up: V(0, 0, 1), capEnd: true });
    return [{ geo, slot: 'bottom', candidates: ['Hips', 'Spine', 'LeftUpLeg', 'RightUpLeg'], power: 2 }];
  },
};

// ---------- Feet ----------
const FEET = {
  none: () => [],
  shoes: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const f = J[`${side}Foot`];
    const t = J[`${side}Toe_End`];
    const c = V(f.x, 0.04 * k, (f.z + t.z) / 2 - 0.005 * k);
    return [{ geo: ellipsoid(c, 0.055 * k, 0.045 * k, (t.z - f.z) / 2 + 0.05 * k), slot: 'shoes', candidates: [`${side}Foot`, `${side}ToeBase`] }];
  }),
  boots: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const f = J[`${side}Foot`];
    const l = J[`${side}Leg`];
    const t = J[`${side}Toe_End`];
    const c = V(f.x, 0.04 * k, (f.z + t.z) / 2 - 0.005 * k);
    return [
      { geo: ellipsoid(c, 0.06 * k, 0.048 * k, (t.z - f.z) / 2 + 0.055 * k), slot: 'shoes', candidates: [`${side}Foot`, `${side}ToeBase`] },
      { geo: sweep([V(f.x, 0.04 * k, f.z), f.clone().lerp(l, 0.55)], [0.064 * k, 0.07 * k], { round: false }), slot: 'shoes', candidates: [`${side}Leg`, `${side}Foot`] },
    ];
  }),
  paws: bothSides((J, ctx, side) => {
    const k = ctx.shape.height;
    const f = J[`${side}Foot`];
    const t = J[`${side}Toe_End`];
    const out = [{ geo: ellipsoid(V(f.x, 0.045 * k, (f.z + t.z) / 2 - 0.01 * k), 0.06 * k, 0.05 * k, 0.09 * k), slot: 'skin', candidates: [`${side}Foot`, `${side}ToeBase`] }];
    for (const dx of [-0.032, 0, 0.032]) out.push({ geo: ellipsoid(V(f.x + dx * k, 0.03 * k, t.z + 0.005 * k), 0.018 * k, 0.018 * k, 0.02 * k), slot: 'skin', rigid: `${side}ToeBase` });
    return out;
  }),
};

// ---------- Extras ----------
const EXTRAS = {
  none: () => [],
  cape: (J, ctx) => {
    const k = ctx.shape.height;
    const w = ctx.shape.build;
    const top = V(0, J.Neck.y - 0.02 * k, -0.11 * k);
    const mid = V(0, J.Spine.y, -0.16 * k);
    const bot = V(0, J.LeftLeg.y + 0.02 * k, -0.2 * k);
    const geo = limb([top, mid, bot], [[0, 0.17 * k * w, 0.012 * k], [0.4, 0.22 * k * w, 0.014 * k], [1, 0.28 * k * w, 0.014 * k]], { count: 14, up: V(0, 0, 1), round: false });
    return [{ geo, slot: 'accent', candidates: ['Spine2', 'Cape1', 'Cape2'], power: 4 }];
  },
  tail: (J, ctx) => {
    const k = ctx.shape.height;
    const pts = [J.Tail1, J.Tail2, J.Tail3, J.Tail_End].map((p) => p.clone());
    return [{ geo: limb(pts, [[0, 0.05 * k, 0.05 * k], [1, 0.012 * k, 0.012 * k]], { count: 16, up: V(0, 1, 0) }), slot: 'hair', candidates: ['Tail1', 'Tail2', 'Tail3'], power: 4 }];
  },
  backpack: (J, ctx) => {
    const k = ctx.shape.height;
    const y = (J.Spine1.y + J.Spine2.y) / 2;
    return [
      { geo: roundedBox(V(0, y, -0.17 * k), 0.13 * k, 0.16 * k, 0.07 * k, 0.04 * k), slot: 'accent', rigid: 'Spine1' },
      { geo: roundedBox(V(0, y - 0.07 * k, -0.24 * k), 0.09 * k, 0.06 * k, 0.025 * k, 0.02 * k), slot: 'accent', rigid: 'Spine1' },
    ];
  },
  wings: (J, ctx) => {
    const k = ctx.shape.height;
    const y = J.Spine2.y;
    const one = limb([V(0.05 * k, y, -0.15 * k), V(0.35 * k, y + 0.22 * k, -0.22 * k), V(0.6 * k, y + 0.05 * k, -0.24 * k)], [[0, 0.06 * k, 0.012 * k], [0.4, 0.12 * k, 0.012 * k], [1, 0.03 * k, 0.008 * k]], { count: 14, up: V(0, 0, 1) });
    return [
      { geo: one, slot: 'white', rigid: 'Spine2' },
      { geo: mirrorX(one), slot: 'white', rigid: 'Spine2' },
    ];
  },
  scarf: (J, ctx) => {
    const k = ctx.shape.height;
    const y = J.Neck.y + 0.01 * k;
    const tail = limb([V(0.06 * k, y - 0.02 * k, 0.07 * k), V(0.08 * k, y - 0.2 * k, 0.12 * k)], [[0, 0.04 * k, 0.012 * k], [1, 0.045 * k, 0.012 * k]], { count: 6, round: false });
    return [
      { geo: torus(V(0, y, 0), 0.06 * k, 0.03 * k), slot: 'accent', candidates: ['Neck', 'Spine2'] },
      { geo: tail, slot: 'accent', rigid: 'Spine2' },
    ];
  },
};

/** Category -> { label, options } in the order the Parts panel shows them. */
export const CATALOG = {
  head: { label: 'Head', options: HEADS },
  eyes: { label: 'Eyes', options: EYES },
  mouth: { label: 'Mouth', options: MOUTHS },
  hair: { label: 'Hair', options: HAIR },
  hat: { label: 'Hat', options: HATS },
  torso: { label: 'Body', options: TORSOS },
  arms: { label: 'Arms', options: ARMS },
  hands: { label: 'Hands', options: HANDS },
  legs: { label: 'Legs', options: LEGS },
  feet: { label: 'Feet', options: FEET },
  extra: { label: 'Extra', options: EXTRAS },
};

export const CATEGORY_ORDER = Object.keys(CATALOG);

/** Face parts sit on the head's surface, so they are built after it. */
export const BUILD_ORDER = ['torso', 'legs', 'feet', 'arms', 'hands', 'head', 'eyes', 'mouth', 'hair', 'hat', 'extra'];

export const DEFAULT_PARTS = { head: 'round', eyes: 'big', mouth: 'smile', hair: 'short', hat: 'none', torso: 'regular', arms: 'tee', hands: 'mitten', legs: 'trousers', feet: 'shoes', extra: 'none' };

export const EMPTY_PARTS = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 'none']));

/** Human-friendly option label from its key. */
export function optionLabel(key) {
  const special = { tophat: 'Top hat', tee: 'T-shirt', none: 'None' };
  return special[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
