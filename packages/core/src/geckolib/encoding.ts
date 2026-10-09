/**
 * Canonical animation values -> GeckoLib / Bedrock channel values.
 *
 * This module is the single source of truth for GeckoLib's conventions:
 *
 * - rotation keyframes are ZYX Euler **degrees**, *added per component* to the bone's rest
 *   rotation (Blockbench and GeckoLib add Euler angles; they don't compose quaternions)
 * - the Bedrock format stores X and Y rotation, and X position, with flipped signs
 *   relative to Blockbench's internal (canonical) space
 * - position keyframes are offsets from the rest pivot in pixels, in the parent's frame
 *
 * The sign conventions are recorded in docs/conventions.md; they are verified in
 * Blockbench and in-game.
 */

import { DEGREES, RADIANS, type Bone } from "../animation/skeleton";
import { closestTo, continuousFromQuats, toQuat } from "../geometry/euler";
import type { Quat, QuatArray, Vec3, Vec3Array } from "../geometry/quat";

export const ROTATION_SIGNS: Vec3 = [-1, -1, 1];
export const POSITION_SIGNS: Vec3 = [-1, 1, 1];

function restRadians(bone: Bone): Vec3 {
  const [x, y, z] = bone.restEulerDegrees;
  return [x * RADIANS, y * RADIANS, z * RADIANS];
}

/** Keyframe values (degrees, 3 per sample) for full local rotations of `bone`. */
export function rotationChannel(bone: Bone, rotations: QuatArray): Vec3Array {
  const rest = restRadians(bone);
  const angles = continuousFromQuats(rotations, rest);
  for (let i = 0; i < angles.length; i++) {
    const axis = i % 3;
    angles[i] = (angles[i]! - rest[axis]!) * DEGREES * ROTATION_SIGNS[axis]!;
  }
  return angles;
}

/** Keyframe value (degrees) for one rotation, closest to the value `near`. */
export function rotationValueNear(bone: Bone, rotation: Quat, near: Vec3): Vec3 {
  const rest = restRadians(bone);
  const previous: Vec3 = [
    rest[0] + near[0] * ROTATION_SIGNS[0] * RADIANS,
    rest[1] + near[1] * ROTATION_SIGNS[1] * RADIANS,
    rest[2] + near[2] * ROTATION_SIGNS[2] * RADIANS,
  ];
  const angles = closestTo(rotation, previous);
  return [
    (angles[0] - rest[0]) * DEGREES * ROTATION_SIGNS[0],
    (angles[1] - rest[1]) * DEGREES * ROTATION_SIGNS[1],
    (angles[2] - rest[2]) * DEGREES * ROTATION_SIGNS[2],
  ];
}

/** The rotation GeckoLib displays for a keyframe value (inverse of the above). */
export function rotationFromChannel(bone: Bone, value: Vec3): Quat {
  const rest = restRadians(bone);
  return toQuat([
    rest[0] + value[0] * ROTATION_SIGNS[0] * RADIANS,
    rest[1] + value[1] * ROTATION_SIGNS[1] * RADIANS,
    rest[2] + value[2] * ROTATION_SIGNS[2] * RADIANS,
  ]);
}

/** Keyframe values (pixels, 3 per sample) for canonical parent-frame offsets. */
export function positionChannel(translations: Vec3Array): Vec3Array {
  const out = Float64Array.from(translations);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * POSITION_SIGNS[i % 3]!;
  return out;
}

/** Canonical rotation for a rotation keyframe value given without a rest pose. */
export function rotationDeltaFromChannel(value: Vec3): Quat {
  return toQuat([
    value[0] * ROTATION_SIGNS[0] * RADIANS,
    value[1] * ROTATION_SIGNS[1] * RADIANS,
    value[2] * ROTATION_SIGNS[2] * RADIANS,
  ]);
}

/** Canonical offset for a position keyframe value (the inverse of `positionChannel`). */
export function positionFromChannel(value: Vec3): Vec3 {
  return [value[0] * POSITION_SIGNS[0], value[1] * POSITION_SIGNS[1], value[2] * POSITION_SIGNS[2]];
}
