// Export the figure for Blender and game engines.
//
// The editor keeps one skinned mesh per piece; the export merges them into a single "Body"
// mesh with one material per colour (named after its slot, so Blender shows Skin, Top, Hair...),
// bound to the Mixamo-named armature, with every animation clip as a glTF animation (Blender
// imports each one as an Action) and the four face shape keys. 1 unit = 1 metre, Y up, facing
// +Z, which Blender's glTF importer turns into its own Z-up, facing -Y convention.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCharacter, MORPHS } from '../build/Builder.js';
import { buildSkeleton } from '../rig/Skeleton.js';
import { buildClips } from '../rig/Animations.js';
import { SLOT_LABELS } from '../body/PartsCatalog.js';
import { zipFiles } from './Zip.js';
import { randomize, shiftPalette, rng, clone } from '../state/State.js';

export const DETAIL_LEVELS = { high: 1, medium: 0.6, low: 0.35 };

export function safeName(name) {
  return (name || 'figure').trim().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'figure';
}

/** Build the export scene graph: Group(name) > [Hips bone tree, Body skinned mesh]. */
export function buildExportRoot(state, { detail = 1, animations = true } = {}) {
  const { joints, pieces } = buildCharacter(state, { detail });
  const { skeleton, root } = buildSkeleton(joints);
  const group = new THREE.Group();
  group.name = safeName(state.card?.name);
  group.add(root);

  // Merge by colour, then into one mesh with a material group per colour.
  const byColor = new Map();
  let inkCount = 0;
  for (const p of pieces) {
    if (!byColor.has(p.color)) byColor.set(p.color, { geos: [], label: p.slot ? SLOT_LABELS[p.slot] : null });
    const entry = byColor.get(p.color);
    entry.geos.push(p.geo);
    if (!entry.label && p.slot) entry.label = SLOT_LABELS[p.slot];
  }
  const geos = [];
  const materials = [];
  const used = new Set();
  for (const [color, { geos: list, label }] of byColor) {
    geos.push(list.length === 1 ? list[0] : mergeGeometries(list, false));
    let name = label ?? `Ink_${++inkCount}`;
    while (used.has(name)) name = `${name}_2`;
    used.add(name);
    materials.push(new THREE.MeshStandardMaterial({ name, color, roughness: 0.85, metalness: 0 }));
  }
  if (!geos.length) {
    // Nothing built yet: still export the armature so the file is valid and useful.
    group.userData = cardExtras(state);
    return { group, clips: animations ? buildClips(state.shape, state.pose) : [], mesh: null, skeleton };
  }
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, true);
  if (geos.length === 1) {
    merged.clearGroups();
    merged.addGroup(0, merged.index.count, 0);
  }
  // Merging drops attribute names; Blender shows these as the shape key names.
  (merged.morphAttributes.position ?? []).forEach((a, i) => (a.name = MORPHS[i]));
  const mesh = new THREE.SkinnedMesh(merged, materials.length === 1 ? materials[0] : materials);
  mesh.name = 'Body';
  group.add(mesh);
  group.updateMatrixWorld(true);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.updateMorphTargets();
  group.userData = cardExtras(state);
  return { group, clips: animations ? buildClips(state.shape, state.pose) : [], mesh, skeleton };
}

function cardExtras(state) {
  const c = state.card ?? {};
  return { character: { name: c.name, role: c.role, bio: c.bio, stats: c.stats }, tool: 'Living Parchment: Figures' };
}

// ------------------------------------------------------------------ VRM 1.0

const VRM_BONES = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Spine1',
  upperChest: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  leftShoulder: 'LeftShoulder',
  leftUpperArm: 'LeftArm',
  leftLowerArm: 'LeftForeArm',
  leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder',
  rightUpperArm: 'RightArm',
  rightLowerArm: 'RightForeArm',
  rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg',
  leftLowerLeg: 'LeftLeg',
  leftFoot: 'LeftFoot',
  leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg',
  rightLowerLeg: 'RightLeg',
  rightFoot: 'RightFoot',
  rightToes: 'RightToeBase',
};

function vrmPlugin(state, group, mesh) {
  return (writer) => ({
    afterParse() {
      const json = writer.json;
      const node = (name) => writer.nodeMap.get(group.getObjectByName(name));
      const humanBones = {};
      for (const [vrm, ours] of Object.entries(VRM_BONES)) humanBones[vrm] = { node: node(ours) };
      const meshNode = mesh ? writer.nodeMap.get(mesh) : undefined;
      const bind = (morph, weight = 1) => (meshNode === undefined ? [] : [{ node: meshNode, index: MORPHS.indexOf(morph), weight }]);
      const preset = {
        happy: { morphTargetBinds: bind('Smile') },
        sad: { morphTargetBinds: bind('Frown') },
        surprised: { morphTargetBinds: bind('MouthOpen') },
        aa: { morphTargetBinds: bind('MouthOpen') },
        blink: { morphTargetBinds: bind('Blink') },
        relaxed: { morphTargetBinds: bind('Blink', 0.4) },
      };
      json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'VRMC_vrm'])];
      json.extensions = json.extensions ?? {};
      json.extensions.VRMC_vrm = {
        specVersion: '1.0',
        meta: {
          name: state.card?.name || 'Figure',
          version: '1',
          authors: [state.card?.author || 'Living Parchment: Figures user'],
          licenseUrl: 'https://vrm.dev/licenses/1.0/',
          avatarPermission: 'onlyAuthor',
          commercialUsage: 'personalNonProfit',
          allowExcessivelyViolentUsage: false,
          allowExcessivelySexualUsage: false,
          allowPoliticalOrReligiousUsage: false,
          allowAntisocialOrHateUsage: false,
          creditNotation: 'required',
          allowRedistribution: false,
          modification: 'prohibited',
        },
        humanoid: { humanBones },
        expressions: { preset },
      };
    },
  });
}

// ------------------------------------------------------------------ writers

/** Binary glTF of a state. opts: detail, animations, vrm. Returns an ArrayBuffer. */
export async function exportGLB(state, { detail = 1, animations = true, vrm = false } = {}) {
  const { group, clips, mesh } = buildExportRoot(state, { detail, animations });
  const exporter = new GLTFExporter();
  if (vrm) exporter.register(vrmPlugin(state, group, mesh));
  const scene = new THREE.Scene();
  scene.add(group);
  return exporter.parseAsync(scene, { binary: true, animations: clips, onlyVisible: false });
}

/** A zip of the figure at three detail levels (LOD0..LOD2) plus a note on triangle counts. */
export async function exportLODs(state, opts = {}) {
  const base = safeName(state.card?.name);
  const files = [];
  const lines = [];
  for (const [i, [label, detail]] of Object.entries(DETAIL_LEVELS).entries()) {
    const glb = await exportGLB(state, { ...opts, detail });
    files.push({ name: `${base}_LOD${i}_${label}.glb`, data: new Uint8Array(glb) });
    lines.push(`LOD${i} (${label}): ${triangleCount(state, detail)} triangles`);
  }
  files.push({ name: 'README.txt', data: new TextEncoder().encode(`${base} at three levels of detail.\n\n${lines.join('\n')}\n\nAll three share the same armature, so the same animations drive each.\n`) });
  return zipFiles(files);
}

export function triangleCount(state, detail = 1) {
  const { pieces } = buildCharacter(state, { detail });
  return pieces.reduce((n, p) => n + p.geo.index.count / 3, 0);
}

/**
 * Seeded crowd variants of a figure: same idea, different colours, proportions and some parts.
 * Returns states (the first is the original).
 */
export function crowdStates(state, count = 10, seed = 1) {
  const out = [clone(state)];
  const r = rng(seed);
  for (let i = 1; i < count; i++) {
    const swap = randomize(state, Math.floor(r() * 1e9));
    const s = clone(state);
    // Keep the body plan, vary the look.
    for (const cat of ['hair', 'hat', 'eyes', 'mouth', 'extra']) if (r() < 0.5) s.parts[cat] = swap.parts[cat];
    s.colors = r() < 0.5 ? shiftPalette(state.colors, r(), (r() - 0.5) * 0.12) : { ...swap.colors, eyes: state.colors.eyes, white: state.colors.white };
    for (const k of ['height', 'build', 'head', 'belly']) s.shape[k] = Math.round(state.shape[k] * (0.88 + r() * 0.24) * 100) / 100;
    s.shape.belly = Math.min(1, Math.max(0, s.shape.belly));
    s.card = { ...s.card, name: `${state.card?.name || 'Figure'} ${i + 1}` };
    out.push(s);
  }
  return out;
}

export async function exportCrowd(state, count = 10, seed = 1, opts = {}) {
  const files = [];
  const states = crowdStates(state, count, seed);
  for (const [i, s] of states.entries()) {
    const glb = await exportGLB(s, opts);
    files.push({ name: `${safeName(state.card?.name)}_${String(i + 1).padStart(2, '0')}.glb`, data: new Uint8Array(glb) });
  }
  return zipFiles(files);
}

/** Save bytes as a download in the browser. */
export function download(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
