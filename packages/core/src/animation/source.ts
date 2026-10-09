/**
 * Format-independent keyed source motion (what a motion file says, before retargeting).
 *
 * Values are in the *source* coordinate space; no axis conversion has happened yet.
 * Each track stores its keys as flat arrays.
 */

import { angle, getQuat, type QuatArray, type Vec3Array } from "../geometry/quat";

/** Channel order of a key's four curves in `SourceBoneTrack.curves`. */
export const CURVE_X = 0;
export const CURVE_Y = 1;
export const CURVE_Z = 2;
export const CURVE_ROTATION = 3;

export const ROTATION_EPS = 1e-4; // radians: below this a rotation counts as "none"
export const TRANSLATION_EPS = 1e-4; // source units

/**
 * Keys of one bone, sorted by frame with unique frames (`K` keys).
 *
 * - `frames`: `K` frame numbers
 * - `translations`: `3K` offsets from the bone's rest position
 * - `rotations`: `4K` xyzw rotations relative to the rest pose
 * - `curves`: `16K` easing curves; key `k`, channel `c` (x, y, z, rotation) is the
 *   normalized `(x1, y1, x2, y2)` at `16k + 4c`, for the segment *arriving* at the key
 */
export interface SourceBoneTrack {
  readonly name: string;
  readonly frames: Float64Array;
  readonly translations: Vec3Array;
  readonly rotations: QuatArray;
  readonly curves: Float64Array;
}

export function makeTrack(track: SourceBoneTrack): SourceBoneTrack {
  const k = track.frames.length;
  if (k === 0) throw new RangeError(`track '${track.name}' has no keys`);
  const expected: [string, Float64Array, number][] = [
    ["translations", track.translations, 3 * k],
    ["rotations", track.rotations, 4 * k],
    ["curves", track.curves, 16 * k],
  ];
  for (const [attribute, values, length] of expected) {
    if (values.length !== length) {
      throw new RangeError(
        `track '${track.name}': ${attribute} must have shape for ${k} keys (${length} numbers)`,
      );
    }
  }
  for (let i = 1; i < k; i++) {
    if (track.frames[i]! <= track.frames[i - 1]!) {
      throw new RangeError(`track '${track.name}': frames must be strictly increasing`);
    }
  }
  return track;
}

/** Some key rotates the bone away from its rest orientation. */
export function trackRotates(track: SourceBoneTrack): boolean {
  for (let i = 0; i < track.frames.length; i++) {
    if (angle(getQuat(track.rotations, i)) > ROTATION_EPS) return true;
  }
  return false;
}

/** Some key moves the bone away from its rest position. */
export function trackTranslates(track: SourceBoneTrack): boolean {
  return track.translations.some((v) => Math.abs(v) > TRANSLATION_EPS);
}

/** The track changes the pose at all (moving, or a static non-rest pose). */
export function trackIsAnimated(track: SourceBoneTrack): boolean {
  return trackRotates(track) || trackTranslates(track);
}

/**
 * A morph's weight over time: `frames` strictly increasing, one weight per frame.
 * Weights are interpolated linearly between keys and held outside them.
 */
export interface MorphTrack {
  readonly name: string;
  readonly frames: Float64Array;
  readonly weights: Float64Array;
}

export function morphIsAnimated(track: MorphTrack): boolean {
  return track.weights.some((w) => Math.abs(w) > 1e-3);
}

export interface SourceMotion {
  readonly name: string;
  readonly frameRate: number;
  readonly endFrame: number;
  readonly tracks: ReadonlyMap<string, SourceBoneTrack>;
  /** Facial expressions etc. */
  readonly morphs: ReadonlyMap<string, MorphTrack>;
  /** Bones whose motion reaches others only via IK. */
  readonly ikBones: ReadonlySet<string>;
  /** IK on/off switches over time: bone -> `[frame, enabled]` pairs sorted by frame. */
  readonly ikStates: ReadonlyMap<string, readonly (readonly [number, boolean])[]>;
  /** Maps a user-written bone name to the key used in `tracks` (formats may truncate names). */
  readonly canonicalName: (name: string) => string;
}

export function motionDuration(motion: SourceMotion): number {
  return motion.endFrame / motion.frameRate;
}
