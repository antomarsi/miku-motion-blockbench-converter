/**
 * Change of basis from a source coordinate space into the canonical space.
 *
 * Canonical space = Blockbench model space: right-handed, Y-up, the model faces -Z and
 * its left side is at -X. This module is the ONLY place source axes are converted.
 *
 * A basis change is an orthogonal matrix `M` (possibly a reflection, det = -1):
 *
 * - points/offsets: `p' = scale * M p`
 * - rotations: `R' = M R M^T`. For quaternions that is `v' = det(M) * M v` for the
 *   vector part (a rotation axis is a pseudovector) with the scalar part unchanged.
 */

import type { Quat, Vec3 } from "../geometry/quat";

export type Matrix3 = readonly [Vec3, Vec3, Vec3];

function apply(m: Matrix3, v: readonly number[]): Vec3 {
  return [
    m[0][0] * v[0]! + m[0][1] * v[1]! + m[0][2] * v[2]!,
    m[1][0] * v[0]! + m[1][1] * v[1]! + m[1][2] * v[2]!,
    m[2][0] * v[0]! + m[2][1] * v[1]! + m[2][2] * v[2]!,
  ];
}

export class BasisChange {
  readonly determinant: number;

  constructor(
    readonly name: string,
    /** Rows of an orthogonal 3x3 matrix. */
    readonly matrix: Matrix3,
  ) {
    const m = matrix;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = m[i]![0] * m[j]![0] + m[i]![1] * m[j]![1] + m[i]![2] * m[j]![2];
        if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-8) {
          throw new RangeError(`basis change '${name}' must be an orthogonal 3x3 matrix`);
        }
      }
    }
    this.determinant =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  point(p: Vec3, scale = 1): Vec3 {
    const v = apply(this.matrix, p);
    return [scale * v[0], scale * v[1], scale * v[2]];
  }

  rotation(q: Quat): Quat {
    const v = apply(this.matrix, q);
    const d = this.determinant;
    return [d * v[0], d * v[1], d * v[2], q[3]];
  }
}

// MikuMikuDance: left-handed, Y-up, the model faces -Z and its left side is at +X.
// Mirroring X both fixes handedness and puts the model's left at -X.
export const MMD_TO_CANONICAL = new BasisChange("mmd", [
  [-1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]);
