// Shared harness for the browser tests: serves dist/ with `vite preview`, launches Chromium
// (software WebGL is fine) and drives the app through real DOM events.
import { preview } from 'vite';
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS = path.join(root, 'test-results');
mkdirSync(SHOTS, { recursive: true });

export async function startServer() {
  const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  return { server, url: server.resolvedUrls.local[0] };
}

export async function launch() {
  // Use a preinstalled Chromium when the environment provides one.
  const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  return chromium.launch({ executablePath });
}

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

export async function openApp(browser, url, { viewport = { width: 1280, height: 800 }, hash = '' } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GPU stall due to ReadPixels/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  await page.addInitScript(INIT);
  await page.goto(`${url}?quality=low${hash}`);
  await page.waitForFunction(() => window.renderer?.info.render.frame > 1, null, { timeout: 60000 });
  return { context, page, errors };
}

/** Draw a stroke through front-plane points (metres) by projecting them to the screen. */
export async function draw(page, pts) {
  await page.evaluate((pts) => {
    const { camera, THREE } = window.__figures;
    const c = document.getElementById('scene');
    const r = c.getBoundingClientRect();
    const scr = pts.map(([x, y]) => {
      const v = new THREE.Vector3(x, y, 0).project(camera);
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    });
    const ev = (type, [cx, cy]) =>
      c.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, pointerId: 7, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerType: 'mouse' }));
    ev('pointerdown', scr[0]);
    for (const p of scr.slice(1)) ev('pointermove', p);
    ev('pointerup', scr[scr.length - 1]);
  }, pts);
}

export const loop = (cx, cy, rx, ry, n = 32) => Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * rx, cy + Math.sin((i / n) * Math.PI * 2) * ry]);

/** Click a button that triggers a download and return its bytes and name. */
export async function downloadFrom(page, selector, timeout = 120000) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), page.click(selector)]);
  const file = await dl.path();
  const { readFileSync } = await import('node:fs');
  return { name: dl.suggestedFilename(), bytes: readFileSync(file) };
}
