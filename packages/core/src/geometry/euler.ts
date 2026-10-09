/**
 * Euler angles for the ZYX composition order: `R = Rz(z) · Ry(y) · Rx(x)`.
 *
 * The rotation about X is applied first, then Y, then Z (all about fixed parent axes).
 * Angles are radians, ordered `[x, y, z]`. Sign conventions of particular file formats
 * are *not* handled here; see `geckolib/encoding`.
 */

import { getQuat, normalize, type Quat, type QuatArray, type Vec3, type Vec3Array } from "./quat";

// Below this |cos(y)| (about 0.00006 deg from +-90) X and Z are treated as aligned
// (gimbal lock): float noise at an exact lock must not pick an arbitrary X/Z split.
const GIMBAL_EPS = 1e-6;
const TWO_PI = 2 * Math.PI;

/** Quaternion for ZYX Euler angles `[x, y, z]` (radians): `qz * qy * qx`. */
export function toQuat(euler: Vec3): Quat {
  const cx = Math.cos(0.5 * euler[0]);
  const cy = Math.cos(0.5 * euler[1]);
  const cz = Math.cos(0.5 * euler[2]);
  const sx = Math.sin(0.5 * euler[0]);
  const sy = Math.sin(0.5 * euler[1]);
  const sz = Math.sin(0.5 * euler[2]);
  return [
    cz * cy * sx - sz * sy * cx,
    cz * sy * cx + sz * cy * sx,
    sz * cy * cx - cz * sy * sx,
    cz * cy * cx + sz * sy * sx,
  ];
}

interface Decomposition {
  readonly angles: Vec3;
  readonly locked: boolean;
}

function decompose(q: Quat, referenceZ: number): Decomposition {
  const [x, y, z, w] = normalize(q);
  // Rotation matrix entries (row, column).
  const m00 = 1 - 2 * (y * y + z * z);
  const m01 = 2 * (x * y - z * w);
  const m02 = 2 * (x * z + y * w);
  const m10 = 2 * (x * y + z * w);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z - x * w);
  const m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + y * y);

  const sinY = Math.min(Math.max(-m20, -1), 1);
  const ey = Math.asin(sinY);
  const cosY = Math.sqrt(Math.max(0, 1 - sinY * sinY));
  if (cosY < GIMBAL_EPS) {
    // Remove the chosen z, leaving Ry · Rx whose (1,2)/(1,1) entries give x.
    const cz = Math.cos(referenceZ);
    const sz = Math.sin(referenceZ);
    const r11 = -sz * m01 + cz * m11;
    const r12 = -sz * m02 + cz * m12;
    return { angles: [Math.atan2(-r12, r11), ey, referenceZ], locked: true };
  }
  return { angles: [Math.atan2(m21, m22), ey, Math.atan2(m10, m00)], locked: false };
}

/**
 * Principal ZYX Euler angles with `y` in `[-pi/2, pi/2]`.
 *
 * At gimbal lock only `x - z` (or `x + z`) is determined; `z` is then set to
 * `referenceZ` and `x` solved from it.
 */
export function fromQuat(q: Quat, referenceZ = 0): Vec3 {
  return decompose(q, referenceZ).angles;
}

/** Python's `round`: halves go to the even neighbour. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function wrapNear(angle: number, reference: number): number {
  return angle + TWO_PI * roundHalfEven((reference - angle) / TWO_PI);
}

function nearest(principal: Vec3, previous: Vec3): Vec3 {
  const [x, y, z] = principal;
  const [px, py, pz] = previous;
  let best: Vec3 = previous;
  let bestDistance = Infinity;
  const candidates: Vec3[] = [
    [x, y, z],
    [x + Math.PI, Math.PI - y, z + Math.PI],
  ];
  for (const candidate of candidates) {
    const cx = wrapNear(candidate[0], px);
    const cy = wrapNear(candidate[1], py);
    const cz = wrapNear(candidate[2], pz);
    const distance = (cx - px) ** 2 + (cy - py) ** 2 + (cz - pz) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [cx, cy, cz];
    }
  }
  return best;
}

/**
 * ZYX Euler angles for `q` chosen to be nearest `previous` (radians).
 *
 * Considers both ZYX solutions `(x, y, z)` and `(x+pi, pi-y, z+pi)` and all `2*pi`
 * unwrappings, so a sequence of nearby rotations yields a continuous Euler curve
 * (important because GeckoLib interpolates Euler components linearly).
 */
export function closestTo(q: Quat, previous: Vec3): Vec3 {
  return nearest(fromQuat(q, previous[2]), previous);
}

/**
 * Convert a rotation sequence to a continuous Euler curve (3 numbers per sample).
 *
 * Each sample is the solution nearest the previous one; the first is nearest `start`.
 */
export function continuousFromQuats(qs: QuatArray, start: Vec3 = [0, 0, 0]): Vec3Array {
  const count = qs.length / 4;
  const out = new Float64Array(3 * count);
  let previous: Vec3 = start;
  for (let i = 0; i < count; i++) {
    const q = getQuat(qs, i);
    let { angles, locked } = decompose(q, 0);
    if (locked) {
      // Gimbal lock: the X/Z split depends on the previous angles.
      ({ angles, locked } = decompose(q, previous[2]));
    }
    previous = nearest(angles, previous);
    out[3 * i] = previous[0];
    out[3 * i + 1] = previous[1];
    out[3 * i + 2] = previous[2];
  }
  return out;
}
