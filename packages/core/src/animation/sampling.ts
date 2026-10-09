/**
 * Evaluate keyed source tracks at arbitrary times.
 *
 * Between two keys, each translation axis follows its own easing curve and the rotation
 * follows its curve through a shortest-path slerp (MMD semantics). Before the first key
 * and after the last one the nearest key's value is held.
 */

import { getQuat, setQuat, slerp, type QuatArray, type Vec3Array } from "../geometry/quat";
import { evaluateCurve } from "./curves";
import { CURVE_ROTATION, type MorphTrack, type SourceBoneTrack } from "./source";

/** Sampled values: 3 numbers per translation, 4 (xyzw) per rotation. */
export interface PoseSamples {
  readonly translations: Vec3Array;
  readonly rotations: QuatArray;
}

/**
 * Sample times `k / fps` covering `[0, duration]`, always including both ends.
 *
 * Computed from integer indices so every run yields bit-identical times.
 */
export function sampleTimes(duration: number, fps: number): Float64Array {
  if (!(fps > 0)) throw new RangeError("fps must be positive");
  const count = Math.floor(duration * fps + 1e-9) + 1;
  const last = (count - 1) / fps;
  const extra = duration - last > 1e-9;
  const times = new Float64Array(count + (extra ? 1 : 0));
  for (let k = 0; k < count; k++) times[k] = k / fps;
  if (extra) times[count] = duration;
  return times;
}

/** Index of the last element of sorted `keys` that is `<= value`, or -1. */
function lastAtOrBefore(keys: Float64Array, value: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Evaluate `track` at (fractional) source `frames`. */
export function sampleTrack(track: SourceBoneTrack, frames: Float64Array): PoseSamples {
  const keys = track.frames;
  const last = keys.length - 1;
  const count = frames.length;
  const translations = new Float64Array(3 * count);
  const rotations = new Float64Array(4 * count);
  const { curves } = track;

  for (let n = 0; n < count; n++) {
    const f = frames[n]!;
    // Segment [i, j] containing the frame; clamped so j is always valid.
    const i = Math.min(Math.max(lastAtOrBefore(keys, f), 0), Math.max(last - 1, 0));
    const j = Math.min(i + 1, last);
    let u = 0;
    if (j > i) {
      u = Math.min(Math.max((f - keys[i]!) / (keys[j]! - keys[i]!), 0), 1);
    }
    const c = 16 * j; // the curves of the key the segment arrives at
    for (let axis = 0; axis < 3; axis++) {
      const o = c + 4 * axis;
      const progress = evaluateCurve(curves[o]!, curves[o + 1]!, curves[o + 2]!, curves[o + 3]!, u);
      const t0 = track.translations[3 * i + axis]!;
      const t1 = track.translations[3 * j + axis]!;
      translations[3 * n + axis] = t0 + (t1 - t0) * progress;
    }
    const o = c + 4 * CURVE_ROTATION;
    const progress = evaluateCurve(curves[o]!, curves[o + 1]!, curves[o + 2]!, curves[o + 3]!, u);
    setQuat(rotations, n, slerp(getQuat(track.rotations, i), getQuat(track.rotations, j), progress));
  }
  return { translations, rotations };
}

/** A morph's weight at (fractional) source `frames`: linear, held at the ends. */
export function sampleMorph(track: MorphTrack, frames: Float64Array): Float64Array {
  const { frames: keys, weights } = track;
  const last = keys.length - 1;
  const out = new Float64Array(frames.length);
  for (let n = 0; n < frames.length; n++) {
    const f = frames[n]!;
    if (f <= keys[0]!) {
      out[n] = weights[0]!;
    } else if (f >= keys[last]!) {
      out[n] = weights[last]!;
    } else {
      const i = lastAtOrBefore(keys, f);
      const span = keys[i + 1]! - keys[i]!;
      out[n] = weights[i]! + ((weights[i + 1]! - weights[i]!) * (f - keys[i]!)) / span;
    }
  }
  return out;
}
