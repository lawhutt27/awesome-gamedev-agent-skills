// Phase 3 end-to-end tests: help panel and labels, the Dimensional Fold and walking,
// ink edges, .glb export, shareable world links and autosave.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, launch, openApp, drawUv, circleUv, riverUv, settle, state, sample, SHOTS } from './helpers.js';

let server;
let url;
let browser;

before(async () => {
  ({ server, url } = await startServer());
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const river = riverUv(0.15, 0.8, 0.85, 0.65);

async function buildWorld(page) {
  await drawUv(page, circleUv(0.35, 0.4, 0.13));
  await drawUv(page, circleUv(0.35, 0.4, 0.06));
  await drawUv(page, circleUv(0.7, 0.35, 0.08, 48, 4));
  await drawUv(page, river);
  await drawUv(page, [[0.5, 0.55]]);
  await drawUv(page, [[0.35, 0.4]]);
  await drawUv(page, [[0.7, 0.35]]);
  await settle(page);
}

describe('ui', () => {
  test('buttons are labelled in English', async () => {
    const { page, context } = await openApp(browser, url);
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#tools button, #toolbar button, #sidebar button')].map((b) => b.textContent.trim()),
    );
    assert.deepEqual(labels, [
      'Draw', 'Hill', 'Mountain', 'River', 'Lake', 'Road', 'Plant', 'Sculpt', 'Erase', 'Move',
      'Help', 'Options', 'Walk', 'Random', 'Photo', 'Share', '.glb',
      'Moss', 'Autumn', 'Moon', 'Undo', 'Redo', 'Clear',
    ]);
    // icon-only camera buttons still have English names
    const pad = await page.evaluate(() => [...document.querySelectorAll('#viewpad button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()));
    assert.deepEqual(pad, ['Turn left', 'Tilt up', 'Turn right', 'Zoom out', 'Tilt down', 'Zoom in', 'Reset view']);
    await context.close();
  });

  test('help opens on the first visit and from the Help button, and closes', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${url}?quality=low`);
    await page.waitForSelector('#help-panel:not([hidden])', { timeout: 30000 });
    const text = await page.textContent('#help-panel');
    for (const w of ['How to play', 'closed loop', 'river', 'Walking', 'Moss', 'Autumn', 'Moon']) {
      assert.ok(text.includes(w), w);
    }
    // the card fits a phone screen (it scrolls inside itself if needed)
    const box = await page.locator('.help-card').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
    await page.screenshot({ path: path.join(SHOTS, 'phase3-help.png') });
    await page.tap('#help-close');
    assert.equal(await page.isHidden('#help-panel'), true);
    await page.tap('#help');
    assert.equal(await page.isVisible('#help-panel'), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#help-panel'), true);
    // not shown again on reload
    await page.reload();
    await page.waitForFunction(() => window.renderer?.info.render.frame > 1, null, { timeout: 60000 });
    assert.equal(await page.isHidden('#help-panel'), true);
    await context.close();
  });
});

describe('world', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url));
    await buildWorld(page);
  });
  after(async () => context?.close());

  test('every committed stroke is logged for replay', async () => {
    const log = await page.evaluate(() => window.__lp.worldLog.map((e) => e.kind));
    assert.deepEqual(log, ['loop', 'loop', 'mountain', 'river', 'tap', 'tap', 'tap']);
  });

  test('ink-edge pass and projected cliff ink are active', async () => {
    const info = await page.evaluate(() => ({
      strength: window.__lp.inkPass.strength,
      cliff: !!window.__lp.uniforms.uCliffInk.value,
      target: window.__lp.inkPass.target.width > 0,
    }));
    assert.ok(info.strength > 0 && info.cliff && info.target);
    await page.screenshot({ path: path.join(SHOTS, 'phase3-map.png') });
  });

  test('Walk folds down to first person at fov 65 with the thumbstick', async () => {
    await page.click('#fold');
    await page.waitForFunction(() => window.__lp.rig.pov && Math.abs(window.__lp.camera.fov - 65) < 0.5, null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => {
      const { rig, camera, terrainY } = window.__lp;
      return {
        eye: camera.position.y - terrainY(rig.walker.x, rig.walker.z),
        stick: document.getElementById('stick').classList.contains('show'),
        label: document.getElementById('fold-label').textContent,
      };
    });
    assert.ok(Math.abs(s.eye - 0.34) < 0.05, `eye height ${s.eye}`);
    assert.equal(s.stick, true);
    assert.equal(s.label, 'Map');
    await page.screenshot({ path: path.join(SHOTS, 'phase3-ground.png') });
  });

  test('W walks forward; the thumbstick drives the same input', async () => {
    const z0 = await page.evaluate(() => window.__lp.rig.walker.z);
    await page.keyboard.down('w');
    await page.waitForTimeout(700);
    await page.keyboard.up('w');
    const z1 = await page.evaluate(() => window.__lp.rig.walker.z);
    assert.ok(z1 < z0 - 0.2, `walked ${z0} -> ${z1}`);
    const v = await page.evaluate(() => {
      const el = document.getElementById('stick');
      const r = el.getBoundingClientRect();
      const base = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: r.left + r.width / 2, clientY: r.top + 2, buttons: 1 }));
      const during = { ...window.__lp.rig.move };
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: r.left + r.width / 2, clientY: r.top + 2, buttons: 0 }));
      return { during, after: { ...window.__lp.rig.move } };
    });
    assert.ok(v.during.y > 0.9, `stick up = forward (${v.during.y})`);
    assert.deepEqual(v.after, { x: 0, y: 0 });
  });

  test('at ground level a drag looks around instead of drawing, and a tap plants', async () => {
    const before = await state(page);
    const yaw0 = await page.evaluate(() => window.__lp.rig.walker.goalYaw);
    await page.evaluate(() => {
      const el = document.getElementById('scene');
      const base = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const ev = (t, x, y, b) => el.dispatchEvent(new PointerEvent(t, { ...base, clientX: x, clientY: y, buttons: b }));
      ev('pointerdown', 300, 300, 1);
      for (let i = 1; i <= 10; i++) ev('pointermove', 300 + i * 12, 300, 1);
      ev('pointerup', 420, 300, 0);
    });
    const yaw1 = await page.evaluate(() => window.__lp.rig.walker.goalYaw);
    assert.ok(yaw1 < yaw0 - 0.3, 'dragging right turns right');
    assert.equal((await state(page)).history.length, before.history.length);
    await page.evaluate(() => {
      const el = document.getElementById('scene');
      const base = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: 360, clientY: 420, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: 360, clientY: 420, buttons: 0 }));
    });
    const after = await state(page);
    assert.ok(after.sprites > before.sprites, 'planted at ground level');
    assert.equal(after.history.at(-1), 'tap');
  });

  test('Map flies back up to the tabletop view', async () => {
    await page.click('#fold');
    await page.waitForFunction(() => !window.__lp.rig.pov && Math.abs(window.__lp.camera.fov - 35) < 0.5, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => document.getElementById('stick').classList.contains('show')), false);
  });

  test('.glb export contains the terrain, rim and sprite meshes', async () => {
    const gltf = await page.evaluate(async () => {
      const buf = await window.__lp.exportWorld({ download: false });
      const v = new DataView(buf);
      const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
      const jsonLen = v.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
      return {
        magic,
        version: v.getUint32(4, true),
        bytes: buf.byteLength,
        meshes: json.nodes.map((n) => n.name),
        images: json.images?.length ?? 0,
        masked: json.materials.filter((m) => m.alphaMode === 'MASK').length,
      };
    });
    assert.equal(gltf.magic, 'glTF');
    assert.equal(gltf.version, 2);
    assert.ok(gltf.meshes.includes('Terrain') && gltf.meshes.includes('Rim'), gltf.meshes.join());
    assert.ok(gltf.meshes.some((n) => /trees|reeds|stones|lanterns/.test(n)));
    assert.ok(gltf.images >= 2 && gltf.masked >= 1);
    await page.click('#export');
    const download = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#export-go');
    assert.equal((await download).suggestedFilename(), 'living-parchment-map.glb');
    await page.click('#export-close');
  });

  test('Share puts the world in the link and the link rebuilds it', async () => {
    await page.click('#share');
    await page.waitForFunction(() => location.hash.startsWith('#w1'), null, { timeout: 10000 });
    const hash = await page.evaluate(() => location.hash);
    const original = {
      log: await page.evaluate(() => window.__lp.worldLog.length),
      sprites: (await state(page)).sprites,
      hill: await sample(page, 0.35, 0.4),
      rock: await sample(page, 0.7, 0.35, 1),
      water: await sample(page, ...river[20]),
    };
    const other = await openApp(browser, url, { hash });
    await settle(other.page);
    const copy = {
      log: await other.page.evaluate(() => window.__lp.worldLog.length),
      sprites: (await state(other.page)).sprites,
      hill: await sample(other.page, 0.35, 0.4),
      rock: await sample(other.page, 0.7, 0.35, 1),
      water: await sample(other.page, ...river[20]),
    };
    assert.equal(copy.log, original.log);
    assert.equal(copy.sprites, original.sprites);
    assert.ok(Math.abs(copy.hill - original.hill) < 0.01, `hill ${original.hill} vs ${copy.hill}`);
    assert.ok(Math.abs(copy.rock - original.rock) < 0.01);
    assert.ok(Math.abs(copy.water - original.water) < 0.01);
    const same = await other.page.evaluate(
      (pos) => window.__lp.sprites.items.every((it, i) => Math.abs(it.x - pos[i][0]) < 1e-6 && Math.abs(it.z - pos[i][1]) < 1e-6),
      await page.evaluate(() => window.__lp.sprites.items.map((it) => [it.x, it.z])),
    );
    assert.ok(same, 'sprites land in the same places');
    await other.page.waitForTimeout(1200);
    await other.page.screenshot({ path: path.join(SHOTS, 'phase3-shared.png') });
    assert.deepEqual(other.errors, []);
    await other.context.close();
  });

  test('the world autosaves and comes back after a reload', async () => {
    const n = await page.evaluate(() => window.__lp.worldLog.length);
    await page.waitForTimeout(800); // autosave debounce
    await page.evaluate(() => history.replaceState(null, '', location.pathname + location.search));
    await page.reload();
    await page.waitForFunction(() => window.renderer?.info.render.frame > 1, null, { timeout: 60000 });
    await page.waitForFunction((n) => window.__lp.worldLog.length === n, n, { timeout: 30000 });
  });

  test('no errors', () => {
    assert.deepEqual(errors, []);
  });
});
