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
import { SPRITE_SIZE } from './SpriteInstancer.js';

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

/** Export defaults: the original diorama (10 units, rim, paper cards, water painted only). */
export const EXPORT_DEFAULTS = { size: PAGE_SIZE, height: 1, detail: 1, sprites: 'cards', trees: 'page', water: false, rim: true, maps: false };

/** Real-world heights in metres (tree, reed, stone, lantern) for trees: 'real'. */
export const REAL_SPRITE_M = [9, 1.6, 2.4, 2.2];

/**
 * Height in metres of one planted sprite in the export. 'page' scales it with the map like the
 * diorama; 'real' keeps it at a real-world size whatever the map size (never larger than 'page').
 */
export function spriteHeight(it, k, trees = 'page') {
  const page = it.scale * k;
  if (trees !== 'real') return page;
  return Math.min(page, (REAL_SPRITE_M[it.type] * it.scale) / SPRITE_SIZE[it.type]);
}

/** Grid segments for a detail level (1 = the live terrain's 160). */
export const segmentsFor = (detail) => SEGMENTS * Math.max(1, Math.min(3, Math.round(detail)));

/**
 * Build the export scene. `opts` (see EXPORT_DEFAULTS):
 *  size    metres across the page; everything scales with it
 *  height  extra vertical exaggeration (1 = true to the page)
 *  detail  1..3, terrain grid 160 / 320 / 480 segments
 *  sprites 'cards' (crossed alpha cards) | 'markers' (empty named nodes) | 'none'
 *  trees   'page' (scale with the map) | 'real' (real-world heights, see REAL_SPRITE_M)
 *  water   a separate water-surface mesh over rivers and lakes, with real depth below it
 *  rim     the cardboard rim around the page
 */
export function buildExportScene({ parchment, sprites, noise, biome }, opts = {}) {
  const o = { ...EXPORT_DEFAULTS, ...opts };
  const k = o.size / PAGE_SIZE;
  const hk = o.height;
  const segs = segmentsFor(o.detail);
  const group = new THREE.Group();
  group.name = 'LivingParchment';
  const relief = makeRelief(noise);
  // texture-space uv (v up) -> world Y in page units, matching the shader. With a water surface
  // the riverbeds keep their carved depth; without one they sit flat at the water level.
  const yAt = (u, tv) => {
    const h = parchment.sample(u, 1 - tv);
    const y = (h - 0.5) * HEIGHT_SCALE + relief(u, tv, h);
    return o.water ? y : Math.max(y, WATER_Y);
  };
  const toWorld = (geo) => {
    geo.scale(k, k * hk, k);
    geo.computeVertexNormals();
    return geo;
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
      const kk = Math.min(1, Math.max(0, (WATER_H - h) / 0.12));
      const i = (y * A + x) * 4;
      for (let c = 0; c < 3; c++) {
        const water = (ink.toArray()[c] * (1 - kk) + deep.toArray()[c] * kk) * 255 * (0.75 + 0.55 * (d[i + c] / 255));
        d[i + c] = d[i + c] * (1 - w) + Math.min(255, water) * w;
      }
    }
  }
  pg.putImageData(img, 0, 0);
  const pageTex = new THREE.CanvasTexture(page);
  pageTex.colorSpace = THREE.SRGBColorSpace;
  group.userData.pageCanvas = page;

  // --- terrain
  const tg = new THREE.PlaneGeometry(PAGE_SIZE, PAGE_SIZE, segs, segs);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position;
  const uv = tg.attributes.uv;
  let peak = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = yAt(uv.getX(i), uv.getY(i));
    pos.setY(i, y);
    if (y > peak) peak = y;
  }
  const terrain = new THREE.Mesh(toWorld(tg), new THREE.MeshStandardMaterial({ map: pageTex, roughness: 0.92, name: 'Parchment' }));
  terrain.name = 'Terrain';
  group.add(terrain);
  group.userData.stats = { segments: segs, triangles: segs * segs * 2, peak: peak * k * hk, size: o.size };

  // --- water surface: flat quads at the water level over every cell that dips below it
  if (o.water) {
    const n = segs;
    const wet = new Uint8Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) wet[j * (n + 1) + i] = parchment.sample(i / n, j / n) < WATER_H + 0.006 ? 1 : 0;
    }
    const verts = [];
    const uvs = [];
    const idx = [];
    const map = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const vert = (i, j) => {
      const key = j * (n + 1) + i;
      if (map[key] < 0) {
        map[key] = verts.length / 3;
        verts.push((i / n - 0.5) * PAGE_SIZE, WATER_Y + 0.012, (j / n - 0.5) * PAGE_SIZE);
        uvs.push(i / n, 1 - j / n);
      }
      return map[key];
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const any = wet[j * (n + 1) + i] | wet[j * (n + 1) + i + 1] | wet[(j + 1) * (n + 1) + i] | wet[(j + 1) * (n + 1) + i + 1];
        if (!any) continue;
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const c = vert(i, j + 1);
        const e = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, e);
      }
    }
    if (idx.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      wg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      wg.setIndex(idx);
      const water = new THREE.Mesh(
        toWorld(wg),
        new THREE.MeshStandardMaterial({ color: ink, transparent: true, opacity: 0.78, roughness: 0.12, metalness: 0, name: 'Water' }),
      );
      water.name = 'Water';
      group.add(water);
    }
  }

  // --- cardboard rim
  if (o.rim) {
    const rg = createRimGeometry(segs);
    const rp = rg.attributes.position;
    const ruv = rg.attributes.uv;
    const top = rg.attributes.aTop;
    for (let i = 0; i < rp.count; i++) {
      if (top.getX(i) > 0.5) rp.setY(i, Math.max(yAt(ruv.getX(i), ruv.getY(i)), WATER_Y));
    }
    rg.deleteAttribute('aTop');
    rg.deleteAttribute('aAlong');
    const rim = new THREE.Mesh(toWorld(rg), new THREE.MeshStandardMaterial({ color: 0xa8804f, roughness: 1, name: 'Cardboard' }));
    rim.name = 'Rim';
    group.add(rim);
  }

  // --- sprites: crossed cards (one merged mesh per type), or empty marker nodes
  if (o.sprites === 'markers') {
    const markers = new THREE.Group();
    markers.name = 'Markers';
    const counts = SPRITE_TYPES.map(() => 0);
    for (const it of sprites.items) {
      const u = it.x / PAGE_SIZE + 0.5;
      const tv = 0.5 - it.z / PAGE_SIZE;
      const node = new THREE.Object3D();
      node.name = `${SPRITE_TYPES[it.type]}_${String(++counts[it.type]).padStart(3, '0')}`;
      node.position.set(it.x * k, Math.max(yAt(u, tv), WATER_Y) * k * hk, it.z * k);
      node.rotation.y = it.phase;
      node.scale.setScalar(spriteHeight(it, k, o.trees));
      markers.add(node);
    }
    group.add(markers);
  } else if (o.sprites !== 'none') {
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
      const s = spriteHeight(it, k, o.trees);
      m.compose(
        new THREE.Vector3(it.x * k, Math.max(yAt(u, tv), WATER_Y) * k * hk - 0.03 * s, it.z * k),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.phase),
        new THREE.Vector3(s, s, s),
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
  }
  return group;
}

/** Export to a .glb ArrayBuffer. */
export async function exportGLB(args, opts) {
  const group = buildExportScene(args, opts);
  const exporter = new GLTFExporter();
  return exporter.parseAsync(group, { binary: true, onlyVisible: true });
}

const canvasPng = (c) =>
  new Promise((res, rej) => c.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a))) : rej(new Error('PNG encode failed'))), 'image/png'));

/**
 * The .glb plus maps for engine terrain systems: an 8-bit heightmap PNG, a 513² 16-bit
 * little-endian heightmap (Unity's RAW import), an RGB splat mask (R grass, G rock, B water),
 * the painted colour map and a README with the numbers needed to line it all up.
 * Returns [{name, data: Uint8Array}].
 */
export async function exportBundle(args, opts = {}) {
  const o = { ...EXPORT_DEFAULTS, ...opts };
  const group = buildExportScene(args, o);
  const glb = new Uint8Array(await new GLTFExporter().parseAsync(group, { binary: true, onlyVisible: true }));
  const files = [{ name: 'map.glb', data: glb }];
  if (!o.maps) return files;
  const { parchment } = args;
  const H = parchment.H;

  const hc = document.createElement('canvas');
  hc.width = hc.height = H;
  hc.getContext('2d').drawImage(parchment.heightCanvas, 0, 0);
  files.push({ name: 'heightmap.png', data: await canvasPng(hc) });

  const R = 513;
  const raw = new Uint8Array(R * R * 2);
  const dv = new DataView(raw.buffer);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) dv.setUint16((j * R + i) * 2, Math.round(parchment.sample(i / (R - 1), j / (R - 1)) * 65535), true);
  }
  files.push({ name: 'heightmap-513x513.r16', data: raw });
  files.push({ name: 'splatmap.png', data: await canvasPng(parchment.maskCanvas) });
  files.push({ name: 'colormap.png', data: await canvasPng(group.userData.pageCanvas) });

  const k = o.size / PAGE_SIZE;
  const lo = -0.5 * HEIGHT_SCALE * k * o.height;
  const hi = 0.5 * HEIGHT_SCALE * k * o.height;
  const f = (v) => v.toFixed(2);
  const readme = `Living Parchment map export

map.glb                 The map as a mesh: Terrain${o.water ? ', Water' : ''}${o.rim ? ', Rim' : ''}${o.sprites === 'cards' ? ', tree/reed/stone/lantern cards' : o.sprites === 'markers' ? ', Markers (empty nodes)' : ''}.
                        1 unit = 1 metre. The page is ${o.size} m x ${o.size} m, centred on the origin.
heightmap.png           ${H}x${H} 8-bit greyscale. Black = ${f(lo)} m, white = ${f(hi)} m, mid grey (128) = ground level (0 m).
heightmap-513x513.r16   The same heights, 513x513, 16-bit little-endian. Unity: Terrain > Import Raw,
                        Depth 16 bit, Byte Order Windows, Resolution 513, Terrain Size ${o.size} x ${f(hi - lo)} x ${o.size},
                        then move the terrain down by ${f(-lo)} m so ground level sits at 0. Tick Flip Vertically if it comes in mirrored.
splatmap.png            ${H}x${H} masks: red = grass on hills, green = mountain rock, blue = water.
colormap.png            The painted page (${parchment.A}x${parchment.A}), usable as the terrain's colour texture.

Image rows run from the far edge of the page (top row, -Z) to the near edge (bottom row, +Z); columns from -X to +X.
Highest point in this export: ${f(group.userData.stats.peak)} m. Collision: generate it from the Terrain mesh in your engine.
`;
  files.push({ name: 'README.txt', data: new TextEncoder().encode(readme) });
  return files;
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

/** Zip several files without compression. `files` = [{name, data}]. Returns a Uint8Array. */
export function zipFiles(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
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
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const centralSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let o = 0;
  for (const part of [...parts, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Zip one file without compression. Returns a Uint8Array. */
export function zipSingle(name, data) {
  return zipFiles([{ name, data }]);
}
