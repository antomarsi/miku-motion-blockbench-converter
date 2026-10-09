/**
 * Convert a parsed VMD into the format-independent `SourceMotion`.
 *
 * This is where VMD specifics end: interpolation bytes become normalized easing curves,
 * keys are grouped per bone, sorted and de-duplicated, and unsupported sections are
 * reported as diagnostics.
 */

import {
  makeTrack,
  type MorphTrack,
  type SourceBoneTrack,
  type SourceMotion,
} from "../animation/source";
import { Code, type Diagnostics } from "../diagnostics";
import { decode } from "./interpolation";
import { canonicalBoneName } from "./names";
import { compareNames } from "../text";
import { FRAME_RATE, isIkName } from "./summary";
import type { VmdBoneKey, VmdFile } from "./types";

const CURVE_SCALE = 127;

function track(name: string, keys: VmdBoneKey[]): SourceBoneTrack {
  const k = keys.length;
  const frames = new Float64Array(k);
  const translations = new Float64Array(3 * k);
  const rotations = new Float64Array(4 * k);
  const curves = new Float64Array(16 * k);
  keys.forEach((key, i) => {
    frames[i] = key.frame;
    translations.set(key.position, 3 * i);
    rotations.set(key.rotation, 4 * i);
    const decoded = decode(key.interpolation);
    [decoded.x, decoded.y, decoded.z, decoded.rotation].forEach((curve, channel) => {
      for (let p = 0; p < 4; p++) curves[16 * i + 4 * channel + p] = curve[p]! / CURVE_SCALE;
    });
  });
  return makeTrack({ name, frames, translations, rotations, curves });
}

function sortedEntries<V>(map: Map<string, V>): [string, V][] {
  return [...map].sort(([a], [b]) => compareNames(a, b));
}

function morphTracks(vmd: VmdFile): Map<string, MorphTrack> {
  const byMorph = new Map<string, Map<number, number>>();
  for (const key of vmd.morphKeys) {
    // File order; a later key for the same frame wins.
    const name = canonicalBoneName(key.name);
    let keys = byMorph.get(name);
    if (!keys) byMorph.set(name, (keys = new Map()));
    keys.set(key.frame, key.weight);
  }
  const out = new Map<string, MorphTrack>();
  for (const [name, keys] of sortedEntries(byMorph)) {
    const frames = [...keys.keys()].sort((a, b) => a - b);
    out.set(name, {
      name,
      frames: Float64Array.from(frames),
      weights: Float64Array.from(frames, (f) => keys.get(f)!),
    });
  }
  return out;
}

function reportUnsupported(vmd: VmdFile, diagnostics: Diagnostics): void {
  const sections = [
    [vmd.cameraKeyCount, Code.UNSUPPORTED_CAMERA, "camera"],
    [vmd.lightKeyCount, Code.UNSUPPORTED_LIGHT, "light"],
    [vmd.shadowKeyCount, Code.UNSUPPORTED_SHADOW, "self-shadow"],
  ] as const;
  for (const [count, code, what] of sections) {
    if (count) diagnostics.warn(code, `${count} ${what} keyframes are not converted`);
  }
}

export function toSourceMotion(vmd: VmdFile, diagnostics: Diagnostics): SourceMotion {
  const byBone = new Map<string, Map<number, VmdBoneKey>>();
  const duplicates = new Map<string, number>();
  for (const key of vmd.boneKeys) {
    // File order; a later key for the same frame wins.
    const name = canonicalBoneName(key.name);
    let frames = byBone.get(name);
    if (!frames) byBone.set(name, (frames = new Map()));
    if (frames.has(key.frame)) duplicates.set(name, (duplicates.get(name) ?? 0) + 1);
    frames.set(key.frame, key);
  }

  if (duplicates.size) {
    const names = [...duplicates.keys()].sort(compareNames);
    const total = [...duplicates.values()].reduce((a, b) => a + b, 0);
    diagnostics.warn(
      Code.DUPLICATE_KEYS,
      `${total} duplicate bone keyframes (same bone and frame); ` +
        `the last one in the file was used for: ${names.join(", ")}`,
      names,
    );
  }

  const tracks = new Map<string, SourceBoneTrack>();
  for (const [name, frames] of sortedEntries(byBone)) {
    const ordered = [...frames.keys()].sort((a, b) => a - b).map((f) => frames.get(f)!);
    tracks.set(name, track(name, ordered));
  }

  // The show/IK section lists the model's real IK bones; names containing "IK" (IK
  // parents, IK tips) are only a fallback for files without that section.
  const ikBones = new Set<string>();
  const ikStates = new Map<string, [number, boolean][]>();
  const showKeys = [...vmd.showIkKeys].sort((a, b) => a.frame - b.frame);
  for (const showKey of showKeys) {
    for (const state of showKey.ik) {
      const name = canonicalBoneName(state.name);
      ikBones.add(name);
      let states = ikStates.get(name);
      if (!states) ikStates.set(name, (states = []));
      states.push([showKey.frame, state.enabled]);
    }
  }
  if (ikBones.size === 0) {
    for (const name of tracks.keys()) if (isIkName(name)) ikBones.add(name);
  }

  reportUnsupported(vmd, diagnostics);
  return {
    name: vmd.modelName,
    frameRate: FRAME_RATE,
    endFrame: vmd.boneKeys.reduce((max, key) => Math.max(max, key.frame), 0),
    tracks,
    morphs: morphTracks(vmd),
    ikBones,
    ikStates: new Map(sortedEntries(ikStates)),
    canonicalName: canonicalBoneName,
  };
}
