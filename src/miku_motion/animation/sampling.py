"""Evaluate keyed source tracks at arbitrary times.

Between two keys, each translation axis follows its own easing curve and the rotation
follows its curve through a shortest-path slerp (MMD semantics). Before the first key
and after the last one the nearest key's value is held.
"""

from dataclasses import dataclass

import numpy as np

from miku_motion.animation import curves
from miku_motion.animation.source import CURVE_ROTATION, SourceBoneTrack
from miku_motion.geometry import quat
from miku_motion.geometry.quat import ArrayLike, FloatArray


@dataclass(frozen=True, slots=True, eq=False)
class PoseSamples:
    """Sampled values: ``translations`` ``(N, 3)`` and ``rotations`` ``(N, 4)`` xyzw."""

    translations: FloatArray
    rotations: FloatArray


def sample_times(duration: float, fps: float) -> FloatArray:
    """Sample times ``k / fps`` covering ``[0, duration]``, always including both ends.

    Computed from integer indices so every run yields bit-identical times.
    """
    if fps <= 0:
        raise ValueError("fps must be positive")
    count = int(np.floor(duration * fps + 1e-9)) + 1
    times = np.arange(count, dtype=np.float64) / fps
    if duration - times[-1] > 1e-9:
        times = np.append(times, duration)
    return times


def sample_track(track: SourceBoneTrack, frames: ArrayLike) -> PoseSamples:
    """Evaluate ``track`` at (fractional) source ``frames``."""
    f = np.asarray(frames, dtype=np.float64)
    keys = track.frames
    last = len(keys) - 1

    # Segment [i, i+1] containing each frame; clamped so i+1 is always valid.
    i = np.clip(np.searchsorted(keys, f, side="right") - 1, 0, max(last - 1, 0))
    j = np.minimum(i + 1, last)
    span = np.where(j > i, keys[j] - keys[i], 1.0)
    u = np.clip((f - keys[i]) / span, 0.0, 1.0)
    u = np.where(j > i, u, 0.0)  # single-key track

    progress = curves.evaluate(track.curves[j], u[:, np.newaxis])  # (N, 4)
    t0, t1 = track.translations[i], track.translations[j]
    translations = t0 + (t1 - t0) * progress[:, :3]
    rotations = quat.slerp(track.rotations[i], track.rotations[j], progress[:, CURVE_ROTATION])
    return PoseSamples(translations, rotations)
