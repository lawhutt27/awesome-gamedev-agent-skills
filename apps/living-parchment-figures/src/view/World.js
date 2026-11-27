// Walk-around mode: the figure leaves the turntable and walks a world with a third-person
// camera. The world is either the built-in paper stage or any .glb, such as a map exported
// from Living Parchment (1 unit = 1 metre in both apps, so figures stand at the right size).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildExportRoot } from '../export/Exporter.js';

function paperStage() {
  const g = new THREE.Group();
  g.name = 'PaperStage';
  const geo = new THREE.CircleGeometry(14, 96, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);
  // Gentle rolling hills, flat in the middle where the figure starts.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const h = Math.max(0, r - 3) * 0.06 * (Math.sin(x * 0.45) + Math.cos(z * 0.38) + 1.2);
    pos.setY(i, h);
  }
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#cdb98a', roughness: 1 }));
  ground.name = 'Ground';
  ground.receiveShadow = true;
  g.add(ground);
  const treeMat = new THREE.MeshStandardMaterial({ color: '#6f8f4e', roughness: 1, flatShading: true });
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#6b4c32', roughness: 1 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#9a9488', roughness: 1, flatShading: true });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 4.5 + rnd() * 8.5;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const t = new THREE.Group();
    t.name = `tree_${i + 1}`;
    const s = 0.8 + rnd() * 0.9;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.12 * s, 1 * s, 6), trunkMat);
    trunk.position.y = 0.5 * s;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.7 * s, 2 * s, 7), treeMat);
    crown.position.y = 1.9 * s;
    for (const m of [trunk, crown]) {
      m.castShadow = true;
      t.add(m);
    }
    t.position.set(x, 0, z);
    t.userData.drop = true;
    g.add(t);
  }
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 3 + rnd() * 9;
    const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2 + rnd() * 0.35, 0), stoneMat);
    st.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    st.castShadow = true;
    st.userData.drop = true;
    g.add(st);
  }
  return g;
}

export class World {
  constructor({ scene, figure, camera }) {
    this.scene = scene;
    this.figure = figure;
    this.camera = camera;
    this.active = false;
    this.ray = new THREE.Raycaster();
    this.heading = 0;
    this.camYaw = 0;
    this.speed = 0;
    this.useStage(paperStage());
  }

  useStage(group) {
    if (this.world) this.scene.remove(this.world);
    this.world = group;
    this.world.visible = this.active;
    this.scene.add(group);
    this.world.updateMatrixWorld(true);
    this.grounds = [];
    group.traverse((o) => {
      if (o.isMesh && !o.parent?.userData?.drop && !o.userData.drop) this.grounds.push(o);
    });
    // Drop props onto the ground.
    for (const child of group.children) {
      if (child.userData.drop) child.position.y = this.groundY(child.position.x, child.position.z) ?? 0;
    }
    const box = new THREE.Box3().setFromObject(group);
    this.center = box.getCenter(new THREE.Vector3());
    this.size = box.getSize(new THREE.Vector3());
  }

  resetStage() {
    this.useStage(paperStage());
    this.place();
  }

  /** Load a .glb / .gltf world from a File. */
  async loadFile(file) {
    const buf = await file.arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const g = new THREE.Group();
    g.name = file.name.replace(/\.[^.]+$/, '') || 'World';
    g.add(gltf.scene);
    g.traverse((o) => {
      if (o.isMesh) {
        o.receiveShadow = true;
        o.castShadow = true;
      }
    });
    this.useStage(g);
    this.place();
  }

  groundY(x, z) {
    this.ray.set(new THREE.Vector3(x, (this.size?.y ?? 50) + 100, z), new THREE.Vector3(0, -1, 0));
    this.ray.far = 1e4;
    const hit = this.ray.intersectObjects(this.grounds, false)[0];
    return hit ? hit.point.y : null;
  }

  place() {
    const g = this.figure.group;
    const c = this.center ?? new THREE.Vector3();
    g.position.set(c.x, this.groundY(c.x, c.z) ?? 0, c.z);
    g.rotation.set(0, 0, 0);
    this.heading = 0;
    this.camYaw = Math.PI; // start behind the figure
  }

  enter() {
    this.active = true;
    this.world.visible = true;
    this.place();
    this.prevClip = this.figure.clipName;
    this.figure.setClip('Idle');
    this.mode = 'Idle';
  }

  exit() {
    this.active = false;
    this.world.visible = false;
    const g = this.figure.group;
    g.position.set(0, 0, 0);
    g.rotation.set(0, 0, 0);
    this.figure.setClip(this.prevClip ?? 'Idle');
  }

  update(dt, input, run) {
    if (!this.active) return;
    const g = this.figure.group;
    const mag = Math.min(1, Math.hypot(input.x, input.y));
    const k = this.figure.state.shape.height;
    const target = mag > 0.05 ? (run ? 3.6 : 1.5) * k * mag : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 8);
    if (mag > 0.05) {
      // Stick up = away from the camera.
      const want = this.camYaw + Math.atan2(input.x, input.y) + Math.PI;
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 10);
    }
    g.rotation.y = this.heading;
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const next = g.position.clone().addScaledVector(fwd, this.speed * dt);
    const y = this.groundY(next.x, next.z);
    if (y !== null) {
      next.y = y;
      g.position.copy(next);
    }
    const mode = this.speed < 0.15 ? 'Idle' : run && this.speed > 2 * k ? 'Run' : 'Walk';
    if (mode !== this.mode) {
      this.mode = mode;
      this.figure.setClip(mode);
    }
    if (this.figure.action) this.figure.action.timeScale = mode === 'Walk' ? Math.max(0.6, this.speed / (1.5 * k)) : 1;
    // Third-person camera: behind and above, swinging slowly toward the walking direction.
    if (mag > 0.05) {
      let d = this.heading + Math.PI - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * 1.2);
    }
    const h = 1.7 * k;
    const back = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).multiplyScalar(4.6 * k + 1.6);
    const want = g.position.clone().add(back).add(new THREE.Vector3(0, h * 1.25, 0));
    this.camera.position.lerp(want, Math.min(1, dt * 4));
    this.camera.lookAt(g.position.clone().add(new THREE.Vector3(0, h * 0.6, 0)));
  }

  /** One .glb holding the world and the rigged figure where it stands. */
  async exportScene(state) {
    const { group, clips } = buildExportRoot(state);
    const g = this.figure.group;
    group.position.copy(g.position);
    group.rotation.y = g.rotation.y;
    const scene = new THREE.Scene();
    const world = this.world.clone(true);
    world.visible = true;
    scene.add(world, group);
    return new GLTFExporter().parseAsync(scene, { binary: true, animations: clips, onlyVisible: false });
  }
}
