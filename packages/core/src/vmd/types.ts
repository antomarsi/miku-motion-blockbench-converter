/** Raw VMD records, close to the file layout. Nothing outside `vmd/` uses these. */

import type { Quat, Vec3 } from "../geometry/quat";

export const INTERPOLATION_BYTES = 64;

export interface VmdBoneKey {
  readonly name: string;
  readonly frame: number;
  readonly position: Vec3;
  /** xyzw, as stored in the file. */
  readonly rotation: Quat;
  /** Raw 64 bytes; decoded by `vmd/adapter`. */
  readonly interpolation: Uint8Array;
}

export interface VmdMorphKey {
  readonly name: string;
  readonly frame: number;
  readonly weight: number;
}

export interface VmdIkState {
  readonly name: string;
  readonly enabled: boolean;
}

export interface VmdShowIkKey {
  readonly frame: number;
  readonly show: boolean;
  readonly ik: readonly VmdIkState[];
}

/** A parsed VMD. Camera/light/shadow keys are counted, not decoded (unsupported). */
export interface VmdFile {
  modelName: string;
  version: number;
  boneKeys: VmdBoneKey[];
  morphKeys: VmdMorphKey[];
  cameraKeyCount: number;
  lightKeyCount: number;
  shadowKeyCount: number;
  showIkKeys: VmdShowIkKey[];
}

export function emptyVmd(modelName: string, version = 2): VmdFile {
  return {
    modelName,
    version,
    boneKeys: [],
    morphKeys: [],
    cameraKeyCount: 0,
    lightKeyCount: 0,
    shadowKeyCount: 0,
    showIkKeys: [],
  };
}
