"""Canonical animation values -> GeckoLib / Bedrock channel values.

This module is the single source of truth for GeckoLib's conventions:

- rotation keyframes are ZYX Euler **degrees**, *added per component* to the bone's rest
  rotation (Blockbench and GeckoLib add Euler angles; they don't compose quaternions)
- the Bedrock format stores X and Y rotation, and X position, with flipped signs
  relative to Blockbench's internal (canonical) space
- position keyframes are offsets from the rest pivot in pixels, in the parent's frame

The sign conventions are recorded in docs/conventions.md and must be confirmed with
the calibration motion (`miku-motion dev synth-calibration`) before being relied on.
"""

import numpy as np

from miku_motion.animation.skeleton import Bone
from miku_motion.geometry import euler
from miku_motion.geometry.quat import FloatArray

ROTATION_SIGNS = np.array([-1.0, -1.0, 1.0])
POSITION_SIGNS = np.array([-1.0, 1.0, 1.0])


def rotation_channel(bone: Bone, rotations: FloatArray) -> FloatArray:
    """Keyframe values (degrees, ``(N, 3)``) for full local rotations of ``bone``."""
    rest = np.radians(bone.rest_euler_degrees)
    angles = euler.continuous_from_quats(rotations, start=rest)
    result: FloatArray = np.degrees(angles - rest) * ROTATION_SIGNS
    return result


def position_channel(translations: FloatArray) -> FloatArray:
    """Keyframe values (pixels, ``(N, 3)``) for canonical parent-frame offsets."""
    result: FloatArray = np.asarray(translations, dtype=np.float64) * POSITION_SIGNS
    return result
