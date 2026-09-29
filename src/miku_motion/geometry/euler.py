"""Euler angles for the ZYX composition order: ``R = Rz(z) · Ry(y) · Rx(x)``.

The rotation about X is applied first, then Y, then Z (all about fixed parent axes).
Angles are radians and returned as ``(..., 3)`` arrays ordered ``[x, y, z]``.
Sign conventions of particular file formats are *not* handled here; see
``geckolib.encoding``.
"""

import numpy as np

from miku_motion.geometry import quat
from miku_motion.geometry.quat import ArrayLike, FloatArray

_X = np.array([1.0, 0.0, 0.0])
_Y = np.array([0.0, 1.0, 0.0])
_Z = np.array([0.0, 0.0, 1.0])

# Below this |cos(y)| the X and Z axes are treated as aligned (gimbal lock).
_GIMBAL_EPS = 1e-9


def to_quat(euler: ArrayLike) -> FloatArray:
    """Quaternion for ZYX Euler angles ``[x, y, z]`` (radians)."""
    e = np.asarray(euler, dtype=np.float64)
    qx = quat.from_axis_angle(_X, e[..., 0])
    qy = quat.from_axis_angle(_Y, e[..., 1])
    qz = quat.from_axis_angle(_Z, e[..., 2])
    return quat.mul_chain(qz, qy, qx)


def _matrix(q: FloatArray) -> FloatArray:
    x, y, z, w = np.moveaxis(quat.normalize(q), -1, 0)
    return np.stack(
        [
            np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
            np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
            np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
        ],
        axis=-2,
    )


def from_quat(q: ArrayLike, reference_z: ArrayLike | None = None) -> FloatArray:
    """Principal ZYX Euler angles with ``y`` in ``[-pi/2, pi/2]``.

    At gimbal lock only ``x - z`` (or ``x + z``) is determined; ``z`` is then set to
    ``reference_z`` (default 0) and ``x`` solved from it.
    """
    m = _matrix(quat.as_quat(q))
    sin_y = np.clip(-m[..., 2, 0], -1.0, 1.0)
    y = np.arcsin(sin_y)
    cos_y = np.sqrt(np.maximum(0.0, 1.0 - sin_y * sin_y))
    locked = cos_y < _GIMBAL_EPS

    x = np.arctan2(m[..., 2, 1], m[..., 2, 2])
    z = np.arctan2(m[..., 1, 0], m[..., 0, 0])

    if np.any(locked):
        z_ref = np.broadcast_to(
            np.asarray(0.0 if reference_z is None else reference_z, dtype=np.float64), y.shape
        )
        # Remove the chosen z, leaving Ry · Rx whose (1,2)/(1,1) entries give x.
        cz, sz = np.cos(z_ref), np.sin(z_ref)
        m11 = -sz * m[..., 0, 1] + cz * m[..., 1, 1]
        m12 = -sz * m[..., 0, 2] + cz * m[..., 1, 2]
        x = np.where(locked, np.arctan2(-m12, m11), x)
        z = np.where(locked, z_ref, z)

    return np.stack([x, y, z], axis=-1)


def _wrap_near(angle: FloatArray, reference: FloatArray) -> FloatArray:
    """Add multiples of 2*pi to ``angle`` so it is as close as possible to ``reference``."""
    result: FloatArray = angle + 2.0 * np.pi * np.round((reference - angle) / (2.0 * np.pi))
    return result


def closest_to(q: ArrayLike, previous: ArrayLike) -> FloatArray:
    """ZYX Euler angles for ``q`` chosen to be nearest ``previous`` (radians, ``(3,)``).

    Considers both ZYX solutions ``(x, y, z)`` and ``(x+pi, pi-y, z+pi)`` and all
    ``2*pi`` unwrappings, so a sequence of nearby rotations yields a continuous
    Euler curve (important because GeckoLib interpolates Euler components linearly).
    """
    prev = np.asarray(previous, dtype=np.float64)
    first = from_quat(q, reference_z=prev[2])
    second = first + np.array([np.pi, 0.0, np.pi])
    second[1] = np.pi - first[1]
    candidates = [_wrap_near(c, prev) for c in (first, second)]
    return min(candidates, key=lambda c: float(np.sum((c - prev) ** 2)))


def continuous_from_quats(qs: ArrayLike, start: ArrayLike | None = None) -> FloatArray:
    """Convert an ``(N, 4)`` rotation sequence to a continuous ``(N, 3)`` Euler curve.

    The first sample is taken nearest ``start`` (default: zero, i.e. the rest pose).
    """
    arr = quat.as_quat(qs)
    if arr.ndim != 2:
        raise ValueError("continuous_from_quats expects an (N, 4) sequence")
    out = np.empty((len(arr), 3))
    prev = np.zeros(3) if start is None else np.asarray(start, dtype=np.float64)
    for i, q in enumerate(arr):
        prev = closest_to(q, prev)
        out[i] = prev
    return out
