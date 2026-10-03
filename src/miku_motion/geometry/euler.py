"""Euler angles for the ZYX composition order: ``R = Rz(z) · Ry(y) · Rx(x)``.

The rotation about X is applied first, then Y, then Z (all about fixed parent axes).
Angles are radians and returned as ``(..., 3)`` arrays ordered ``[x, y, z]``.
Sign conventions of particular file formats are *not* handled here; see
``geckolib.encoding``.
"""

import math

import numpy as np

from miku_motion.geometry import quat
from miku_motion.geometry.quat import ArrayLike, FloatArray

# Below this |cos(y)| (about 0.00006 deg from +-90) X and Z are treated as aligned
# (gimbal lock): float noise at an exact lock must not pick an arbitrary X/Z split.
_GIMBAL_EPS = 1e-6


def to_quat(euler: ArrayLike) -> FloatArray:
    """Quaternion for ZYX Euler angles ``[x, y, z]`` (radians): ``qz * qy * qx``."""
    e = np.asarray(euler, dtype=np.float64)
    half = 0.5 * e
    cx, cy, cz = np.cos(half[..., 0]), np.cos(half[..., 1]), np.cos(half[..., 2])
    sx, sy, sz = np.sin(half[..., 0]), np.sin(half[..., 1]), np.sin(half[..., 2])
    return np.stack(
        [
            cz * cy * sx - sz * sy * cx,
            cz * sy * cx + sz * cy * sx,
            sz * cy * cx - cz * sy * sx,
            cz * cy * cx + sz * sy * sx,
        ],
        axis=-1,
    )


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

    Equivalent to calling :func:`closest_to` sample by sample (the first one nearest
    ``start``, default zero), but the decompositions are computed in one vectorized pass
    and only the branch choice runs per sample.
    """
    arr = quat.as_quat(qs)
    if arr.ndim != 2:
        raise ValueError("continuous_from_quats expects an (N, 4) sequence")
    principal = from_quat(arr)
    locked = np.sqrt(np.maximum(0.0, 1.0 - np.sin(principal[:, 1]) ** 2)) < _GIMBAL_EPS
    rows = principal.tolist()
    flags = locked.tolist()
    two_pi = 2.0 * math.pi
    px, py, pz = (0.0, 0.0, 0.0) if start is None else (float(v) for v in np.asarray(start))
    out = []
    for i, (x, y, z) in enumerate(rows):
        if flags[i]:  # gimbal lock: the X/Z split depends on the previous angles
            x, y, z = from_quat(arr[i], reference_z=pz).tolist()
        best = None
        for cx, cy, cz in ((x, y, z), (x + math.pi, math.pi - y, z + math.pi)):
            cx += two_pi * round((px - cx) / two_pi)
            cy += two_pi * round((py - cy) / two_pi)
            cz += two_pi * round((pz - cz) / two_pi)
            distance = (cx - px) ** 2 + (cy - py) ** 2 + (cz - pz) ** 2
            if best is None or distance < best[0]:
                best = (distance, cx, cy, cz)
        assert best is not None
        _, px, py, pz = best
        out.append((px, py, pz))
    return np.array(out, dtype=np.float64).reshape(len(rows), 3)
