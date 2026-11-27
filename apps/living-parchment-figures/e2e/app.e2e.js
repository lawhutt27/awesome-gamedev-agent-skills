// End-to-end: start screen, sketching, parts, shape, colours, motion, pose, world and every export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, launch, openApp, draw, loop, downloadFrom, SHOTS } from './helpers.js';

let server;
let url;
let browser;
before(async () => {
  ({ server, url } = await startServer());
  browser = await launch();
});
after(async () => {
  await browser?.close();
  server?.httpServer.close();
});

/** Parse a .glb's JSON chunk. */
function glbJson(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.toString('utf8', 0, 4), 'glTF');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.toString('utf8', 20, 20 + len));
}

test('start screen offers sketch or swap parts', async () => {
  const { page, errors, context } = await openApp(browser, url);
  assert.equal(await page.isVisible('#start'), true);
  assert.equal(await page.isVisible('#start-sketch'), true);
  assert.equal(await page.isVisible('#start-swap'), true);
  await page.screenshot({ path: path.join(SHOTS, 'start.png') });
  assert.deepEqual(errors, []);
  await context.close();
});

test('sketch: loops, limbs, dots and spikes become a rigged figure', async () => {
  const { page, errors, context } = await openApp(browser, url);
  await page.click('#start-sketch');
  assert.equal(await page.isVisible('#sketch-rail'), true);
  await draw(page, loop(0, 1.2, 0.17, 0.28));
  await draw(page, loop(0, 1.62, 0.13, 0.14));
  await draw(page, [[0.17, 1.4], [0.3, 1.42], [0.45, 1.4], [0.6, 1.38], [0.7, 1.4]]);
  await draw(page, [[0.09, 0.95], [0.1, 0.7], [0.1, 0.45], [0.1, 0.15], [0.11, 0.05]]);
  await page.click('[data-tool="dot"]');
  await draw(page, [[0.045, 1.65]]);
  await page.click('[data-tool="tube"]');
  await draw(page, [[-0.05, 1.56], [0, 1.545], [0.05, 1.56]]);
  await page.click('[data-tool="spikes"]');
  await draw(page, [[-0.12, 1.72], [-0.09, 1.82], [-0.06, 1.73], [-0.03, 1.84], [0, 1.74], [0.03, 1.84], [0.06, 1.73], [0.09, 1.82], [0.12, 1.72]]);
  const kinds = await page.evaluate(() => window.__figures.state.strokes.map((s) => `${s.k}:${s.z}`));
  assert.deepEqual(kinds, ['blob:mid', 'blob:mid', 'tube:mid', 'tube:mid', 'dot:surf', 'tube:surf', 'spikes:mid']);
  // Mirror doubles the off-centre strokes: 2 blobs + 2 arms + 2 legs + 2 eyes + mouth + spikes.
  const meshes = await page.evaluate(() => window.__figures.figure.meshes.length);
  assert.ok(meshes >= 10, `meshes ${meshes}`);
  await page.screenshot({ path: path.join(SHOTS, 'sketch.png') });
  // Sculpt and paint a drawn part, then erase one.
  await page.click('[data-tool="sculpt"]');
  await draw(page, [[0, 1.2]]);
  assert.equal(await page.evaluate(() => window.__figures.state.strokes[0].s), 1.15);
  await page.click('[data-tool="paint"]');
  await page.click('.swatch[title="#3b8fa8"]');
  await draw(page, [[0, 1.2]]);
  assert.equal(await page.evaluate(() => window.__figures.state.strokes[0].c), '#3b8fa8');
  await page.click('[data-tool="erase"]');
  await draw(page, [[0, 1.2]]);
  assert.equal(await page.evaluate(() => window.__figures.state.strokes.length), 6);
  await page.click('#undo');
  assert.equal(await page.evaluate(() => window.__figures.state.strokes.length), 7);
  // Kitbash: save the drawing, start over, add it back.
  await page.fill('#kit-name', 'Red imp');
  await page.click('#kit-save');
  assert.match(await page.textContent('#kit-list'), /Red imp/);
  await page.evaluate(() => window.__figures.commit((s) => (s.strokes = [])));
  await page.click('#kit-list button:has-text("Red imp")');
  assert.equal(await page.evaluate(() => window.__figures.state.strokes.length), 7);
  assert.deepEqual(errors, []);
  await context.close();
});

test('parts, shape, colours, motion and card panels', async () => {
  const { page, errors, context } = await openApp(browser, url);
  await page.click('#start-swap');
  for (const [cat, opt] of [
    ['head', 'cat'],
    ['hair', 'spiky'],
    ['hat', 'crown'],
    ['torso', 'hero'],
    ['legs', 'robe'],
    ['extra', 'tail'],
  ]) {
    await page.click(`#part-cats button[data-cat="${cat}"]`);
    await page.click(`#part-options button[data-option="${opt}"]`);
    assert.equal(await page.evaluate((c) => window.__figures.state.parts[c], cat), opt);
  }
  await page.click('[data-tab="shape"]');
  await page.locator('#shape-sliders input[data-k="legs"]').fill('0.6');
  assert.equal(await page.evaluate(() => window.__figures.state.shape.legs), 0.6);
  await page.click('[data-tab="colors"]');
  await page.click('#styles button:has-text("Cut paper")');
  assert.equal(await page.evaluate(() => window.__figures.state.style), 'paper');
  const before = await page.evaluate(() => window.__figures.state.colors.top);
  await page.click('#variants .variant >> nth=0');
  assert.notEqual(await page.evaluate(() => window.__figures.state.colors.top), before);
  await page.click('[data-tab="motion"]');
  for (const clip of ['Walk', 'Run', 'Jump', 'Wave', 'Sit']) {
    await page.click(`#clips button:has-text("${clip}")`);
    assert.equal(await page.evaluate(() => window.__figures.figure.clipName), clip);
  }
  await page.click('#faces button:has-text("Happy")');
  assert.equal(await page.evaluate(() => window.__figures.figure.expression), 'happy');
  await page.click('#clips button:has-text("Walk")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'parts-walk.png') });
  await page.click('[data-tab="card"]');
  await page.fill('#card-name', 'Mossback');
  await page.fill('#card-role', 'Ranger');
  assert.equal(await page.evaluate(() => window.__figures.state.card.name), 'Mossback');
  assert.deepEqual(errors, []);
  await context.close();
});

test('pose by hand and walk around a world', async () => {
  const { page, errors, context } = await openApp(browser, url);
  await page.click('#start-swap');
  await page.click('[data-tab="motion"]');
  await page.click('#pose-btn');
  assert.equal(await page.isVisible('#pose-bar'), true);
  // Drag the left hand up over the head.
  await page.evaluate(() => {
    const { figure, THREE } = window.__figures;
    const h = figure.handles();
    figure.reach('LeftHand', h.Head.clone().add(new THREE.Vector3(0.3, 0.1, 0.1)));
  });
  await page.click('#pose-done');
  const pose = await page.evaluate(() => window.__figures.state.pose);
  assert.ok(pose && pose.LeftArm, 'pose saved');
  assert.equal(await page.evaluate(() => window.__figures.figure.clipName), 'Pose');
  await page.click('#world-btn');
  assert.equal(await page.isVisible('#world-bar'), true);
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);
  await page.keyboard.up('w');
  const moved = await page.evaluate(() => window.__figures.figure.group.position.length());
  assert.ok(moved > 0.2, `walked ${moved} m`);
  await page.screenshot({ path: path.join(SHOTS, 'world.png') });
  const scene = await downloadFrom(page, '#world-save');
  const json = glbJson(scene.bytes);
  assert.ok(json.skins?.length === 1 && json.nodes.some((n) => n.name === 'PaperStage'));
  await page.click('#world-exit');
  assert.equal(await page.evaluate(() => window.__figures.figure.group.position.length()), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('every export downloads a valid file', async () => {
  const { page, errors, context } = await openApp(browser, url);
  await page.click('#start-swap');
  await page.click('#export-btn');
  const glb = await downloadFrom(page, '#ex-glb');
  writeFileSync(path.join(SHOTS, 'figure.glb'), glb.bytes);
  const json = glbJson(glb.bytes);
  assert.equal(json.skins.length, 1);
  assert.ok(json.skins[0].joints.length >= 30);
  assert.deepEqual(json.animations.map((a) => a.name).sort(), ['Idle', 'Jump', 'Run', 'Sit', 'Walk', 'Wave']);
  assert.ok(json.nodes.some((n) => n.name === 'Hips') && json.nodes.some((n) => n.name === 'LeftForeArm'));
  assert.deepEqual(json.meshes[0].extras.targetNames, ['Blink', 'Smile', 'Frown', 'MouthOpen']);
  const vrm = await downloadFrom(page, '#ex-vrm');
  writeFileSync(path.join(SHOTS, 'figure.vrm'), vrm.bytes);
  const vj = glbJson(vrm.bytes);
  assert.ok(vj.extensionsUsed.includes('VRMC_vrm'));
  assert.ok(Number.isInteger(vj.extensions.VRMC_vrm.humanoid.humanBones.hips.node));
  for (const [sel, name] of [
    ['#ex-lods', /_LODs\.zip$/],
    ['#ex-crowd', /_crowd_10\.zip$/],
    ['#ex-sprites', /_sprites\.zip$/],
    ['#ex-photo', /\.png$/],
    ['#ex-gif', /_turntable\.gif$/],
    ['#ex-card', /_card\.png$/],
  ]) {
    const f = await downloadFrom(page, sel);
    assert.match(f.name, name);
    assert.ok(f.bytes.length > 1000, `${f.name} has ${f.bytes.length} bytes`);
    if (f.name.endsWith('.zip')) assert.equal(f.bytes.readUInt32LE(0), 0x04034b50);
    writeFileSync(path.join(SHOTS, f.name), f.bytes);
  }
  await page.click('#ex-link');
  await page.waitForFunction(() => location.hash.startsWith('#c='));
  const hash = await page.evaluate(() => location.hash);
  assert.match(hash, /^#c=/);
  // The link rebuilds the same figure.
  const parts = await page.evaluate(() => JSON.stringify(window.__figures.state.parts));
  const again = await openApp(browser, url, { hash });
  assert.equal(await again.page.evaluate(() => JSON.stringify(window.__figures.state.parts)), parts);
  assert.equal(await again.page.isVisible('#start'), false);
  await again.context.close();
  assert.deepEqual(errors, []);
  await context.close();
});

test('phone layout keeps the figure, panel and dock on screen', async () => {
  const { page, errors, context } = await openApp(browser, url, { viewport: { width: 390, height: 844 } });
  await page.click('#start-swap');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'phone-parts.png') });
  await page.click('[data-tab="sketch"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'phone-sketch.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  assert.deepEqual(errors, []);
  await context.close();
});
