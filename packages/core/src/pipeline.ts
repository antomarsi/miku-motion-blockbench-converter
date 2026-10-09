/** End-to-end conversion: motion + target model + mapping -> GeckoLib animation. */

import { LoopMode, type Animation } from "./animation/clip";
import { sampleTimes, sampleTrack, type PoseSamples } from "./animation/sampling";
import { motionDuration } from "./animation/source";
import { isGeckolib, type BlockbenchModel } from "./blockbench/bbmodel";
import { MMD_TO_CANONICAL } from "./conversion/coordinates";
import { applyMorphRules, resolveMorphRules } from "./conversion/morphs";
import { retarget } from "./conversion/retarget";
import { applySecondaryMotion } from "./conversion/secondary";
import { Code, Diagnostics } from "./diagnostics";
import { MikuMotionError } from "./errors";
import type { Tolerance } from "./geckolib/optimize";
import { renderAnimation, type WriteStats } from "./geckolib/writer";
import { getVec3, IDENTITY, inverse, rotate, type Vec3 } from "./geometry/quat";
import { resolve } from "./mapping/resolve";
import type { MappingFile } from "./mapping/schema";
import { resolveSecondary, suggestChains } from "./mapping/secondary";
import { solveIk, type ChainResult } from "./rig/ik";
import type { SourceRig } from "./rig/model";
import { builtinSkeleton } from "./rig/schema";
import { compareNames } from "./text";
import { toSourceMotion } from "./vmd/adapter";
import { parseVmd } from "./vmd/parser";

export const DEFAULT_FPS = 20;
export const OPTIMIZED_FPS = 60; // finer sampling for the optimizer to choose keys from
const IK_REACH_TOLERANCE = 0.1; // source units (MMD: ~8 mm)
const IK_UNREACHED_SHARE = 0.02; // warn when more samples than this miss their goal

export interface ConvertOptions {
  /** Samples per second. */
  readonly fps?: number;
  /** Animation name; default `animation.<model>.<motion>`. */
  readonly name?: string | undefined;
  readonly loop?: LoopMode;
  /**
   * The skeleton of the motion's MMD model, used to solve IK. Default: the built-in
   * standard skeleton. `null` turns IK solving off.
   */
  readonly sourceRig?: SourceRig | null;
  /** Reduce keyframes within this error. */
  readonly tolerance?: Tolerance | undefined;
}

export interface MotionInput {
  /** The `.vmd` file's bytes. */
  readonly data: Uint8Array;
  /** Names the animation (usually the file name without its extension). */
  readonly label: string;
  /** Used only in error messages. */
  readonly path?: string | undefined;
}

export interface ConvertInputs {
  readonly motion: MotionInput;
  readonly model: BlockbenchModel;
  readonly mapping: MappingFile;
  /** Used only in error messages. */
  readonly mappingPath?: string | undefined;
}

export interface ConversionResult {
  /** The `.animation.json` text. */
  readonly text: string;
  readonly animation: Animation;
  readonly model: BlockbenchModel;
  readonly diagnostics: Diagnostics;
  readonly stats: WriteStats;
}

function identifier(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^0-9a-z_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unnamed";
}

/** GeckoLib's convention: `animation.<model>.<animation>`. */
export function defaultAnimationName(model: BlockbenchModel, label: string): string {
  return `animation.${identifier(model.name)}.${identifier(label)}`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function reportIk(rig: SourceRig, results: readonly ChainResult[], diagnostics: Diagnostics): void {
  const solved = results.filter((r) => r.enabledFraction > 0).map((r) => r.chain.bone);
  if (solved.length) {
    diagnostics.info(
      Code.IK_SOLVED,
      `solved IK with source skeleton '${rig.name}': ${solved.join(", ")}`,
      solved,
    );
  }
  for (const result of results) {
    if (result.enabledFraction === 0) continue;
    let missed = 0;
    let worst = 0;
    for (const residual of result.residuals) {
      if (residual > IK_REACH_TOLERANCE) missed++;
      if (residual > worst) worst = residual;
    }
    const share = missed / result.residuals.length;
    if (share > IK_UNREACHED_SHARE) {
      diagnostics.warn(
        Code.IK_UNREACHED,
        `${result.chain.bone} missed its goal in ${percent(share)} of samples (by up to ` +
          `${worst.toFixed(2)} units); the source skeleton's ` +
          "proportions probably differ from the motion's model",
        [result.chain.bone],
      );
    }
  }
}

function reportReduction(stats: WriteStats, tolerance: Tolerance, diagnostics: Diagnostics): void {
  const saved = stats.denseKeys ? 1 - stats.keys / stats.denseKeys : 0;
  const grouped = (value: number): string => value.toLocaleString("en-US");
  diagnostics.info(
    Code.KEYS_REDUCED,
    `keyframes reduced from ${grouped(stats.denseKeys)} to ${grouped(stats.keys)} ` +
      `(-${percent(saved)}); worst error ${stats.maxRotationError.toFixed(2)} deg / ` +
      `${stats.maxPositionError.toFixed(3)} px`,
  );
  if (stats.maxRotationError > tolerance.rotationDegrees + 1e-6) {
    diagnostics.warn(
      Code.REDUCTION_OVER_TOLERANCE,
      `some rotations still differ by up to ${stats.maxRotationError.toFixed(2)} deg between ` +
        `keys (tolerance ${Number(tolerance.rotationDegrees.toPrecision(6))} deg); try a higher --fps`,
    );
  }
}

/** A converted animation that can still be adjusted before it is written. */
export interface Draft {
  readonly animation: Animation;
  readonly model: BlockbenchModel;
  readonly diagnostics: Diagnostics;
  /** The motion has bone or morph keys (not just a camera, say). */
  readonly performs: boolean;
}

export function draft(inputs: ConvertInputs, options: ConvertOptions = {}): Draft {
  const diagnostics = new Diagnostics();
  const { model, mapping: mappingFile, mappingPath } = inputs;
  const motion = toSourceMotion(parseVmd(inputs.motion.data, inputs.motion.path), diagnostics);
  if (!isGeckolib(model)) {
    diagnostics.info(
      Code.TARGET_NOT_GECKOLIB,
      `the Blockbench project format is '${model.modelFormat}'; the animation imports ` +
        "fine, but for GeckoLib convert the project (File > Convert Project > GeckoLib " +
        "Animated Model) before exporting the model",
    );
  }
  let rig = options.sourceRig === undefined ? builtinSkeleton() : options.sourceRig;
  const ikBones = new Set(rig ? rig.ik.map((chain) => motion.canonicalName(chain.bone)) : []);
  const chains = resolveSecondary(mappingFile, model.skeleton, mappingPath);
  const candidates = suggestChains(model.skeleton, mappingFile);
  if (candidates.length) {
    diagnostics.info(
      Code.SECONDARY_CANDIDATES,
      `${candidates.length} bone chains look like hair/cloth but have no secondary motion: ` +
        candidates.map((c) => c.bones.join(" > ")).join(", ") +
        "; `miku-motion inspect-model` prints a snippet to add them",
    );
  }
  const mapping = resolve(mappingFile, model.skeleton, motion, diagnostics, {
    mappingPath,
    solvedIk: ikBones,
  });

  const times = sampleTimes(motionDuration(motion), options.fps ?? DEFAULT_FPS);
  const frames = Float64Array.from(times, (t) => t * motion.frameRate);
  const needed = new Set(mapping.bindings.flatMap((b) => b.chain.map((link) => link.source)));
  if (rig) {
    rig = rig.driving(needed, motion.canonicalName);
    for (const name of rig.requiredBones()) needed.add(name);
  }
  const poses = new Map<string, PoseSamples>();
  for (const name of [...needed].sort(compareNames)) {
    const track = motion.tracks.get(name);
    if (track) poses.set(name, sampleTrack(track, frames));
  }
  if (rig) reportIk(rig, solveIk(rig, motion, poses, frames), diagnostics);

  const animation = retarget(poses, times, mapping, model.skeleton, MMD_TO_CANONICAL, {
    name: options.name ?? defaultAnimationName(model, inputs.motion.label),
    loop: options.loop ?? LoopMode.ONCE,
  });
  const morphRules = resolveMorphRules(mappingFile.morphs, model.skeleton, motion, diagnostics, mappingPath);
  applyMorphRules(animation, model.skeleton, motion, morphRules);
  if (chains.length) {
    applySecondaryMotion(animation, model.skeleton, chains);
    diagnostics.info(
      Code.SECONDARY_MOTION,
      "simulated secondary motion for " + chains.map((c) => c.bones.join(" > ")).join(", "),
    );
  }
  return {
    animation,
    model,
    diagnostics,
    performs: motion.tracks.size > 0 || motion.morphs.size > 0,
  };
}

export function finish(work: Draft, options: ConvertOptions = {}): ConversionResult {
  const { text, stats } = renderAnimation(work.animation, work.model.skeleton, options.tolerance);
  if (options.tolerance) reportReduction(stats, options.tolerance, work.diagnostics);
  return {
    text,
    stats,
    animation: work.animation,
    model: work.model,
    diagnostics: work.diagnostics,
  };
}

export function convert(inputs: ConvertInputs, options: ConvertOptions = {}): ConversionResult {
  return finish(draft(inputs, options), options);
}

// --- performer groups -------------------------------------------------------------------------

export const DEFAULT_GROUP_DURATION_TOLERANCE = 1; // seconds

/** What happens to the stage positions the performers' motions carry. */
export const Formation = {
  /** As authored: every performer stands where its motion puts it. */
  KEEP: "keep",
  /** The group moves as one so that its middle starts at the origin. */
  CENTER: "center",
  /** Every performer starts at its own origin (the runtime places them). */
  ORIGIN: "origin",
} as const;
export type Formation = (typeof Formation)[keyof typeof Formation];

export interface GroupOptions {
  /** Seconds a member's length may differ from the group's average before a warning. */
  readonly durationTolerance?: number;
  readonly formation?: Formation;
  /** Give every animation the longest member's length. */
  readonly syncLength?: boolean;
}

export interface GroupMember {
  readonly motion: MotionInput;
  readonly result: ConversionResult;
  /** Names the animation and the output file. */
  readonly label: string;
  /** Where the motion puts the performer at t=0 (model pixels). */
  readonly start: Vec3;
}

export interface GroupResult {
  readonly members: readonly GroupMember[];
  /** Group-level only: each member's own diagnostics are in its result. */
  readonly diagnostics: Diagnostics;
}

/** A motion's file name (without folders) for messages. */
function displayName(motion: MotionInput): string {
  return (motion.path ?? motion.label).replace(/^.*[\/]/, "");
}

/** Labels must give distinct animation names. */
export function checkGroupLabels(motions: readonly MotionInput[]): void {
  const seen = new Map<string, MotionInput>();
  for (const motion of motions) {
    const key = identifier(motion.label);
    const other = seen.get(key);
    if (other) {
      throw new MikuMotionError(
        `it would get the same animation name as ${other.path ?? other.label}`,
        {
          path: motion.path ?? motion.label,
          hint: "rename one of the motions, or convert them in separate runs",
        },
      );
    }
    seen.set(key, motion);
  }
}

/** Translated bones with no translated ancestor: they carry the stage position. */
function movers(work: Draft): string[] {
  const { skeleton } = work.model;
  const moved = new Set(
    [...work.animation.tracks].filter(([, track]) => track.translations).map(([name]) => name),
  );
  return skeleton.names.filter(
    (name) => moved.has(name) && !skeleton.ancestors(name).some((a) => moved.has(a.name)),
  );
}

function parentRest(work: Draft, bone: string): readonly [number, number, number, number] {
  const { parent } = work.model.skeleton.get(bone);
  return parent !== undefined ? work.model.skeleton.restWorldRotation(parent) : IDENTITY;
}

/** Model-space offset of `bone` from its rest position at the first sample. */
function startOf(work: Draft, bone: string): Vec3 {
  return rotate(parentRest(work, bone), getVec3(work.animation.tracks.get(bone)!.translations!, 0));
}

/** Move `bone`'s whole track by `-offset` (model space), horizontally only. */
function shift(work: Draft, bone: string, offset: Vec3): void {
  const track = work.animation.tracks.get(bone)!;
  const local = rotate(inverse(parentRest(work, bone)), [offset[0], 0, offset[2]]);
  const translations = Float64Array.from(track.translations!, (value, i) => value - local[i % 3]!);
  work.animation.tracks.set(bone, { ...track, translations });
}

/**
 * Convert several motions onto the same target rig, as a group of performers sharing
 * one rig and formation - e.g. a dance crew, not a solo.
 *
 * By default this is a convenience over calling `convert` once per motion - each motion
 * is converted independently and its output is identical - plus one group-level
 * diagnostic: performers meant to move together are usually expected to share a
 * timeline, so a member whose converted length diverges from the group's average by
 * more than `durationTolerance` is flagged.
 *
 * Two opt-in adjustments treat the motions as one performance:
 *
 * - `syncLength` gives every animation the longest member's length (shorter ones hold
 *   their last pose), so they can be started together and end together.
 * - `formation` re-centres the group or moves every performer to its own origin. Only
 *   horizontal position changes; heights are kept.
 *
 * This still has no notion of what uses the group (a duet, a full ensemble) or when
 * each member starts within some larger piece - that stays the runtime's problem.
 * `GroupMember.start` reports where each motion put its performer, for runtimes that
 * place them themselves.
 */
export function convertGroup(
  motions: readonly MotionInput[],
  target: Omit<ConvertInputs, "motion">,
  options: ConvertOptions = {},
  group: GroupOptions = {},
): GroupResult {
  const formation = group.formation ?? Formation.KEEP;
  const syncLength = group.syncLength ?? false;
  const durationTolerance = group.durationTolerance ?? DEFAULT_GROUP_DURATION_TOLERANCE;
  let entries = [...motions];
  let drafts = entries.map((motion) => draft({ ...target, motion }, { ...options, name: undefined }));

  const diagnostics = new Diagnostics();
  const idle = entries.filter((_, i) => !drafts[i]!.performs).map(displayName);
  if (idle.length && idle.length < drafts.length) {
    // Dance folders often ship the camera motion next to the performers'.
    diagnostics.warn(
      Code.GROUP_MEMBER_SKIPPED,
      `skipped ${idle.join(", ")}: no bone or morph keyframes (a camera or light motion?)`,
    );
    entries = entries.filter((_, i) => drafts[i]!.performs);
    drafts = drafts.filter((work) => work.performs);
  }

  const lengths = drafts.map((work) => work.animation.length);
  if (drafts.length > 1 && !syncLength) {
    const average = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    entries.forEach((entry, i) => {
      const deviation = Math.abs(lengths[i]! - average);
      if (deviation > durationTolerance) {
        diagnostics.warn(
          Code.GROUP_DURATION_MISMATCH,
          `${displayName(entry)} converts to ${lengths[i]!.toFixed(2)}s, ` +
            `${deviation.toFixed(2)}s away from the group's average ` +
            `(${average.toFixed(2)}s over ${drafts.length} members)`,
        );
      }
    });
  }

  const starts: Vec3[] = drafts.map((work) => {
    const first = movers(work)[0];
    return first !== undefined ? startOf(work, first) : [0, 0, 0];
  });
  if (formation !== Formation.KEEP && drafts.length) {
    const middle: Vec3 = [0, 1, 2].map(
      (axis) => starts.reduce((sum, start) => sum + start[axis]!, 0) / starts.length,
    ) as unknown as Vec3;
    for (const work of drafts) {
      for (const bone of movers(work)) {
        shift(work, bone, formation === Formation.ORIGIN ? startOf(work, bone) : middle);
      }
    }
    const change =
      formation === Formation.ORIGIN
        ? "every performer now starts at its own origin"
        : "the group was moved so that its middle starts at the origin";
    diagnostics.info(
      Code.GROUP_FORMATION,
      `formation '${formation}': ${change}; heights are unchanged`,
    );
  }
  if (syncLength && drafts.length) {
    const longest = Math.max(...lengths);
    const padded = entries.filter((_, i) => lengths[i]! < longest).map(displayName);
    for (const work of drafts) work.animation.length = longest;
    if (padded.length) {
      diagnostics.info(
        Code.GROUP_LENGTH_SYNCED,
        `every animation is now ${longest.toFixed(2)}s long; these hold their last pose ` +
          `until then: ${padded.join(", ")}`,
      );
    }
  }

  const members = entries.map((motion, i) => ({
    motion,
    result: finish(drafts[i]!, options),
    label: motion.label,
    start: starts[i]!,
  }));
  return { members, diagnostics };
}
