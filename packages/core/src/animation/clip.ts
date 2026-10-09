/**
 * Sampled target animation, independent of any output format.
 *
 * Rotations are each bone's **full local rotation** (rest included) and translations are
 * offsets from the rest pivot in the parent's frame, both in canonical space and target
 * units. Output formats derive their own deltas from these (e.g. GeckoLib subtracts the
 * rest Euler angles).
 */

import type { QuatArray, Vec3Array } from "../geometry/quat";

/** GeckoLib loop modes, by the names the command line uses. */
export const LoopMode = { ONCE: "false", LOOP: "true", HOLD: "hold" } as const;
export type LoopMode = (typeof LoopMode)[keyof typeof LoopMode];

export interface BoneTrack {
  /** 4 numbers (xyzw) per sample: full local rotation. */
  readonly rotations?: QuatArray | undefined;
  /** 3 numbers per sample: offset from rest, parent frame. */
  readonly translations?: Vec3Array | undefined;
  /** 3 numbers per sample: multipliers (1 = rest; 0 hides the bone). */
  readonly scales?: Vec3Array | undefined;
}

export interface Animation {
  name: string;
  /** Seconds, shared by every track. */
  times: Float64Array;
  /** Seconds. */
  length: number;
  loop: LoopMode;
  tracks: Map<string, BoneTrack>;
}
