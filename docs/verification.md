# Verifying conversions in Blockbench

Automated tests prove the converter is internally consistent. Only Blockbench (and then GeckoLib in game) can prove that the sign conventions in [conventions.md](conventions.md) are right. Run this checklist whenever those conventions change.

## Opening an animation in Blockbench

1. Open the target `.bbmodel` (GeckoLib "Animated Model" project).
2. Switch to the **Animate** tab.
3. Import the `.animation.json` from the Animations panel (the import/open button, or File → Import).
4. Select the animation and press play.

## Step 1: calibration (sign conventions)

Generate a motion that moves one axis at a time, then convert it:

```bash
miku-motion dev synth-calibration -o out/calibration.vmd --rotate 頭 --move センター
miku-motion convert out/calibration.vmd -t assets/models/Mikucraft.bbmodel \
    -m mappings/mikucraft.json -o out/calibration.animation.json
```

Each step reaches its pose at the listed time and returns to rest one second later. Expected results are derived from MMD's axes (left-handed, the model faces −Z, the model's left is +X). "Model's left/right" means the character's own side.

| Time | Step | Expected in Blockbench | If wrong, suspect |
|---|---|---|---|
| 1 s | head +45° X | head tilts **back** (looks up) | X rotation sign |
| 3 s | head +45° Y | head turns toward the **model's right** | Y rotation sign |
| 5 s | head +45° Z | head tilts toward the **model's right** shoulder | Z rotation sign |
| 7 s | body +2 X | whole model slides toward the **model's left** | X position sign |
| 9 s | body +2 Y | whole model rises (3.2 px with scale 1.6) | Y position sign / scale |
| 11 s | body +2 Z | whole model moves **backward** (away from where it faces) | Z position sign |

If a row fails, flip the corresponding sign in `geckolib/encoding.py`, update [conventions.md](conventions.md) and the golden file (`pytest --update-golden`), and add a regression test.

If *every* rotation looks mirrored, the assumption about how MMD applies quaternions is wrong instead. Fix that in `conversion/coordinates.py`, not in the encoder.

## Step 2: arm wave and rest pose

Convert a motion that raises the left arm (e.g. from `tests/integration/test_convert.py`, or any VMD):

- The **model's left** arm moves (not the right).
- At rest the arms sit in MMD's A-pose, angled roughly 37° below horizontal (that's the `rest_correction` in the mapping). If they're too high or low, tune `rest_correction.euler_deg` on the arm entries.
- A bone with a rest rotation (e.g. `Chest`) doesn't jump when the animation starts.

## Step 3: real dance

Convert a full dance and scrub through it:

- Timing: the animation length equals the motion's duration shown by `miku-motion inspect`.
- The head, torso and arms follow the choreography.
- Legs only follow FK keys (IK isn't solved yet, warning MM102), so knees won't bend properly.

Record any failure as an issue with the time in seconds and the bone name.
