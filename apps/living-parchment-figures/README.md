# Living Parchment: Figures

A browser character builder, the sister app to the Living Parchment world-builder. Pick
**Sketch** to draw over a mannequin and watch your lines puff up into a body, or **Swap parts**
to pick heads, bodies, hair and outfits. Both mix freely on the same figure. Every figure is
rigged and animated the moment it exists, and exports as a `.glb` that opens in Blender with
its armature, actions and shape keys.

Everything is procedural (bodies, clothes, motion), so there are no asset files to load.

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN, for testing on a phone)
npm run build      # static site in dist/ (works from any folder, so it can go straight to itch.io)
npm test           # unit tests (node --test)
npm run test:e2e   # builds, then drives the app in Chromium and checks every export
npm run build:single  # one self-contained .html in dist-single/ that runs offline
```

### One file, offline

`npm run build:single` inlines the whole app (scripts, styles, no network calls) into
`dist-single/figures.html`. Double-click it and it runs from disk in any modern browser.
It also writes `dist-single/figures-artifact.html`, the same app as a page body for publishing
as a claude.ai Artifact. Inside an Artifact, files are saved through the viewer's downloads
prompt, which takes zips, so a single `.glb`, `.vrm`, `.png` or `.gif` arrives zipped
(`Wanderer-glb.zip` holds `Wanderer.glb`). The Artifact's address cannot be shared, so
**Copy link** copies a figure code instead; paste it into **Figure code** in the Export dialog,
here or in the offline file, to open that exact figure.

## The screen

The bottom dock has one tab per step, in the order you usually build a character. The top bar
holds what applies everywhere: **Undo**, **Redo**, **Random** (a new figure that keeps your
drawing), **Help** and **Export**.

| Tab | What is in it |
| --- | --- |
| **Sketch** | The left rail picks a tool. Ink colours, brush size, **Mirror** (draw one side, get both), **Mannequin** guide, and **My parts**. |
| **Parts** | Head, Eyes, Mouth, Hair, Hat, Body, Arms, Hands, Legs, Feet and Extra. The chip shows what each category is set to. |
| **Shape** | Height, head size, build, arm length, leg length and belly. Drawn parts follow the sliders too. |
| **Colors** | Style (Ink & wash, Cut paper, Woodblock, Chalk), four one-tap palette variants, and exact colours per slot (skin, top, bottom, hair, accent, shoes, eyes, whites). |
| **Motion** | T-pose, Idle, Walk, Run, Jump, Wave, Sit and your own pose; face expressions; springy hair, capes and tails; **Pose by hand**; **Walk around**. |
| **Card** | Name, role, a short story and four stats, saved into the export and printable as a card. |

### Sketch tools

| Tool | What it does |
| --- | --- |
| **Draw** | The shape decides: a closed loop puffs into a rounded part, an open line becomes a limb, a tap makes a dot, a zigzag makes spikes. |
| **Blob**, **Limb**, **Dot**, **Spikes** | Force one kind of shape. |
| **Sculpt** | Tap any part (drawn or swapped) to **Grow**, **Shrink**, **Puff** or **Flatten** it. |
| **Paint** | Tap any part to colour it with the current ink. |
| **Erase** | Tap a part to remove it. |
| **Look** | One-finger drag turns the view. Right-drag or two fingers turn it with any tool. |

Drawing on top of an existing part lays the new shape on its surface: a loop on a belly bulges
out of it, a line across the face becomes a mouth or a stripe, dots on the head become eyes.
Dots and lines on the face also get the face shape keys, so they blink and smile.

**My parts** saves the current drawing under a name in the browser, then adds it to any other
figure with one tap (kitbashing).

### Pose by hand and walk around

**Pose by hand** shows red handles on the hands, feet and head. Drag them and the arms and legs
bend to follow (two-bone IK, knees only bend backwards). **Save pose** keeps it as a **My pose**
animation that also exports.

**Walk around** drops the figure on a paper stage with a third-person camera: thumbstick or
`W` `A` `S` `D` to walk, `Shift` to run. **Load world .glb** walks it through any glTF world,
including a map exported from the Living Parchment world-builder (both apps use 1 unit = 1 m,
so the figure stands at the right size). **Save scene .glb** writes the world and the rigged
figure into one file.

## Export

| Button | What you get |
| --- | --- |
| **Download .glb** | One `Body` mesh with a material per colour (named Skin, Top, Hair…), bound to a Mixamo-named armature, all six animations as actions, and the shape keys Blink, Smile, Frown and MouthOpen. Detail High, Medium or Low; animations optional. |
| **VRM avatar** | The same model as VRM 1.0 (`VRMC_vrm`): humanoid bone map, and the shape keys mapped to the happy, sad, surprised, aa, blink and relaxed expressions. |
| **LOD set** | A zip of the figure at three levels of detail (about 19k, 8k and 4k triangles for a default figure) on the same armature, plus a README with the counts. |
| **Download crowd** | 5 to 100 seeded look-alikes (colours, proportions, hair, hats and faces vary, the body plan stays), each a rigged `.glb`. |
| **Sprite sheets** | One transparent PNG per animation, a row per direction (4 or 8; `S` faces the camera, `E` faces right) and 8 frames per row, plus `atlas.json`. |
| **Copy link** | The whole figure, drawing included, in the page link. **Figure code** opens one that was pasted. |
| **Photo**, **Turntable GIF**, **Character card** | A PNG of the view, a spinning 320 px GIF, and the parchment card with portrait, name, role, stats and story. |

### Into Blender

1. **File › Import › glTF 2.0 (.glb/.gltf)** and pick the file. Defaults are fine.
2. The armature comes in with 36 bones (`Hips` at the root), the `Body` mesh parented to it with
   an Armature modifier and one vertex group per bone.
3. Each animation is an Action: pick one in the **Action Editor** (Dope Sheet) on the armature.
4. Shape keys are under **Object Data Properties › Shape Keys**.

The model is 1 unit = 1 metre, built Y-up facing +Z, which Blender's importer turns into its own
Z-up, facing −Y. Bone names match Mixamo without the `mixamorig:` prefix, so retargeting
presets built for Mixamo rigs can map them, and Unity's Humanoid avatar setup can auto-map them. The extra bones
(`HairBack`, `Cape1`/`Cape2`, `Tail1`–`Tail3`) drive springy parts and are ignored by retargeters.

`scripts/blender-check.py` imports a file with Blender's own importer (run it with Blender, or
with the `bpy` package from PyPI) and prints the bones, materials, shape keys and actions, then
checks that the mesh really moves for Walk, Jump and Sit:

```bash
pip install bpy            # Blender as a Python module
python scripts/blender-check.py figure.glb
```

## How it works

```text
src/
├── main.js                  # Stage, tabs, tools, pose and world modes, export dialog
├── rig/
│   ├── Skeleton.js          # Mixamo-named T-pose skeleton from the shape sliders
│   ├── Skinning.js          # Automatic weights (inverse distance to bone segments), stroke regions
│   └── Animations.js        # Procedural clips sampled into keyframes (and baked follow-through)
├── body/
│   ├── Geometry.js          # Sweeps, ellipsoids, rounded boxes, cones; detail levels for LODs
│   └── PartsCatalog.js      # Every swap part as a small builder fitted to the skeleton
├── sketch/Inflate.js        # Outline -> Delaunay mesh -> circular inflation; tubes; stroke classifier
├── build/Builder.js         # State -> skinned pieces with face shape keys; re-fits drawings to the body
├── view/
│   ├── Figure.js            # Live skinned meshes, mixer, expressions, springs, CCD IK
│   └── World.js             # Paper stage or loaded .glb, ground following, third-person camera
├── export/
│   ├── Exporter.js          # Merged .glb, VRM 1.0 plugin, LODs, crowds
│   ├── Media.js             # Photo, sprite sheets, turntable GIF (gifenc), character card
│   └── Zip.js               # Stored .zip writer
├── state/State.js           # The character as plain data, share codes, undo, autosave, My parts
└── render/InkEdgePass.js    # Ink outlines, shared with the world-builder
```

- **One source of truth.** The character is plain data (parts, colours, shape, drawn strokes,
  pose, card). Meshes, skeleton and clips are rebuilt from it, so undo, autosave, share links and
  every export agree.
- **Inflation.** A closed stroke is resampled, filled with a grid, Delaunay-triangulated and
  clipped to the outline; each vertex is lifted by `sqrt(d (2 dmax − d))` of its distance to the
  outline, front and back, so circles become balls and long ovals sausages.
- **Drawings follow the body.** Stroke points are stored against the default body as a place
  along their nearest bone plus an offset, and re-fitted bone by bone to the current shape.
- **Auto-rig.** Each vertex weighs its candidate bones by an inverse sixth power of the distance
  to the bone segment (top four kept), which gives near-rigid parts with a short blend at each
  joint. A stroke's candidate bones come from the body regions its points vote for, so a torso
  loop never follows an arm.
- **Clips.** Pose functions (one per animation) are sampled at 24 fps into quaternion tracks plus
  the hips' position; rest rotations are the identity, so a key is the rotation away from the
  T-pose. Capes, tails and long hair get baked follow-through in the clips and a live spring on
  top in the editor.
