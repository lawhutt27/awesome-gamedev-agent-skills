// Terrain, depth and diorama-rim materials.
//
// All three patch built-in materials with onBeforeCompile, so the sun, hemisphere light,
// shadow maps and fog keep working. They share one uniform set: the terrain height is read
// from two RGBA DataTextures (mask RGB + height A) and blended by uMix, which a spring drives
// past 1.0 for the overshoot when a terrace pops up. No texture upload is needed for that
// animation, only a uniform change.

import * as THREE from 'three';

export const PAGE_SIZE = 10; // world units across the sheet
export const HEIGHT_SCALE = 2.4; // world units per 1.0 of height texture
export const WATER_H = 0.42; // height below which channels fill with water
export const WATER_Y = (WATER_H - 0.5) * HEIGHT_SCALE;
export const RIM_DEPTH = -0.6; // bottom of the cardboard skirt
export const SEGMENTS = 160;

/** Page UV (v down the page) -> world XZ. */
export function uvToWorld(u, v, out = { x: 0, z: 0 }) {
  out.x = (u - 0.5) * PAGE_SIZE;
  out.z = (v - 0.5) * PAGE_SIZE;
  return out;
}
/** World XZ -> page UV (v down the page). */
export function worldToUv(x, z, out = { x: 0, y: 0 }) {
  out.x = x / PAGE_SIZE + 0.5;
  out.y = z / PAGE_SIZE + 0.5;
  return out;
}
/** Height sample (0..1) -> world Y, matching lpWorldY in GLSL without the micro relief. */
export function heightToY(h) {
  return Math.max((h - 0.5) * HEIGHT_SCALE, WATER_Y);
}

// Shared GLSL: texture-space uv has v=1 at the top of the page (far edge, -Z).
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightFrom;
uniform sampler2D uHeightTo;
uniform float uMix;
uniform sampler2D uNoise;
#define LP_HS ${HEIGHT_SCALE.toFixed(4)}
#define LP_WATER_Y ${WATER_Y.toFixed(4)}
float lpRawH(vec2 uv) {
  return mix(texture2D(uHeightFrom, uv).a, texture2D(uHeightTo, uv).a, uMix);
}
float lpRelief(vec2 uv, float h) {
  float n1 = texture2D(uNoise, uv * 3.0).r - 0.5;
  float n2 = texture2D(uNoise, uv * 11.0).g - 0.5;
  return (n1 * 0.6 + n2 * 0.25) * (0.012 + 0.8 * max(h - 0.5, 0.0));
}
float lpWorldY(vec2 uv) {
  float h = lpRawH(uv);
  return max((h - 0.5) * LP_HS + lpRelief(uv, h), LP_WATER_Y);
}
`;

export function createSharedUniforms({ heightFrom, heightTo, noise, albedo, flow }) {
  return {
    uHeightFrom: { value: heightFrom },
    uHeightTo: { value: heightTo },
    uMix: { value: 1 },
    uNoise: { value: noise },
    uAlbedo: { value: albedo },
    uFlow: { value: flow },
    uTime: { value: 0 },
    uWaterInk: { value: new THREE.Color('#2f5d66') },
    uWaterDeep: { value: new THREE.Color('#173a45') },
    uWaterGlint: { value: new THREE.Color('#d9efe6') },
    uContour: { value: new THREE.Color('#3a3424') },
    uSky: { value: new THREE.Color('#e8efd8') },
    uGrain: { value: 0.22 },
    uCliffInk: { value: null },
    uContourAmt: { value: 1 }, // 0 hides the contour lines (Options)
  };
}

/** Hand-drawn strata lines and hatching for steep faces. 1 = paper, 0 = ink. Tiles. */
export function createCliffInkTexture(noise2D, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.lineCap = 'round';
  // Wavy strata (horizontal in world Y), drawn to wrap across the tile seam.
  for (let i = 0; i < 9; i++) {
    const y0 = (i + 0.5) * (size / 9);
    g.strokeStyle = `rgba(0,0,0,${0.55 + 0.35 * ((i * 7) % 3) / 2})`;
    g.lineWidth = 1.2 + ((i * 5) % 3) * 0.6;
    g.beginPath();
    for (let x = -4; x <= size + 4; x += 4) {
      const t = (x / size) * Math.PI * 2;
      const y = y0 + Math.sin(t * 2 + i) * 3 + noise2D(Math.cos(t) * 1.5 + i, Math.sin(t) * 1.5) * 2.5;
      if (x === -4) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // Short downward hatching between strata, denser on alternate bands.
  for (let k = 0; k < 340; k++) {
    const x = ((k * 97.13) % size) + noise2D(k, 3) * 3;
    const band = k % 9;
    const y = (band + 0.55) * (size / 9) + noise2D(k, 7) * 4;
    const len = 5 + ((k * 13) % 7);
    g.strokeStyle = `rgba(0,0,0,${band % 2 ? 0.45 : 0.25})`;
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - 2, y + len);
    g.stroke();
  }
  return c;
}

function inject(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
}

// ------------------------------------------------------------------ terrain

export function createTerrainMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    map: uniforms.uAlbedo.value,
    roughness: 0.92,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    inject(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${HEIGHT_GLSL}
varying float vH;
varying vec2 vTUv;
varying vec3 vWN;
varying vec3 vWP;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `float lpE = 1.0 / 192.0;
float lpWs = ${PAGE_SIZE.toFixed(1)} * lpE;
float lpL = lpWorldY(uv - vec2(lpE, 0.0));
float lpR = lpWorldY(uv + vec2(lpE, 0.0));
float lpD = lpWorldY(uv - vec2(0.0, lpE));
float lpU = lpWorldY(uv + vec2(0.0, lpE));
vec3 objectNormal = normalize(vec3(lpL - lpR, 2.0 * lpWs, lpU - lpD));
vWN = objectNormal;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
transformed.y = lpWorldY(uv);
vH = lpRawH(uv);
vTUv = uv;
vWP = transformed;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uHeightFrom;
uniform sampler2D uHeightTo;
uniform float uMix;
uniform sampler2D uNoise;
uniform sampler2D uFlow;
uniform float uTime;
uniform vec3 uWaterInk;
uniform vec3 uWaterDeep;
uniform vec3 uWaterGlint;
uniform vec3 uContour;
uniform vec3 uSky;
uniform float uGrain;
uniform sampler2D uCliffInk;
uniform float uContourAmt;
varying float vH;
varying vec2 vTUv;
varying vec3 vWN;
varying vec3 vWP;
float lpWater;
float lpBands;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  vec4 hm = mix(texture2D(uHeightFrom, vTUv), texture2D(uHeightTo, vTUv), uMix);
  float h = vH;
  float grain = texture2D(uNoise, vTUv * 24.0).g;
  // Moss and stone pick up a little extra pigment texture.
  diffuseColor.rgb *= mix(1.0, 0.86 + 0.24 * grain, clamp(hm.r * 0.5 + hm.g * 0.8, 0.0, 1.0));

  // Hand-inked contour lines at elevation steps (never on flat paper or under water).
  float c = (h - 0.5) * 13.0 - 0.5;
  float fw = max(fwidth(c), 1e-4);
  float d = abs(fract(c) - 0.5) / fw;
  float line = 1.0 - clamp(d - 0.35, 0.0, 1.0);
  float majorC = (h - 0.5) * 3.9 - 0.5;
  float majorFw = max(fwidth(majorC), 1e-4);
  float major = 1.0 - clamp(abs(fract(majorC) - 0.5) / majorFw - 0.6, 0.0, 1.0);
  float aboveSea = smoothstep(0.515, 0.545, h);
  diffuseColor.rgb = mix(diffuseColor.rgb, uContour, clamp(line * 0.3 + major * 0.45, 0.0, 0.7) * aboveSea * uContourAmt);

  // Projected cliff ink: the page is painted from above, so steep terraces and mountain faces
  // would smear it. Side-project hand-drawn strata and hatching onto them instead
  // (triplanar on X/Z, in world space, so nothing stretches with the slope).
  vec3 wn = normalize(vWN);
  float steep = smoothstep(0.86, 0.5, wn.y) * smoothstep(0.43, 0.47, h);
  if (steep > 0.0) {
    vec3 an = abs(wn);
    float bx = an.x / (an.x + an.z + 1e-4);
    vec2 sideScale = vec2(0.9, 3.2);
    float inkX = texture2D(uCliffInk, vWP.zy * sideScale).r;
    float inkZ = texture2D(uCliffInk, vWP.xy * sideScale).r;
    float ink = mix(inkZ, inkX, bx);
    vec3 cliff = diffuseColor.rgb * mix(vec3(0.62, 0.55, 0.45), vec3(1.0), 0.55);
    cliff = mix(uContour, cliff, ink);
    diffuseColor.rgb = mix(diffuseColor.rgb, cliff, steep);
  }

  // Animated ink-wash water wherever the channel drops below the water table.
  lpWater = 1.0 - smoothstep(0.405, 0.425, h);
  lpBands = 0.0;
  if (lpWater > 0.0) {
    vec2 flow = texture2D(uFlow, vTUv).rg * 2.0 - 1.0;
    float t = uTime * 0.35;
    float p0 = fract(t);
    float p1 = fract(t + 0.5);
    float w = abs(p0 - 0.5) * 2.0;
    vec2 base = vTUv * 5.0 + vec2(uTime * 0.01, uTime * 0.007);
    float nA = texture2D(uNoise, base - flow * p0 * 0.6).b;
    float nB = texture2D(uNoise, base - flow * p1 * 0.6 + 0.37).b;
    float n = mix(nA, nB, w);
    lpBands = smoothstep(0.6, 0.66, n) - smoothstep(0.7, 0.8, n);
    float depth = smoothstep(0.42, 0.3, h);
    vec3 wcol = mix(uWaterInk, uWaterDeep, depth);
    vec3 col = wcol * (0.75 + 0.55 * diffuseColor.rgb);
    col = mix(col, uWaterGlint, lpBands * 0.3);
    diffuseColor.rgb = mix(diffuseColor.rgb, col, lpWater);
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.22, lpWater);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  // Paper-fiber normal perturbation plus water ripples, built in world space.
  vec2 g = vTUv * 40.0;
  float tx = 1.0 / 256.0;
  float gx = texture2D(uNoise, g + vec2(tx, 0.0)).g - texture2D(uNoise, g - vec2(tx, 0.0)).g;
  float gy = texture2D(uNoise, g + vec2(0.0, tx)).g - texture2D(uNoise, g - vec2(0.0, tx)).g;
  vec3 pert = vec3(gx, 0.0, -gy) * uGrain * (1.0 - lpWater * 0.8);
  if (lpWater > 0.0) {
    vec2 r = vTUv * 18.0 + vec2(uTime * 0.03, -uTime * 0.02);
    float rx = texture2D(uNoise, r + vec2(tx, 0.0)).b - texture2D(uNoise, r - vec2(tx, 0.0)).b;
    float ry = texture2D(uNoise, r + vec2(0.0, tx)).b - texture2D(uNoise, r - vec2(0.0, tx)).b;
    pert += vec3(rx, 0.0, -ry) * 0.9 * lpWater;
  }
  normal = normalize(normal + (viewMatrix * vec4(pert, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += uSky * (fr * 0.35 + lpBands * 0.08) * lpWater;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'lp-terrain';
  return mat;
}

/** Shadow-pass material: same displacement so hills cast and receive correct shadows. */
export function createTerrainDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    inject(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y = lpWorldY(uv);');
  };
  mat.customProgramCacheKey = () => 'lp-terrain-depth';
  return mat;
}

// ------------------------------------------------------------------ terrain + rim geometry

export function createTerrainGeometry() {
  const g = new THREE.PlaneGeometry(PAGE_SIZE, PAGE_SIZE, SEGMENTS, SEGMENTS);
  g.rotateX(-Math.PI / 2);
  // Displacement happens on the GPU, so give the culler a box that covers any terrain height.
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(-PAGE_SIZE / 2, WATER_Y - 0.1, -PAGE_SIZE / 2),
    new THREE.Vector3(PAGE_SIZE / 2, HEIGHT_SCALE * 0.5 + 0.3, PAGE_SIZE / 2),
  );
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PAGE_SIZE);
  return g;
}

/**
 * Four-sided skirt hanging from the page edge down to RIM_DEPTH. Top vertices carry
 * aTop = 1 and follow the displaced terrain edge in the vertex shader.
 */
export function createRimGeometry(segments = SEGMENTS) {
  const half = PAGE_SIZE / 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const tops = [];
  const along = [];
  const index = [];
  // Each edge: start corner, direction, outward normal.
  const edges = [
    { s: [-half, half], d: [1, 0], n: [0, 1] }, // near edge (+Z)
    { s: [half, half], d: [0, -1], n: [1, 0] }, // right (+X)
    { s: [half, -half], d: [-1, 0], n: [0, -1] }, // far (-Z)
    { s: [-half, -half], d: [0, 1], n: [-1, 0] }, // left (-X)
  ];
  let base = 0;
  let run = 0;
  for (const e of edges) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = e.s[0] + e.d[0] * PAGE_SIZE * t;
      const z = e.s[1] + e.d[1] * PAGE_SIZE * t;
      const u = x / PAGE_SIZE + 0.5;
      const v = 0.5 - z / PAGE_SIZE; // texture-space v (1 = far edge)
      for (const top of [1, 0]) {
        positions.push(x, top ? 0 : RIM_DEPTH, z);
        normals.push(e.n[0], 0, e.n[1]);
        uvs.push(u, v);
        tops.push(top);
        along.push(run + PAGE_SIZE * t);
      }
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += (segments + 1) * 2;
    run += PAGE_SIZE;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(tops, 1));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PAGE_SIZE);
  return g;
}

/** Layered corrugated-cardboard cross-section, drawn procedurally from world height. */
export function createRimMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, side: THREE.FrontSide });
  mat.onBeforeCompile = (shader) => {
    inject(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${HEIGHT_GLSL}
attribute float aTop;
attribute float aAlong;
varying float vY;
varying float vAlong;
varying float vTopY;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
float lpTop = lpWorldY(uv);
if (aTop > 0.5) transformed.y = lpTop;
vY = transformed.y;
vTopY = lpTop;
vAlong = aAlong;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uNoise;
varying float vY;
varying float vAlong;
varying float vTopY;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
  // depth below the top surface, in world units (0 at the page, grows downward)
  float dTop = vTopY - vY;
  float y = -vY;            // 0 at paper level, 0.6 at the table
  float fib = texture2D(uNoise, vec2(vAlong * 0.9, vY * 3.0)).g;
  vec3 paper = vec3(0.93, 0.87, 0.74);
  vec3 kraft = vec3(0.66, 0.5, 0.33);
  vec3 kraftDark = vec3(0.36, 0.25, 0.15);
  vec3 col;
  if (dTop < 0.045) {
    col = paper * (0.92 + 0.08 * fib);                           // parchment sheet
  } else if (y < 0.07) {
    col = mix(paper * 0.8, kraft, smoothstep(0.0, 0.07, y));       // glued soil / paper below hills
  } else {
    // two corrugated layers between kraft liners
    float layer = y < 0.33 ? 0.0 : 1.0;
    float y0 = layer < 0.5 ? 0.07 : 0.33;
    float y1 = layer < 0.5 ? 0.31 : 0.58;
    float liner = 0.018;
    if (y < y0 + liner || y > y1 - liner || y > 0.585) {
      col = kraft * (0.95 + 0.1 * fib);
    } else {
      float f = (y - y0 - liner) / (y1 - y0 - 2.0 * liner); // 0..1 inside the flute band
      float freq = layer < 0.5 ? 9.0 : 7.0;
      float wave = 0.5 + 0.45 * sin(vAlong * freq * 6.2831 + layer * 1.7);
      float dist = abs(f - wave);
      float flute = 1.0 - smoothstep(0.05, 0.11, dist);
      // voids between flutes are deep shadow; under each arch slightly lighter
      vec3 voidCol = mix(kraftDark * 0.55, kraftDark, smoothstep(0.0, 0.5, f));
      col = mix(voidCol, kraft * 1.05, flute);
    }
    col *= 0.9 + 0.12 * fib;
  }
  diffuseColor.rgb *= col;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'lp-rim';
  return mat;
}

/** Depth material for the rim, so the skirt's displaced top casts a matching shadow. */
export function createRimDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    inject(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}\nattribute float aTop;`)
      .replace(
        '#include <begin_vertex>',
        'vec3 transformed = vec3(position);\nif (aTop > 0.5) transformed.y = lpWorldY(uv);',
      );
  };
  mat.customProgramCacheKey = () => 'lp-rim-depth';
  return mat;
}
