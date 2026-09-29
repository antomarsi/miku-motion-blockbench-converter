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

## Scope

v0.1 covers skeletal motion only: bone rotation and translation with MMD interpolation curves, resampled at a fixed rate. Not yet supported: facial morphs, camera, lights, physics (hair and skirt), and IK solving. Legs driven by MMD's leg IK are approximated. Every dropped or approximated feature is reported as a warning.

## Development

```bash
uv run pytest
uv run ruff check . && uv run mypy
```

Put your own models and motions in `assets/`. That folder is git-ignored, so real assets never end up in the repository.

## License

MIT
