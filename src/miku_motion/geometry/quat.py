"""Quaternion operations, vectorized over leading axes.

Convention: quaternions are float64 arrays shaped ``(..., 4)`` in **xyzw** order
(scalar last), matching the VMD file layout. All functions accept a single
quaternion ``(4,)`` or a batch ``(N, 4)``; broadcasting follows NumPy rules.
Rotations are active (they rotate vectors) and compose like matrices:
``mul(a, b)`` applies ``b`` first, then ``a``.
"""

from typing import Any

import numpy as np
import numpy.typing as npt

type FloatArray = npt.NDArray[np.float64]
type ArrayLike = npt.ArrayLike

_EPS = 1e-12


def as_quat(q: ArrayLike) -> FloatArray:
    arr = np.asarray(q, dtype=np.float64)
    if arr.shape[-1:] != (4,):
        raise ValueError(f"quaternion arrays must have a trailing axis of 4, got {arr.shape}")
    return arr


def identity(n: int | None = None) -> FloatArray:
    """The identity rotation, or ``n`` of them."""
    q = np.array([0.0, 0.0, 0.0, 1.0])
    if n is None:
        return q
    batch: FloatArray = np.tile(q, (n, 1))
    return batch


def normalize(q: ArrayLike) -> FloatArray:
    arr = as_quat(q)
    norm = np.linalg.norm(arr, axis=-1, keepdims=True)
    if np.any(norm < _EPS):
        raise ValueError("cannot normalize a zero-length quaternion")
    result: FloatArray = arr / norm
    return result


def conjugate(q: ArrayLike) -> FloatArray:
    result: FloatArray = as_quat(q) * np.array([-1.0, -1.0, -1.0, 1.0])
    return result


def inverse(q: ArrayLike) -> FloatArray:
    """Inverse of a unit quaternion (its conjugate)."""
    return conjugate(q)


def mul(a: ArrayLike, b: ArrayLike) -> FloatArray:
    """Hamilton product ``a * b``: the rotation ``b`` followed by ``a``."""
    qa, qb = as_quat(a), as_quat(b)
    ax, ay, az, aw = np.moveaxis(qa, -1, 0)
    bx, by, bz, bw = np.moveaxis(qb, -1, 0)
    return np.stack(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        axis=-1,
    )


def mul_chain(*qs: ArrayLike) -> FloatArray:
    """``qs[0] * qs[1] * ... * qs[-1]`` (the last one is applied first)."""
    if not qs:
        return identity()
    result = as_quat(qs[0])
    for q in qs[1:]:
        result = mul(result, q)
    return result


def rotate(q: ArrayLike, v: ArrayLike) -> FloatArray:
    """Rotate vectors ``v`` shaped ``(..., 3)`` by unit quaternions ``q``."""
    qa = as_quat(q)
    vec = np.asarray(v, dtype=np.float64)
    u = qa[..., :3]
    w = qa[..., 3:4]
    t = 2.0 * np.cross(u, vec)
    result: FloatArray = vec + w * t + np.cross(u, t)
    return result


def from_axis_angle(axis: ArrayLike, angle: ArrayLike) -> FloatArray:
    """Rotation of ``angle`` radians about ``axis`` (normalized internally)."""
    ax = np.asarray(axis, dtype=np.float64)
    norm = np.linalg.norm(ax, axis=-1, keepdims=True)
    if np.any(norm < _EPS):
        raise ValueError("rotation axis must be non-zero")
    half = 0.5 * np.asarray(angle, dtype=np.float64)[..., np.newaxis]
    return np.concatenate([ax / norm * np.sin(half), np.cos(half)], axis=-1)


def angle(q: ArrayLike) -> FloatArray:
    """Rotation angle in radians, in ``[0, pi]``."""
    arr = normalize(q)
    vec_norm = np.linalg.norm(arr[..., :3], axis=-1)
    result: FloatArray = 2.0 * np.arctan2(vec_norm, np.abs(arr[..., 3]))
    return result


def angle_between(a: ArrayLike, b: ArrayLike) -> FloatArray:
    """Geodesic angle in radians between rotations ``a`` and ``b``, in ``[0, pi]``."""
    return angle(mul(inverse(a), b))


def slerp(a: ArrayLike, b: ArrayLike, t: ArrayLike) -> FloatArray:
    """Shortest-path spherical interpolation from ``a`` (t=0) to ``b`` (t=1)."""
    qa, qb = normalize(a), normalize(b)
    tt = np.asarray(t, dtype=np.float64)[..., np.newaxis]
    dot = np.sum(qa * qb, axis=-1, keepdims=True)
    qb = np.where(dot < 0.0, -qb, qb)
    dot = np.abs(dot)
    theta = np.arccos(np.clip(dot, -1.0, 1.0))
    sin_theta = np.sin(theta)
    nearly_parallel = sin_theta < 1e-9
    safe_sin = np.where(nearly_parallel, 1.0, sin_theta)
    wa = np.where(nearly_parallel, 1.0 - tt, np.sin((1.0 - tt) * theta) / safe_sin)
    wb = np.where(nearly_parallel, tt, np.sin(tt * theta) / safe_sin)
    return normalize(wa * qa + wb * qb)


def power(q: ArrayLike, weight: float) -> FloatArray:
    """Scale a rotation's angle by ``weight`` about the same axis (``weight=-1`` inverts)."""
    return slerp(identity(), q, weight) if weight >= 0 else inverse(slerp(identity(), q, -weight))


def make_continuous(qs: ArrayLike) -> FloatArray:
    """Flip signs along axis 0 so consecutive quaternions lie in the same hemisphere.

    ``q`` and ``-q`` are the same rotation; keeping neighbours close avoids long-way
    interpolation and Euler jumps downstream.
    """
    arr = as_quat(qs).copy()
    if arr.ndim != 2:
        raise ValueError("make_continuous expects an (N, 4) sequence")
    for i in range(1, len(arr)):
        if np.dot(arr[i - 1], arr[i]) < 0.0:
            arr[i] = -arr[i]
    return arr


def allclose_rotation(a: ArrayLike, b: ArrayLike, atol: float = 1e-9) -> bool:
    """True when ``a`` and ``b`` represent the same rotation(s) (sign-insensitive)."""
    qa, qb = normalize(a), normalize(b)
    dots: Any = np.abs(np.sum(qa * qb, axis=-1))
    return bool(np.all(dots >= 1.0 - atol))
