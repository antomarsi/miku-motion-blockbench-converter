# MMD Motion Importer for Blockbench

[![Tests](https://github.com/antomarsi/miku-motion-blockbench-converter/actions/workflows/ci.yml/badge.svg)](https://github.com/antomarsi/miku-motion-blockbench-converter/actions/workflows/ci.yml)
[![Release](https://github.com/antomarsi/miku-motion-blockbench-converter/actions/workflows/release.yml/badge.svg)](https://github.com/antomarsi/miku-motion-blockbench-converter/actions/workflows/release.yml)
[![Latest version](https://img.shields.io/github/v/release/antomarsi/miku-motion-blockbench-converter?include_prereleases&label=version)](https://github.com/antomarsi/miku-motion-blockbench-converter/releases)

> [!WARNING]
> **This is an alpha.** It works on the models and dances it was tested with, but expect rough edges, and things may change between versions. Keep a copy of your model before using the tools that edit it, and please [report what breaks](https://github.com/antomarsi/miku-motion-blockbench-converter/issues).

Import MikuMikuDance motion files (`.vmd`) into [Blockbench](https://www.blockbench.net/) as GeckoLib animations, on any model, and play them in Minecraft mods that use GeckoLib.

It comes as a **Blockbench plugin** (desktop and web app) and as a **command-line tool** that does the same conversions from a terminal.

- The whole body follows the dance, including knees bent by MMD's leg IK.
- Hair, skirts and ties swing by simulation and stay out of the body.
- Blinks and mouth shapes drive the model's face parts.
- A built-in model with the exact shape of the Minecraft player dances in any Minecraft skin, with no setup.
- Your own model works too: the plugin can fix its rig and work out which bone follows which part of the dance.

## Install the plugin

The plugin isn't in Blockbench's plugin list yet. Until it is, load it yourself:

- **From a release:** download `mmd_motion_importer.js` from the [Releases page](../../releases), then in Blockbench use File > Plugins > Load Plugin from File.
- **From the address of the latest release:** File > Plugins > Load Plugin from URL, with `https://antomarsi.github.io/miku-motion-blockbench-converter/mmd_motion_importer.js`.
- **From source:** `npm install`, then `npm run build`, and load `packages/plugin/dist/mmd_motion_importer.js`.

It needs Blockbench 4.8 or newer. To export for a mod you also need the GeckoLib Models & Animations plugin, as for any GeckoLib model.

## Quick start: a Minecraft skin that dances

1. **File > New > New Minecraft Dancer.** Pick your skin `.png` (optional) and press Create. Slim or classic arms follow the skin.
2. **File > Import > Import MMD Motion (.vmd).** Pick the `.vmd` and press Import VMD. The same button is at the top of the Animations panel.
3. Press play in the Animate tab.

The dancer has hair (twintails, ponytail, long hair, a bob), skirt panels, a tie and sleeve cuffs as hidden groups. Show the ones you want; they swing with the dance.

After an import, a report tells you what was left out or approximated, in plain words. Bone names in it are links that select the bone, and the "MMD Import Report" panel in the Animate tab keeps the last report.

## The import dialog

- **Custom mapping:** a mapping `.json` for your own rig (see below). It is then saved with the project. Left empty, the built-in mapping of the dancer model is used.
- **Source model:** optional. The MMD model (`.pmx`) the dance was made for. Its leg proportions make the feet land exactly. Only use the dance's own model: another one makes it worse.
- **Reduce keyframes:** keeps only the keyframes needed to follow the dance. The animation gets much smaller and the motion between keys more accurate. Recommended.
- **Samples per second:** 60 suits reduced keyframes; 20 keeps unreduced animations small.
- **Solve leg IK:** works out knee bends from where the dance places the feet, as MMD does.
- **Hair avoids the body:** keeps simulated hair and cloth from passing through the head and body.
- **Loop:** play once, loop, or hold on the last frame.

A progress window shows how far the conversion is, with a Cancel button.

Importing the same motion again replaces the animation of the same name. After changing the model or its mapping, **Re-import** in the "MMD Import Report" panel (or Animation > Re-import Last MMD Motion) converts the last motion again with the same settings, without picking the file; **Change settings** reopens the dialog on it. Imported animations aren't linked to a file on disk; export them from Blockbench as usual.

For a dance with several performers, import each performer's `.vmd` in its own project. The command line's `convert-group` can also give them the same length and adjust their stage positions.

## Your own model

Everything here is under **Tools > MMD Motion Importer**.

1. **Prepare Model for Dancing** checks the rig and shows the changes it would make before applying them. One undo restores the original. It can:
   - add a root bone that carries the dance across the floor;
   - attach the head and arms to the torso, for rigs where every part sits at the top level;
   - move the legs out of the torso, so bending the upper body doesn't swing them;
   - move the torso's pivot to the waist;
   - split one-piece arms and legs at the elbow and knee, keeping the texture exact;
   - add Blockbench IK handles to limbs and hair, for posing by hand (dances don't need them).
2. **Generate Bone Mapping** finds the body parts from the model's shape (any naming style) and writes the mapping. Choose "Use for imports" to save it in the project.
3. **Check Rig** adds a short test animation that turns one bone a single direction at a time and then moves the whole model, and tells you what each step should look like.
4. **Edit Bone Mapping** shows every bone with the motion bones it follows, and the chains that swing as hair or cloth. Bones nothing drives are marked. You can also load or save the mapping as a file here.

**Apply Minecraft Skin** changes the skin of a dancer model later.

Face parts only get blink and mouth rules when their pivot sits on the part itself; otherwise scaling would slide them across the face, so they are left still and the dialog says which ones.

## The mapping file

A mapping describes how MMD bones drive your model's bones. The converter itself never assumes a particular rig. [mappings/template.json](mappings/template.json) is the built-in one; the same format is used by the plugin and the command line.

- Each key under `bones` is a bone of **your model**. `from` lists the MMD bones whose rotations combine into it, parent to child.
- `{"bone": "腰", "weight": -1}` applies a bone's rotation inverted. This reproduces MMD's waist-cancel bones.
- `"translation": true` keeps the chain's movement, scaled by `units.translation_scale` (pixels per MMD unit).
- `rest_correction` rotates the model's rest pose onto MMD's A-pose (for arms that hang straight down).
- `ignore` silences warnings for bones you intentionally drop (globs allowed).

### Hair and other secondary motion

MMD hair, skirts and ties move by physics, which a `.vmd` doesn't store. Instead, the mapping lists springy chains of your model's bones, and the converter simulates them from the body's motion. No IK setup in Blockbench is needed.

```json
"secondary_motion": [
  { "bones": ["Tt_right", "middle_right", "bottom_right"], "preset": "long_hair", "offset": [0, 0, 4] },
  { "bones": ["Ponytail"], "preset": "ponytail", "bounciness": 0.7 }
]
```

- **`bones`:** parent to child.
- **`preset`:** `long_hair` (default), `ponytail`, `short_hair`, `cloth` or `accessory`. Any value below overrides the preset.
- **`bounciness`:** from 0 (settles without overshooting) to 1 (keeps bouncing). `damping` sets the same thing directly, for advanced use.
- **`stiffness`:** how tightly the chain follows the body.
- **`gravity`:** 1 = real gravity at Minecraft scale.
- **`offset`:** shifts the chain's resting shape, in pixels at the tip. For example, `[0, 0, 4]` hangs hair 4 px further back (+Z is the back).
- **`tip`:** where the last bone ends. By default it's measured from that bone's cubes, so one-bone chains need no extra setup.
- **`collide`:** the body parts the chain can't pass through. By default the head and trunk (head, chest, torso, hips) are found from the model's shape, and `cloth` chains also avoid the thighs and shins, so a lifting leg pushes a skirt instead of passing through it. Give a list of bone names to choose them yourself (add the arms for hair, say), or `false` to let the chain pass through everything. Each part is a box around its cubes.
- **`collision_padding`:** pixels kept between the chain's joints and those parts. By default it's half the thickness of the chain's pieces, and never so much that the resting hair would be pushed away.

### Face

`morphs` lists rules that turn MMD's facial morphs (blink, vowels) into scale, position, rotation or visibility of your model's face bones. Generate Bone Mapping writes them for bones named like `eyelid_left`, `eyes`, `mouth` or `mouth_a` inside the head; the template mapping shows every form.

## Command line

The same conversions without Blockbench. It needs Node 20 or newer.

```bash
npm install && npm run build
node packages/cli/dist/miku-motion.mjs --help
```

The examples below write `miku-motion` for `node packages/cli/dist/miku-motion.mjs`. Each release also attaches the tool as a single file.

```bash
miku-motion inspect dance.vmd                    # frames, duration, animated bones, unsupported data
miku-motion inspect-model model.bbmodel          # bone tree, pivots, suggested hair chains
miku-motion convert dance.vmd -t model.bbmodel -m mappings/my-rig.json -o dance.animation.json --optimize
miku-motion convert-group dances/crew/ -t model.bbmodel -m mappings/my-rig.json -o out/crew/ \
    --sync-length --formation origin
miku-motion validate dance.animation.json -t model.bbmodel
```

For a model of your own:

```bash
miku-motion prepare-model model.bbmodel --check  # what's missing (writes nothing)
miku-motion prepare-model model.bbmodel          # writes model.prepared.bbmodel
miku-motion init-mapping model.prepared.bbmodel -o mappings/model.json
```

For a Minecraft skin on the built-in model:

```bash
miku-motion apply-skin my_skin.png -o my_model.bbmodel   # detects classic or slim arms
miku-motion convert dance.vmd -t my_model.bbmodel -m mappings/template.json -o dance.animation.json
```

Use `mappings/template_slim.json` for slim skins. `miku-motion <command> --help` lists every option.

Notes that apply to both the plugin and the command line:

- **Keyframe reduction (`--optimize`):** the motion is sampled at 60 fps, and keys are dropped wherever GeckoLib's blend between the remaining keys stays within tolerance (1° and 0.05 px by default). The check is on the true 3D rotation, including halfway between samples, which catches the detours plain sampling produces when a bone turns about 90° sideways. Dense, motion-capture-like dances shrink by roughly 25–60%; hand-keyed ones much more. Warning MM402 means some fast moves still exceed the tolerance.
- **Leg IK:** solving needs the dancing model's bone positions, which a `.vmd` doesn't contain. A built-in skeleton with standard MMD proportions is used by default and works for most dances. If warning MM106 says feet miss their targets, pass the dance's own model: `--source-skeleton model.pmx` (only its bones and IK settings are read). The mapping then also follows that model's bone tree where it differs from the standard one (info MM110), such as an arm twist that reaches the elbow only in part. A skeleton `.json` works too ([format](packages/core/src/data/skeletons/mmd-standard.json)). `--no-ik` turns solving off.
- **Groups:** in a folder given to `convert-group`, animations are named `<folder>_<motion>`. Only horizontal stage positions change with `--formation`; heights are kept.

## Scope

Supported: skeletal motion (bone rotation and translation with MMD interpolation curves, resampled at a fixed rate), leg and toe IK, facial morphs through mapping rules, and simulated hair and cloth motion.

Not supported: camera, lights, and MMD's own physics. Sound is not written either; add music in Blockbench. Every dropped or approximated feature is reported.

The converter knows nothing about any particular mod. Its only output is the animation.

## Development

```bash
npm install
npm run check    # lint, type check, tests, build
```

- `packages/core`: the conversion, in pure TypeScript (no Blockbench, browser or Node APIs).
- `packages/plugin`: the Blockbench plugin, bundled into one file.
- `packages/cli`: the command-line tool.
- `reference/`: outputs of the original Python version on synthetic inputs; the tests compare against them.
- [docs/conventions.md](docs/conventions.md) records the axis and sign conventions, verified in Blockbench and in-game. [docs/verification.md](docs/verification.md) is the checklist for re-verifying them.

The original Python command-line version is kept on the [`python` branch](../../tree/python). It also holds the generator of the template models (`tools/make_template.py`).

Put your own models and motions in `assets/`. That folder is git-ignored, so real assets never end up in the repository.

## Credits

These MMD models were used during development, only to study how MMD skeletons are built (bone trees, IK settings, morph names) and to test the converter. No part of them is included in this repository or in anything the converter writes: no mesh, texture, physics or measurements.

- **Project DIVA X HD Model Pack #1** by Durles (models © SEGA).
- **Project SEKAI "Default Miku"** from TearlessHen's SEKAI archive (© SEGA, Colorful Palette; conversion by TearlessHen).
- **Tsumi-style Kagamine Len and Kagamine Rin** (つみ式鏡音レン / つみ式鏡音リン) by つみだんご.

Hatsune Miku, Kagamine Rin and Kagamine Len are © Crypton Future Media, INC.

## License

MIT (the converter's code and the template model). The models credited above are not covered by it and are not distributed here.
