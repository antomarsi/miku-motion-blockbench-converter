"""Error-bounded keyframe reduction for GeckoLib channels.

GeckoLib interpolates keyframe *values* linearly: Euler angles for rotation, offsets for
position. Starting from densely sampled true poses, this keeps only the keys needed
for that interpolation to stay within a tolerance of the truth:

1. Douglas-Peucker: keep the endpoints; while a segment's interpolation misses the truth
   by more than the tolerance anywhere, keep its worst sample and split there.
2. Refinement: where two neighbouring samples still interpolate badly (Euler
   interpolation detours near gimbal lock), insert keys at half steps.

Rotation error is the true 3D angle between GeckoLib's interpolated rotation and the
intended one, checked at every sample and halfway between samples (where the intended
rotation is the shortest-path blend of its neighbours).
"""

from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise

import numpy as np

from miku_motion.animation.skeleton import Bone
from miku_motion.geckolib import encoding
from miku_motion.geometry import quat
from miku_motion.geometry.quat import FloatArray

MAX_REFINE_DEPTH = 3  # up to 8 keys between two samples
DEFAULT_ROTATION_TOLERANCE = 1.0  # degrees; invisible on blocky models, ~45% smaller files
DEFAULT_POSITION_TOLERANCE = 0.05  # pixels


@dataclass(frozen=True, slots=True)
class Tolerance:
    rotation_degrees: float = DEFAULT_ROTATION_TOLERANCE
    position: float = DEFAULT_POSITION_TOLERANCE  # pixels


@dataclass(frozen=True, slots=True, eq=False)
class ReducedChannel:
    times: FloatArray  # (K,) seconds
    values: FloatArray  # (K, 3) keyframe values in file units
    max_error: float  # degrees for rotation, pixels for position


type SegmentError = Callable[[int, int], tuple[float, int]]


def _douglas_peucker(count: int, segment_error: SegmentError, tolerance: float) -> list[int]:
    keep = {0, count - 1}
    stack = [(0, count - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        error, worst = segment_error(i, j)
        if error > tolerance:
            keep.add(worst)
            stack += [(i, worst), (worst, j)]
    return sorted(keep)


def reduce_position(times: FloatArray, values: FloatArray, tolerance: float) -> ReducedChannel:
    def segment_error(i: int, j: int) -> tuple[float, int]:
        alpha = (times[i + 1 : j] - times[i]) / (times[j] - times[i])
        lerp = values[i] + alpha[:, None] * (values[j] - values[i])
        errors = np.linalg.norm(lerp - values[i + 1 : j], axis=1)
        k = int(np.argmax(errors))
        return float(errors[k]), i + 1 + k

    keep = _douglas_peucker(len(times), segment_error, tolerance)
    max_error = max((segment_error(a, b)[0] for a, b in pairwise(keep) if b - a > 1), default=0.0)
    return ReducedChannel(times[keep], values[keep], max_error)


def _angle_between_units(a: FloatArray, b: FloatArray) -> FloatArray:
    """Rotation angle between unit quaternions (a cheap form for the hot loop)."""
    result: FloatArray = 2.0 * np.arccos(np.minimum(np.abs(np.sum(a * b, axis=-1)), 1.0))
    return result


def reduce_rotation(
    bone: Bone, times: FloatArray, rotations: FloatArray, tolerance_degrees: float
) -> ReducedChannel:
    """Reduce a rotation channel; ``rotations`` are the true full local rotations."""
    tolerance = np.radians(tolerance_degrees)
    values = encoding.rotation_channel(bone, rotations)
    truth = quat.make_continuous(rotations)
    midpoints = quat.slerp(truth[:-1], truth[1:], 0.5)
    mid_times = 0.5 * (times[:-1] + times[1:])

    def errors_between(i: int, j: int) -> tuple[FloatArray, FloatArray]:
        """Errors at samples i+1..j-1 and at midpoints i..j-1 for keys i and j."""
        span = times[j] - times[i]
        alpha = np.concatenate([times[i + 1 : j], mid_times[i:j]]) - times[i]
        lerp = values[i] + (alpha / span)[:, None] * (values[j] - values[i])
        shown = encoding.rotation_from_channel(bone, lerp)
        intended = np.concatenate([truth[i + 1 : j], midpoints[i:j]])
        errors = _angle_between_units(shown, intended)
        return errors[: j - i - 1], errors[j - i - 1 :]

    def segment_error(i: int, j: int) -> tuple[float, int]:
        at_samples, at_midpoints = errors_between(i, j)
        worst_sample = int(np.argmax(at_samples))
        worst_mid = int(np.argmax(at_midpoints))
        if at_midpoints[worst_mid] > at_samples[worst_sample]:
            # Split at the sample next to the worst midpoint (never an endpoint).
            k = min(max(i + worst_mid + 1, i + 1), j - 1)
            return float(at_midpoints[worst_mid]), k
        return float(at_samples[worst_sample]), i + 1 + worst_sample

    keep = _douglas_peucker(len(times), segment_error, tolerance)

    out_times: list[float] = [float(times[keep[0]])]
    out_values: list[FloatArray] = [values[keep[0]]]
    max_error = 0.0
    for a, b in pairwise(keep):
        if b - a > 1:
            max_error = max(max_error, segment_error(a, b)[0])
        else:
            inserted, error = _refine(
                bone, (times[a], values[a], truth[a]), (times[b], values[b], truth[b]), tolerance
            )
            for t, v in inserted:
                out_times.append(t)
                out_values.append(v)
            max_error = max(max_error, error)
        out_times.append(float(times[b]))
        out_values.append(values[b])
    return ReducedChannel(np.array(out_times), np.array(out_values), float(np.degrees(max_error)))


type Key = tuple[float, FloatArray, FloatArray]  # time, file value, true rotation


def _refine(
    bone: Bone, start: Key, end: Key, tolerance: float, depth: int = 0
) -> tuple[list[tuple[float, FloatArray]], float]:
    """Keys to insert between two neighbouring keys whose interpolation detours.

    Each inserted value is the representation of the halfway rotation closest to the
    halfway value, bridging both neighbours. Near gimbal lock the neighbours can sit on
    different Euler branches, where no linear blend fits well; inserted keys are
    therefore kept only if they actually reduce the error.
    """
    (t0, v0, q0), (t1, v1, q1) = start, end
    t_mid = 0.5 * (t0 + t1)
    q_mid = quat.slerp(q0, q1, 0.5)
    shown = encoding.rotation_from_channel(bone, 0.5 * (v0 + v1))
    error = float(quat.angle_between(shown, q_mid))
    if error <= tolerance or depth >= MAX_REFINE_DEPTH:
        return [], error
    v_mid = encoding.rotation_value_near(bone, q_mid, 0.5 * (v0 + v1))
    left, left_error = _refine(bone, start, (t_mid, v_mid, q_mid), tolerance, depth + 1)
    right, right_error = _refine(bone, (t_mid, v_mid, q_mid), end, tolerance, depth + 1)
    refined_error = max(left_error, right_error)
    if refined_error >= error:
        return [], error
    return [*left, (t_mid, v_mid), *right], refined_error
