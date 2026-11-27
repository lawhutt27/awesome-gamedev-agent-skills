// The live figure: skeleton, one skinned mesh per piece, the animation mixer, face shape keys,
// springy follow-through and pose-mode IK.

import * as THREE from 'three';
import { buildCharacter, MORPHS } from '../build/Builder.js';
import { buildSkeleton, BONE_NAMES } from '../rig/Skeleton.js';
import { buildClips, poseFromState, rot } from '../rig/Animations.js';
import { STYLES } from '../state/State.js';

export const EXPRESSIONS = {
  neutral: {},
  happy: { Smile: 1 },
  sad: { Frown: 1 },
  surprised: { MouthOpen: 1 },
  sleepy: { Blink: 0.75 },
  grumpy: { Frown: 0.6, Blink: 0.35 },
};

function toonRamp() {
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class Figure {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Figure';
    scene.add(this.group);
    this.meshes = [];
    this.materials = new Map();
    this.ramp = toonRamp();
    this.clipName = 'Idle';
    this.expression = 'neutral';
    this.blinkTimer = 2;
    this.blink = 0;
    this.time = 0;
    this.prevHips = new THREE.Vector3();
    this.spring = { cape: 0, capeV: 0, tail: 0, tailV: 0, hair: 0, hairV: 0 };
    this.secondary = true;
    this.posing = false;
  }

  material(color, styleKey) {
    const key = `${color}|${styleKey}`;
    let m = this.materials.get(key);
    if (m) return m;
    const st = STYLES[styleKey] ?? STYLES.ink;
    if (st.toon) m = new THREE.MeshToonMaterial({ color, gradientMap: this.ramp });
    else m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
    if (st.flat) m.flatShading = true;
    this.materials.set(key, m);
    return m;
  }

  /** Rebuild every mesh from the state. Keeps the clip that was playing. */
  rebuild(state) {
    this.state = state;
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    if (this.root) this.group.remove(this.root);
    const { joints, pieces } = buildCharacter(state);
    this.joints = joints;
    const { skeleton, bones, root } = buildSkeleton(joints);
    this.skeleton = skeleton;
    this.bones = bones;
    this.root = root;
    this.group.add(root);
    this.group.updateMatrixWorld(true);
    this.pieces = pieces;
    this.meshes = pieces.map((p, i) => {
      const mesh = new THREE.SkinnedMesh(p.geo, this.material(p.color, state.style));
      mesh.name = `${p.name}_${i}`;
      mesh.userData.ref = p.ref;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      mesh.bind(skeleton, new THREE.Matrix4());
      return mesh;
    });
    this.clips = buildClips(state.shape, state.pose);
    this.mixer = new THREE.AnimationMixer(this.group);
    this.applyExpression();
    this.setClip(this.clipName, true);
  }

  /** 'TPose' holds the rest pose; otherwise plays the named clip. */
  setClip(name, instant = false) {
    this.clipName = name;
    if (!this.mixer) return;
    const clip = this.clips.find((c) => c.name === name);
    const next = clip ? this.mixer.clipAction(clip) : null;
    if (this.action && this.action !== next) {
      if (instant || !next) this.action.stop();
      else this.action.fadeOut(0.25);
    }
    if (!next) {
      this.restPose();
      this.action = null;
      return;
    }
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    if (!instant && this.action) next.fadeIn(0.25);
    next.play();
    this.action = next;
  }

  restPose() {
    this.skeleton?.pose();
    this.root && this.root.position.copy(this.joints.Hips);
  }

  setExpression(name) {
    this.expression = name in EXPRESSIONS ? name : 'neutral';
    this.applyExpression();
  }

  applyExpression() {
    const w = EXPRESSIONS[this.expression] ?? {};
    for (const m of this.meshes) {
      if (!m.morphTargetInfluences) continue;
      MORPHS.forEach((name, i) => {
        let v = w[name] ?? 0;
        if (name === 'Blink') v = Math.max(v, this.blink);
        m.morphTargetInfluences[i] = v;
      });
    }
  }

  update(dt) {
    this.time += dt;
    if (this.mixer && !this.posing) this.mixer.update(dt);
    // Blink every few seconds.
    this.blinkTimer -= dt;
    let b = 0;
    if (this.blinkTimer < 0.14 && this.blinkTimer > 0) b = Math.sin((1 - this.blinkTimer / 0.14) * Math.PI);
    if (this.blinkTimer <= 0) this.blinkTimer = 2 + Math.random() * 3.5;
    if (b !== this.blink) {
      this.blink = b;
      this.applyExpression();
    }
    // The mixer rewrites the spring bones every frame, so the extra lag is layered on top.
    if (this.secondary && this.bones && !this.posing && this.action) this.followThrough(dt);
  }

  /** Springy capes, tails and long hair lag behind how fast the body moves. */
  followThrough(dt) {
    const hips = new THREE.Vector3();
    this.bones.Hips.getWorldPosition(hips);
    const v = hips.clone().sub(this.prevHips).divideScalar(Math.max(dt, 1e-3));
    this.prevHips.copy(hips);
    if (dt <= 0 || dt > 0.2) return;
    const s = this.spring;
    const step = (key, target, k = 60, damp = 9) => {
      const a = (target - s[key]) * k - s[`${key}V`] * damp;
      s[`${key}V`] += a * dt;
      s[key] += s[`${key}V`] * dt;
    };
    const local = v.clone().applyQuaternion(this.group.quaternion.clone().invert());
    step('cape', THREE.MathUtils.clamp(local.z * 0.35 - local.y * 0.25, -0.6, 0.9));
    step('tail', THREE.MathUtils.clamp(-local.y * 0.4, -0.6, 0.6), 40, 6);
    step('hair', THREE.MathUtils.clamp(local.z * 0.2 - local.y * 0.3, -0.5, 0.6), 70, 10);
    this.bones.Cape1.quaternion.multiply(rot(s.cape, 0, 0));
    this.bones.Tail1.quaternion.multiply(rot(s.tail, 0, 0));
    this.bones.HairBack.quaternion.multiply(rot(s.hair, 0, 0));
  }

  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.meshes, false);
    return hits[0] ?? null;
  }

  // ------------------------------------------------------------------ pose mode

  /** Enter pose mode: freeze the mixer and lay the saved pose (or a relaxed stance) on the bones. */
  startPose() {
    this.posing = true;
    this.action?.stop();
    this.action = null;
    this.restPose();
    const p = this.state.pose ? poseFromState(this.state.pose) : null;
    if (p) {
      for (const [k, q] of Object.entries(p)) if (k !== 'hips' && this.bones[k]) this.bones[k].quaternion.copy(q);
      if (p.hips) this.bones.Hips.position.copy(this.joints.Hips).add(p.hips);
    } else {
      this.bones.LeftArm.quaternion.copy(rot(0, 0, -1.1));
      this.bones.RightArm.quaternion.copy(rot(0, 0, 1.1));
    }
    this.root.updateMatrixWorld(true);
  }

  stopPose() {
    this.posing = false;
    this.setClip(this.clipName, true);
  }

  /** The handles pose mode drags. */
  handles() {
    const out = {};
    for (const [key, bone] of [
      ['LeftHand', 'LeftHand'],
      ['RightHand', 'RightHand'],
      ['LeftFoot', 'LeftFoot'],
      ['RightFoot', 'RightFoot'],
      ['Head', 'HeadTop_End'],
    ]) {
      out[key] = this.bones[bone].getWorldPosition(new THREE.Vector3());
    }
    return out;
  }

  /** CCD IK: bend a chain so its end reaches `target` (world space). */
  reach(handle, target) {
    const chains = {
      LeftHand: ['LeftHand', ['LeftForeArm', 'LeftArm']],
      RightHand: ['RightHand', ['RightForeArm', 'RightArm']],
      LeftFoot: ['LeftFoot', ['LeftLeg', 'LeftUpLeg']],
      RightFoot: ['RightFoot', ['RightLeg', 'RightUpLeg']],
      Head: ['HeadTop_End', ['Head', 'Neck']],
    };
    const [endName, chain] = chains[handle];
    const end = this.bones[endName];
    const e = new THREE.Vector3();
    const b = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const wq = new THREE.Quaternion();
    const pq = new THREE.Quaternion();
    for (let iter = 0; iter < 12; iter++) {
      for (const name of chain) {
        const bone = this.bones[name];
        end.getWorldPosition(e);
        bone.getWorldPosition(b);
        const v1 = e.clone().sub(b);
        const v2 = target.clone().sub(b);
        if (v1.lengthSq() < 1e-8 || v2.lengthSq() < 1e-8) continue;
        q.setFromUnitVectors(v1.normalize(), v2.normalize());
        bone.getWorldQuaternion(wq);
        bone.parent.getWorldQuaternion(pq);
        const nw = q.multiply(wq);
        bone.quaternion.copy(pq.invert().multiply(nw));
        // Knees only bend backwards and elbows only forwards: clamp the hinge sign.
        if (name.endsWith('Leg') && !name.endsWith('UpLeg')) {
          const ex = new THREE.Euler().setFromQuaternion(bone.quaternion, 'XYZ');
          bone.quaternion.setFromEuler(new THREE.Euler(Math.max(0, Math.min(2.5, ex.x)), 0, 0));
        }
        bone.updateMatrixWorld(true);
      }
    }
  }

  /** Current bone rotations as plain data for state.pose. */
  capturePose() {
    const pose = {};
    for (const name of BONE_NAMES) {
      const q = this.bones[name].quaternion;
      if (Math.abs(q.w - 1) > 1e-5) pose[name] = [q.x, q.y, q.z, q.w].map((v) => Math.round(v * 1e4) / 1e4);
    }
    const off = this.bones.Hips.position.clone().sub(this.joints.Hips);
    pose.hips = [off.x, off.y, off.z].map((v) => Math.round(v * 1e4) / 1e4);
    return pose;
  }
}
