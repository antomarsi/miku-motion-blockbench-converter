# miku-motion-converter

Convert MikuMikuDance motion files (`.vmd`) into GeckoLib-compatible `.animation.json` files that you can preview and edit in Blockbench and play in Minecraft mods using GeckoLib.

```
dance.vmd + model.bbmodel + mapping.json  →  miku-motion convert  →  dance.animation.json
```

> **Status:** early development (pre-0.1). `inspect` and `convert` work; `inspect-model` and `validate` are planned. The axis and sign conventions are verified in Blockbench ([docs/conventions.md](docs/conventions.md)); in-game GeckoLib playback is still to be checked.

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
    --output dance.animation.json [--fps 20] [--audio dance.ogg] [--sound modid:dance]
miku-motion validate dance.animation.json --target model.bbmodel
```

The **mapping file** describes how MMD bones drive your model's bones. The converter itself never assumes a particular rig, so any Blockbench model can be targeted with its own mapping. [mappings/mikucraft.json](mappings/mikucraft.json) is a commented example:

- Each key is a **target** (Blockbench) bone. `from` lists the MMD bones whose rotations combine into it, parent to child.
- `{"bone": "腰", "weight": -1}` applies a bone's rotation inverted. This reproduces MMD's waist-cancel bones.
- `"translation": true` keeps the chain's movement, scaled by `units.translation_scale` (pixels per MMD unit).
- `rest_correction` rotates the target's rest pose onto MMD's A-pose (e.g. arms that hang straight down).
- `ignore` silences warnings for bones you intentionally drop (globs allowed).

### Music

`--audio dance.ogg` adds a GeckoLib sound keyframe on the first frame (`"sound_effects": {"0.0": {"effect": ...}}`) and warns if the music's length differs from the motion's by more than 2 s.

- The effect ID defaults to `<mod id>:<audio file name>`, using the GeckoLib mod ID stored in the `.bbmodel`. Override it with `--sound`.
- The converter doesn't copy the audio anywhere. The consuming mod must register a sound with that ID and handle GeckoLib sound keyframes.

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
- If warning MM106 says feet miss their targets, the real model's legs differ from the template. Pass a skeleton `.json` with that model's proportions (format: [src/miku_motion/data/skeletons/mmd-standard.json](src/miku_motion/data/skeletons/mmd-standard.json)). Reading the model's `.pmx` directly is planned.
- `--no-ik` turns solving off.

## Scope

Supported: skeletal motion (bone rotation and translation with MMD interpolation curves, resampled at a fixed rate) and leg/toe IK. Not yet supported: facial morphs, camera, lights, and physics (hair, skirt, ties). Every dropped or approximated feature is reported as a warning.

## Development

```bash
uv run pytest
uv run ruff check . && uv run mypy
```

Put your own models and motions in `assets/`. That folder is git-ignored, so real assets never end up in the repository.

## License

MIT
