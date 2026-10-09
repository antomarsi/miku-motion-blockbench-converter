/**
 * Synthetic motions for verifying conventions end to end.
 *
 * The calibration motion exercises one axis at a time, so each direction can be checked
 * visually in Blockbench. Bone names are parameters: nothing here assumes a rig.
 */

import type { Quat, Vec3 } from "../geometry/quat";
import { encode } from "./interpolation";
import { emptyVmd, type VmdBoneKey, type VmdFile } from "./types";

/** Each step takes one second at MMD's 30 fps. */
export const SEGMENT_FRAMES = 30;

export interface CalibrationStep {
  readonly label: string;
  /** The pose is reached here and released `SEGMENT_FRAMES` later. */
  readonly startFrame: number;
  readonly kind: "rotate" | "move";
  /** 0, 1, 2 for X, Y, Z in MMD's axes. */
  readonly axis: number;
}

export interface Calibration {
  readonly vmd: VmdFile;
  readonly steps: readonly CalibrationStep[];
}

function axisQuat(axis: number, degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  const q: [number, number, number, number] = [0, 0, 0, Math.cos(half)];
  q[axis] = Math.sin(half);
  return q;
}

/**
 * Rotate `rotateBone` +`degrees` about X, Y, Z in turn, then move `moveBone` +`distance`
 * along X, Y, Z. Every step returns to rest before the next begins.
 */
export function calibration(
  rotateBone: string,
  moveBone: string | undefined,
  degrees = 45,
  distance = 2,
): Calibration {
  const curve = encode();
  const origin: Vec3 = [0, 0, 0];
  const identity: Quat = [0, 0, 0, 1];
  const keys: VmdBoneKey[] = [];
  const steps: CalibrationStep[] = [];
  let frame = 0;

  const pose = (
    bone: string,
    position: Vec3,
    rotation: Quat,
    step: Omit<CalibrationStep, "startFrame">,
  ): void => {
    if (!keys.some((key) => key.name === bone && key.frame === frame)) {
      keys.push({ name: bone, frame, position: origin, rotation: identity, interpolation: curve });
    }
    keys.push({ name: bone, frame: frame + SEGMENT_FRAMES, position, rotation, interpolation: curve });
    keys.push({
      name: bone,
      frame: frame + 2 * SEGMENT_FRAMES,
      position: origin,
      rotation: identity,
      interpolation: curve,
    });
    steps.push({ ...step, startFrame: frame + SEGMENT_FRAMES });
    frame += 2 * SEGMENT_FRAMES;
  };

  const letters = ["X", "Y", "Z"];
  for (let axis = 0; axis < 3; axis++) {
    pose(rotateBone, origin, axisQuat(axis, degrees), {
      label: `${rotateBone} +${degrees}° ${letters[axis]}`,
      kind: "rotate",
      axis,
    });
  }
  if (moveBone !== undefined) {
    for (let axis = 0; axis < 3; axis++) {
      const offset: [number, number, number] = [0, 0, 0];
      offset[axis] = distance;
      pose(moveBone, offset, identity, {
        label: `${moveBone} +${distance} ${letters[axis]}`,
        kind: "move",
        axis,
      });
    }
  }
  const vmd = emptyVmd("calibration");
  vmd.boneKeys = keys;
  return { vmd, steps };
}
