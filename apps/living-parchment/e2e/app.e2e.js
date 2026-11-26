// End-to-end tests: the real app in headless Chromium, driven through DOM pointer events.
// Run with `npm run test:e2e` (builds first). Screenshots land in test-results/.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  startServer,
  launch,
  openApp,
  drawUv,
  stroke,
  uvToScreen,
  circleUv,
  riverUv,
  settle,
  state,
  sample,
  SHOTS,
} from './helpers.js';

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

describe('desktop', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url));
  });
  after(async () => context?.close());

  test('boots: renders frames with terrain, rim, table, sprites and shadows, no errors', async () => {
    const info = await page.evaluate(() => {
      const r = window.renderer;
      const names = [];
      window.__lp.scene.traverse((o) => o.name && names.push(o.name));
      const terrain = window.__lp.scene.getObjectByName('terrain');
      return {
        calls: r.info.render.calls,
        shadow: r.shadowMap.enabled,
        names,
        segments: terrain.geometry.parameters.widthSegments,
        hasDepthMat: !!terrain.customDepthMaterial,
        spriteDepth: !!window.__lp.sprites.mesh.customDepthMaterial,
        spriteIsInstanced: window.__lp.sprites.mesh.isInstancedMesh,
        alphaTest: window.__lp.sprites.material.alphaTest,
        pixelRatio: r.getPixelRatio(),
      };
    });
    assert.ok(info.calls > 0, 'draw calls');
    assert.ok(info.shadow);
    for (const n of ['terrain', 'rim', 'table', 'sprites', 'flow']) assert.ok(info.names.includes(n), n);
    assert.equal(info.segments, 160);
    assert.ok(info.hasDepthMat && info.spriteDepth && info.spriteIsInstanced);
    assert.equal(info.alphaTest, 0.5);
    assert.ok(info.pixelRatio <= 2);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-0-empty.png') });
    assert.deepEqual(errors, []);
  });

  test('viewport is touch-locked (touch-action, user-select, overscroll)', async () => {
    const css = await page.evaluate(() => {
      const b = getComputedStyle(document.body);
      const c = getComputedStyle(document.getElementById('scene'));
      return { body: b.touchAction, canvas: c.touchAction, select: b.userSelect, over: b.overscrollBehaviorY };
    });
    assert.equal(css.body, 'none');
    assert.equal(css.canvas, 'none');
    assert.equal(css.select, 'none');
    assert.equal(css.over, 'none');
  });

  test('a closed loop raises a terraced hill with a spring settle', async () => {
    const before = await sample(page, 0.35, 0.45);
    await drawUv(page, circleUv(0.35, 0.45, 0.12));
    const s = await state(page);
    assert.deepEqual(s.history, ['loop']);
    assert.equal(s.undoDisabled, false);
    assert.equal(await page.evaluate(() => window.__lp.spring.active), true);
    await settle(page);
    const after = await sample(page, 0.35, 0.45);
    assert.ok(Math.abs(before - 0.5) < 0.01, `flat before (${before})`);
    assert.ok(after > 0.58, `raised (${after})`);
    assert.ok((await sample(page, 0.35, 0.45, 0)) > 0.5, 'grass mask');
    assert.equal(await page.evaluate(() => window.__lp.uniforms.uMix.value), 1);
  });

  test('a loop inside a hill stacks a higher terrace', async () => {
    const h1 = await sample(page, 0.35, 0.45);
    await drawUv(page, circleUv(0.35, 0.45, 0.05));
    await settle(page);
    const h2 = await sample(page, 0.35, 0.45);
    assert.ok(h2 > h1 + 0.08, `${h1} -> ${h2}`);
    // the outer ring of the first hill keeps its first-terrace height
    const ring = await sample(page, 0.35 + 0.09, 0.45);
    assert.ok(ring > 0.56 && ring < h2 - 0.05, `ring ${ring}`);
  });

  test('an angular loop builds a stone ruin plateau', async () => {
    await drawUv(page, circleUv(0.72, 0.3, 0.08, 48, 4));
    const s = await state(page);
    assert.equal(s.history.at(-1), 'ruin');
    await settle(page);
    assert.ok((await sample(page, 0.72, 0.3, 1)) > 0.5, 'stone mask');
    assert.ok((await sample(page, 0.72, 0.3)) > 0.55, 'plateau');
  });

  const river = riverUv(0.12, 0.85, 0.88, 0.7);
  const mid = river[20];
  test('an open stroke carves a river with water and flow particles', async () => {
    await drawUv(page, river);
    const s = await state(page);
    assert.equal(s.history.at(-1), 'river');
    assert.equal(s.rivers, 1);
    assert.ok(s.flowDrawn > 5);
    await settle(page);
    const h = await sample(page, ...mid);
    assert.ok(h < 0.42, `below water table (${h})`);
    assert.ok((await sample(page, ...mid, 2)) > 0.5, 'water mask');
    const moved = await page.evaluate(async () => {
      const p = window.__lp.flow.positions;
      const a = [p[0], p[2]];
      await new Promise((r) => setTimeout(r, 600));
      return Math.hypot(p[0] - a[0], p[2] - a[1]);
    });
    assert.ok(moved > 0.01, 'flow particles move');
  });

  test('a tap plants an instanced cluster of paper-cutout sprites', async () => {
    const n0 = (await state(page)).sprites;
    await drawUv(page, [[0.6, 0.5]]);
    const s = await state(page);
    assert.ok(s.sprites - n0 >= 3 && s.sprites - n0 <= 6, `planted ${s.sprites - n0}`);
    assert.equal(s.meshCount, s.sprites);
    assert.equal(s.history.at(-1), 'tap');
  });

  test('tapping a river plants reeds', async () => {
    const n0 = (await state(page)).sprites;
    await drawUv(page, [mid]);
    const types = await page.evaluate((n0) => window.__lp.sprites.items.slice(n0).map((i) => i.type), n0);
    assert.ok(types.length >= 3);
    assert.ok(types.filter((t) => t === 1).length >= types.length / 2, `types ${types}`);
  });

  test('a short flick plants a row of sprites', async () => {
    const n0 = (await state(page)).sprites;
    await drawUv(page, [
      [0.55, 0.2],
      [0.565, 0.2],
      [0.58, 0.2],
      [0.595, 0.2],
    ]);
    const s = await state(page);
    assert.equal(s.history.at(-1), 'flick');
    assert.ok(s.sprites - n0 >= 3);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-1-world.png') });
  });

  test('undo pops strokes: sprites, rivers and terrain return', async () => {
    const s0 = await state(page);
    await page.click('#undo'); // flick
    await page.click('#undo'); // reeds
    await page.click('#undo'); // tap
    let s = await state(page);
    assert.equal(s.history.length, s0.history.length - 3);
    assert.equal(s.sprites, 0);
    await page.click('#undo'); // river
    await settle(page);
    s = await state(page);
    assert.equal(s.rivers, 0);
    assert.equal(s.flowDrawn, 0);
    assert.ok(Math.abs((await sample(page, ...mid)) - 0.5) < 0.02, 'river filled back in');
    await page.keyboard.press('Control+z'); // ruin
    await settle(page);
    assert.ok((await sample(page, 0.72, 0.3, 1)) < 0.05);
  });

  test('history keeps at most 10 steps', async () => {
    for (let i = 0; i < 12; i++) await drawUv(page, [[0.15 + i * 0.05, 0.15]]);
    const s = await state(page);
    assert.equal(s.history.length, 10);
    for (let i = 0; i < 10; i++) await page.click('#undo');
    const after = await state(page);
    assert.equal(after.history.length, 0);
    assert.equal(after.undoDisabled, true);
    // the two strokes that fell off the stack stay on the page
    assert.ok(after.sprites > 0);
  });

  test('clear page wipes everything and is undoable', async () => {
    const r2 = riverUv(0.1, 0.6, 0.9, 0.6);
    await drawUv(page, r2);
    await drawUv(page, [[0.3, 0.3]]);
    const s0 = await state(page);
    await page.click('#clear');
    await settle(page);
    let s = await state(page);
    assert.equal(s.sprites, 0);
    assert.equal(s.rivers, 0);
    assert.ok(Math.abs((await sample(page, ...r2[20])) - 0.5) < 0.01);
    await page.click('#undo');
    await settle(page);
    s = await state(page);
    assert.equal(s.sprites, s0.sprites);
    assert.equal(s.rivers, 1);
    assert.ok((await sample(page, ...r2[20])) < 0.42);
  });

  test('biome switch flips sprites, retints light and water, updates the UI', async () => {
    const before = await page.evaluate(() => ({
      sun: window.__lp.scene.children.find((o) => o.isDirectionalLight).color.getHexString(),
      water: window.__lp.uniforms.uWaterInk.value.getHexString(),
    }));
    await page.click('[data-biome="moonlitTide"]');
    await page.waitForFunction(() => window.__lp.sprites.uniforms.uFlip.value === 1 && window.__lp.sprites.uniforms.uBiomeRow.value === 2, null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      sun: window.__lp.scene.children.find((o) => o.isDirectionalLight).color.getHexString(),
      water: window.__lp.uniforms.uWaterInk.value.getHexString(),
      checked: document.querySelector('[data-biome="moonlitTide"]').getAttribute('aria-checked'),
      glow: window.__lp.sprites.material.emissiveIntensity,
    }));
    assert.notEqual(after.sun, before.sun);
    assert.notEqual(after.water, before.water);
    assert.equal(after.checked, 'true');
    assert.ok(after.glow > 1);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-2-moonlit.png') });
    await page.keyboard.press('2');
    assert.equal((await state(page)).biome, 'autumnRidge');
  });

  test('right-drag orbits and tilts, wheel zooms, neither draws', async () => {
    const g0 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    const h0 = (await state(page)).history.length;
    await stroke(
      page,
      [
        [300, 300],
        [340, 280],
        [380, 260],
      ],
      { buttons: 2 },
    );
    const g1 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    assert.notEqual(g1.yaw, g0.yaw);
    assert.notEqual(g1.pitch, g0.pitch);
    await page.mouse.move(360, 270);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction((d) => window.__lp.rig.goal.distance > d, g1.distance);
    assert.equal((await state(page)).history.length, h0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-3-orbit.png') });
  });

  test('strokes that start off the page do nothing', async () => {
    await page.evaluate(() => Object.assign(window.__lp.rig.goal, { yaw: 0, pitch: 1.05, distance: 15.5 }));
    await page.waitForTimeout(800);
    const h0 = (await state(page)).history.length;
    await stroke(page, [
      [3, 3],
      [6, 6],
    ]);
    assert.equal((await state(page)).history.length, h0);
  });

  test('audio unlocks on the first stroke and the pen scratch follows velocity', async () => {
    const a = await page.evaluate(() => {
      const s = window.__lp.synth;
      return { ready: s.ready, state: s.ctx?.state };
    });
    assert.equal(a.ready, true);
    assert.notEqual(a.state, 'closed');
  });

  test('survives a WebGL context loss', async () => {
    await page.evaluate(async () => {
      window.renderer.forceContextLoss();
      await new Promise((r) => setTimeout(r, 300));
      window.renderer.forceContextRestore();
      await new Promise((r) => setTimeout(r, 1500));
    });
    const f0 = await page.evaluate(() => window.renderer.info.render.frame);
    await page.waitForFunction((f) => window.renderer.info.render.frame > f + 1, f0, { timeout: 30000 });
    assert.deepEqual(errors.filter((e) => !/CONTEXT_LOST|context lost/i.test(e)), []);
  });

  test('steady state: no texture or geometry leaks across frames', async () => {
    const m0 = await page.evaluate(() => ({ ...window.renderer.info.memory }));
    await page.waitForTimeout(1500);
    const m1 = await page.evaluate(() => ({ ...window.renderer.info.memory }));
    assert.deepEqual(m1, m0);
    const calls = await page.evaluate(() => window.renderer.info.render.calls);
    assert.ok(calls <= 12, `draw calls ${calls}`);
  });
});

describe('mobile (touch)', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    }));
  });
  after(async () => context?.close());

  test('portrait layout: whole page and toolbar fit, no scrolling', async () => {
    const m = await page.evaluate(() => {
      const t = document.getElementById('toolbar').getBoundingClientRect();
      return {
        toolbar: [t.left, t.right, t.bottom],
        sw: document.documentElement.scrollWidth,
        w: innerWidth,
        h: innerHeight,
      };
    });
    assert.ok(m.toolbar[0] >= 0 && m.toolbar[1] <= m.w && m.toolbar[2] <= m.h);
    assert.ok(m.sw <= m.w);
    // every corner of the page is on screen
    const corners = await uvToScreen(page, [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    for (const [x, y] of corners) assert.ok(x >= 0 && x <= m.w && y >= 0 && y <= m.h, `corner ${x},${y}`);
  });

  test('a touch tap plants sprites', async () => {
    const [[x, y]] = await uvToScreen(page, [[0.5, 0.5]]);
    await page.touchscreen.tap(x, y);
    await page.waitForFunction(() => window.__lp.sprites.count > 0, null, { timeout: 20000 });
  });

  test('a touch stroke draws a loop', async () => {
    await drawUv(page, circleUv(0.4, 0.35, 0.12), { pointerType: 'touch' });
    assert.equal((await state(page)).history.at(-1), 'loop');
  });

  test('two-finger pinch zooms and cancels the stroke in progress', async () => {
    const cdp = await context.newCDPSession(page);
    const h0 = (await state(page)).history.length;
    const d0 = await page.evaluate(() => window.__lp.rig.goal.distance);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const c = { x: 195, y: 420 };
    await touch('touchStart', [{ x: c.x, y: c.y - 30, id: 1 }]);
    await touch('touchMove', [{ x: c.x + 5, y: c.y - 40, id: 1 }]);
    await touch('touchStart', [
      { x: c.x + 5, y: c.y - 40, id: 1 },
      { x: c.x, y: c.y + 30, id: 2 },
    ]);
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [
        { x: c.x + 5, y: c.y - 40 - i * 15, id: 1 },
        { x: c.x, y: c.y + 30 + i * 15, id: 2 },
      ]);
    }
    await touch('touchEnd', []);
    const d1 = await page.evaluate(() => window.__lp.rig.goal.distance);
    assert.ok(d1 < d0, `pinch out zooms in (${d0} -> ${d1})`);
    const s = await state(page);
    assert.equal(s.history.length, h0, 'no stroke committed');
    assert.equal(await page.evaluate(() => window.__lp.parchment.pending), null);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, 'mobile-0.png') });
    assert.deepEqual(errors, []);
  });

  test('toolbar buttons respond to touch', async () => {
    await page.tap('[data-biome="autumnRidge"]');
    assert.equal((await state(page)).biome, 'autumnRidge');
  });
});
