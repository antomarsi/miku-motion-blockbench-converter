/**
 * The bone-mapping file: how source (MMD) bones drive target (Blockbench) bones.
 *
 * Keyed by **target** bone. Each entry lists the chain of source bones, parent to child,
 * from the bone after the nearest mapped target ancestor's chain down to this bone.
 * Their local rotations are multiplied in order.
 *
 * ```json
 * {
 *   "schema_version": 1,
 *   "units": {"translation_scale": 1.0},
 *   "ignore": ["glob*"],
 *   "bones": {
 *     "TargetA": "SourceA",
 *     "TargetB": {"from": ["S1", {"bone": "S2", "weight": -1}, "S3"], "translation": true,
 *                 "rest_correction": {"euler_deg": [0, 0, 37]}}
 *   }
 * }
 * ```
 *
 * The types keep the file's own field names.
 */

import * as z from "zod";

import { MappingError } from "../errors";

export const SCHEMA_VERSION = 1;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const chainLink = z.strictObject({
  bone: z.string().min(1),
  /** Rotation scale; -1 applies the inverse (e.g. a "cancel" bone). */
  weight: z.number().default(1),
});

/** Rotation taking the target's rest pose to the source's rest pose (ZYX, degrees). */
const restCorrection = z.strictObject({
  euler_deg: vec3.default([0, 0, 0]),
});

const boneEntry = z.strictObject({
  from: z.array(z.union([z.string().min(1), chainLink])).min(1),
  translation: z.boolean().default(false),
  rest_correction: restCorrection.optional(),
});

export const SECONDARY_PRESETS = ["long_hair", "ponytail", "short_hair", "cloth", "accessory"] as const;

/**
 * A springy chain of target bones (hair, tie...) simulated from the body's motion.
 * Unset values come from `preset` (default `long_hair`).
 */
const secondaryMotionSpec = z
  .strictObject({
    /** Parent to child. */
    bones: z.array(z.string()).min(1),
    preset: z.enum(SECONDARY_PRESETS).optional(),
    /** End of the last bone; default: from its cubes. */
    tip: vec3.optional(),
    /** Higher = follows the body more. */
    stiffness: z.number().positive().optional(),
    /** 0 = no overshoot, 1 = springy. */
    bounciness: z.number().min(0).max(1).optional(),
    /** Advanced: instead of bounciness. */
    damping: z.number().min(0).optional(),
    /** 1 = real gravity at Minecraft scale. */
    gravity: z.number().min(0).optional(),
    /** Pixels; rest shift of the tip (+Z = back). */
    offset: vec3.default([0, 0, 0]),
    /** Max swing, degrees. */
    max_angle: z.number().positive().max(180).optional(),
    /**
     * Body parts the chain can't pass through: `true` (default) picks the head and
     * trunk, `false` turns collision off, a list names the bones to avoid.
     */
    collide: z.union([z.boolean(), z.array(z.string())]).optional(),
    /** Pixels kept between the chain's joints and those parts; default: half its thickness. */
    collision_padding: z.number().min(0).optional(),
  })
  .superRefine((spec, context) => {
    if (spec.damping !== undefined && spec.bounciness !== undefined) {
      context.addIssue({ code: "custom", message: "set either bounciness or damping, not both" });
    }
  });

/**
 * How a source morph (facial expression) moves a target bone.
 *
 * The morph's weight (0..1; the strongest one when several are listed) drives exactly
 * one effect. Rotation and position use the values Blockbench displays.
 */
const morphRule = z
  .strictObject({
    morph: z.union([z.string(), z.array(z.string())]),
    bone: z.string().min(1),
    /** Reached at weight 1 ... */
    scale: vec3.optional(),
    /** ... from this at weight 0. */
    scale_from: vec3.default([1, 1, 1]),
    /** Pixel offset at weight 1. */
    position: vec3.optional(),
    /** Degrees at weight 1. */
    rotation: vec3.optional(),
    /** Visible only past this weight. */
    show_above: z.number().min(0).max(1).optional(),
    /** Hidden past this weight. */
    hide_above: z.number().min(0).max(1).optional(),
  })
  .superRefine((rule, context) => {
    const effects = [rule.scale, rule.position, rule.rotation, rule.show_above, rule.hide_above];
    if (effects.filter((e) => e !== undefined).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "set exactly one of scale, position, rotation, show_above or hide_above",
      });
    }
    if (rule.scale === undefined && rule.scale_from.some((v) => v !== 1)) {
      context.addIssue({ code: "custom", message: "scale_from only goes with scale" });
    }
    if (Array.isArray(rule.morph) && rule.morph.length === 0) {
      context.addIssue({ code: "custom", message: "name at least one morph" });
    }
  });

const mappingFile = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  name: z.string().nullish(),
  description: z.string().nullish(),
  units: z
    .strictObject({
      /** Target units per source unit. */
      translation_scale: z.number().positive().default(1),
    })
    .default({ translation_scale: 1 }),
  unmapped: z.enum(["warn", "error", "ignore"]).default("warn"),
  ignore: z.array(z.string()).default([]),
  bones: z
    .record(z.string(), z.union([z.string().min(1), boneEntry]))
    .refine((bones) => Object.keys(bones).length > 0, "must map at least one target bone"),
  secondary_motion: z.array(secondaryMotionSpec).default([]),
  /** Facial animation. */
  morphs: z.array(morphRule).default([]),
});

export type ChainLink = z.infer<typeof chainLink>;
export type BoneEntry = z.infer<typeof boneEntry>;
export type SecondaryMotionSpec = z.infer<typeof secondaryMotionSpec>;
export type MorphRule = z.infer<typeof morphRule>;
export type MappingFile = z.infer<typeof mappingFile>;

/** One target's entry in long form. */
export interface MappingEntry {
  readonly chain: readonly ChainLink[];
  readonly translation: boolean;
  readonly restCorrectionDegrees: readonly [number, number, number] | undefined;
}

/** Every target entry in long form (string shorthand expanded), in file order. */
export function mappingEntries(mapping: MappingFile): Map<string, MappingEntry> {
  const out = new Map<string, MappingEntry>();
  for (const [target, value] of Object.entries(mapping.bones)) {
    const entry = typeof value === "string" ? { from: [value], translation: false } : value;
    out.set(target, {
      chain: entry.from.map((link) => (typeof link === "string" ? { bone: link, weight: 1 } : link)),
      translation: entry.translation,
      restCorrectionDegrees:
        "rest_correction" in entry ? entry.rest_correction?.euler_deg : undefined,
    });
  }
  return out;
}

/** The morphs a rule listens to. */
export function ruleMorphs(rule: MorphRule): string[] {
  return typeof rule.morph === "string" ? [rule.morph] : [...rule.morph];
}

type Issue = z.core.$ZodIssue;

/**
 * Flatten "none of the alternatives matched" into the errors of the alternative the
 * user most likely meant: the one that got past the value's basic type.
 */
function leaves(issue: Issue, prefix: PropertyKey[] = []): { path: PropertyKey[]; message: string }[] {
  const path = [...prefix, ...issue.path];
  if (issue.code === "invalid_union" && issue.errors.length) {
    const typed = issue.errors.filter(
      (errors) => !errors.some((e) => e.code === "invalid_type" && e.path.length === 0),
    );
    const chosen = typed[0] ?? issue.errors[issue.errors.length - 1]!;
    return chosen.flatMap((inner) => leaves(inner, path));
  }
  return [{ path, message: issue.message }];
}

function describe(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => leaves(issue))
    .map(({ path, message }) => `  - ${path.map(String).join(".") || "(top level)"}: ${message}`)
    .join("\n");
}

/** Validate a parsed mapping document. `path` is used only for error messages. */
export function parseMapping(data: unknown, path?: string): MappingFile {
  const result = mappingFile.safeParse(data);
  if (!result.success) {
    throw new MappingError(`invalid mapping file:\n${describe(result.error)}`, { path });
  }
  return result.data;
}

/** Parse and validate the text of a mapping file. */
export function parseMappingText(text: string, path?: string): MappingFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MappingError(`not valid JSON: ${reason}`, { path });
  }
  return parseMapping(data, path);
}
