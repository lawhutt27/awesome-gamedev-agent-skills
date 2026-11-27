// Lake, Road and Sculpt brushes, and the Export for games panel.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, launch, openApp, drawUv, circleUv, riverUv, settle, sample, SHOTS } from './helpers.js';

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
const WATER_H = 0.42;

/** Parse a .glb in the page and return node names, plus the Terrain's position bounds. */
async function readGlb(page, opts) {
  return page.evaluate(async (opts) => {
    const buf = await window.__lp.exportWorld({ download: false, ...opts });
    const v = new DataView(buf);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, v.getUint32(12, true))));
    const node = (name) => json.nodes.find((n) => n.name === name);
    const bounds = (name) => {
      const n = node(name);
      if (!n || n.mesh === undefined) return null;
      const acc = json.accessors[json.meshes[n.mesh].primitives[0].attributes.POSITION];
      return { min: acc.min, max: acc.max, count: acc.count };
    };
    return { names: json.nodes.map((n) => n.name), terrain: bounds('Terrain'), water: bounds('Water'), trees: bounds('trees'), markers: node('Markers')?.children?.length ?? 0 };
  }, opts);
}

describe('new brushes', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url));
  });
  after(async () => context?.close());

  test('Lake fills any loop with still water, deeper in the middle', async () => {
    await tool(page, 'lake');
    await drawUv(page, circleUv(0.3, 0.3, 0.1));
    await settle(page);
    assert.equal(await lastKind(page), 'lake');
    const mid = await sample(page, 0.3, 0.3);
    const shore = await sample(page, 0.3 + 0.09, 0.3);
    const land = await sample(page, 0.3 + 0.13, 0.3);
    assert.ok(mid < WATER_H && mid < shore - 0.02 && land > WATER_H, `lake floor ${mid}, shore ${shore}, land ${land}`);
    assert.ok((await sample(page, 0.3, 0.3, 2)) > 0.5, 'water mask');
  });

  test('Road crosses a river on a causeway and clears its water', async () => {
    await tool(page, 'river');
    await drawUv(page, riverUv(0.7, 0.1, 0.7, 0.6, 24, 0));
    await settle(page);
    assert.ok((await sample(page, 0.7, 0.35)) < WATER_H, 'river carved');
    await tool(page, 'road');
    await drawUv(page, riverUv(0.5, 0.35, 0.9, 0.35, 24, 0));
    await settle(page);
    assert.equal(await lastKind(page), 'road');
    assert.ok((await sample(page, 0.7, 0.35)) > WATER_H, 'causeway above the water');
    assert.ok((await sample(page, 0.7, 0.35, 2)) < 0.2, 'no water on the road');
    assert.ok((await sample(page, 0.7, 0.45)) < WATER_H, 'river still there off the road');
  });

  test('Sculpt raises, lowers and flattens, picked from its mode chips', async () => {
    assert.equal(await page.isVisible('#sculpt-modes'), false);
    await tool(page, 'sculpt');
    assert.equal(await page.isVisible('#sculpt-modes'), true);
    const at = (u, v) => sample(page, u, v);
    const line = (v) => riverUv(0.15, v, 0.45, v, 16, 0);

    const h0 = await at(0.3, 0.6);
    await page.click('#sculpt-modes [data-sculpt="raise"]');
    await drawUv(page, line(0.6));
    await drawUv(page, line(0.6));
    await settle(page);
    assert.equal(await lastKind(page), 'raise');
    const raised = await at(0.3, 0.6);
    assert.ok(raised > h0 + 0.04, `raised ${h0} -> ${raised}`);

    await page.click('#sculpt-modes [data-sculpt="lower"]');
    assert.equal(await page.evaluate(() => window.__lp.opts.sculpt), 'lower');
    await drawUv(page, line(0.8));
    await settle(page);
    assert.equal(await lastKind(page), 'lower');
    assert.ok((await at(0.3, 0.8)) < h0 - 0.02, 'lowered');

    // Flatten from bare paper across the raised strip levels it back to paper height.
    await page.click('#sculpt-modes [data-sculpt="flatten"]');
    await drawUv(page, riverUv(0.3, 0.5, 0.3, 0.7, 16, 0));
    await settle(page);
    assert.equal(await lastKind(page), 'flatten');
    assert.ok(Math.abs((await at(0.3, 0.6)) - h0) < 0.02, 'flattened');
    await page.screenshot({ path: path.join(SHOTS, 'brushes.png') });

    await tool(page, 'auto');
    assert.equal(await page.isVisible('#sculpt-modes'), false);
  });

  test('River and Road show width chips that set the brush size', async () => {
    assert.equal(await page.isVisible('#width-modes'), false);
    await tool(page, 'river');
    assert.equal(await page.isVisible('#width-modes'), true);
    await page.click('#width-modes [data-size="3"]');
    assert.equal(await page.evaluate(() => window.__lp.opts.size), 3);
    await drawUv(page, riverUv(0.1, 0.92, 0.9, 0.92, 30, 0));
    await settle(page);
    assert.equal(await page.evaluate(() => window.__lp.worldLog.at(-1).size), 3);
    assert.ok((await sample(page, 0.5, 0.92 + 0.03, 2)) > 0.5, 'very wide river reaches 0.03 from its centreline');
    await page.click('#width-modes [data-size="0"]');
    await tool(page, 'road');
    assert.equal(await page.isVisible('#width-modes'), true);
    assert.equal(await page.getAttribute('#width-modes [data-size="0"]', 'aria-checked'), 'true');
    await tool(page, 'auto');
    assert.equal(await page.isVisible('#width-modes'), false);
    await page.click('#undo');
    await settle(page);
  });

  test('the new strokes undo, and replay the same from a share link', async () => {
    const before = await sample(page, 0.3, 0.6);
    await page.click('#undo');
    await settle(page);
    assert.ok(Math.abs((await sample(page, 0.3, 0.6)) - before) > 0.02, 'undo flatten');
    await page.click('#redo');
    await settle(page);
    const code = await page.evaluate(() => window.__lp.encodeWorld());
    const pick = (p) =>
      p.evaluate(() => ({
        kinds: window.__lp.worldLog.map((e) => e.kind),
        h: [[0.3, 0.6], [0.3, 0.8], [0.3, 0.3], [0.7, 0.35]].map(([u, v]) => window.__lp.parchment.sample(u, v)),
      }));
    const original = await pick(page);
    const other = await openApp(browser, url, { hash: `#${code}` });
    await settle(other.page);
    const copy = await pick(other.page);
    assert.deepEqual(copy.kinds, original.kinds);
    assert.ok(copy.h.every((h, i) => Math.abs(h - original.h[i]) < 0.01), JSON.stringify({ copy: copy.h, original: original.h }));
    assert.deepEqual(other.errors, []);
    await other.context.close();
  });

  test('no errors', () => {
    assert.deepEqual(errors, []);
  });
});

describe('export for games', () => {
  let page;
  let errors;
  let context;
  before(async () => {
    ({ page, errors, context } = await openApp(browser, url));
    await page.evaluate(() => window.__lp.randomWorld());
    await settle(page);
    await tool(page, 'lake');
    await drawUv(page, circleUv(0.5, 0.5, 0.08));
    await settle(page);
  });
  after(async () => context?.close());

  test('the .glb button opens the panel; Escape closes it', async () => {
    await page.click('#export');
    assert.equal(await page.isVisible('#export-panel'), true);
    assert.equal(await page.getAttribute('#export', 'aria-expanded'), 'true');
    assert.match(await page.textContent('#export-summary'), /100 × 100 m.*205k triangles.*one \.glb/);
    await page.screenshot({ path: path.join(SHOTS, 'export-panel.png') });
    await page.click('.seg[data-exp="detail"] button[data-value="3"]');
    assert.match(await page.textContent('#export-summary'), /461k triangles/);
    await page.click('.seg[data-exp="detail"] button[data-value="2"]');
    // Opening Options closes Export, and the other way round.
    await page.click('#options-btn');
    assert.equal(await page.isVisible('#export-panel'), false);
    await page.click('#export');
    assert.equal(await page.isVisible('#options'), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#export-panel'), false);
  });

  test('map size scales the model in metres; height exaggerates only Y', async () => {
    const small = await readGlb(page, { size: 10 });
    const big = await readGlb(page, { size: 250, height: 2 });
    assert.ok(Math.abs(small.terrain.max[0] - 5) < 1e-3 && Math.abs(big.terrain.max[0] - 125) < 1e-2, JSON.stringify([small.terrain, big.terrain]));
    const ratio = big.terrain.max[1] / small.terrain.max[1];
    assert.ok(Math.abs(ratio - 50) < 0.5, `Y ratio ${ratio}`);
  });

  test('detail sets the grid; water adds a surface mesh; rim is optional', async () => {
    const low = await readGlb(page, { detail: 1, water: false, rim: true });
    const med = await readGlb(page, { detail: 2, water: true, rim: false });
    assert.equal(low.terrain.count, 161 * 161);
    assert.equal(med.terrain.count, 321 * 321);
    assert.ok(low.names.includes('Rim') && !low.names.includes('Water'));
    assert.ok(!med.names.includes('Rim') && med.names.includes('Water'), med.names.join());
    assert.ok(med.water.count > 0 && Math.abs(med.water.max[1] - med.water.min[1]) < 1e-4, 'flat water surface');
    // with a water surface the lake bed keeps its depth below it
    assert.ok(med.terrain.min[1] < med.water.min[1] - 0.05);
  });

  test('trees stay a real size on a big map instead of growing with it', async () => {
    // Marker nodes carry each plant's height in metres as their scale.
    const treeHeights = (opts) =>
      page.evaluate(async (opts) => {
        const buf = await window.__lp.exportWorld({ download: false, sprites: 'markers', ...opts });
        const v = new DataView(buf);
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, v.getUint32(12, true))));
        const t = json.nodes.find((n) => n.name === 'Terrain');
        const ground = json.accessors[json.meshes[t.mesh].primitives[0].attributes.POSITION].max[1];
        return { trees: json.nodes.filter((n) => /^tree_/.test(n.name)).map((n) => n.matrix?.[5] ?? n.scale?.[1] ?? 1), ground };
      }, opts);
    const real = await treeHeights({ size: 250, trees: 'real', height: 2 });
    const diorama = await treeHeights({ size: 250, trees: 'page', height: 2 });
    assert.ok(real.trees.length > 0);
    const tallest = Math.max(...real.trees);
    assert.ok(tallest > 6 && tallest < 15, `real tree ${tallest} m`);
    assert.ok(Math.max(...diorama.trees) > 3 * tallest, `diorama tree ${Math.max(...diorama.trees)} m`);
    assert.ok(real.ground > 3 * tallest, `ground ${real.ground} m vs tree ${tallest} m`);
    await page.click('#export');
    assert.match(await page.textContent('#export-summary'), /trees about 9\.0 m/);
    await page.click('#export-close');
  });

  test('markers replace the cards with named empty nodes', async () => {
    const g = await readGlb(page, { sprites: 'markers' });
    assert.ok(g.markers > 5, `markers ${g.markers}`);
    assert.ok(g.names.some((n) => /^(tree|reed|stone|lantern)_\d{3}$/.test(n)), g.names.slice(0, 20).join());
    assert.ok(!g.names.some((n) => /^(tree|reed|stone|lantern)s$/.test(n)));
    const none = await readGlb(page, { sprites: 'none' });
    assert.ok(!none.names.some((n) => /^(tree|reed|stone|lantern)/.test(n)) && !none.names.includes('Markers'));
  });

  test('Download saves map.glb, or a zip with heightmaps and masks', async () => {
    await page.click('#export');
    let download = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#export-go');
    assert.equal((await download).suggestedFilename(), 'living-parchment-map.glb');

    await page.check('#exp-maps');
    assert.match(await page.textContent('#export-summary'), /zip/);
    download = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#export-go');
    const d = await download;
    assert.equal(d.suggestedFilename(), 'living-parchment-map.zip');
    const files = await page.evaluate(async () => {
      const list = await window.__lp.exportWorld({ download: false, maps: true, size: 100 });
      return list.map((f) => [f.name, f.data.length]);
    });
    assert.deepEqual(
      files.map((f) => f[0]),
      ['map.glb', 'heightmap.png', 'heightmap-513x513.r16', 'splatmap.png', 'colormap.png', 'README.txt'],
    );
    assert.equal(files[2][1], 513 * 513 * 2);
    // panel choices are remembered
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('living-parchment-export')).maps), true);
    await page.uncheck('#exp-maps');
    await page.click('#export-close');
  });

  test('no errors', () => {
    assert.deepEqual(errors, []);
  });
});

describe('export panel on a phone', () => {
  test('fits above the toolbar', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const { page, errors } = await openApp(browser, url, { context });
    await page.tap('#export');
    const sheet = await page.locator('#export-panel').boundingBox();
    const bar = await page.locator('#toolbar').boundingBox();
    assert.ok(sheet.x >= 0 && sheet.y >= 0 && sheet.x + sheet.width <= 390 && sheet.y + sheet.height <= bar.y + 1, JSON.stringify({ sheet, bar }));
    assert.ok(await page.isVisible('#export-go'));
    await page.screenshot({ path: path.join(SHOTS, 'export-phone.png') });
    assert.deepEqual(errors, []);
    await context.close();
  });
});
