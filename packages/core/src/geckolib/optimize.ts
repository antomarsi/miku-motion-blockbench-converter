/**
 * Error-bounded keyframe reduction for GeckoLib channels.
 *
 * GeckoLib interpolates keyframe *values* linearly: Euler angles for rotation, offsets for
 * position. Starting from densely sampled true poses, this keeps only the keys needed
 * for that interpolation to stay within a tolerance of the truth:
 *
 * 1. Douglas-Peucker: keep the endpoints; while a segment's interpolation misses the truth
 *    by more than the tolerance anywhere, keep its worst sample and split there.
 * 2. Refinement: where two neighbouring samples still interpolate badly (Euler
 *    interpolation detours near gimbal lock), insert keys at half steps.
 *
 * Rotation error is the true 3D angle between GeckoLib's interpolated rotation and the
 * intended one, checked at every sample and halfway between samples (where the intended
 * rotation is the shortest-path blend of its neighbours).
 */

import { DEGREES, RADIANS, type Bone } from "../animation/skeleton";
import {
  angleBetween,
  getQuat,
  getVec3,
  makeContinuous,
  slerp,
  type Quat,
  type QuatArray,
  type Vec3,
  type Vec3Array,
} from "../geometry/quat";
import { rotationChannel, rotationFromChannel, rotationValueNear } from "./encoding";

export const MAX_REFINE_DEPTH = 3; // up to 8 keys between two samples
export const DEFAULT_ROTATION_TOLERANCE = 1; // degrees; invisible on blocky models
export const DEFAULT_POSITION_TOLERANCE = 0.05; // pixels
export const DEFAULT_SCALE_TOLERANCE = 0.01; // fraction of the bone's size

export interface Tolerance {
  readonly rotationDegrees: number;
  /** Pixels. */
  readonly position: number;
  /** Fraction of the bone's size. */
  readonly scale: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  rotationDegrees: DEFAULT_ROTATION_TOLERANCE,
  position: DEFAULT_POSITION_TOLERANCE,
  scale: DEFAULT_SCALE_TOLERANCE,
};

export interface ReducedChannel {
  /** Seconds. */
  readonly times: Float64Array;
  /** 3 keyframe values per time, in file units. */
  readonly values: Vec3Array;
  /** Degrees for rotation, pixels for position. */
  readonly maxError: number;
}

/** Worst error of the segment between keys `i` and `j`, and the sample to split at. */
type SegmentError = (i: number, j: number) => readonly [error: number, worst: number];

function douglasPeucker(count: number, segmentError: SegmentError, tolerance: number): number[] {
  const keep = new Set([0, count - 1]);
  const stack: [number, number][] = [[0, count - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j - i < 2) continue;
    const [error, worst] = segmentError(i, j);
    if (error > tolerance) {
      keep.add(worst);
      stack.push([i, worst], [worst, j]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

function lerp3(values: Vec3Array, i: number, j: number, alpha: number): Vec3 {
  const a = 3 * i;
  const b = 3 * j;
  return [
    values[a]! + alpha * (values[b]! - values[a]!),
    values[a + 1]! + alpha * (values[b + 1]! - values[a + 1]!),
    values[a + 2]! + alpha * (values[b + 2]! - values[a + 2]!),
  ];
}

function pick(times: Float64Array, values: Vec3Array, keep: readonly number[]): [Float64Array, Vec3Array] {
  const outTimes = new Float64Array(keep.length);
  const outValues = new Float64Array(3 * keep.length);
  keep.forEach((k, n) => {
    outTimes[n] = times[k]!;
    outValues.set(values.subarray(3 * k, 3 * k + 3), 3 * n);
  });
  return [outTimes, outValues];
}

export function reducePosition(times: Float64Array, values: Vec3Array, tolerance: number): ReducedChannel {
  const segmentError: SegmentError = (i, j) => {
    let worst = i + 1;
    let worstError = -1;
    const span = times[j]! - times[i]!;
    for (let k = i + 1; k < j; k++) {
      const shown = lerp3(values, i, j, (times[k]! - times[i]!) / span);
      const error = Math.hypot(
        shown[0] - values[3 * k]!,
        shown[1] - values[3 * k + 1]!,
        shown[2] - values[3 * k + 2]!,
      );
      if (error > worstError) {
        worstError = error;
        worst = k;
      }
    }
    return [worstError, worst];
  };

  const keep = douglasPeucker(times.length, segmentError, tolerance);
  let maxError = 0;
  for (let n = 1; n < keep.length; n++) {
    if (keep[n]! - keep[n - 1]! > 1) maxError = Math.max(maxError, segmentError(keep[n - 1]!, keep[n]!)[0]);
  }
  const [outTimes, outValues] = pick(times, values, keep);
  return { times: outTimes, values: outValues, maxError };
}

/** Rotation angle between unit quaternions (a cheap form for the hot loop). */
function angleBetweenUnits(a: Quat, b: Quat): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(dot, 1));
}

/** A key while refining: its time, file value and true rotation. */
interface Key {
  readonly time: number;
  readonly value: Vec3;
  readonly rotation: Quat;
}

const midValue = (a: Vec3, b: Vec3): Vec3 => [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2])];

/**
 * Keys to insert between two neighbouring keys whose interpolation detours.
 *
 * Each inserted value is the representation of the halfway rotation closest to the
 * halfway value, bridging both neighbours. Near gimbal lock the neighbours can sit on
 * different Euler branches, where no linear blend fits well; inserted keys are
 * therefore kept only if they actually reduce the error.
 */
function refine(bone: Bone, start: Key, end: Key, tolerance: number, depth = 0): { inserted: Key[]; error: number } {
  const time = 0.5 * (start.time + end.time);
  const rotation = slerp(start.rotation, end.rotation, 0.5);
  const halfway = midValue(start.value, end.value);
  const error = angleBetween(rotationFromChannel(bone, halfway), rotation);
  if (error <= tolerance || depth >= MAX_REFINE_DEPTH) return { inserted: [], error };
  const middle: Key = { time, value: rotationValueNear(bone, rotation, halfway), rotation };
  const left = refine(bone, start, middle, tolerance, depth + 1);
  const right = refine(bone, middle, end, tolerance, depth + 1);
  const refined = Math.max(left.error, right.error);
  if (refined >= error) return { inserted: [], error };
  return { inserted: [...left.inserted, middle, ...right.inserted], error: refined };
}

/** Reduce a rotation channel; `rotations` are the true full local rotations. */
export function reduceRotation(
  bone: Bone,
  times: Float64Array,
  rotations: QuatArray,
  toleranceDegrees: number,
): ReducedChannel {
  const tolerance = toleranceDegrees * RADIANS;
  const count = times.length;
  const values = rotationChannel(bone, rotations);
  const truth = makeContinuous(rotations);
  const midpoints: Quat[] = [];
  const midTimes = new Float64Array(Math.max(count - 1, 0));
  for (let k = 0; k + 1 < count; k++) {
    midpoints.push(slerp(getQuat(truth, k), getQuat(truth, k + 1), 0.5));
    midTimes[k] = 0.5 * (times[k]! + times[k + 1]!);
  }

  const shownError = (i: number, j: number, time: number, intended: Quat): number => {
    const alpha = (time - times[i]!) / (times[j]! - times[i]!);
    return angleBetweenUnits(rotationFromChannel(bone, lerp3(values, i, j, alpha)), intended);
  };

  /** Errors at samples i+1..j-1 and at midpoints i..j-1 for keys i and j. */
  const segmentError: SegmentError = (i, j) => {
    let worstSample = 0;
    let sampleError = -1;
    for (let k = i + 1; k < j; k++) {
      const error = shownError(i, j, times[k]!, getQuat(truth, k));
      if (error > sampleError) {
        sampleError = error;
        worstSample = k - (i + 1);
      }
    }
    let worstMid = 0;
    let midError = -1;
    for (let m = i; m < j; m++) {
      const error = shownError(i, j, midTimes[m]!, midpoints[m]!);
      if (error > midError) {
        midError = error;
        worstMid = m - i;
      }
    }
    if (midError > sampleError) {
      // Split at the sample next to the worst midpoint (never an endpoint).
      return [midError, Math.min(Math.max(i + worstMid + 1, i + 1), j - 1)];
    }
    return [sampleError, i + 1 + worstSample];
  };

  const keep = douglasPeucker(count, segmentError, tolerance);
  const key = (k: number): Key => ({ time: times[k]!, value: getVec3(values, k), rotation: getQuat(truth, k) });

  const outTimes: number[] = [times[keep[0]!]!];
  const outValues: Vec3[] = [getVec3(values, keep[0]!)];
  let maxError = 0;
  for (let n = 1; n < keep.length; n++) {
    const a = keep[n - 1]!;
    const b = keep[n]!;
    if (b - a > 1) {
      maxError = Math.max(maxError, segmentError(a, b)[0]);
    } else {
      const { inserted, error } = refine(bone, key(a), key(b), tolerance);
      for (const extra of inserted) {
        outTimes.push(extra.time);
        outValues.push(extra.value);
      }
      maxError = Math.max(maxError, error);
    }
    outTimes.push(times[b]!);
    outValues.push(getVec3(values, b));
  }
  const flat = new Float64Array(3 * outValues.length);
  outValues.forEach((value, n) => flat.set(value, 3 * n));
  return { times: Float64Array.from(outTimes), values: flat, maxError: maxError * DEGREES };
}
