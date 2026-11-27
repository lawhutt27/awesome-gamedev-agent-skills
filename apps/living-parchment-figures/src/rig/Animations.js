// Procedural animation clips, generated from the skeleton so any figure can move the moment
// it exists. Each clip samples a pose function into quaternion keyframes (one track per bone,
// plus the hips' position), which three.js plays in the editor and GLTFExporter writes out as
// Blender actions. Springy parts (cape, tail, long hair) get baked follow-through.
//
// Rotation conventions in the T-pose (rest rotations are the identity):
//   arms hang down:   LeftArm z = -DOWN, RightArm z = +DOWN
//   swing forward:    negative x on arms and legs
//   knees bend:       positive x on LeftLeg / RightLeg
//   lean forward:     positive x on the spine
//   elbows bend fwd:  negative y on LeftForeArm, positive y on RightForeArm

import * as THREE from 'three';
import { BONE_NAMES, jointPositions } from './Skeleton.js';

const DOWN = 1.22;
const FPS = 24;

const qx = new THREE.Quaternion();
const qy = new THREE.Quaternion();
const qz = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);

/** Rotation applied as z first, then y, then x (so an arm drops, then swings). */
export function rot(x = 0, y = 0, z = 0) {
  qx.setFromAxisAngle(AX, x);
  qy.setFromAxisAngle(AY, y);
  qz.setFromAxisAngle(AZ, z);
  return new THREE.Quaternion().multiplyQuaternions(qx, qy).multiply(qz);
}

const TAU = Math.PI * 2;

/** Arms at rest by the sides, with a little elbow bend. */
function armsDown(p, { swingL = 0, swingR = 0, drop = DOWN, elbow = 0.18 } = {}) {
  p.LeftArm = rot(swingL, 0, -drop);
  p.RightArm = rot(swingR, 0, drop);
  p.LeftForeArm = rot(0, -elbow, 0);
  p.RightForeArm = rot(0, elbow, 0);
}

function springs(p, t, { speed = 0, sway = 1 } = {}) {
  p.Cape1 = rot(0.12 + speed * 0.5 + 0.05 * Math.sin(t * TAU * 2) * (0.4 + speed), 0, 0.04 * Math.sin(t * TAU));
  p.Cape2 = rot(0.06 + speed * 0.25 + 0.08 * Math.sin(t * TAU * 2 - 0.9) * (0.4 + speed), 0, 0);
  p.Tail1 = rot(0.05 * Math.sin(t * TAU), 0.25 * sway * Math.sin(t * TAU), 0);
  p.Tail2 = rot(0, 0.3 * sway * Math.sin(t * TAU - 0.7), 0);
  p.Tail3 = rot(0, 0.35 * sway * Math.sin(t * TAU - 1.4), 0);
  p.HairBack = rot(0.04 * Math.sin(t * TAU * 2 - 0.6) * (0.3 + speed) + speed * 0.15, 0, 0.03 * Math.sin(t * TAU));
}

/** Pose functions: t in 0..1 over the clip -> { bone: Quaternion, hips: Vector3 offset }. */
export const CLIPS = {
  Idle: {
    duration: 2.4,
    pose(t) {
      const b = Math.sin(t * TAU);
      const p = {};
      armsDown(p, { drop: DOWN + 0.03 * b, elbow: 0.2 + 0.03 * b });
      p.Spine1 = rot(0.02 * b, 0, 0);
      p.Spine2 = rot(0.015 * b, 0, 0);
      p.Neck = rot(-0.02 * b, 0.04 * Math.sin(t * TAU + 1), 0);
      p.Head = rot(0.02 * Math.sin(t * TAU + 0.5), 0.05 * Math.sin(t * TAU + 1), 0.02 * b);
      springs(p, t, { speed: 0, sway: 0.6 });
      p.hips = new THREE.Vector3(0, -0.006 + 0.006 * b, 0);
      return p;
    },
  },
  Walk: {
    duration: 1.0,
    pose(t) {
      const a = t * TAU;
      const s = Math.sin(a);
      const p = {};
      p.LeftUpLeg = rot(-0.45 * s, 0, 0);
      p.RightUpLeg = rot(0.45 * s, 0, 0);
      p.LeftLeg = rot(0.08 + 0.75 * Math.max(0, -Math.sin(a + 0.9)), 0, 0);
      p.RightLeg = rot(0.08 + 0.75 * Math.max(0, Math.sin(a + 0.9)), 0, 0);
      p.LeftFoot = rot(0.25 * s * 0.6, 0, 0);
      p.RightFoot = rot(-0.25 * s * 0.6, 0, 0);
      armsDown(p, { swingL: 0.42 * s, swingR: -0.42 * s, elbow: 0.3 });
      p.Hips = rot(0, 0.12 * s, 0);
      p.Spine1 = rot(0.04, -0.1 * s, 0);
      p.Head = rot(0, 0.04 * s, 0);
      springs(p, t, { speed: 0.4 });
      p.hips = new THREE.Vector3(0, -0.012 + 0.022 * Math.abs(Math.cos(a)), 0);
      return p;
    },
  },
  Run: {
    duration: 0.62,
    pose(t) {
      const a = t * TAU;
      const s = Math.sin(a);
      const p = {};
      p.LeftUpLeg = rot(-0.85 * s - 0.15, 0, 0);
      p.RightUpLeg = rot(0.85 * s - 0.15, 0, 0);
      p.LeftLeg = rot(0.2 + 1.3 * Math.max(0, -Math.sin(a + 0.7)), 0, 0);
      p.RightLeg = rot(0.2 + 1.3 * Math.max(0, Math.sin(a + 0.7)), 0, 0);
      p.LeftFoot = rot(0.3 * s, 0, 0);
      p.RightFoot = rot(-0.3 * s, 0, 0);
      armsDown(p, { swingL: 0.9 * s, swingR: -0.9 * s, drop: DOWN - 0.1, elbow: 1.2 });
      p.Hips = rot(0.12, 0.18 * s, 0);
      p.Spine1 = rot(0.12, -0.16 * s, 0);
      p.Neck = rot(-0.15, 0, 0);
      springs(p, t, { speed: 1 });
      p.hips = new THREE.Vector3(0, -0.04 + 0.05 * Math.abs(Math.cos(a)), 0);
      return p;
    },
  },
  Jump: {
    duration: 1.3,
    pose(t, J) {
      const p = {};
      const legLen = J.LeftUpLeg.y - J.LeftFoot.y;
      // 0-.25 crouch, .25-.4 push, .4-.7 air, .7-.85 land, .85-1 recover
      const crouch = t < 0.25 ? Math.sin((t / 0.25) * Math.PI * 0.5) : t < 0.4 ? 1 - (t - 0.25) / 0.15 : t < 0.7 ? 0 : t < 0.85 ? Math.sin(((t - 0.7) / 0.15) * Math.PI * 0.5) : 1 - (t - 0.85) / 0.15;
      const air = t > 0.38 && t < 0.72 ? Math.sin(((t - 0.38) / 0.34) * Math.PI) : 0;
      const tuck = air * 0.6;
      p.LeftUpLeg = rot(-0.9 * crouch - tuck, 0, 0);
      p.RightUpLeg = rot(-0.9 * crouch - tuck, 0, 0);
      p.LeftLeg = rot(1.6 * crouch + tuck * 1.4, 0, 0);
      p.RightLeg = rot(1.6 * crouch + tuck * 1.4, 0, 0);
      p.LeftFoot = rot(-0.7 * crouch, 0, 0);
      p.RightFoot = rot(-0.7 * crouch, 0, 0);
      p.Spine1 = rot(0.35 * crouch - 0.1 * air, 0, 0);
      const up = air;
      armsDown(p, { swingL: 0.5 * crouch, swingR: 0.5 * crouch, drop: DOWN - 1.9 * up, elbow: 0.3 });
      springs(p, t, { speed: 0.6 + air });
      p.hips = new THREE.Vector3(0, -legLen * 0.3 * crouch + 0.45 * air * (legLen / 0.82), 0.04 * crouch);
      return p;
    },
  },
  Wave: {
    duration: 1.6,
    pose(t) {
      const p = {};
      const w = Math.sin(t * TAU * 2);
      armsDown(p, {});
      p.RightArm = rot(0, 0, -0.9);
      p.RightForeArm = rot(0, 0.35, -0.75 + 0.45 * w);
      p.RightHand = rot(0, 0, 0.2 * w);
      p.Head = rot(0, -0.12, 0.1);
      p.Spine1 = rot(0, 0, 0.04);
      springs(p, t, { speed: 0, sway: 0.8 });
      return p;
    },
  },
  Sit: {
    duration: 2.4,
    pose(t, J) {
      const p = {};
      const b = Math.sin(t * TAU);
      const shin = J.LeftLeg.y - J.LeftFoot.y;
      const thigh = J.LeftUpLeg.y - J.LeftLeg.y;
      p.LeftUpLeg = rot(-1.5, 0.08, 0);
      p.RightUpLeg = rot(-1.5, -0.08, 0);
      p.LeftLeg = rot(1.5, 0, 0);
      p.RightLeg = rot(1.5, 0, 0);
      armsDown(p, { swingL: -0.55, swingR: -0.55, elbow: 0.6 });
      p.Spine1 = rot(0.08 + 0.015 * b, 0, 0);
      p.Head = rot(0.05, 0.08 * Math.sin(t * TAU * 0.5), 0);
      springs(p, t, { speed: 0, sway: 0.4 });
      const hipsY = J.LeftFoot.y + shin + (J.Hips.y - J.LeftUpLeg.y);
      p.hips = new THREE.Vector3(0, hipsY - J.Hips.y + 0.03, -thigh * 0.15);
      return p;
    },
  },
};

export const CLIP_NAMES = Object.keys(CLIPS);

/** Sample a pose function into an AnimationClip. */
export function makeClip(name, duration, poseAt, joints) {
  const frames = Math.max(2, Math.round(duration * FPS) + 1);
  const times = new Float32Array(frames);
  const rotations = {};
  const hips = [];
  for (let f = 0; f < frames; f++) {
    const t = f / (frames - 1);
    times[f] = t * duration;
    const p = poseAt(t, joints);
    for (const name of BONE_NAMES) {
      if (name.endsWith('_End')) continue;
      const q = p[name] ?? new THREE.Quaternion();
      (rotations[name] ??= []).push(q.x, q.y, q.z, q.w);
    }
    const off = p.hips ?? new THREE.Vector3();
    hips.push(joints.Hips.x + off.x, joints.Hips.y + off.y, joints.Hips.z + off.z);
  }
  const tracks = [];
  for (const [bone, values] of Object.entries(rotations)) {
    // Skip bones that never move, to keep files small.
    let moving = false;
    for (let i = 0; i < values.length; i += 4) if (Math.abs(values[i + 3] - 1) > 1e-5) moving = true;
    if (moving) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hips));
  return new THREE.AnimationClip(name, duration, tracks);
}

/** Every built-in clip for a body shape, plus the custom pose if there is one. */
export function buildClips(shape, pose = null) {
  const J = jointPositions(shape);
  const clips = CLIP_NAMES.map((n) => makeClip(n, CLIPS[n].duration, CLIPS[n].pose, J));
  if (pose) clips.push(makeClip('Pose', 1, () => poseFromState(pose), J));
  return clips;
}

/** state.pose ({ bone: [x, y, z, w], hips: [x, y, z] }) -> pose map. */
export function poseFromState(pose) {
  const p = {};
  for (const [k, v] of Object.entries(pose)) {
    if (k === 'hips') p.hips = new THREE.Vector3(...v);
    else p[k] = new THREE.Quaternion(...v);
  }
  return p;
}
