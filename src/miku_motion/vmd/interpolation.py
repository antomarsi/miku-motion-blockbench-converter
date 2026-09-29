"""The 64-byte VMD bone interpolation block.

Each key stores four cubic-Bezier curves (X, Y, Z translation and rotation) describing
the segment *arriving* at that key. A curve is ``(x1, y1, x2, y2)`` in ``0..127``; its
endpoints are fixed at ``(0, 0)`` and ``(127, 127)``.

Row 0 (bytes 0-15) holds the parameters interleaved by channel::

    [Xx1 Yx1 Zx1 Rx1  Xy1 Yy1 Zy1 Ry1  Xx2 Yx2 Zx2 Rx2  Xy2 Yy2 Zy2 Ry2]

Rows 1-3 repeat row 0 shifted left by 1, 2 and 3 bytes. MMD reuses bytes 2 and 3 of
row 0 as flags (physics on/off), so ``Zx1`` and ``Rx1`` are read from row 1 (bytes 17
and 18) instead. Verified against real files: every other byte matches the shift rule.
"""

from dataclasses import dataclass

from miku_motion.vmd.types import INTERPOLATION_BYTES

type Curve = tuple[int, int, int, int]

LINEAR: Curve = (20, 20, 107, 107)
_ROW = 16


@dataclass(frozen=True, slots=True)
class BoneCurves:
    x: Curve
    y: Curve
    z: Curve
    rotation: Curve


LINEAR_CURVES = BoneCurves(LINEAR, LINEAR, LINEAR, LINEAR)


def decode(data: bytes) -> BoneCurves:
    if len(data) != INTERPOLATION_BYTES:
        raise ValueError(f"interpolation block must be {INTERPOLATION_BYTES} bytes")
    row = bytearray(data[:_ROW])
    row[2], row[3] = data[_ROW + 1], data[_ROW + 2]
    channels = [(row[c], row[4 + c], row[8 + c], row[12 + c]) for c in range(4)]
    return BoneCurves(*channels)


def encode(curves: BoneCurves = LINEAR_CURVES, *, physics_flags: bytes = b"\0\0") -> bytes:
    """Build a 64-byte block the way MMD writes it (row 0 bytes 2-3 hold flags)."""
    channels = (curves.x, curves.y, curves.z, curves.rotation)
    for curve in channels:
        if not all(0 <= v <= 127 for v in curve):
            raise ValueError(f"interpolation values must be within 0..127, got {curve}")
    row = bytes(channels[c][p] for p in range(4) for c in range(4))
    rows = [row[shift:] + bytes(shift) for shift in range(4)]
    rows[0] = row[:2] + physics_flags + row[4:]
    return b"".join(rows)
