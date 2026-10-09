/** Check a mapping against a concrete target skeleton and source motion. */

import { RADIANS, type Skeleton } from "../animation/skeleton";
import { trackIsAnimated, trackTranslates, type SourceMotion } from "../animation/source";
import { Code, type Diagnostics } from "../diagnostics";
import { MappingError } from "../errors";
import { toQuat } from "../geometry/euler";
import { IDENTITY, type Quat } from "../geometry/quat";
import { closestMatch, compareNames, globMatch, listNames } from "../text";
import { mappingEntries, type MappingFile } from "./schema";

export interface Link {
  /** Canonical source bone name. */
  readonly source: string;
  readonly weight: number;
}

export interface Binding {
  readonly target: string;
  readonly chain: readonly Link[];
  readonly translation: boolean;
  /** Quaternion, canonical space. */
  readonly restCorrection: Quat;
  /** Nearest mapped ancestor in the target skeleton. */
  readonly anchor: string | undefined;
}

export interface ResolvedMapping {
  /** In target skeleton order. */
  readonly bindings: readonly Binding[];
  readonly translationScale: number;
}

export function unknownTargets(unknown: readonly string[], skeleton: Skeleton): string {
  return unknown
    .map((name) => {
      const close = closestMatch(name, skeleton.names);
      return `  - '${name}'` + (close ? ` (did you mean '${close}'?)` : "");
    })
    .join("\n");
}

export interface ResolveOptions {
  /** Used only in error messages. */
  mappingPath?: string | undefined;
  /** IK bones the source skeleton solves. */
  solvedIk?: ReadonlySet<string>;
}

export function resolve(
  mapping: MappingFile,
  skeleton: Skeleton,
  motion: SourceMotion,
  diagnostics: Diagnostics,
  options: ResolveOptions = {},
): ResolvedMapping {
  const entries = mappingEntries(mapping);
  const unknown = [...entries.keys()].filter((target) => !skeleton.has(target));
  if (unknown.length) {
    throw new MappingError(
      `mapped target bones not found in the model:\n${unknownTargets(unknown, skeleton)}`,
      {
        path: options.mappingPath,
        hint: "the model may have changed; list its bones with `inspect-model`",
      },
    );
  }

  const key = motion.canonicalName;
  const bindings: Binding[] = [];
  for (const bone of skeleton) {
    const entry = entries.get(bone.name);
    if (!entry) continue;
    const degrees = entry.restCorrectionDegrees;
    bindings.push({
      target: bone.name,
      chain: entry.chain.map((link) => ({ source: key(link.bone), weight: link.weight })),
      translation: entry.translation,
      restCorrection: degrees
        ? toQuat([degrees[0] * RADIANS, degrees[1] * RADIANS, degrees[2] * RADIANS])
        : IDENTITY,
      anchor: skeleton.ancestors(bone.name).find((a) => entries.has(a.name))?.name,
    });
  }

  const resolved: ResolvedMapping = { bindings, translationScale: mapping.units.translation_scale };
  report(mapping, resolved, skeleton, motion, diagnostics, options);
  return resolved;
}

function report(
  mapping: MappingFile,
  resolved: ResolvedMapping,
  skeleton: Skeleton,
  motion: SourceMotion,
  diagnostics: Diagnostics,
  options: ResolveOptions,
): void {
  const used = new Set(resolved.bindings.flatMap((b) => b.chain.map((link) => link.source)));
  const ignore = mapping.ignore.map((pattern) => motion.canonicalName(pattern));
  const ignored = (name: string): boolean => ignore.some((pattern) => globMatch(name, pattern));
  const solvedIk = options.solvedIk ?? new Set<string>();

  const missing = [...used].filter((name) => !motion.tracks.has(name)).sort(compareNames);
  if (missing.length) {
    diagnostics.info(
      Code.MAPPED_SOURCE_MISSING,
      `${missing.length} mapped source bones have no keyframes in this motion (held at ` +
        `rest): ${listNames(missing)}`,
      missing,
    );
  }

  const ik = [...motion.ikBones]
    .filter((name) => motion.tracks.has(name) && !solvedIk.has(name) && !ignored(name))
    // IK matters even when its goal is static (it pins feet while the body moves).
    .filter((name) => (motion.ikStates.get(name) ?? [[0, true]]).some(([, on]) => on))
    .sort(compareNames);
  if (ik.length) {
    diagnostics.warn(
      Code.IK_DRIVEN_BONES,
      `motion uses IK bones the source skeleton doesn't define (${listNames(ik)}); bones ` +
        "they drive only follow their own keyframes",
      ik,
    );
  }

  const unmapped = [...motion.tracks]
    .filter(
      ([name, track]) =>
        trackIsAnimated(track) && !used.has(name) && !motion.ikBones.has(name) && !ignored(name),
    )
    .map(([name]) => name)
    .sort(compareNames);
  if (unmapped.length && mapping.unmapped !== "ignore") {
    const message =
      `${unmapped.length} animated source bones are not mapped and their motion is ` +
      `dropped: ${listNames(unmapped)}`;
    if (mapping.unmapped === "error") {
      throw new MappingError(message, {
        path: options.mappingPath,
        hint: 'map them, add them to \'ignore\', or set "unmapped": "warn"',
      });
    }
    diagnostics.warn(Code.UNMAPPED_ANIMATED_BONES, message, unmapped);
  }

  const dropped = new Set<string>();
  for (const binding of resolved.bindings) {
    if (binding.translation) continue;
    for (const link of binding.chain) {
      const track = motion.tracks.get(link.source);
      if (track && trackTranslates(track)) dropped.add(link.source);
    }
  }
  if (dropped.size) {
    const names = [...dropped].sort(compareNames);
    diagnostics.warn(
      Code.TRANSLATION_DROPPED,
      `translation of ${listNames(names)} is dropped because their target entry has no ` +
        '"translation": true',
      names,
    );
  }

  const driven = new Set([
    ...resolved.bindings.map((b) => b.target),
    ...mapping.secondary_motion.flatMap((chain) => chain.bones),
  ]);
  const unbound = skeleton.names.filter((name) => !driven.has(name));
  if (unbound.length) {
    diagnostics.info(
      Code.UNMAPPED_TARGET_BONES,
      `${unbound.length} target bones are not mapped and stay at rest: ${listNames(unbound)}`,
      unbound,
    );
  }

  lintRig(resolved, skeleton, diagnostics);
}

function allClose(a: readonly number[], b: readonly number[]): boolean {
  return a.every((value, i) => Math.abs(value - b[i]!) <= 1e-8 + 1e-5 * Math.abs(b[i]!));
}

/** Mapping-vs-rig mistakes that convert fine but look wrong. */
function lintRig(resolved: ResolvedMapping, skeleton: Skeleton, diagnostics: Diagnostics): void {
  const byTarget = new Map(resolved.bindings.map((b) => [b.target, b]));

  const doubled: string[] = [];
  for (const binding of resolved.bindings) {
    const weights = new Map<string, number>();
    // This chain plus every mapped ancestor's chain.
    for (
      let node: Binding | undefined = binding;
      node;
      node = node.anchor ? byTarget.get(node.anchor) : undefined
    ) {
      for (const link of node.chain) {
        weights.set(link.source, (weights.get(link.source) ?? 0) + link.weight);
      }
    }
    for (const [source, weight] of weights) {
      if (weight > 1 + 1e-9 && binding.chain.some((link) => link.source === source)) {
        doubled.push(`${source} (${binding.target} via ${binding.anchor})`);
      }
    }
  }
  if (doubled.length) {
    diagnostics.warn(
      Code.SOURCE_APPLIED_TWICE,
      "source bones are applied twice because they're also in a mapped ancestor's " +
        `chain: ${listNames(doubled)}; remove them from the child's "from"`,
      doubled,
    );
  }

  const shared: string[] = [];
  for (const binding of resolved.bindings) {
    const bone = skeleton.get(binding.target);
    if (bone.parent !== undefined && byTarget.has(bone.parent)) {
      if (allClose(bone.pivot, skeleton.get(bone.parent).pivot)) {
        shared.push(`${binding.target} (pivot of ${bone.parent})`);
      }
    }
  }
  if (shared.length) {
    diagnostics.warn(
      Code.PIVOT_SHARED_WITH_PARENT,
      `these bones rotate around their parent's pivot: ${listNames(shared)}; if they're ` +
        "separate joints (elbow, knee, chest...), move their pivot to the joint in Blockbench",
      shared,
    );
  }
}
