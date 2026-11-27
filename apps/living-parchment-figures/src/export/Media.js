// Pictures of the figure: photos, sprite sheets for 2D games, a turntable GIF and the
// parchment character card. All of them borrow the live renderer for a moment at a fixed size,
// copy the frame into a 2D canvas, then put the view back.

import * as THREE from 'three';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { zipFiles } from './Zip.js';
import { STAT_NAMES } from '../state/State.js';
import { figureHeight } from '../rig/Skeleton.js';

const DIRS = {
  4: ['S', 'E', 'N', 'W'],
  8: ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'],
};

/**
 * Render frames at a fixed size. `each(draw)` is called once; inside it, `draw(setup)` renders
 * one frame after `setup()` and returns a canvas copy. Restores size, camera and background.
 */
function withFrame(app, w, h, { transparent = false, camera = null, floor = true } = {}, each) {
  const { renderer, scene, ink } = app;
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevRatio = renderer.getPixelRatio();
  const prevBg = scene.background;
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevFloor = app.floor.visible;
  app.rendering = true;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    ink.setSize();
    if (transparent) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    app.floor.visible = floor && !transparent;
    const cam = camera ?? app.camera;
    const prevAspect = cam.isPerspectiveCamera ? cam.aspect : null;
    if (cam.isPerspectiveCamera) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    const draw = (setup) => {
      setup?.();
      app.figure.group.updateMatrixWorld(true);
      ink.render(scene, cam);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(renderer.domElement, 0, 0, w, h, 0, 0, w, h);
      return c;
    };
    const result = each(draw);
    if (prevAspect !== null) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
    return result;
  } finally {
    scene.background = prevBg;
    renderer.setClearColor(prevClear, prevAlpha);
    app.floor.visible = prevFloor;
    renderer.setPixelRatio(prevRatio);
    renderer.setSize(prevSize.x, prevSize.y, false);
    ink.setSize();
    app.rendering = false;
  }
}

/** A camera that frames the whole figure from the front, a little above. */
function framingCamera(state, aspect = 1, { ortho = false, elevation = 0.18 } = {}) {
  const h = figureHeight(state.shape) * 1.18 + 0.35;
  const target = new THREE.Vector3(0, h * 0.42, 0);
  let cam;
  if (ortho) {
    cam = new THREE.OrthographicCamera((-h / 2) * aspect, (h / 2) * aspect, h / 2, -h / 2, 0.05, 50);
  } else {
    cam = new THREE.PerspectiveCamera(30, aspect, 0.05, 60);
  }
  const dist = ortho ? 8 : h / 2 / Math.tan(THREE.MathUtils.degToRad(15)) * 1.05;
  cam.position.set(0, target.y + Math.sin(elevation) * dist, Math.cos(elevation) * dist);
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  return cam;
}

function canvasBlob(canvas, type = 'image/png') {
  return new Promise((res) => canvas.toBlob(res, type));
}

/** PNG of the current view. */
export async function photo(app) {
  const { renderer } = app;
  const size = renderer.getSize(new THREE.Vector2());
  const w = Math.round(size.x * Math.min(2, window.devicePixelRatio || 1));
  const h = Math.round(size.y * Math.min(2, window.devicePixelRatio || 1));
  const canvas = withFrame(app, w, h, {}, (draw) => draw());
  return canvasBlob(canvas);
}

/** A square portrait canvas (for the card). */
export function portrait(app, state, size = 512) {
  const cam = framingCamera(state, 1, { elevation: 0.12 });
  return withFrame(app, size, size, { camera: cam }, (draw) => draw());
}

/**
 * Sprite sheets: one PNG per animation, a row per direction and a column per frame, plus an
 * atlas.json describing them. Returns zip bytes.
 */
export async function spriteSheets(app, state, { directions = 4, cell = 256, frames = 8, clips = ['Idle', 'Walk', 'Run', 'Jump', 'Wave', 'Sit'] } = {}) {
  const { figure } = app;
  const dirs = DIRS[directions] ?? DIRS[4];
  const cam = framingCamera(state, 1, { ortho: true, elevation: 0.35 });
  const prevClip = figure.clipName;
  const prevRot = figure.group.rotation.y;
  const mixer = new THREE.AnimationMixer(figure.group);
  figure.mixer.stopAllAction();
  const atlas = { frameWidth: cell, frameHeight: cell, directions: dirs, note: 'Rows are directions (S faces the camera), columns are frames.', animations: {} };
  const files = [];
  try {
    for (const name of clips) {
      const clip = figure.clips.find((c) => c.name === name);
      if (!clip) continue;
      const sheet = document.createElement('canvas');
      sheet.width = cell * frames;
      sheet.height = cell * dirs.length;
      const ctx = sheet.getContext('2d');
      const action = mixer.clipAction(clip);
      action.play();
      withFrame(app, cell, cell, { transparent: true, camera: cam }, (draw) => {
        dirs.forEach((_, d) => {
          for (let f = 0; f < frames; f++) {
            const c = draw(() => {
              figure.group.rotation.y = (d / dirs.length) * Math.PI * 2;
              mixer.setTime((f / frames) * clip.duration);
            });
            ctx.drawImage(c, f * cell, d * cell);
          }
        });
      });
      action.stop();
      const file = `${name.toLowerCase()}.png`;
      atlas.animations[name] = { file, frames, fps: Math.round(frames / clip.duration), loop: true };
      files.push({ name: file, data: new Uint8Array(await (await canvasBlob(sheet)).arrayBuffer()) });
    }
  } finally {
    mixer.stopAllAction();
    figure.group.rotation.y = prevRot;
    figure.setClip(prevClip, true);
  }
  files.push({ name: 'atlas.json', data: new TextEncoder().encode(JSON.stringify(atlas, null, 2)) });
  return zipFiles(files);
}

/** A spinning turntable GIF. Returns a Blob. */
export async function turntableGif(app, state, { size = 320, frames = 36 } = {}) {
  const { figure } = app;
  const cam = framingCamera(state, 1, { elevation: 0.2 });
  const prevRot = figure.group.rotation.y;
  const gif = GIFEncoder();
  try {
    const canvases = withFrame(app, size, size, { camera: cam }, (draw) => {
      const out = [];
      for (let i = 0; i < frames; i++) {
        out.push(
          draw(() => {
            figure.group.rotation.y = (i / frames) * Math.PI * 2;
            figure.mixer?.update(1 / 12);
          }),
        );
      }
      return out;
    });
    for (const c of canvases) {
      const { data } = c.getContext('2d').getImageData(0, 0, size, size);
      const palette = quantize(data, 128);
      gif.writeFrame(applyPalette(data, palette), size, size, { palette, delay: 70 });
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
    }
  } finally {
    figure.group.rotation.y = prevRot;
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/** The parchment character card as a PNG Blob. */
export async function characterCard(app, state) {
  const W = 600;
  const H = 880;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(W * 0.35, H * 0.25, 40, W / 2, H / 2, H * 0.75);
  g.addColorStop(0, '#fbf3df');
  g.addColorStop(1, '#e3cfa3');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#7d1f18';
  ctx.lineWidth = 3;
  ctx.strokeRect(18, 18, W - 36, H - 36);
  ctx.lineWidth = 1;
  ctx.strokeRect(26, 26, W - 52, H - 52);
  const pic = portrait(app, state, 420);
  ctx.save();
  ctx.beginPath();
  ctx.rect(90, 50, 420, 420);
  ctx.clip();
  ctx.drawImage(pic, 90, 50);
  ctx.restore();
  ctx.strokeStyle = '#1d1712';
  ctx.strokeRect(90, 50, 420, 420);
  const card = state.card ?? {};
  ctx.fillStyle = '#1d1712';
  ctx.textAlign = 'center';
  ctx.font = '600 38px "Iowan Old Style", Palatino, Georgia, serif';
  ctx.fillText(card.name || 'Unnamed', W / 2, 522);
  ctx.font = 'italic 22px "Iowan Old Style", Palatino, Georgia, serif';
  ctx.fillStyle = '#7d1f18';
  ctx.fillText(card.role || '', W / 2, 554);
  ctx.textAlign = 'left';
  ctx.font = '18px "Iowan Old Style", Palatino, Georgia, serif';
  const stats = card.stats ?? [5, 5, 5, 5];
  STAT_NAMES.forEach((n, i) => {
    const y = 594 + i * 32;
    ctx.fillStyle = '#1d1712';
    ctx.fillText(n, 70, y + 6);
    ctx.fillStyle = 'rgba(60,40,20,0.15)';
    ctx.fillRect(190, y - 8, 330, 16);
    ctx.fillStyle = '#b8342a';
    ctx.fillRect(190, y - 8, (330 * Math.max(0, Math.min(10, stats[i] ?? 5))) / 10, 16);
  });
  ctx.fillStyle = '#3b2a1e';
  ctx.font = '17px "Iowan Old Style", Palatino, Georgia, serif';
  const lines = wrap(ctx, card.bio || '', W - 140).slice(0, 5);
  lines.forEach((l, i) => ctx.fillText(l, 70, 744 + i * 24));
  return canvasBlob(c);
}
