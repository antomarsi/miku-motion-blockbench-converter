/**
 * Binary VMD writer, used for synthetic test fixtures and calibration motions.
 *
 * Camera/light/shadow sections are written empty; their counts in `VmdFile` are ignored.
 */

import { BONE_NAME_BYTES, MODEL_NAME_BYTES, encodeName } from "./names";
import {
  BONE_RECORD_BYTES,
  IK_NAME_BYTES,
  MAGIC_BYTES,
  MAGIC_V2,
  MORPH_RECORD_BYTES,
} from "./parser";
import { INTERPOLATION_BYTES, type VmdFile } from "./types";

/** Serialize `vmd` as a version-2 VMD file. */
export function writeVmd(vmd: VmdFile): Uint8Array {
  let size = MAGIC_BYTES + MODEL_NAME_BYTES;
  size += 4 + vmd.boneKeys.length * BONE_RECORD_BYTES;
  size += 4 + vmd.morphKeys.length * MORPH_RECORD_BYTES;
  size += 12; // camera, light, self-shadow counts
  size += 4;
  for (const key of vmd.showIkKeys) size += 9 + key.ik.length * (IK_NAME_BYTES + 1);

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < MAGIC_V2.length; i++) out[i] = MAGIC_V2.charCodeAt(i);
  o += MAGIC_BYTES;
  out.set(encodeName(vmd.modelName, MODEL_NAME_BYTES), o);
  o += MODEL_NAME_BYTES;

  view.setUint32(o, vmd.boneKeys.length, true);
  o += 4;
  for (const key of vmd.boneKeys) {
    if (key.interpolation.length !== INTERPOLATION_BYTES) {
      throw new RangeError(`bone key '${key.name}' needs ${INTERPOLATION_BYTES} interp bytes`);
    }
    out.set(encodeName(key.name, BONE_NAME_BYTES), o);
    o += BONE_NAME_BYTES;
    view.setUint32(o, key.frame, true);
    o += 4;
    for (const value of [...key.position, ...key.rotation]) {
      view.setFloat32(o, value, true);
      o += 4;
    }
    out.set(key.interpolation, o);
    o += INTERPOLATION_BYTES;
  }

  view.setUint32(o, vmd.morphKeys.length, true);
  o += 4;
  for (const morph of vmd.morphKeys) {
    out.set(encodeName(morph.name, BONE_NAME_BYTES), o);
    o += BONE_NAME_BYTES;
    view.setUint32(o, morph.frame, true);
    view.setFloat32(o + 4, morph.weight, true);
    o += 8;
  }

  o += 12; // camera, light, self-shadow: zero records each

  view.setUint32(o, vmd.showIkKeys.length, true);
  o += 4;
  for (const key of vmd.showIkKeys) {
    view.setUint32(o, key.frame, true);
    out[o + 4] = key.show ? 1 : 0;
    view.setUint32(o + 5, key.ik.length, true);
    o += 9;
    for (const state of key.ik) {
      out.set(encodeName(state.name, IK_NAME_BYTES), o);
      out[o + IK_NAME_BYTES] = state.enabled ? 1 : 0;
      o += IK_NAME_BYTES + 1;
    }
  }
  return out;
}
