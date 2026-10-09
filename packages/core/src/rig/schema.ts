/**
 * Source skeleton files (JSON): bones, inherited rotations and IK chains.
 *
 * ```json
 * {
 *   "schema_version": 1,
 *   "name": "...",
 *   "bones": [
 *     {"name": "Hip", "parent": null, "position": [0, 10, 0]},
 *     {"name": "Cancel", "parent": "Hip", "position": [1, 10, 0],
 *      "inherit": {"bone": "Waist", "weight": -1}}
 *   ],
 *   "ik": [
 *     {"bone": "LegIK", "target": "Ankle", "iterations": 40, "limit_angle_deg": 114.59,
 *      "links": [{"bone": "Knee", "min_deg": [-180, 0, 0], "max_deg": [-0.5, 0, 0]},
 *                {"bone": "Thigh"}]}
 *   ]
 * }
 * ```
 *
 * Bones must be listed parents first. IK links run from the target's parent upwards,
 * each one the parent of the previous.
 */

import * as z from "zod";

import { RADIANS } from "../animation/skeleton";
import mmdStandard from "../data/skeletons/mmd-standard.json";
import { SkeletonError } from "../errors";
import type { Vec3 } from "../geometry/quat";
import { SourceRig, type IkChain, type RigBone } from "./model";

export const DEFAULT_SKELETON = "mmd-standard";
const BUILTIN: Readonly<Record<string, unknown>> = { [DEFAULT_SKELETON]: mmdStandard };

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const skeletonFile = z.strictObject({
  schema_version: z.literal(1).default(1),
  name: z.string(),
  description: z.string().nullish(),
  bones: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        parent: z.string().nullish(),
        position: vec3,
        inherit: z.strictObject({ bone: z.string(), weight: z.number() }).nullish(),
      }),
    )
    .min(1),
  ik: z
    .array(
      z.strictObject({
        bone: z.string(),
        target: z.string(),
        iterations: z.number().int().min(1).max(1000).default(40),
        limit_angle_deg: z.number().positive().default(114.5916),
        links: z
          .array(
            z.strictObject({
              bone: z.string(),
              min_deg: vec3.nullish(),
              max_deg: vec3.nullish(),
            }),
          )
          .min(1),
      }),
    )
    .default([]),
});

type SkeletonFile = z.infer<typeof skeletonFile>;

const radians = (degrees: Vec3): Vec3 => [
  degrees[0] * RADIANS,
  degrees[1] * RADIANS,
  degrees[2] * RADIANS,
];

function build(spec: SkeletonFile, source: string): SourceRig {
  const bones = new Map<string, RigBone>();
  for (const b of spec.bones) {
    if (bones.has(b.name)) {
      throw new SkeletonError(`bone '${b.name}' is listed twice`, { path: source });
    }
    const parent = b.parent ?? undefined;
    if (parent !== undefined && !bones.has(parent)) {
      throw new SkeletonError(`bone '${b.name}' must come after its parent '${parent}'`, {
        path: source,
      });
    }
    bones.set(b.name, {
      name: b.name,
      parent,
      position: b.position,
      inherit: b.inherit ? { bone: b.inherit.bone, weight: b.inherit.weight } : undefined,
    });
  }
  for (const bone of bones.values()) {
    if (bone.inherit && !bones.has(bone.inherit.bone)) {
      throw new SkeletonError(
        `bone '${bone.name}' inherits from unknown bone '${bone.inherit.bone}'`,
        { path: source },
      );
    }
  }

  const chains: IkChain[] = [];
  for (const ik of spec.ik) {
    const names = [ik.bone, ik.target, ...ik.links.map((link) => link.bone)];
    const unknown = names.filter((name) => !bones.has(name));
    if (unknown.length) {
      throw new SkeletonError(`IK '${ik.bone}' uses unknown bones [${unknown.join(", ")}]`, {
        path: source,
      });
    }
    let expectedChild = ik.target;
    for (const link of ik.links) {
      if (bones.get(expectedChild)!.parent !== link.bone) {
        throw new SkeletonError(
          `IK '${ik.bone}': '${link.bone}' must be the parent of '${expectedChild}' ` +
            "(links run from the target's parent upwards)",
          { path: source },
        );
      }
      expectedChild = link.bone;
    }
    chains.push({
      bone: ik.bone,
      target: ik.target,
      links: ik.links.map((link) => ({
        bone: link.bone,
        minAngles: link.min_deg ? radians(link.min_deg) : undefined,
        maxAngles: link.max_deg ? radians(link.max_deg) : undefined,
      })),
      iterations: ik.iterations,
      limitAngle: ik.limit_angle_deg * RADIANS,
    });
  }
  return new SourceRig(spec.name, bones, chains);
}

/** Validate a parsed skeleton document. `source` names it in error messages. */
export function parseSkeleton(data: unknown, source: string): SourceRig {
  const result = skeletonFile.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("\n");
    throw new SkeletonError(`invalid skeleton file:\n${details}`, { path: source });
  }
  return build(result.data, source);
}

export function parseSkeletonText(text: string, source: string): SourceRig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SkeletonError(`not valid JSON: ${reason}`, { path: source });
  }
  return parseSkeleton(data, source);
}

export function builtinSkeletonNames(): string[] {
  return Object.keys(BUILTIN).sort();
}

/** A built-in skeleton by name (e.g. `mmd-standard`). */
export function builtinSkeleton(name: string = DEFAULT_SKELETON): SourceRig {
  const data = BUILTIN[name];
  if (data === undefined) {
    throw new SkeletonError(
      `unknown built-in skeleton '${name}'; available: [${builtinSkeletonNames().join(", ")}]`,
    );
  }
  return parseSkeleton(data, `built-in:${name}`);
}
