# Living Parchment World-Builder

A mobile-first browser toy: draw ink strokes on an illuminated parchment page and they push
up into a 2D-HD paper diorama in real time, then fold the map down and walk around in it.
All three phases of the design are built here.
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
| Two fingers | Twist to orbit, drag up or down to tilt. **Pinch is the Dimensional Fold:** pinch in for a flat 15° top-down map, pinch out to sink to ground level at 65°. A second finger cancels the stroke in progress. |
| Walking | At ground level the thumbstick (or `W` `A` `S` `D`) walks, a one-finger drag looks around, and a tap still plants. **Walk** / **Map** jumps between the two. |
| Desktop | Right-drag or shift-drag to orbit, wheel to fold, `Ctrl/Cmd+Z` undo, `1` `2` `3` biomes, `V` walk, `H` help. |

The bottom bar switches between the **Moss**, **Autumn** and **Moon** biomes (Mossy Ruin,
Autumn Ridge, Moonlit Tide: light, water ink, contour ink and sprite art all change), **Undo**
steps back up to 10 strokes and **Clear** wipes the page (also undoable). On the right, **Help**
opens the how-to-play panel (also shown on the first visit), **Share** saves the whole world into
the page link, and **.glb** downloads the diorama as a 3D model. The world also autosaves in the
browser.

## How it works

```text
src/
├── main.js                  # Scene, renderer, lighting, diorama rim, picking, main loop
├── terrain/
│   ├── ParchmentCanvas.js   # Dual offscreen 2D canvases, undo stack, stamp brushes
│   └── TerrainShader.js     # Vertex height displacement, contour lines, ink water, rim
├── render/
│   └── InkEdgePass.js       # Screen-space Sobel + depth-Laplacian ink edges, tone mapping
├── input/
│   ├── GestureClassifier.js # Loop vs. ruin vs. river vs. tap ($1 + corner analysis), gestures
│   ├── CameraRig.js         # Dimensional Fold: 15° map -> 65° first person, walking
│   └── Thumbstick.js        # Virtual stick + WASD
├── world/
│   ├── BiomeConfig.js       # Mossy Ruin, Autumn Ridge, Moonlit Tide palettes
│   ├── SpriteInstancer.js   # Procedural cutout atlases, instanced billboards, flow particles
│   ├── WorldSeed.js         # Replayable stroke log <-> compact link code
│   └── Exporter.js          # Bake to plain meshes and export .glb
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
- **Dimensional Fold.** One `fold` value runs the camera from a 15° near-orthographic map to a
  65° first-person view. The field of view widens with it while, over the last part of the range,
  the rig lowers onto a walker standing at the near edge of the page. Fog and the background haze
  follow the camera so the horizon reads as a tabletop in a room.
- **Ink edges.** The scene renders into a multisampled half-float target with a depth texture. A
  full-screen pass inks silhouettes (Sobel on linear depth) and creases (depth Laplacian, which
  ignores flat ground at grazing angles), heavier at ground level than from above.
- **Projected cliff ink.** The page texture is painted from above, so steep terrace and ruin walls
  get a side-projected (triplanar on X/Z) strata-and-hatching texture instead of a smear. This
  covers what `three-projected-material` was suggested for without adding the dependency.
- **World links.** Every committed stroke is logged with its points (simplified and quantized
  before it is applied) and its own random seed, so replaying the log rebuilds the same world.
  The log is packed to bytes, deflated and base32-encoded into `#w1…`, which is a plain hash and
  works inside the claude.ai artifact viewer too.
- **.glb export.** GPU-only effects are baked on the CPU: displaced terrain with water painted
  into its texture, the rim, and crossed alpha-masked cards for every sprite. Where the host only
  allows common file types (the claude.ai viewer) the file is wrapped in a zip.
- **Performance.** Pixel ratio capped at 2, one shadow-casting light, about 10 draw calls,
  no allocations in the frame loop, and texture uploads only on change.
  Add `?quality=low` to the URL for pixel ratio 1, no MSAA and a smaller shadow map.

## Tests

```bash
npm test           # unit tests: stroke geometry, $1 recognizer, classifier, camera rig, thumbstick,
                   # world codec, zip writer, biomes, audio maths
npm run test:e2e   # builds, serves dist/ and drives the app in headless Chromium
```

The browser suite draws real loops, ruins, rivers, taps and flicks through pointer events, then
checks the composed height and mask data, sprite and particle counts, undo (including the 10-step
limit and undoing Clear), biome switching, orbit and wheel zoom, touch pinch cancelling a stroke,
the portrait phone layout, audio unlock, WebGL context loss and steady-state memory, plus the
English labels and help panel, folding to ground level, walking, looking and planting there,
.glb export (parsed back), share links that rebuild an identical world, and autosave. Screenshots
go to `test-results/`. It uses the `playwright` package and needs a Chromium it can launch.

## Notes

- Walking has no collision with sprites; you pass through paper cutouts.
- World links store strokes, not pixels, so a link made by a future version with a different
  brush may replay slightly differently. The format is versioned (`w1`).
