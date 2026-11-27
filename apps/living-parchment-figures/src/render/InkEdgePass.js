// Screen-space ink edges.
//
// The scene renders into a half-float target with a depth texture; a full-screen pass then
// runs a Sobel filter on linear depth (silhouettes: tree cards against the sky, ridges against
// the far page) and a depth Laplacian (creases where a terrace slope meets its flat top), and
// lays the result down as Sumi ink. Flat ground at a grazing angle has a steady depth gradient
// but no curvature, so the Laplacian ignores it, which keeps the first-person view clean.
// Tone mapping and sRGB output are applied here, since the scene pass renders linear.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform vec3 uInk;
uniform float uStrength;
uniform float uThickness;
varying vec2 vUv;

float lin(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return -perspectiveDepthToViewZ(d, uNear, uFar);
}

void main() {
  vec4 col = texture2D(tColor, vUv);
  if (uStrength > 0.0) {
    vec2 o = uTexel * uThickness;
    float tl = lin(vUv + vec2(-o.x,  o.y));
    float t  = lin(vUv + vec2( 0.0,  o.y));
    float tr = lin(vUv + vec2( o.x,  o.y));
    float l  = lin(vUv + vec2(-o.x,  0.0));
    float c  = lin(vUv);
    float r  = lin(vUv + vec2( o.x,  0.0));
    float bl = lin(vUv + vec2(-o.x, -o.y));
    float b  = lin(vUv + vec2( 0.0, -o.y));
    float br = lin(vUv + vec2( o.x, -o.y));

    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
    float sobel = sqrt(gx * gx + gy * gy) / max(c, 1e-3);
    float lap = abs(l + r - 2.0 * c) + abs(t + b - 2.0 * c)
              + 0.5 * (abs(tl + br - 2.0 * c) + abs(tr + bl - 2.0 * c));
    lap /= max(c, 1e-3);

    // Nothing behind the far plane (the sky) only contributes as a silhouette.
    float edge = max(smoothstep(0.22, 0.45, sobel), smoothstep(0.012, 0.03, lap));
    // Ink thins with distance, like a pen line seen across a table.
    edge *= mix(1.0, 0.45, smoothstep(6.0, 40.0, c));
    col.rgb = mix(col.rgb, uInk, clamp(edge * uStrength, 0.0, 0.85));
  }
  gl_FragColor = col;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class InkEdgePass {
  constructor(renderer, { samples = 0 } = {}) {
    this.renderer = renderer;
    this.strength = 0.5;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
    });
    this.target.depthTexture.type = THREE.UnsignedIntType;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uTexel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uInk: { value: new THREE.Color('#1b1a16') },
        uStrength: { value: this.strength },
        uThickness: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target.setSize(size.x, size.y);
    this.material.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    // Keep lines about one CSS pixel wide on high-density screens.
    this.material.uniforms.uThickness.value = Math.max(1, Math.min(1.6, this.renderer.getPixelRatio() * 0.8));
  }

  render(scene, camera) {
    const u = this.material.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uStrength.value = this.strength;
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCamera);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
