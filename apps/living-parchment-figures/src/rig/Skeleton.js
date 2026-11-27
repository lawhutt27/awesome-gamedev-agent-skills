// The humanoid skeleton every figure is built on.
//
// Bone names follow Mixamo (without the "mixamorig:" prefix), which Blender's Rigify and
// auto-rig tools, Unity's Humanoid avatar and Godot's skeleton profile all recognise, so the
// exported armature retargets without renaming. The rest pose is a T-pose facing +Z (glTF's
// "front"), 1 unit = 1 metre, feet on y = 0. Every bone's rest rotation is the identity, so an
// animation key is simply the rotation away from the T-pose.

import * as THREE from 'three';

/** name -> parent name (null for the root). Order matters: parents come first. */
export const BONES = [
  ['Hips', null],
  ['Spine', 'Hips'],
  ['Spine1', 'Spine'],
  ['Spine2', 'Spine1'],
  ['Neck', 'Spine2'],
  ['Head', 'Neck'],
  ['HeadTop_End', 'Head'],
  ['LeftShoulder', 'Spine2'],
  ['LeftArm', 'LeftShoulder'],
  ['LeftForeArm', 'LeftArm'],
  ['LeftHand', 'LeftForeArm'],
  ['LeftHand_End', 'LeftHand'],
  ['RightShoulder', 'Spine2'],
  ['RightArm', 'RightShoulder'],
  ['RightForeArm', 'RightArm'],
  ['RightHand', 'RightForeArm'],
  ['RightHand_End', 'RightHand'],
  ['LeftUpLeg', 'Hips'],
  ['LeftLeg', 'LeftUpLeg'],
  ['LeftFoot', 'LeftLeg'],
  ['LeftToeBase', 'LeftFoot'],
  ['LeftToe_End', 'LeftToeBase'],
  ['RightUpLeg', 'Hips'],
  ['RightLeg', 'RightUpLeg'],
  ['RightFoot', 'RightLeg'],
  ['RightToeBase', 'RightFoot'],
  ['RightToe_End', 'RightToeBase'],
  // Secondary bones for springy parts (long hair, capes, tails). Retargeting tools ignore them.
  ['HairBack', 'Head'],
  ['HairBack_End', 'HairBack'],
  ['Cape1', 'Spine2'],
  ['Cape2', 'Cape1'],
  ['Cape_End', 'Cape2'],
  ['Tail1', 'Hips'],
  ['Tail2', 'Tail1'],
  ['Tail3', 'Tail2'],
  ['Tail_End', 'Tail3'],
];

export const BONE_NAMES = BONES.map((b) => b[0]);
export const PARENT = Object.fromEntries(BONES);

/** The bone each deforming bone points at (its segment runs from its head to this one's head). */
export const CHILD = {
  Hips: 'Spine',
  Spine: 'Spine1',
  Spine1: 'Spine2',
  Spine2: 'Neck',
  Neck: 'Head',
  Head: 'HeadTop_End',
  LeftShoulder: 'LeftArm',
  LeftArm: 'LeftForeArm',
  LeftForeArm: 'LeftHand',
  LeftHand: 'LeftHand_End',
  RightShoulder: 'RightArm',
  RightArm: 'RightForeArm',
  RightForeArm: 'RightHand',
  RightHand: 'RightHand_End',
  LeftUpLeg: 'LeftLeg',
  LeftLeg: 'LeftFoot',
  LeftFoot: 'LeftToeBase',
  LeftToeBase: 'LeftToe_End',
  RightUpLeg: 'RightLeg',
  RightLeg: 'RightFoot',
  RightFoot: 'RightToeBase',
  RightToeBase: 'RightToe_End',
  HairBack: 'HairBack_End',
  Cape1: 'Cape2',
  Cape2: 'Cape_End',
  Tail1: 'Tail2',
  Tail2: 'Tail3',
  Tail3: 'Tail_End',
};

/** Bones that only springy parts use. */
export const SECONDARY = ['HairBack', 'Cape1', 'Cape2', 'Tail1', 'Tail2', 'Tail3'];

/** Body bones that carry skin weights (the _End bones are tips only). */
export const DEFORM = Object.keys(CHILD).filter((b) => !SECONDARY.includes(b));

/** Body regions, used to decide which bones a drawn stroke may bend with. */
export const REGIONS = {
  torso: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder'],
  head: ['Head', 'Neck'],
  leftArm: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'],
  rightArm: ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'],
  leftLeg: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'],
  rightLeg: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'],
};

/** Body-shape sliders. Each is a multiplier around 1 except belly (0..1). */
export const SHAPE_DEFAULTS = { height: 1, head: 1, build: 1, arms: 1, legs: 1, belly: 0 };
export const SHAPE_RANGES = {
  height: [0.55, 1.3],
  head: [0.7, 1.9],
  build: [0.7, 1.6],
  arms: [0.7, 1.35],
  legs: [0.45, 1.35],
  belly: [0, 1],
};

/**
 * Rest-pose joint positions (metres) for a body shape. A default figure stands 1.7 m tall.
 * Legs, torso and head stack from the ground up, so short legs lower everything above them.
 */
export function jointPositions(shape = SHAPE_DEFAULTS) {
  const s = { ...SHAPE_DEFAULTS, ...shape };
  const k = s.height;
  const w = s.build;
  const leg = 0.86 * s.legs; // hip joint to ankle
  const ankle = 0.08;
  const hipY = ankle + leg;
  const torso = [0.1, 0.13, 0.13, 0.13]; // Hips->Spine->Spine1->Spine2->Neck
  const neckLen = 0.1;
  const headLen = 0.24 * s.head;
  const arm = s.arms;
  const v = (x, y, z = 0) => new THREE.Vector3(x * k, y * k, z * k);
  const p = {};
  p.Hips = v(0, hipY);
  p.Spine = v(0, hipY + torso[0]);
  p.Spine1 = v(0, hipY + torso[0] + torso[1]);
  p.Spine2 = v(0, hipY + torso[0] + torso[1] + torso[2]);
  const neckY = hipY + torso[0] + torso[1] + torso[2] + torso[3];
  p.Neck = v(0, neckY);
  p.Head = v(0, neckY + neckLen);
  p.HeadTop_End = v(0, neckY + neckLen + headLen);
  const shY = neckY - 0.04;
  for (const [side, sx] of [
    ['Left', 1],
    ['Right', -1],
  ]) {
    p[`${side}Shoulder`] = v(sx * 0.04 * w, shY);
    p[`${side}Arm`] = v(sx * 0.17 * w, shY);
    p[`${side}ForeArm`] = v(sx * (0.17 * w + 0.28 * arm), shY);
    p[`${side}Hand`] = v(sx * (0.17 * w + 0.54 * arm), shY);
    p[`${side}Hand_End`] = v(sx * (0.17 * w + 0.54 * arm + 0.16 * Math.sqrt(arm)), shY);
    const hx = sx * 0.095 * w;
    p[`${side}UpLeg`] = v(hx, hipY - 0.04);
    p[`${side}Leg`] = v(hx, ankle + leg * 0.5);
    p[`${side}Foot`] = v(hx, ankle);
    p[`${side}ToeBase`] = v(hx, 0.025, 0.12);
    p[`${side}Toe_End`] = v(hx, 0.025, 0.2);
  }
  // Secondary chains: hair hangs behind the head, the cape from the shoulder blades to the
  // knees, the tail curls back from the base of the spine.
  const headC = p.Head.clone().lerp(p.HeadTop_End, 0.45);
  p.HairBack = headC.clone().add(v(0, 0, -0.06));
  p.HairBack_End = new THREE.Vector3(0, p.Neck.y - 0.12 * k, -0.1 * k);
  p.Cape1 = new THREE.Vector3(0, p.Neck.y - 0.02 * k, -0.12 * k);
  p.Cape2 = new THREE.Vector3(0, p.Spine.y, -0.16 * k);
  p.Cape_End = new THREE.Vector3(0, p.LeftLeg.y + 0.02 * k, -0.2 * k);
  p.Tail1 = new THREE.Vector3(0, p.Hips.y - 0.02 * k, -0.08 * k);
  p.Tail2 = new THREE.Vector3(0, p.Hips.y - 0.25 * k, -0.3 * k);
  p.Tail3 = new THREE.Vector3(0, p.Hips.y - 0.2 * k, -0.55 * k);
  p.Tail_End = new THREE.Vector3(0, p.Hips.y + 0.05 * k, -0.68 * k);
  return p;
}

/** Height of the top of the head, for framing the camera. */
export function figureHeight(shape) {
  return jointPositions(shape).HeadTop_End.y;
}

/** Build a THREE.Skeleton (identity rest rotations) from joint positions. */
export function buildSkeleton(joints) {
  const bones = {};
  for (const [name, parent] of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    const pos = joints[name].clone();
    if (parent) pos.sub(joints[parent]);
    b.position.copy(pos);
    bones[name] = b;
    if (parent) bones[parent].add(b);
  }
  const list = BONE_NAMES.map((n) => bones[n]);
  const root = bones.Hips;
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  return { skeleton, bones, root };
}

/** Segments [a, b] (rest positions) of the deforming bones, for skin weights and stroke regions. */
export function boneSegments(joints) {
  const out = {};
  for (const name of Object.keys(CHILD)) out[name] = [joints[name], joints[CHILD[name]]];
  return out;
}
