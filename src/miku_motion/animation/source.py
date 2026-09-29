"""Format-independent keyed source motion (what a motion file says, before retargeting).

Values are in the *source* coordinate space; no axis conversion has happened yet.
Each track stores its keys as arrays for vectorized sampling.
"""

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from miku_motion.geometry import quat
from miku_motion.geometry.quat import FloatArray

# Channel order of `SourceBoneTrack.curves[:, channel]`.
CURVE_X, CURVE_Y, CURVE_Z, CURVE_ROTATION = range(4)


def _same_name(name: str) -> str:
    return name


ROTATION_EPS = 1e-4  # radians: below this a rotation counts as "none"
TRANSLATION_EPS = 1e-4  # source units


@dataclass(frozen=True, slots=True, eq=False)
class SourceBoneTrack:
    """Keys of one bone, sorted by frame with unique frames.

    - ``frames``: ``(K,)`` integer frame numbers
    - ``translations``: ``(K, 3)`` offsets from the bone's rest position
    - ``rotations``: ``(K, 4)`` xyzw rotations relative to the rest pose
    - ``curves``: ``(K, 4, 4)`` easing curves (x, y, z, rotation) of the segment
      *arriving* at each key, as normalized ``(x1, y1, x2, y2)``
    """

    name: str
    frames: FloatArray
    translations: FloatArray
    rotations: FloatArray
    curves: FloatArray

    def __post_init__(self) -> None:
        k = len(self.frames)
        if k == 0:
            raise ValueError(f"track {self.name!r} has no keys")
        expected = {"translations": (k, 3), "rotations": (k, 4), "curves": (k, 4, 4)}
        for attr, shape in expected.items():
            if getattr(self, attr).shape != shape:
                raise ValueError(f"track {self.name!r}: {attr} must have shape {shape}")
        if np.any(np.diff(self.frames) <= 0):
            raise ValueError(f"track {self.name!r}: frames must be strictly increasing")

    @property
    def rotates(self) -> bool:
        """Some key rotates the bone away from its rest orientation."""
        return bool(np.any(quat.angle(self.rotations) > ROTATION_EPS))

    @property
    def translates(self) -> bool:
        """Some key moves the bone away from its rest position."""
        return bool(np.any(np.abs(self.translations) > TRANSLATION_EPS))

    @property
    def is_animated(self) -> bool:
        """The track changes the pose at all (moving, or a static non-rest pose)."""
        return self.rotates or self.translates


@dataclass(slots=True)
class SourceMotion:
    name: str
    frame_rate: float
    end_frame: int
    tracks: dict[str, SourceBoneTrack] = field(default_factory=dict)
    ik_bones: frozenset[str] = frozenset()  # bones whose motion reaches others only via IK
    # Maps a user-written bone name to the key used in `tracks` (formats may truncate names).
    canonical_name: Callable[[str], str] = _same_name

    @property
    def duration(self) -> float:
        return self.end_frame / self.frame_rate
