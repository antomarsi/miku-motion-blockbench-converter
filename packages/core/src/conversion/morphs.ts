/**
 * Facial animation: drive target bones from source morph weights.
 *
 * GeckoLib animations only move bones, so each morph rule turns a morph's weight into a
 * bone effect: a scale blend (eyelids closing, a mouth opening), a position or rotation
 * offset, or a swap that shows/hides a bone (a scale of 0 hides it). Rules on the same
 * bone combine: scales multiply, offsets add, and a bone with "show" rules is visible only
 * while one of them is active.
 */

import type { Animation, BoneTrack } from "../animation/clip";
import { sampleMorph } from "../animation/sampling";
import type { Skeleton } from "../animation/skeleton";
import { morphIsAnimated, type SourceMotion } from "../animation/source";
import { Code, type Diagnostics } from "../diagnostics";
import { MappingError } from "../errors";
import { positionFromChannel, rotationDeltaFromChannel } from "../geckolib/encoding";
import { getQuat, makeContinuous, mul, setQuat } from "../geometry/quat";
import { unknownTargets } from "../mapping/resolve";
import { ruleMorphs, type MorphRule } from "../mapping/schema";
import { compareNames, listNames } from "../text";

export interface ResolvedMorphRule {
  readonly rule: MorphRule;
  /** Canonical source morph names. */
  readonly morphs: readonly string[];
}

export function resolveMorphRules(
  rules: readonly MorphRule[],
  skeleton: Skeleton,
  motion: SourceMotion,
  diagnostics: Diagnostics,
  mappingPath?: string,
): ResolvedMorphRule[] {
  const unknown = [...new Set(rules.map((r) => r.bone).filter((bone) => !skeleton.has(bone)))].sort(
    compareNames,
  );
  if (unknown.length) {
    throw new MappingError(
      `morph rules use bones not found in the model:\n${unknownTargets(unknown, skeleton)}`,
      { path: mappingPath },
    );
  }
  const resolved = rules.map((rule) => ({
    rule,
    morphs: ruleMorphs(rule).map((morph) => motion.canonicalName(morph)),
  }));
  const used = new Set(resolved.flatMap((r) => r.morphs));
  const animated = [...motion.morphs]
    .filter(([, track]) => morphIsAnimated(track))
    .map(([name]) => name)
    .sort(compareNames);
  const unmapped = animated.filter((morph) => !used.has(morph));
  if (unmapped.length && !rules.length) {
    diagnostics.warn(
      Code.UNSUPPORTED_MORPHS,
      `facial animation is not converted: ${unmapped.length} animated morphs ` +
        `(${listNames(unmapped)}) but the mapping has no morph rules; \`miku-motion ` +
        "init-mapping` generates them for face bones",
      unmapped,
    );
  } else if (unmapped.length) {
    diagnostics.warn(
      Code.UNSUPPORTED_MORPHS,
      `${unmapped.length} animated morphs have no morph rule and are dropped: ` +
        listNames(unmapped),
      unmapped,
    );
  }
  const animatedSet = new Set(animated);
  const driven = [
    ...new Set(resolved.filter((r) => r.morphs.some((m) => animatedSet.has(m))).map((r) => r.rule.bone)),
  ].sort(compareNames);
  if (driven.length) {
    const count = [...used].filter((morph) => animatedSet.has(morph)).length;
    diagnostics.info(
      Code.FACIAL_ANIMATION,
      `facial animation drives ${listNames(driven)} from ${count} morphs`,
      driven,
    );
  }
  return resolved;
}

/** Add the morph-driven channels to `animation` (in place). */
export function applyMorphRules(
  animation: Animation,
  skeleton: Skeleton,
  motion: SourceMotion,
  rules: readonly ResolvedMorphRule[],
): void {
  const count = animation.times.length;
  const frames = Float64Array.from(animation.times, (t) => t * motion.frameRate);
  const cache = new Map<string, Float64Array>();

  /** The strongest of the named morphs per sample, clamped to 0..1. */
  const weight = (names: readonly string[]): Float64Array => {
    const out = new Float64Array(count);
    for (const name of names) {
      let sampled = cache.get(name);
      if (!sampled) {
        const track = motion.morphs.get(name);
        sampled = track ? sampleMorph(track, frames) : new Float64Array(count);
        cache.set(name, sampled);
      }
      for (let n = 0; n < count; n++) out[n] = Math.max(out[n]!, sampled[n]!);
    }
    for (let n = 0; n < count; n++) out[n] = Math.min(Math.max(out[n]!, 0), 1);
    return out;
  };

  const byBone = new Map<string, ResolvedMorphRule[]>();
  for (const resolved of rules) {
    const list = byBone.get(resolved.rule.bone);
    if (list) list.push(resolved);
    else byBone.set(resolved.rule.bone, [resolved]);
  }

  for (const [boneName, boneRules] of byBone) {
    const bone = skeleton.get(boneName);
    const scale = new Float64Array(3 * count).fill(1);
    const offset = new Float64Array(3 * count);
    const turn = new Float64Array(3 * count);
    const shown = new Uint8Array(count);
    const hidden = new Uint8Array(count);
    let hasShowRules = false;
    for (const { rule, morphs } of boneRules) {
      const w = weight(morphs);
      if (rule.scale !== undefined) {
        for (let n = 0; n < count; n++) {
          for (let axis = 0; axis < 3; axis++) {
            const start = rule.scale_from[axis]!;
            scale[3 * n + axis] = scale[3 * n + axis]! * (start + w[n]! * (rule.scale[axis]! - start));
          }
        }
      } else if (rule.position !== undefined) {
        for (let n = 0; n < count; n++) {
          for (let axis = 0; axis < 3; axis++) offset[3 * n + axis] = offset[3 * n + axis]! + w[n]! * rule.position[axis]!;
        }
      } else if (rule.rotation !== undefined) {
        for (let n = 0; n < count; n++) {
          for (let axis = 0; axis < 3; axis++) turn[3 * n + axis] = turn[3 * n + axis]! + w[n]! * rule.rotation[axis]!;
        }
      } else if (rule.show_above !== undefined) {
        hasShowRules = true;
        for (let n = 0; n < count; n++) if (w[n]! >= rule.show_above) shown[n] = 1;
      } else if (rule.hide_above !== undefined) {
        for (let n = 0; n < count; n++) if (w[n]! >= rule.hide_above) hidden[n] = 1;
      }
    }
    for (let n = 0; n < count; n++) {
      const visible = (hasShowRules ? shown[n] === 1 : true) && hidden[n] === 0;
      if (!visible) scale.fill(0, 3 * n, 3 * n + 3);
    }

    const track: BoneTrack = animation.tracks.get(boneName) ?? {};
    let { rotations, translations, scales } = track;
    let changed = false;
    if (scale.some((value) => value !== 1)) {
      scales = scales ? scales.map((value, i) => value * scale[i]!) : scale;
      changed = true;
    }
    if (offset.some((value) => value !== 0)) {
      const moved = new Float64Array(3 * count);
      for (let n = 0; n < count; n++) {
        moved.set(positionFromChannel([offset[3 * n]!, offset[3 * n + 1]!, offset[3 * n + 2]!]), 3 * n);
      }
      translations = translations ? translations.map((value, i) => value + moved[i]!) : moved;
      changed = true;
    }
    if (turn.some((value) => value !== 0)) {
      const turned = new Float64Array(4 * count);
      for (let n = 0; n < count; n++) {
        const base = rotations ? getQuat(rotations, n) : bone.restRotation;
        const delta = rotationDeltaFromChannel([turn[3 * n]!, turn[3 * n + 1]!, turn[3 * n + 2]!]);
        setQuat(turned, n, mul(base, delta));
      }
      rotations = makeContinuous(turned);
      changed = true;
    }
    if (changed) animation.tracks.set(boneName, { rotations, translations, scales });
  }
}
