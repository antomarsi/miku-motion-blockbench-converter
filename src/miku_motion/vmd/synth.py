"""Synthetic motions for verifying conventions end to end.

The calibration motion exercises one axis at a time, so each direction can be checked
visually in Blockbench. Bone names are parameters: nothing here assumes a rig.
"""

import math
from dataclasses import dataclass

from miku_motion.vmd import interpolation
from miku_motion.vmd.types import Quat, Vec3, VmdBoneKey, VmdFile

_IDENTITY: Quat = (0.0, 0.0, 0.0, 1.0)
_ORIGIN: Vec3 = (0.0, 0.0, 0.0)
SEGMENT_FRAMES = 30  # each step takes one second at MMD's 30 fps


@dataclass(frozen=True, slots=True)
class Step:
    label: str
    start_frame: int  # the pose is reached here and released SEGMENT_FRAMES later


def _axis_quat(axis: int, degrees: float) -> Quat:
    half = math.radians(degrees) / 2
    q = [0.0, 0.0, 0.0, math.cos(half)]
    q[axis] = math.sin(half)
    return (q[0], q[1], q[2], q[3])


def calibration(
    rotate_bone: str, move_bone: str | None, degrees: float = 45.0, distance: float = 2.0
) -> tuple[VmdFile, list[Step]]:
    """Rotate ``rotate_bone`` +``degrees`` about X, Y, Z in turn, then move ``move_bone``
    +``distance`` along X, Y, Z. Every step returns to rest before the next begins."""
    curve = interpolation.encode()
    keys: list[VmdBoneKey] = []
    steps: list[Step] = []
    frame = 0

    def pose(bone: str, position: Vec3, rotation: Quat, label: str) -> None:
        nonlocal frame
        if not any(k.name == bone and k.frame == frame for k in keys):
            keys.append(VmdBoneKey(bone, frame, _ORIGIN, _IDENTITY, curve))
        keys.append(VmdBoneKey(bone, frame + SEGMENT_FRAMES, position, rotation, curve))
        keys.append(VmdBoneKey(bone, frame + 2 * SEGMENT_FRAMES, _ORIGIN, _IDENTITY, curve))
        steps.append(Step(label, frame + SEGMENT_FRAMES))
        frame += 2 * SEGMENT_FRAMES

    for axis, letter in enumerate("XYZ"):
        pose(
            rotate_bone, _ORIGIN, _axis_quat(axis, degrees), f"{rotate_bone} +{degrees:g}° {letter}"
        )
    if move_bone is not None:
        for axis, letter in enumerate("XYZ"):
            offset = [0.0, 0.0, 0.0]
            offset[axis] = distance
            pose(
                move_bone,
                (offset[0], offset[1], offset[2]),
                _IDENTITY,
                f"{move_bone} +{distance:g} {letter}",
            )
    return VmdFile(model_name="calibration", bone_keys=keys), steps
