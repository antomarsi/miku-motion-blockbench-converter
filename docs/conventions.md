# Coordinate and format conventions

This page records every convention the converter relies on and whether it has been verified. When a verification changes a convention, update the one module that owns it (listed below), update this page, and add a regression test.

## Spaces

| Space | Handedness | Up | Model faces | Model's left | Units | Owner |
|---|---|---|---|---|---|---|
| MMD (VMD/PMX) | left | +Y | −Z | +X | ≈ 8 cm | `packages/core/src/conversion/coordinates.ts` |
| **Canonical** (= Blockbench model space) | right | +Y | −Z | −X | pixel (1/16 block) | — |
| GeckoLib / Bedrock animation file | see below | | | | pixel | `packages/core/src/geckolib/encoding.ts` |

MMD → canonical is an **X-mirror**: `p' = (−x, y, z)`, `q' = (qx, −qy, −qz, qw)`. The mirror corrects the handedness and also puts the model's left at −X.

Status: **verified** (2026-09-29). Facing and left/right were confirmed from real assets (the Mikucraft face is at −Z with `LeftArm` at −X; MMD `左` bones have +X positions). The calibration motion then matched every expected direction in Blockbench, confirming that MMD applies a key's quaternion as `v' = q v q⁻¹` in its own axes.

## Rotation keyframes (GeckoLib / Blockbench)

- Euler order ZYX: `R = Rz · Ry · Rx` (X applied first). **Verified in Blockbench.**
- A keyframe is a delta **added per Euler component** to the bone's rest rotation. It is not composed as a quaternion. The converter handles this by subtracting the rest Euler angles in `packages/core/src/geckolib/encoding.ts`. **Assumed; not yet exercised**: the Mikucraft rig currently has no mapped bone with a rest rotation.
- Bedrock sign convention relative to Blockbench's internal space: X and Y are negated, Z is kept (`ROTATION_SIGNS = (−1, −1, +1)`). **Verified in Blockbench** (calibration steps 1–3).
- Rest rotations in `.bbmodel` groups are read as canonical ZYX degrees with no sign changes. **Assumed; not yet exercised.**

## Position keyframes

- Offset from the rest pivot, in pixels, in the parent bone's frame.
- X is negated (`POSITION_SIGNS = (−1, +1, +1)`). **Verified in Blockbench** (calibration steps 4–6).
- GeckoLib at runtime in Minecraft matches Blockbench. **Verified in-game** (2026-10) with converted dances.

## Numbers and determinism

- Times: `k / fps` from integer indices, 4 decimals, trailing zeros stripped (`"0.05"`, `"1.0"`).
- Values: rounded to 4 decimals, `-0` written as `0`.
- A channel that never changes is written as one keyframe at `0.0`. A channel that stays at the rest pose is omitted.
