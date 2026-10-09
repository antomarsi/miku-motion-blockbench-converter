/**
 * Quaternion operations.
 *
 * Convention: quaternions are `[x, y, z, w]` (scalar last), matching the VMD file
 * layout. Rotations are active (they rotate vectors) and compose like matrices:
 * `mul(a, b)` applies `b` first, then `a`.
 *
 * Single values are plain tuples. Sequences are flat `Float64Array`s: 4 numbers per
 * quaternion (`QuatArray`) or 3 per vector (`Vec3Array`), read and written with the
 * `get*` / `set*` helpers.
 */

export type Quat = readonly [number, number, number, number];
export type Vec3 = readonly [number, number, number];
/** Flat `[x, y, z, w, x, y, z, w, ...]`. */
export type QuatArray = Float64Array;
/** Flat `[x, y, z, x, y, z, ...]`. */
export type Vec3Array = Float64Array;

const EPS = 1e-12;

export const IDENTITY: Quat = [0, 0, 0, 1];

export function identity(): Quat {
  return IDENTITY;
}

/** `n` identity rotations. */
export function identityArray(n: number): QuatArray {
  const out = new Float64Array(4 * n);
  for (let i = 0; i < n; i++) out[4 * i + 3] = 1;
  return out;
}

export function getQuat(array: QuatArray, index: number): Quat {
  const o = 4 * index;
  return [array[o]!, array[o + 1]!, array[o + 2]!, array[o + 3]!];
}

export function setQuat(array: QuatArray, index: number, q: Quat): void {
  const o = 4 * index;
  array[o] = q[0];
  array[o + 1] = q[1];
  array[o + 2] = q[2];
  array[o + 3] = q[3];
}

export function getVec3(array: Vec3Array, index: number): Vec3 {
  const o = 3 * index;
  return [array[o]!, array[o + 1]!, array[o + 2]!];
}

export function setVec3(array: Vec3Array, index: number, v: Vec3): void {
  const o = 3 * index;
  array[o] = v[0];
  array[o + 1] = v[1];
  array[o + 2] = v[2];
}

export function quatArray(quats: readonly Quat[]): QuatArray {
  const out = new Float64Array(4 * quats.length);
  quats.forEach((q, i) => setQuat(out, i, q));
  return out;
}

export function vec3Array(vectors: readonly Vec3[]): Vec3Array {
  const out = new Float64Array(3 * vectors.length);
  vectors.forEach((v, i) => setVec3(out, i, v));
  return out;
}

export function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(q: Quat): Quat {
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  if (norm < EPS) throw new RangeError("cannot normalize a zero-length quaternion");
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

export function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Inverse of a unit quaternion (its conjugate). */
export function inverse(q: Quat): Quat {
  return conjugate(q);
}

export function negate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], -q[3]];
}

export function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** Hamilton product `a * b`: the rotation `b` followed by `a`. */
export function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** `qs[0] * qs[1] * ... * qs[n-1]` (the last one is applied first). */
export function mulChain(...qs: readonly Quat[]): Quat {
  let result = qs[0] ?? IDENTITY;
  for (let i = 1; i < qs.length; i++) result = mul(result, qs[i]!);
  return result;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Rotate vector `v` by unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const w = q[3];
  const c = cross(u, v);
  const t: Vec3 = [2 * c[0], 2 * c[1], 2 * c[2]];
  const ut = cross(u, t);
  return [v[0] + w * t[0] + ut[0], v[1] + w * t[1] + ut[1], v[2] + w * t[2] + ut[2]];
}

/** Rotation of `angle` radians about `axis` (normalized internally). */
export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const norm = norm3(axis);
  if (norm < EPS) throw new RangeError("rotation axis must be non-zero");
  const half = 0.5 * angle;
  const s = Math.sin(half) / norm;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** Rotation angle in radians, in `[0, pi]`. */
export function angle(q: Quat): number {
  const n = normalize(q);
  return 2 * Math.atan2(Math.hypot(n[0], n[1], n[2]), Math.abs(n[3]));
}

/** Geodesic angle in radians between rotations `a` and `b`, in `[0, pi]`. */
export function angleBetween(a: Quat, b: Quat): number {
  return angle(mul(inverse(a), b));
}

/** Shortest-path spherical interpolation from `a` (t=0) to `b` (t=1). */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  const qa = normalize(a);
  let qb = normalize(b);
  let d = dot(qa, qb);
  if (d < 0) {
    qb = negate(qb);
    d = -d;
  }
  const theta = Math.acos(Math.min(Math.max(d, -1), 1));
  const sinTheta = Math.sin(theta);
  let wa: number;
  let wb: number;
  if (sinTheta < 1e-9) {
    wa = 1 - t;
    wb = t;
  } else {
    wa = Math.sin((1 - t) * theta) / sinTheta;
    wb = Math.sin(t * theta) / sinTheta;
  }
  return normalize([
    wa * qa[0] + wb * qb[0],
    wa * qa[1] + wb * qb[1],
    wa * qa[2] + wb * qb[2],
    wa * qa[3] + wb * qb[3],
  ]);
}

/** Scale a rotation's angle by `weight` about the same axis (`weight = -1` inverts). */
export function power(q: Quat, weight: number): Quat {
  return weight >= 0 ? slerp(IDENTITY, q, weight) : inverse(slerp(IDENTITY, q, -weight));
}

/**
 * Flip signs along a sequence so consecutive quaternions lie in the same hemisphere.
 *
 * `q` and `-q` are the same rotation; keeping neighbours close avoids long-way
 * interpolation and Euler jumps downstream.
 */
export function makeContinuous(qs: QuatArray): QuatArray {
  const out = Float64Array.from(qs);
  for (let i = 4; i < out.length; i += 4) {
    const d =
      out[i - 4]! * out[i]! +
      out[i - 3]! * out[i + 1]! +
      out[i - 2]! * out[i + 2]! +
      out[i - 1]! * out[i + 3]!;
    if (d < 0) {
      out[i] = -out[i]!;
      out[i + 1] = -out[i + 1]!;
      out[i + 2] = -out[i + 2]!;
      out[i + 3] = -out[i + 3]!;
    }
  }
  return out;
}

/** True when `a` and `b` represent the same rotation (sign-insensitive). */
export function sameRotation(a: Quat, b: Quat, atol = 1e-9): boolean {
  return Math.abs(dot(normalize(a), normalize(b))) >= 1 - atol;
}
