/**
 * The 64-byte VMD bone interpolation block.
 *
 * Each key stores four cubic-Bezier curves (X, Y, Z translation and rotation) describing
 * the segment *arriving* at that key. A curve is `(x1, y1, x2, y2)` in `0..127`; its
 * endpoints are fixed at `(0, 0)` and `(127, 127)`.
 *
 * Row 0 (bytes 0-15) holds the parameters interleaved by channel:
 *
 *     [Xx1 Yx1 Zx1 Rx1  Xy1 Yy1 Zy1 Ry1  Xx2 Yx2 Zx2 Rx2  Xy2 Yy2 Zy2 Ry2]
 *
 * Rows 1-3 repeat row 0 shifted left by 1, 2 and 3 bytes. MMD reuses bytes 2 and 3 of
 * row 0 as flags (physics on/off), so `Zx1` and `Rx1` are read from row 1 (bytes 17
 * and 18) instead. Verified against real files: every other byte matches the shift rule.
 */

import { INTERPOLATION_BYTES } from "./types";

/** `(x1, y1, x2, y2)`, each `0..127`. */
export type ByteCurve = readonly [number, number, number, number];

export const LINEAR: ByteCurve = [20, 20, 107, 107];
const ROW = 16;

export interface BoneCurves {
  readonly x: ByteCurve;
  readonly y: ByteCurve;
  readonly z: ByteCurve;
  readonly rotation: ByteCurve;
}

export const LINEAR_CURVES: BoneCurves = { x: LINEAR, y: LINEAR, z: LINEAR, rotation: LINEAR };

export function decode(data: Uint8Array): BoneCurves {
  if (data.length !== INTERPOLATION_BYTES) {
    throw new RangeError(`interpolation block must be ${INTERPOLATION_BYTES} bytes`);
  }
  const row = data.slice(0, ROW);
  row[2] = data[ROW + 1]!;
  row[3] = data[ROW + 2]!;
  const channel = (c: number): ByteCurve => [row[c]!, row[4 + c]!, row[8 + c]!, row[12 + c]!];
  return { x: channel(0), y: channel(1), z: channel(2), rotation: channel(3) };
}

/** Build a 64-byte block the way MMD writes it (row 0 bytes 2-3 hold flags). */
export function encode(
  curves: BoneCurves = LINEAR_CURVES,
  physicsFlags: readonly [number, number] = [0, 0],
): Uint8Array {
  const channels = [curves.x, curves.y, curves.z, curves.rotation];
  for (const curve of channels) {
    if (!curve.every((v) => Number.isInteger(v) && v >= 0 && v <= 127)) {
      throw new RangeError(`interpolation values must be within 0..127, got (${curve.join(", ")})`);
    }
  }
  const row = new Uint8Array(ROW);
  for (let p = 0; p < 4; p++) for (let c = 0; c < 4; c++) row[4 * p + c] = channels[c]![p]!;
  const out = new Uint8Array(INTERPOLATION_BYTES);
  for (let shift = 0; shift < 4; shift++) out.set(row.subarray(shift), ROW * shift);
  out[2] = physicsFlags[0];
  out[3] = physicsFlags[1];
  return out;
}
