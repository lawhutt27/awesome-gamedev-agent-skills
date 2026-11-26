// Bake the live diorama into plain meshes and export a binary glTF (.glb).
//
// Everything on screen is displaced or billboarded on the GPU, which glTF cannot express, so the
// export rebuilds it on the CPU: terrain vertices take their height from the composed height
// data (plus the same simplex micro-relief), water is painted into the baked page texture, the
// rim's top edge follows the terrain, and each paper-cutout sprite becomes two crossed
// alpha-masked cards. The result drops straight into any three.js scene (1 unit = 1 metre).

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAGE_SIZE, HEIGHT_SCALE, WATER_H, WATER_Y, SEGMENTS, createRimGeometry } from '../terrain/TerrainShader.js';
import { SPRITE_TYPES } from './BiomeConfig.js';

/** CPU twin of lpRelief in TerrainShader.js, sampling the same repeat-wrapped noise texture. */
function makeRelief(noise) {
  const { data, width: W, height: H } = noise.image;
  const tap = (u, v, ch) => {
    const x = ((u * W) % W + W) % W;
    const y = ((v * H) % H + H) % H;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = (x0 + 1) % W;
    const y1 = (y0 + 1) % H;
    const tx = x - x0;
    const ty = y - y0;
    const at = (xx, yy) => data[(yy * W + xx) * 4 + ch] / 255;
    const a = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
    return a + (b - a) * ty;
  };
  return (u, v, h) => {
    const n1 = tap(u * 3, v * 3, 0) - 0.5;
    const n2 = tap(u * 11, v * 11, 1) - 0.5;
    return (n1 * 0.6 + n2 * 0.25) * (0.012 + 0.8 * Math.max(h - 0.5, 0));
  };
}

function hex(c) {
  return new THREE.Color(c);
}

export function buildExportScene({ parchment, sprites, noise, biome }) {
  const group = new THREE.Group();
  group.name = 'LivingParchment';
  const relief = makeRelief(noise);
  // texture-space uv (v up) -> world Y, matching the shader
  const yAt = (u, tv) => {
    const h = parchment.sample(u, 1 - tv);
    return Math.max((h - 0.5) * HEIGHT_SCALE + relief(u, tv, h), WATER_Y);
  };

  // --- page texture with the water baked in
  const A = parchment.A;
  const page = document.createElement('canvas');
  page.width = page.height = A;
  const pg = page.getContext('2d', { willReadFrequently: true });
  pg.drawImage(parchment.albedoCanvas, 0, 0);
  const img = pg.getImageData(0, 0, A, A);
  const d = img.data;
  const ink = hex(biome.waterInk);
  const deep = hex(biome.waterDeep);
  for (let y = 0; y < A; y++) {
    for (let x = 0; x < A; x++) {
      const h = parchment.sample((x + 0.5) / A, (y + 0.5) / A);
      if (h >= WATER_H + 0.005) continue;
      const w = Math.min(1, (WATER_H + 0.005 - h) / 0.015);
      const k = Math.min(1, Math.max(0, (WATER_H - h) / 0.12));
      const i = (y * A + x) * 4;
      for (let c = 0; c < 3; c++) {
        const water = (ink.toArray()[c] * (1 - k) + deep.toArray()[c] * k) * 255 * (0.75 + 0.55 * (d[i + c] / 255));
        d[i + c] = d[i + c] * (1 - w) + Math.min(255, water) * w;
      }
    }
  }
  pg.putImageData(img, 0, 0);
  const pageTex = new THREE.CanvasTexture(page);
  pageTex.colorSpace = THREE.SRGBColorSpace;

  // --- terrain
  const tg = new THREE.PlaneGeometry(PAGE_SIZE, PAGE_SIZE, SEGMENTS, SEGMENTS);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position;
  const uv = tg.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, yAt(uv.getX(i), uv.getY(i)));
  }
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ map: pageTex, roughness: 0.92, name: 'Parchment' }));
  terrain.name = 'Terrain';
  group.add(terrain);

  // --- cardboard rim
  const rg = createRimGeometry(SEGMENTS);
  const rp = rg.attributes.position;
  const ruv = rg.attributes.uv;
  const top = rg.attributes.aTop;
  for (let i = 0; i < rp.count; i++) {
    if (top.getX(i) > 0.5) rp.setY(i, yAt(ruv.getX(i), ruv.getY(i)));
  }
  rg.deleteAttribute('aTop');
  rg.deleteAttribute('aAlong');
  rg.computeVertexNormals();
  const rim = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ color: 0xa8804f, roughness: 1, name: 'Cardboard' }));
  rim.name = 'Rim';
  group.add(rim);

  // --- sprites: crossed cards, one merged mesh per sprite type
  const atlas = sprites.atlasCanvas;
  const cell = atlas.width / SPRITE_TYPES.length;
  const glowAtlas = sprites.glowTex.image;
  const perType = SPRITE_TYPES.map(() => []);
  const card = new THREE.PlaneGeometry(1, 1);
  card.translate(0, 0.5, 0);
  const cross = mergeGeometries([card, card.clone().rotateY(Math.PI / 2)]);
  const m = new THREE.Matrix4();
  for (const it of sprites.items) {
    const u = it.x / PAGE_SIZE + 0.5;
    const tv = 0.5 - it.z / PAGE_SIZE;
    m.compose(
      new THREE.Vector3(it.x, yAt(u, tv) - 0.03 * it.scale, it.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.phase),
      new THREE.Vector3(it.scale, it.scale, it.scale),
    );
    perType[it.type].push(cross.clone().applyMatrix4(m));
  }
  perType.forEach((geos, type) => {
    if (!geos.length) return;
    const crop = (src) => {
      const c = document.createElement('canvas');
      c.width = c.height = cell;
      c.getContext('2d').drawImage(src, type * cell, biome.row * cell, cell, cell, 0, 0, cell, cell);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const mat = new THREE.MeshStandardMaterial({
      map: crop(atlas),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.95,
      name: SPRITE_TYPES[type],
    });
    if (SPRITE_TYPES[type] === 'lantern') {
      mat.emissiveMap = crop(glowAtlas);
      mat.emissive = new THREE.Color(1, 0.85, 0.6);
      mat.emissiveIntensity = Math.min(1, biome.glow);
    }
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.name = `${SPRITE_TYPES[type]}s`;
    group.add(mesh);
  });
  return group;
}

/** Export to a .glb ArrayBuffer. */
export async function exportGLB(args) {
  const group = buildExportScene(args);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(group, { binary: true, onlyVisible: true });
  return result;
}

// ------------------------------------------------------------------ minimal .zip (stored)
// Some hosts (the claude.ai artifact viewer) only let a page save files with common extensions,
// so the .glb can be handed over inside a plain, uncompressed zip.

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip one file without compression. Returns a Uint8Array. */
export function zipSingle(name, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(bytes);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true); // version needed
  local.setUint16(8, 0, true); // stored
  local.setUint32(14, crc, true);
  local.setUint32(18, bytes.length, true);
  local.setUint32(22, bytes.length, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, bytes.length, true);
  central.setUint32(24, bytes.length, true);
  central.setUint16(28, nameBytes.length, true);
  central.setUint32(42, 0, true); // local header offset
  const centralOffset = 30 + nameBytes.length + bytes.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, centralOffset, true);
  const out = new Uint8Array(centralOffset + 46 + nameBytes.length + 22);
  let o = 0;
  for (const part of [new Uint8Array(local.buffer), nameBytes, bytes, new Uint8Array(central.buffer), nameBytes, new Uint8Array(end.buffer)]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
