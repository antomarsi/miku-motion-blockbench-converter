/** Metadata about a VMD file, for the `inspect` command. */

import { compareNames } from "../text";
import type { VmdBoneKey, VmdFile } from "./types";

export const FRAME_RATE = 30;
const ROTATION_EPS = 1e-4; // radians
const TRANSLATION_EPS = 1e-4; // MMD units

export interface BoneSummary {
  readonly name: string;
  readonly keyCount: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  /** Some key rotates away from the rest pose. */
  readonly rotates: boolean;
  /** Some key moves away from the rest position. */
  readonly translates: boolean;
  /** Keys differ from each other (actual motion, not a static pose). */
  readonly varies: boolean;
  /** An IK target/effector bone: it drives other bones through the model's IK. */
  readonly ik: boolean;
}

export interface VmdSummary {
  readonly modelName: string;
  readonly version: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly boneKeyCount: number;
  readonly morphKeyCount: number;
  readonly morphNames: readonly string[];
  readonly cameraKeyCount: number;
  readonly lightKeyCount: number;
  readonly shadowKeyCount: number;
  readonly showIkKeyCount: number;
  readonly bones: readonly BoneSummary[];
}

export function durationSeconds(summary: VmdSummary): number {
  return summary.lastFrame / FRAME_RATE;
}

/** Data that converts only with the right mapping or source skeleton. */
export function conditionalNotes(summary: VmdSummary): string[] {
  const notes: string[] = [];
  if (summary.morphKeyCount) {
    notes.push(
      `${summary.morphKeyCount} morph keyframes (facial animation): converted for ` +
        "the morphs the mapping has rules for",
    );
  }
  const ikBones = summary.bones.filter((b) => b.ik && (b.varies || b.translates)).map((b) => b.name);
  if (ikBones.length) {
    notes.push(`IK-driven motion, solved with the source skeleton: ${ikBones.join(", ")}`);
  }
  return notes;
}

export function unsupportedNotes(summary: VmdSummary): string[] {
  const notes: string[] = [];
  if (summary.cameraKeyCount) notes.push(`${summary.cameraKeyCount} camera keyframes`);
  if (summary.lightKeyCount) notes.push(`${summary.lightKeyCount} light keyframes`);
  if (summary.shadowKeyCount) notes.push(`${summary.shadowKeyCount} self-shadow keyframes`);
  return notes;
}

/** MMD names IK bones with 'IK' (often full-width); normalize before checking. */
export function isIkName(name: string): boolean {
  return name.normalize("NFKC").toUpperCase().includes("IK");
}

function rotationAngle(q: readonly number[]): number {
  return 2 * Math.atan2(Math.hypot(q[0]!, q[1]!, q[2]!), Math.abs(q[3]!));
}

function maxDifference(a: readonly number[], b: readonly number[]): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

function boneSummary(name: string, keys: VmdBoneKey[], ikNames: Set<string>): BoneSummary {
  const first = keys[0]!;
  return {
    name,
    keyCount: keys.length,
    // Reduced, not spread: a baked motion can have more keys than a call takes arguments.
    firstFrame: keys.reduce((min, k) => Math.min(min, k.frame), Infinity),
    lastFrame: keys.reduce((max, k) => Math.max(max, k.frame), -Infinity),
    rotates: keys.some((k) => rotationAngle(k.rotation) > ROTATION_EPS),
    translates: keys.some((k) => Math.max(...k.position.map(Math.abs)) > TRANSLATION_EPS),
    varies: keys.some(
      (k) =>
        maxDifference(k.position, first.position) > TRANSLATION_EPS ||
        maxDifference(k.rotation, first.rotation) > ROTATION_EPS,
    ),
    ik: ikNames.has(name) || isIkName(name),
  };
}

export function summarize(vmd: VmdFile): VmdSummary {
  const byBone = new Map<string, VmdBoneKey[]>();
  for (const key of vmd.boneKeys) {
    const keys = byBone.get(key.name);
    if (keys) keys.push(key);
    else byBone.set(key.name, [key]);
  }
  const ikNames = new Set(vmd.showIkKeys.flatMap((key) => key.ik.map((state) => state.name)));
  let firstFrame = Infinity;
  let lastFrame = -Infinity;
  for (const key of [...vmd.boneKeys, ...vmd.morphKeys]) {
    firstFrame = Math.min(firstFrame, key.frame);
    lastFrame = Math.max(lastFrame, key.frame);
  }
  const bones = [...byBone]
    .map(([name, keys]) => boneSummary(name, keys, ikNames))
    .sort((a, b) => b.keyCount - a.keyCount || compareNames(a.name, b.name));
  return {
    modelName: vmd.modelName,
    version: vmd.version,
    firstFrame: Number.isFinite(firstFrame) ? firstFrame : 0,
    lastFrame: Number.isFinite(lastFrame) ? lastFrame : 0,
    boneKeyCount: vmd.boneKeys.length,
    morphKeyCount: vmd.morphKeys.length,
    morphNames: [...new Set(vmd.morphKeys.map((k) => k.name))].sort(compareNames),
    cameraKeyCount: vmd.cameraKeyCount,
    lightKeyCount: vmd.lightKeyCount,
    shadowKeyCount: vmd.shadowKeyCount,
    showIkKeyCount: vmd.showIkKeys.length,
    bones,
  };
}
