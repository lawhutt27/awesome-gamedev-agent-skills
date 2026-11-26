# Living Parchment World-Builder

A mobile-first browser toy: draw ink strokes on an illuminated parchment page and they push
up into a 2D-HD paper diorama in real time. Phases 1 and 2 of the design are built here.
Everything is procedural (paper, ink, sprites, sound), so there are no asset files to load.

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN, for testing on a phone)
npm run build      # static site in dist/
```

## How to play

| Gesture | What it makes |
| --- | --- |
| Closed loop | A terraced hill. Loops drawn inside a hill stack a higher terrace. |
| Closed loop with 3 or more sharp corners | A stone ruin: inked foundation walls on a flat plateau. |
| Open stroke | A river carved below the water table. The water flows the way you drew it. |
| Tap (or a short flick) | A cluster (or a row) of paper-cutout trees, reeds, standing stones or lanterns, chosen by biome and terrain. |
| Two fingers | Pinch to zoom, twist to orbit, drag up or down to tilt. A second finger cancels the stroke in progress. |
| Desktop | Right-drag or shift-drag to orbit, wheel to zoom, `Ctrl/Cmd+Z` to undo, `1` `2` `3` for biomes. |

The stamp buttons switch between **Mossy Ruin**, **Autumn Ridge** and **Moonlit Tide**
(light, water ink, contour ink and sprite art all change), **Undo** steps back up to 10 strokes,
and **Clear** wipes the page (also undoable).

## How it works

```text
src/
├── main.js                  # Scene, renderer, lighting, diorama rim, picking, main loop
├── terrain/
│   ├── ParchmentCanvas.js   # Dual offscreen 2D canvases, undo stack, stamp brushes
│   └── TerrainShader.js     # Vertex height displacement, contour lines, ink water, rim
├── input/
│   └── GestureClassifier.js # Loop vs. ruin vs. river vs. tap ($1 + corner analysis), orbit rig
├── world/
│   ├── BiomeConfig.js       # Mossy Ruin, Autumn Ridge, Moonlit Tide palettes
│   └── SpriteInstancer.js   # Procedural cutout atlases, instanced billboards, flow particles
└── audio/
    └── PaperSynth.js        # Web Audio pen-scratch foley and terrace thuds
```

- **Two canvases, one page.** The 1024² albedo canvas holds the parchment, watercolor washes and
  Sumi ink and is uploaded as a `CanvasTexture` only while ink is moving. The 512² height/mask
  pair is composed into one RGBA `DataTexture` (R grass, G stone, B water, A height with 0.5 as
  paper level) when a stroke commits. A small flow canvas stores river direction.
- **Spring settle without re-uploads.** The terrain reads a "from" and a "to" height texture and
  blends them with `uMix`. A spring drives `uMix` past 1 and back, so a terrace pops up with
  overshoot while the GPU only sees a uniform change.
- **One displacement everywhere.** Terrain, its shadow-depth material, the cardboard rim and
  every sprite card call the same GLSL height function, so sprites stay glued to rising hills and
  hills cast correct shadows.
- **Terrain shader.** `MeshStandardMaterial` patched with `onBeforeCompile`: vertex displacement
  plus simplex micro-relief, normals from neighbour taps, hand-inked contour lines from
  `fwidth`, paper-fibre normal perturbation, and flow-mapped ink-wash water below `h < 0.42`.
- **Sprites.** One `InstancedMesh` of Y-axis billboarded cards with `alphaTest: 0.5`, wind sway,
  a spring pop-in and a card flip when the biome changes. A `customDepthMaterial` runs the same
  vertex code so each cutout casts a crisp shadow. Lantern windows glow through an emissive atlas.
- **Classifier.** Strokes are measured in page UV. A loop must close (overshoot is trimmed) and
  enclose area; sharp turns are counted on a resampled ring, and a $1 unistroke recognizer
  (start-point and direction invariant) settles borderline shapes. Everything else long enough
  is a river; short moves plant.
- **Performance.** Pixel ratio capped at 2, one shadow-casting light, about 10 draw calls,
  no allocations in the frame loop, and texture uploads only on change.
  Add `?quality=low` to the URL for pixel ratio 1, no MSAA and a smaller shadow map.

## Tests

```bash
npm test           # unit tests: stroke geometry, $1 recognizer, classifier, rig, biomes, audio maths
npm run test:e2e   # builds, serves dist/ and drives the app in headless Chromium
```

The browser suite draws real loops, ruins, rivers, taps and flicks through pointer events, then
checks the composed height and mask data, sprite and particle counts, undo (including the 10-step
limit and undoing Clear), biome switching, orbit and wheel zoom, touch pinch cancelling a stroke,
the portrait phone layout, audio unlock, WebGL context loss and steady-state memory. Screenshots
go to `test-results/`. It uses the `playwright` package and needs a Chromium it can launch.

## Not in this phase

Phase 3 adds the pinch-to-ground-level camera with thumbstick walking, the screen-space Sobel
ink-edge pass for first-person views, projected ink on cliffs, and `.glb` / URL-seed export.
