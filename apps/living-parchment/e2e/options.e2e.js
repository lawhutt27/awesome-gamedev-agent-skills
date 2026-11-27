// Tool rail, Options panel, Redo / Random / Photo and the free desktop camera.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, launch, openApp, drawUv, circleUv, riverUv, stroke, settle, state, sample, SHOTS } from './helpers.js';

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

const lastKind = async (page) => page.evaluate(() => window.__lp.worldLog.at(-1)?.kind);
const tool = (page, id) => page.click(`.tool-btn[data-tool="${id}"]`);
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Three quarters of a circle: open, but it encloses area. */
function arcUv(cu, cv, r) {
  return circleUv(cu, cv, r, 48).slice(0, 37);
}

describe('tools', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url));
  });
  after(async () => context?.close());

  test('the tool rail is a radio group that starts on Draw', async () => {
    const checked = await page.evaluate(() =>
      [...document.querySelectorAll('.tool-btn')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.tool),
    );
    assert.deepEqual(checked, ['auto']);
    await tool(page, 'hill');
    assert.equal(await page.evaluate(() => window.__lp.opts.tool), 'hill');
    assert.equal(await page.getAttribute('.tool-btn[data-tool="auto"]', 'aria-checked'), 'false');
  });

  test('Hill raises a hill from an open stroke that Draw would call a river', async () => {
    await drawUv(page, arcUv(0.3, 0.35, 0.11));
    await settle(page);
    assert.equal(await lastKind(page), 'loop');
    assert.ok((await sample(page, 0.3, 0.35)) > 0.55);
  });

  test('Hill ignores a tap and says why', async () => {
    const n = await page.evaluate(() => window.__lp.worldLog.length);
    await drawUv(page, [[0.6, 0.6]]);
    assert.equal(await page.evaluate(() => window.__lp.worldLog.length), n);
    assert.match(await page.textContent('#toast'), /hill/);
  });

  test('River carves a river from a closed loop', async () => {
    await tool(page, 'river');
    await drawUv(page, circleUv(0.7, 0.3, 0.1));
    await settle(page);
    assert.equal(await lastKind(page), 'river');
    assert.ok((await sample(page, 0.8, 0.3, 2)) > 0.5, 'water along the ring');
  });

  test('Ruin builds a ruin from a smooth loop', async () => {
    await tool(page, 'ruin');
    await drawUv(page, circleUv(0.3, 0.75, 0.08));
    await settle(page);
    assert.equal(await lastKind(page), 'ruin');
    assert.ok((await sample(page, 0.3, 0.75, 1)) > 0.5, 'stone inside');
  });

  test('Plant drags a row, and "What to plant" picks the sprite', async () => {
    await tool(page, 'plant');
    await page.click('#options-btn');
    await page.click('.seg[data-opt="plant"] button[data-value="3"]'); // Stones
    await page.click('#options-close');
    const before = (await state(page)).sprites;
    await drawUv(page, riverUv(0.5, 0.85, 0.9, 0.85, 20, 0));
    assert.equal(await lastKind(page), 'row');
    const added = await page.evaluate((n) => window.__lp.sprites.items.slice(n).map((it) => it.type), before);
    assert.ok(added.length >= 6, `planted ${added.length}`);
    assert.ok(added.every((t) => t === 2), 'all standing stones');
    assert.equal(await page.evaluate(() => window.__lp.worldLog.at(-1).plant), 3);
  });

  test('Erase rubs out a hill and its planting; Undo brings them back; Redo erases again', async () => {
    await tool(page, 'plant');
    await page.evaluate(() => (window.__lp.opts.plant = 0));
    await drawUv(page, [[0.3, 0.35]]);
    const before = { sprites: (await state(page)).sprites, h: await sample(page, 0.3, 0.35) };
    await tool(page, 'erase');
    await page.click('#options-btn');
    await page.click('.seg[data-opt="size"] button[data-value="2"]'); // Bold
    await page.click('#options-close');
    await drawUv(page, riverUv(0.18, 0.35, 0.42, 0.35, 24, 0));
    await settle(page);
    assert.equal(await lastKind(page), 'erase');
    const erased = { sprites: (await state(page)).sprites, h: await sample(page, 0.3, 0.35) };
    assert.ok(erased.sprites < before.sprites, `sprites ${before.sprites} -> ${erased.sprites}`);
    assert.ok(Math.abs(erased.h - 0.5) < 0.03, `flattened to paper (${erased.h})`);
    await page.screenshot({ path: path.join(SHOTS, 'options-erase.png') });

    await page.click('#undo');
    await settle(page);
    assert.equal((await state(page)).sprites, before.sprites);
    assert.ok(Math.abs((await sample(page, 0.3, 0.35)) - before.h) < 0.01);
    assert.equal(await page.isDisabled('#redo'), false);

    await page.click('#redo');
    await settle(page);
    assert.equal((await state(page)).sprites, erased.sprites);
    assert.ok(Math.abs((await sample(page, 0.3, 0.35)) - erased.h) < 0.01);
    assert.equal(await page.isDisabled('#redo'), true);
  });

  test('a new stroke clears Redo; Ctrl+Shift+Z redoes', async () => {
    await page.keyboard.press('Control+z');
    assert.equal(await page.isDisabled('#redo'), false);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.isDisabled('#redo'), true);
    await page.keyboard.press('Control+z');
    await tool(page, 'auto');
    await drawUv(page, [[0.85, 0.15]]);
    assert.equal(await page.isDisabled('#redo'), true);
  });

  test('Bold rivers are wider than Fine ones', async () => {
    await page.evaluate(() => window.__lp.clearPage());
    await page.click('#options-btn');
    await page.click('.seg[data-opt="size"] button[data-value="1"]'); // Fine
    await page.click('#options-close');
    await drawUv(page, riverUv(0.1, 0.25, 0.9, 0.25, 30, 0));
    await page.click('#options-btn');
    await page.click('.seg[data-opt="size"] button[data-value="2"]'); // Bold
    await page.click('#options-close');
    await drawUv(page, riverUv(0.1, 0.7, 0.9, 0.7, 30, 0));
    await settle(page);
    const fine = await sample(page, 0.5, 0.25 + 0.022, 2);
    const bold = await sample(page, 0.5, 0.7 + 0.022, 2);
    assert.ok(bold > 0.5 && fine < bold, `water beside the centreline: fine ${fine}, bold ${bold}`);
    await page.click('#options-btn');
    await page.click('.seg[data-opt="size"] button[data-value="0"]');
    await page.click('#options-close');
  });

  test('Random draws a whole world as one undoable step', async () => {
    const n0 = await page.evaluate(() => window.__lp.worldLog.length);
    await page.click('#random');
    await settle(page);
    const s = await state(page);
    const n1 = await page.evaluate(() => window.__lp.worldLog.length);
    assert.ok(n1 >= 8, `random world has ${n1} strokes`);
    assert.ok(s.sprites > 10 && s.rivers >= 1);
    assert.equal(s.history.at(-1), 'batch');
    // the same seed makes the same world
    const a = await page.evaluate(() => JSON.stringify(window.__lp.randomEntries(1234)));
    const b = await page.evaluate(() => JSON.stringify(window.__lp.randomEntries(1234)));
    assert.equal(a, b);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, 'options-random.png') });
    await page.click('#undo');
    assert.equal(await page.evaluate(() => window.__lp.worldLog.length), n0);
    await page.click('#redo');
    assert.equal(await page.evaluate(() => window.__lp.worldLog.length), n1);
  });

  test('share links keep erase, brush size and planting choices', async () => {
    await page.evaluate(() => window.__lp.clearPage());
    await drawUv(page, circleUv(0.4, 0.4, 0.12));
    await page.click('#options-btn');
    await page.click('.seg[data-opt="size"] button[data-value="2"]');
    await page.click('.seg[data-opt="plant"] button[data-value="4"]'); // Lanterns
    await page.click('#options-close');
    await drawUv(page, [[0.4, 0.4]]);
    await drawUv(page, [[0.65, 0.65]]);
    await tool(page, 'erase');
    await drawUv(page, riverUv(0.3, 0.5, 0.55, 0.5, 16, 0));
    await tool(page, 'auto');
    await settle(page);
    const code = await page.evaluate(() => window.__lp.encodeWorld());
    const original = await page.evaluate(() => ({
      kinds: window.__lp.worldLog.map((e) => `${e.kind}:${e.size ?? 0}:${e.plant ?? 0}`),
      sprites: window.__lp.sprites.items.map((it) => [it.x, it.z, it.type]),
      h: window.__lp.parchment.sample(0.4, 0.5),
    }));
    assert.ok(original.kinds.includes('erase:2:0') && original.kinds.includes('tap:2:4'), original.kinds.join());
    const other = await openApp(browser, url, { hash: `#${code}` });
    await settle(other.page);
    const copy = await other.page.evaluate(() => ({
      kinds: window.__lp.worldLog.map((e) => `${e.kind}:${e.size ?? 0}:${e.plant ?? 0}`),
      sprites: window.__lp.sprites.items.map((it) => [it.x, it.z, it.type]),
      h: window.__lp.parchment.sample(0.4, 0.5),
    }));
    assert.deepEqual(copy.kinds, original.kinds);
    assert.equal(copy.sprites.length, original.sprites.length);
    assert.ok(copy.sprites.every((p, i) => Math.abs(p[0] - original.sprites[i][0]) < 1e-6 && p[2] === original.sprites[i][2]));
    assert.ok(Math.abs(copy.h - original.h) < 0.01);
    assert.deepEqual(other.errors, []);
    await other.context.close();
  });

  test('no errors', () => {
    assert.deepEqual(errors, []);
  });
});

describe('camera and options', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url, { viewport: { width: 1100, height: 700 } }));
    await page.evaluate(() => window.__lp.randomWorld(99));
    await settle(page);
  });
  after(async () => context?.close());

  test('Move tool: a left-drag turns and tilts instead of drawing', async () => {
    await tool(page, 'move');
    const g0 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    const h0 = (await state(page)).history.length;
    await stroke(page, [[500, 350], [560, 330], [620, 310]]);
    const g1 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    assert.ok(g1.yaw < g0.yaw - 0.3 && g1.pitch !== g0.pitch);
    assert.equal((await state(page)).history.length, h0);
    assert.equal(await page.evaluate(() => document.getElementById('scene').style.cursor), 'grab');
    await tool(page, 'auto');
  });

  test('middle-drag and Alt-drag pan the map; neither draws', async () => {
    const h0 = (await state(page)).history.length;
    await page.evaluate(() => window.__lp.viewAction('reset'));
    await stroke(page, [[500, 350], [450, 350], [400, 350]], { buttons: 4 });
    const g1 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    assert.ok(g1.panX > 0.1, `dragging left moves the view right (${g1.panX})`);
    await stroke(page, [[500, 350], [500, 300], [500, 250]], { altKey: true });
    const g2 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    assert.ok(g2.panZ > g1.panZ + 0.1, `dragging up moves the view toward you (${g2.panZ})`);
    assert.equal((await state(page)).history.length, h0);
  });

  test('the map turns all the way round and tilts from nearly edge-on to straight down', async () => {
    await page.evaluate(() => window.__lp.viewAction('reset'));
    for (let i = 0; i < 8; i++) await page.click('#viewpad [data-view="turn-left"]');
    assert.ok(Math.abs((await page.evaluate(() => window.__lp.rig.goal.yaw)) - Math.PI * 2) < 1e-6);
    for (let i = 0; i < 6; i++) await page.click('#viewpad [data-view="tilt-down"]');
    assert.ok((await page.evaluate(() => window.__lp.rig.goal.pitch)) <= 0.11);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, 'options-low-angle.png') });
    await page.click('#options-btn');
    await page.click('#options [data-view="top"]');
    assert.equal(await page.evaluate(() => window.__lp.rig.goal.pitch), 1.56);
    await page.click('#options-close');
    await page.click('#viewpad [data-view="reset"]');
    const g = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    assert.deepEqual([g.yaw, g.pitch, g.zoomK, g.panX, g.panZ, g.fold], [0, 1.05, 1, 0, 0, 0.4]);
  });

  test('wheel and the zoom buttons dolly in and out before folding', async () => {
    await page.click('#viewpad [data-view="zoom-in"]');
    assert.ok((await page.evaluate(() => window.__lp.rig.goal.zoomK)) < 1);
    assert.equal(await page.evaluate(() => window.__lp.rig.goal.fold), 0.4);
    await page.mouse.move(550, 350);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -200);
    await page.waitForFunction(() => window.__lp.rig.goal.fold === 1, null, { timeout: 10000 });
    await page.click('#fold'); // Map
    await page.waitForFunction(() => !window.__lp.rig.pov, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__lp.rig.goal.zoomK), 1);
  });

  test('keys: Q turns, R tilts, D slides the map, 0 resets', async () => {
    await page.evaluate(() => window.__lp.viewAction('reset'));
    await page.waitForTimeout(300);
    const g0 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    await page.keyboard.down('q');
    await page.keyboard.down('f');
    await page.keyboard.down('d');
    await page.waitForTimeout(600);
    await page.keyboard.up('q');
    await page.keyboard.up('f');
    await page.keyboard.up('d');
    const g1 = await page.evaluate(() => ({ ...window.__lp.rig.goal }));
    assert.ok(g1.yaw > g0.yaw + 0.1, 'Q turns');
    assert.ok(g1.pitch < g0.pitch - 0.05, 'F tilts toward the horizon');
    assert.ok(Math.hypot(g1.panX, g1.panZ) > 0.1, 'D slides');
    await page.keyboard.press('0');
    assert.equal(await page.evaluate(() => window.__lp.rig.goal.panX), 0);
  });

  test('display switches and the sun apply live and are remembered', async () => {
    await page.click('#options-btn');
    assert.equal(await page.isVisible('#options'), true);
    await page.screenshot({ path: path.join(SHOTS, 'options-panel.png') });
    for (const o of ['ink', 'contours', 'wind', 'water', 'sound']) await page.uncheck(`#options input[data-opt="${o}"]`);
    await frame(page);
    const off = await page.evaluate(() => ({
      ink: window.__lp.inkPass.strength,
      contour: window.__lp.uniforms.uContourAmt.value,
      wind: window.__lp.sprites.uniforms.uWind.value,
      water: window.__lp.flow.points.visible,
      muted: window.__lp.synth.muted,
    }));
    assert.deepEqual(off, { ink: 0, contour: 0, wind: 0, water: false, muted: true });
    const sun0 = await page.evaluate(() => window.__lp.scene.children.find((c) => c.isDirectionalLight).position.toArray());
    await page.fill('#opt-sun-angle', '120');
    await page.dispatchEvent('#opt-sun-angle', 'change');
    const sun1 = await page.evaluate(() => window.__lp.scene.children.find((c) => c.isDirectionalLight).position.toArray());
    assert.ok(Math.hypot(sun1[0] - sun0[0], sun1[2] - sun0[2]) > 3, 'the sun moved round');
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => window.renderer?.info.render.frame > 1, null, { timeout: 60000 });
    const kept = await page.evaluate(() => ({ ...window.__lp.opts }));
    assert.equal(kept.ink, false);
    assert.equal(kept.sound, false);
    assert.equal(kept.sunAngle, 120);
    assert.equal(await page.isChecked('#options input[data-opt="contours"]'), false);
    await page.click('#options-btn');
    await page.click('#options-reset');
    assert.equal(await page.isChecked('#options input[data-opt="ink"]'), true);
    assert.equal(await page.evaluate(() => window.__lp.opts.sunAngle), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#options'), true);
  });

  test('Photo saves a PNG of the view', async () => {
    const info = await page.evaluate(async () => {
      const b = await window.__lp.takePhoto({ download: false });
      const head = new Uint8Array(await b.slice(0, 4).arrayBuffer());
      return { type: b.type, size: b.size, head: [...head] };
    });
    assert.equal(info.type, 'image/png');
    assert.deepEqual(info.head, [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(info.size > 5000);
    const download = page.waitForEvent('download', { timeout: 30000 });
    await page.click('#photo');
    assert.match((await download).suggestedFilename(), /^living-parchment-.*\.png$/);
  });

  test('no errors', () => {
    assert.deepEqual(errors, []);
  });
});

describe('phone layout', () => {
  test('rails, toolbar and the Options sheet fit a portrait phone without overlapping', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const { page, errors } = await openApp(browser, url, { context });
    const box = (sel) => page.locator(sel).boundingBox();
    const tools = await box('#tools');
    const side = await box('#sidebar');
    const bar = await box('#toolbar');
    const inside = (b) => b.x >= 0 && b.y >= 0 && b.x + b.width <= 390 && b.y + b.height <= 844;
    assert.ok(inside(tools) && inside(side) && inside(bar), JSON.stringify({ tools, side, bar }));
    assert.ok(tools.x + tools.width < side.x, 'left and right rails do not touch');
    assert.ok(tools.y + tools.height < bar.y && side.y + side.height < bar.y, 'rails stay above the toolbar');
    assert.equal(await page.isVisible('#viewpad'), false);
    await page.tap('#options-btn');
    const sheet = await box('#options');
    assert.ok(inside(sheet) && sheet.y + sheet.height <= bar.y, JSON.stringify(sheet));
    await page.screenshot({ path: path.join(SHOTS, 'options-phone.png') });
    await page.tap('#options-close');
    await page.screenshot({ path: path.join(SHOTS, 'options-phone-tools.png') });
    assert.deepEqual(errors, []);
    await context.close();
  });
});
