"""Easing curves: cubic Bezier from (0, 0) to (1, 1), as used by MMD and CSS.

A curve is ``(x1, y1, x2, y2)``: its two inner control points, each coordinate in
``[0, 1]``. Evaluating at ``x`` (normalized time) returns ``y`` (normalized progress).
All functions are vectorized: curves shaped ``(..., 4)`` broadcast against ``x``.
"""

import numpy as np

from miku_motion.geometry.quat import ArrayLike, FloatArray

LINEAR = np.array([0.25, 0.25, 0.75, 0.75])

_ITERATIONS = 48  # bisection steps: 2**-48 is far below float32 input precision


def _bezier(p1: FloatArray, p2: FloatArray, s: FloatArray) -> FloatArray:
    """One coordinate of the curve at parameter ``s``."""
    inv = 1.0 - s
    result: FloatArray = 3.0 * inv * inv * s * p1 + 3.0 * inv * s * s * p2 + s * s * s
    return result


def evaluate(curve: ArrayLike, x: ArrayLike) -> FloatArray:
    """Progress ``y`` of ``curve`` at normalized time ``x`` (clamped to ``[0, 1]``)."""
    c = np.asarray(curve, dtype=np.float64)
    target = np.clip(np.asarray(x, dtype=np.float64), 0.0, 1.0)
    x1, y1, x2, y2 = (c[..., i] for i in range(4))
    x1, x2 = np.clip(x1, 0.0, 1.0), np.clip(x2, 0.0, 1.0)  # keeps x(s) monotonic

    lo = np.zeros(np.broadcast(x1, target).shape)
    hi = np.ones_like(lo)
    for _ in range(_ITERATIONS):
        mid = 0.5 * (lo + hi)
        below = _bezier(x1, x2, mid) < target
        lo = np.where(below, mid, lo)
        hi = np.where(below, hi, mid)
    y = _bezier(y1, y2, 0.5 * (lo + hi))
    # Exact endpoints, so keyed values are reproduced bit-for-bit.
    result: FloatArray = np.where(target <= 0.0, 0.0, np.where(target >= 1.0, 1.0, y))
    return result


def is_linear(curve: ArrayLike, atol: float = 1e-9) -> bool:
    """True when the curve is the identity easing (control points on the diagonal)."""
    c = np.asarray(curve, dtype=np.float64)
    return bool(np.allclose(c[..., 0], c[..., 1], atol=atol)) and bool(
        np.allclose(c[..., 2], c[..., 3], atol=atol)
    )
