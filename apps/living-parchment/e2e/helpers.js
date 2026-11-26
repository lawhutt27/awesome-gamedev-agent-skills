// Shared harness for the browser tests: builds nothing, serves dist/ with `vite preview`,
// launches Chromium (software WebGL is fine) and drives the app through real DOM events.
import { preview } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS = path.join(root, 'test-results');
mkdirSync(SHOTS, { recursive: true });

export async function startServer() {
  const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  const url = server.resolvedUrls.local[0];
  return { server, url };
}

export async function launch() {
  return chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
}

/**
 * Synthetic pointer events are dispatched synchronously inside the page so a whole stroke
 * costs one round trip (software WebGL renders only a few frames per second).
 * setPointerCapture throws for synthetic pointer ids, so the test page makes it lenient.
 */
const INIT = () => {
  for (const name of ['setPointerCapture', 'releasePointerCapture']) {
    const orig = Element.prototype[name];
    Element.prototype[name] = function lenient(id) {
      try {
        return orig.call(this, id);
      } catch {
        return undefined;
      }
    };
  }
};

export async function openApp(browser, url, { viewport = { width: 720, height: 540 }, ...ctxOpts } = {}) {
  const context = await browser.newContext({ viewport, ...ctxOpts });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GPU stall due to ReadPixels/.test(t)) return; // software-GL perf notice, not a bug
    errors.push(`console: ${t}`);
  });
  await page.addInitScript(INIT);
  await page.goto(`${url}?quality=low`);
  await page.waitForFunction(() => window.renderer?.info.render.frame > 1, null, { timeout: 60000 });
  return { context, page, errors };
}

/** Page UV (v down the page) -> CSS pixel on screen, using the live camera. */
export async function uvToScreen(page, pts) {
  return page.evaluate((pts) => {
    const { camera, terrainY } = window.__lp;
    const rect = document.getElementById('scene').getBoundingClientRect();
    camera.updateMatrixWorld();
    return pts.map(([u, v]) => {
      const x = (u - 0.5) * 10;
      const z = (v - 0.5) * 10;
      const p = camera.position.clone().set(x, terrainY(x, z), z).project(camera);
      return [rect.left + (p.x * 0.5 + 0.5) * rect.width, rect.top + (-p.y * 0.5 + 0.5) * rect.height];
    });
  }, pts);
}

/** Dispatch a full stroke (screen px points) as pointer events on the canvas. */
export async function stroke(page, screenPts, { pointerType = 'mouse', buttons = 1, shiftKey = false } = {}) {
  await page.evaluate(
    ({ pts, pointerType, buttons, shiftKey }) => {
      const el = document.getElementById('scene');
      const base = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType, isPrimary: true, shiftKey };
      const ev = (type, [x, y], b) =>
        el.dispatchEvent(new PointerEvent(type, { ...base, clientX: x, clientY: y, buttons: b, button: type === 'pointermove' ? -1 : 0, pressure: b ? 0.5 : 0 }));
      ev('pointerdown', pts[0], buttons);
      for (let i = 1; i < pts.length; i++) ev('pointermove', pts[i], buttons);
      ev('pointerup', pts[pts.length - 1], 0);
    },
    { pts: screenPts, pointerType, buttons, shiftKey },
  );
}

export function circleUv(cu, cv, r, n = 48, sides = 0) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    let x = Math.cos(a);
    let y = Math.sin(a);
    if (sides === 4) {
      const m = Math.max(Math.abs(x), Math.abs(y));
      x /= m;
      y /= m;
    }
    pts.push([cu + x * r, cv + y * r]);
  }
  return pts;
}

export function riverUv(u0, v0, u1, v1, n = 40, amp = 0.03) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const nx = -(v1 - v0);
    const ny = u1 - u0;
    const l = Math.hypot(nx, ny);
    const s = Math.sin(t * Math.PI * 3) * amp;
    pts.push([u0 + (u1 - u0) * t + (nx / l) * s, v0 + (v1 - v0) * t + (ny / l) * s]);
  }
  return pts;
}

export async function drawUv(page, uvPts, opts) {
  await stroke(page, await uvToScreen(page, uvPts), opts);
}

export async function settle(page) {
  await page.waitForFunction(() => !window.__lp.spring.active, null, { timeout: 30000 });
}

export async function state(page) {
  return page.evaluate(() => {
    const lp = window.__lp;
    return {
      sprites: lp.sprites.count,
      meshCount: lp.sprites.mesh.count,
      rivers: lp.flow.riverCount,
      flowDrawn: lp.flow.points.geometry.drawRange.count,
      history: lp.parchment.history.map((h) => h.meta.kind),
      undoDisabled: document.getElementById('undo').disabled,
      biome: lp.biome,
    };
  });
}

/** Height (0..1) / masks at page UV from the composed CPU copy of the DataTexture. */
export async function sample(page, u, v, channel = 3) {
  return page.evaluate(([u, v, c]) => window.__lp.parchment.sample(u, v, c), [u, v, channel]);
}
