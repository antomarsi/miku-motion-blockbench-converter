/** End-to-end conversion: motion + target model + mapping -> GeckoLib animation. */

import { LoopMode, type Animation } from "./animation/clip";
import { sampleTimes, sampleTrack, type PoseSamples } from "./animation/sampling";
import { morphIsAnimated, motionDuration, type SourceMotion } from "./animation/source";
import { isGeckolib, type BlockbenchModel } from "./blockbench/bbmodel";
import { MMD_TO_CANONICAL } from "./conversion/coordinates";
import { retarget } from "./conversion/retarget";
import { Code, Diagnostics } from "./diagnostics";
import { renderAnimation, type WriteStats } from "./geckolib/writer";
import { resolve } from "./mapping/resolve";
import type { MappingFile } from "./mapping/schema";
import { compareNames, listNames } from "./text";
import { toSourceMotion } from "./vmd/adapter";
import { parseVmd } from "./vmd/parser";

export const DEFAULT_FPS = 20;

export interface ConvertOptions {
  /** Samples per second. */
  readonly fps?: number;
  /** Animation name; default `animation.<model>.<motion>`. */
  readonly name?: string | undefined;
  readonly loop?: LoopMode;
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

/** A converted animation that can still be adjusted before it is written. */
export interface Draft {
  readonly animation: Animation;
  readonly model: BlockbenchModel;
  readonly diagnostics: Diagnostics;
  /** The motion has bone or morph keys (not just a camera, say). */
  readonly performs: boolean;
}

/**
 * Parts of the conversion this port doesn't do yet. Nothing is dropped silently, so
 * each one is reported until it is ported (leg IK is reported by the mapping check).
 */
function notYetPorted(mapping: MappingFile, motion: SourceMotion, diagnostics: Diagnostics): void {
  const morphs = [...motion.morphs.values()].filter(morphIsAnimated).map((m) => m.name);
  if (morphs.length) {
    diagnostics.warn(
      Code.UNSUPPORTED_MORPHS,
      `facial animation is not converted by this version yet: ${morphs.length} animated ` +
        `morphs are dropped (${listNames(morphs)})`,
      morphs,
    );
  }
  const chains = mapping.secondary_motion.map((chain) => chain.bones.join(" > "));
  if (chains.length) {
    diagnostics.warn(
      Code.SECONDARY_MOTION,
      "simulated hair/cloth motion is not converted by this version yet; these chains " +
        `stay at rest: ${chains.join(", ")}`,
      mapping.secondary_motion.flatMap((chain) => chain.bones),
    );
  }
}

export function draft(inputs: ConvertInputs, options: ConvertOptions = {}): Draft {
  const diagnostics = new Diagnostics();
  const { model, mapping: mappingFile } = inputs;
  const motion = toSourceMotion(parseVmd(inputs.motion.data, inputs.motion.path), diagnostics);
  if (!isGeckolib(model)) {
    diagnostics.info(
      Code.TARGET_NOT_GECKOLIB,
      `the Blockbench project format is '${model.modelFormat}'; the animation imports ` +
        "fine, but for GeckoLib convert the project (File > Convert Project > GeckoLib " +
        "Animated Model) before exporting the model",
    );
  }
  const mapping = resolve(mappingFile, model.skeleton, motion, diagnostics, {
    mappingPath: inputs.mappingPath,
  });

  notYetPorted(mappingFile, motion, diagnostics);

  const times = sampleTimes(motionDuration(motion), options.fps ?? DEFAULT_FPS);
  const frames = Float64Array.from(times, (t) => t * motion.frameRate);
  const needed = new Set(mapping.bindings.flatMap((b) => b.chain.map((link) => link.source)));
  const poses = new Map<string, PoseSamples>();
  for (const name of [...needed].sort(compareNames)) {
    const track = motion.tracks.get(name);
    if (track) poses.set(name, sampleTrack(track, frames));
  }

  const animation = retarget(poses, times, mapping, model.skeleton, MMD_TO_CANONICAL, {
    name: options.name ?? defaultAnimationName(model, inputs.motion.label),
    loop: options.loop ?? LoopMode.ONCE,
  });
  return {
    animation,
    model,
    diagnostics,
    performs: motion.tracks.size > 0 || motion.morphs.size > 0,
  };
}

export function finish(work: Draft): ConversionResult {
  const { text, stats } = renderAnimation(work.animation, work.model.skeleton);
  return {
    text,
    stats,
    animation: work.animation,
    model: work.model,
    diagnostics: work.diagnostics,
  };
}

export function convert(inputs: ConvertInputs, options: ConvertOptions = {}): ConversionResult {
  return finish(draft(inputs, options));
}
