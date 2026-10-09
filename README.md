# miku-motion-converter

Convert MikuMikuDance motion files (`.vmd`) into GeckoLib-compatible `.animation.json` files that you can preview and edit in Blockbench and play in Minecraft mods using GeckoLib.

```
dance.vmd + model.bbmodel + mapping.json  →  miku-motion convert  →  dance.animation.json
```

> **Status:** this branch is being ported from a Python command-line tool to a **Blockbench plugin** (TypeScript) with a Node CLI. The port is in progress: it converts body motion, but not yet leg IK, simulated hair or facial animation.
>
> - **For complete conversions today**, use the Python version on the [`python` branch](../../tree/python). Everything below this notice describes that version.
> - **To try the plugin:** `npm install`, then `npm run build`. Load `packages/plugin/dist/mmd_motion_importer.js` in Blockbench with File > Plugins > Load Plugin from File, then use File > Import > Import MMD Motion (.vmd).
> - **Development checks:** `npm run check` (lint, type check, tests, build).
>
> The axis and sign conventions are verified in Blockbench and in-game ([docs/conventions.md](docs/conventions.md)).

## Install

Requires [uv](https://docs.astral.sh/uv/) (Python 3.12+ is installed automatically).

```bash
uv sync
uv run miku-motion --help
```

## Planned usage

```bash
miku-motion inspect dance.vmd                 # frames, duration, animated bones, unsupported data
miku-motion inspect-model model.bbmodel       # bone tree, pivots, rest rotations
miku-motion convert dance.vmd --target model.bbmodel --mapping mappings/my-rig.json \
    --output dance.animation.json [--fps 20] [--optimize]
miku-motion convert-group crew-1.vmd crew-2.vmd crew-3.vmd \
    --target model.bbmodel --mapping mappings/my-rig.json --output-dir out/
miku-motion validate dance.animation.json --target model.bbmodel
```

`convert-group` batches several motions against one shared target rig and mapping - e.g. a
dance crew performing together - and flags any member whose converted length diverges from the
group's average (`--duration-tolerance`, default 1s), since performers meant to move together
are usually expected to share a timeline. Each motion is still converted fully independently;
this tool has no notion of a "show" or who plays the result back together - that stays entirely
the runtime's job.

A folder stands for every `.vmd` inside it, and its animations are named `<folder>_<motion>`:

```bash
miku-motion convert-group dances/crew/ --target model.bbmodel --mapping mappings/my-rig.json \
    --output-dir out/crew/ --sync-length --formation origin
```

Two options adjust the motions as one performance:

- `--sync-length` gives every animation the longest one's length, so they start and end
  together; shorter ones hold their last pose.
- `--formation` decides what happens to the stage positions stored in the motions:
  - `keep` (default): every performer stands where its motion puts it.
  - `center`: the whole group moves so that its middle starts at the origin.
  - `origin`: every performer starts at its own origin, for runtimes that place the
    performers themselves. The summary table lists where each one stood (x, z in pixels).

  Only horizontal positions change; heights are kept.

The **mapping file** describes how MMD bones drive your model's bones. The converter itself never assumes a particular rig, so any Blockbench model can be targeted with its own mapping. [mappings/mikucraft.json](mappings/mikucraft.json) is a commented example:

- Each key is a **target** (Blockbench) bone. `from` lists the MMD bones whose rotations combine into it, parent to child.
- `{"bone": "腰", "weight": -1}` applies a bone's rotation inverted. This reproduces MMD's waist-cancel bones.
- `"translation": true` keeps the chain's movement, scaled by `units.translation_scale` (pixels per MMD unit).
- `rest_correction` rotates the target's rest pose onto MMD's A-pose (e.g. arms that hang straight down).
- `ignore` silences warnings for bones you intentionally drop (globs allowed).

### Template model (works with any Minecraft skin)

[templates/](templates/) holds ready-to-dance GeckoLib models with the **exact proportions and skin layout of the Minecraft player**:

- **Two variants:** `template.bbmodel` for classic skins (4 px arms, like Steve) and `template_slim.bbmodel` for slim skins (3 px arms, like Alex). Each has a matching mapping, [mappings/template.json](mappings/template.json) and [mappings/template_slim.json](mappings/template_slim.json).
- **Skin layout:** the 64×128 skin's top 64×64 is a standard Minecraft skin (base and overlay layers, including the hat layer for hair). The extras live **outside** it, in the bottom half.
- **The pieces:** each Minecraft box is cut at the joints without moving or resizing anything. The body becomes waist and chest, the arms upper arm, forearm and hand, the legs thigh, shin and foot. A separate hips group carries the legs.
- **Extras:** twintails, ponytail, long hair, a short bob, skirt panels, a tie and sleeve cuffs, all **hidden by default** so a plain Minecraft skin looks right; unhide what you want. Hair, skirt and tie get secondary motion; the cuffs wrap the forearm, so they stay rigid with it.

Put any Minecraft skin on it (64×64, or legacy 64×32):

```bash
miku-motion apply-skin my_skin.png -o my_model.bbmodel   # detects classic/slim arms
miku-motion convert dance.vmd -t my_model.bbmodel -m mappings/template.json -o dance.animation.json
```

This writes `my_model.bbmodel` plus `my_model.png` (your skin on top, the extras below); use `mappings/template_slim.json` for slim skins. `uv run --with pillow python tools/make_template.py` regenerates the templates and their default skins.

### Preparing any model

Most Blockbench models weren't built for dancing: limbs are one piece, legs hang off the torso, the body pivots at the neck. The converter finds the body parts from the geometry (any naming style) and fixes the rig for you:

```bash
miku-motion prepare-model model.bbmodel --check   # what's missing (writes nothing)
miku-motion prepare-model model.bbmodel           # writes model.prepared.bbmodel
miku-motion init-mapping model.prepared.bbmodel -o mappings/model.json
miku-motion convert dance.vmd -t model.prepared.bbmodel -m mappings/model.json -o dance.animation.json
```

`prepare-model` never changes the original file. It can:

- **Add a root group** that carries the dance across the floor.
- **Attach the head and arms to the torso**, for flat rigs where every part sits at the top level.
- **Move the legs out of the torso**, so bending the upper body doesn't swing them.
- **Move the torso's pivot to the waist.**
- **Split one-piece arms and legs at the elbow and knee.** The texture stays exact: split cubes switch to per-face UVs.
- **Add Blockbench IK to hair chains and limbs:** a tip locator, an IK null and a pole null, so you can pose them by hand in Blockbench.

`init-mapping` writes the matching mapping. Each bone's MMD chain is derived from the standard MMD skeleton, arm rest corrections are measured from the model, the translation scale comes from its height, and hair and cloth chains are added as secondary motion. Review the result; a model with unusual parts may need a few edits.

### Hair and other secondary motion

MMD hair, skirts and ties move by physics, which a `.vmd` doesn't store. Instead, list springy chains of your model's bones in the mapping, and the converter simulates them from the body's motion. It doesn't need any IK set up in Blockbench: twintails, a single back ponytail, short hair, a tie or a skirt are all just chains of one or more bones.

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

`miku-motion inspect-model model.bbmodel [-m mapping.json]` lists a model's bones and suggests hair, cloth and accessory chains it finds by name and shape, as a snippet you can paste into the mapping. Conversions also mention unconfigured candidates (info MM303).

### Smaller, smoother files

`--optimize` keeps only the keyframes GeckoLib needs, within a tolerance (default 1°, `--rotation-tolerance`; positions 0.05 px, `--position-tolerance`):

- **Sampling:** the motion is sampled at 60 fps by default, and keys are dropped wherever GeckoLib's linear blend between the remaining keys stays within tolerance of the real motion.
- **Accuracy:** the check is on the true 3D rotation, including halfway between samples. It catches the detours that plain sampling produces near gimbal lock, where a bone turns about 90° sideways and its angles swing wildly.
- **Size:** dense, motion-capture-like dances shrink by roughly 25–60% depending on tolerance. Hand-keyed motions shrink much more.
- **Report:** the conversion prints the key count before and after, and the worst error (info MM401). Warning MM402 means some fast moves still exceed the tolerance; a higher `--fps` helps.

### Leg IK

Most dances move the legs through MMD's IK: the motion stores where the feet go, and MMD bends the knees to reach them. The converter solves this IK the way MMD does, so knees bend and feet stay planted.

- Solving needs the dancing model's bone positions, which a `.vmd` doesn't contain. By default a built-in skeleton with standard MMD proportions is used (`--source-skeleton mmd-standard`).
- You don't need the model. The built-in skeleton works for most dances.
- If warning MM106 says feet miss their targets, the real model's legs differ from the built-in ones. If you have the `.pmx` model the motion was made for, pass it: `--source-skeleton model.pmx`. Only its bones and IK settings are read; the mesh, textures and physics are skipped.
  - Use the motion's own model. A different model can make the feet miss more, not less.
  - A skeleton `.json` works too (format: [src/miku_motion/data/skeletons/mmd-standard.json](src/miku_motion/data/skeletons/mmd-standard.json)).
- Toe IK only aims the foot at its goal, so it's judged by its aim, not by distance.
- `--no-ik` turns solving off.

## Scope

Supported: skeletal motion (bone rotation and translation with MMD interpolation curves, resampled at a fixed rate), leg/toe IK, facial morphs through mapping rules, and simulated hair/cloth motion. Not supported: camera, lights, and MMD's own physics. Every dropped or approximated feature is reported as a warning.

## Development

```bash
uv run pytest
uv run ruff check . && uv run mypy
```

Put your own models and motions in `assets/`. That folder is git-ignored, so real assets never end up in the repository.

## Credits

These MMD models were used during development, only to study how MMD skeletons are built (bone trees, IK settings, morph names) and to test the converter. No part of them is included in this repository or in anything the converter writes: no mesh, texture, physics or measurements.

- **Project DIVA X HD Model Pack #1** by Durles (models © SEGA).
- **Project SEKAI "Default Miku"** from TearlessHen's SEKAI archive (© SEGA, Colorful Palette; conversion by TearlessHen).
- **Tsumi-style Kagamine Len and Kagamine Rin** (つみ式鏡音レン / つみ式鏡音リン) by つみだんご.

Hatsune Miku, Kagamine Rin and Kagamine Len are © Crypton Future Media, INC.

## License

MIT (the converter's code and the template model). The models credited above are not covered by it and are not distributed here.
