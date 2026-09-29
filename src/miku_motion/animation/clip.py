"""Sampled target animation, independent of any output format.

Rotations are each bone's **full local rotation** (rest included) and translations are
offsets from the rest pivot in the parent's frame, both in canonical space and target
units. Output formats derive their own deltas from these (e.g. GeckoLib subtracts the
rest Euler angles).
"""

from dataclasses import dataclass, field
from enum import StrEnum

from miku_motion.geometry.quat import FloatArray


class LoopMode(StrEnum):
    ONCE = "false"
    LOOP = "true"
    HOLD = "hold"


@dataclass(frozen=True, slots=True, eq=False)
class BoneTrack:
    rotations: FloatArray | None = None  # (N, 4) xyzw, full local rotation
    translations: FloatArray | None = None  # (N, 3) offset from rest, parent frame


@dataclass(frozen=True, slots=True)
class SoundCue:
    time: float  # seconds
    effect: str  # sound identifier, meaningful to the consumer (e.g. a GeckoLib mod)


@dataclass(slots=True)
class Animation:
    name: str
    times: FloatArray  # (N,) seconds, shared by every track
    length: float  # seconds
    loop: LoopMode = LoopMode.ONCE
    tracks: dict[str, BoneTrack] = field(default_factory=dict)
    sounds: tuple[SoundCue, ...] = ()
