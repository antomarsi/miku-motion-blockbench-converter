/**
 * Generate a starter mapping from a model's detected body parts.
 *
 * Each target bone's `from` chain is the path, in the standard MMD bone tree
 * (`data/mmd_roles.json`), from its nearest mapped ancestor's source bone to its own.
 * Going *up* the tree emits inverses, so e.g. legs parented to the torso get the upper
 * body's rotation cancelled; MMD's waist-cancel node becomes the waist bone with weight -1.
 */

import { DEGREES, RADIANS, type Skeleton } from "../animation/skeleton";
import faceData from "../data/face_morphs.json";
import roleData from "../data/mmd_roles.json";
import { fromQuat } from "../geometry/euler";
import { angle, cross, normalize, type Quat, type Vec3 } from "../geometry/quat";
import { rolesByRole, type Roles, type Side } from "../model/roles";
import { geometryTip, type Suggestion } from "./secondary";

const MMD_HEIGHT = 20; // MMD units from feet to the top of a standard model's head
const MIN_CORRECTION_DEGREES = 1;

type Tree = Readonly<Record<string, string | null>>;
type Link = string | { bone: string; weight: number };

interface RoleSpec {
  source: string;
  translation?: boolean;
  rest?: string;
  absorb?: string[];
}

const TREE: Tree = roleData.tree;
const INVERSE: Readonly<Record<string, string>> = roleData.inverse;
const ROLE_SPECS: Readonly<Record<string, RoleSpec>> = roleData.roles;

/** `bone` and its ancestors, nearest first. */
function lineage(tree: Tree, bone: string): string[] {
  const out = [bone];
  for (let parent = tree[bone]; parent != null; parent = tree[parent]) out.push(parent);
  return out;
}

function link(node: string, inverse: Readonly<Record<string, string>>, weight: number): Link {
  // A cancel node is the inverse of another bone's rotation.
  const cancelled = inverse[node];
  const bone = cancelled ?? node;
  const signed = cancelled !== undefined ? -weight : weight;
  return signed === 1 ? bone : { bone, weight: signed };
}

/** Chain from `start` (exclusive; `undefined` = the tree root) down to `end`. */
export function sourcePath(
  tree: Tree,
  inverse: Readonly<Record<string, string>>,
  start: string | undefined,
  end: string,
): Link[] {
  const down = lineage(tree, end);
  if (start === undefined) return down.reverse().map((node) => link(node, inverse, 1));
  const up = lineage(tree, start);
  const common = up.find((node) => down.includes(node))!;
  const ups = up.slice(0, up.indexOf(common)); // start ... child of the common ancestor
  const downs = down.slice(0, down.indexOf(common)).reverse(); // below the common ancestor ... end
  return [...ups.map((n) => link(n, inverse, -1)), ...downs.map((n) => link(n, inverse, 1))];
}

function shortestArc(u: Vec3, v: Vec3): Quat {
  const axis = cross(u, v);
  return normalize([axis[0], axis[1], axis[2], 1 + (u[0] * v[0] + u[1] * v[1] + u[2] * v[2])]);
}

/** One decimal, and never `-0`. */
function round1(value: number): number {
  return Number(value.toFixed(1)) + 0;
}

/** Euler degrees turning the target arm's rest direction onto MMD's A-pose. */
function armCorrection(
  skeleton: Skeleton,
  segments: readonly string[],
  side: Side,
  aPose: number,
): [number, number, number] | undefined {
  const first = skeleton.get(segments[0]!);
  const last = skeleton.get(segments[segments.length - 1]!);
  const tip = geometryTip(last, first.pivot);
  if (!tip) return undefined;
  const target: Vec3 = [tip[0] - first.pivot[0], tip[1] - first.pivot[1], tip[2] - first.pivot[2]];
  const length = Math.hypot(...target);
  if (length < 1e-6) return undefined;
  const pose = aPose * RADIANS;
  const sign = side === "left" ? -1 : 1; // canonical: the model's left is -X
  const mmd: Vec3 = [sign * Math.cos(pose), -Math.sin(pose), 0];
  const correction = shortestArc([target[0] / length, target[1] / length, target[2] / length], mmd);
  if (angle(correction) * DEGREES < MIN_CORRECTION_DEGREES) return undefined;
  const euler = fromQuat(correction);
  return [round1(euler[0] * DEGREES), round1(euler[1] * DEGREES), round1(euler[2] * DEGREES)];
}

export interface GeneratedBoneEntry {
  from: Link[];
  translation?: true;
  rest_correction?: { euler_deg: [number, number, number] };
}

/** A generated mapping document, in the order it is written. */
export interface GeneratedMapping {
  schema_version: 1;
  name: string;
  description: string;
  units: { translation_scale: number };
  unmapped: "warn";
  ignore: string[];
  bones: Record<string, string | GeneratedBoneEntry>;
  secondary_motion: { bones: string[]; preset: string }[];
  morphs: Record<string, unknown>[];
}

export function generateMapping(
  skeleton: Skeleton,
  roles: Roles,
  suggestions: readonly Suggestion[],
  name: string,
): GeneratedMapping {
  const byRole = rolesByRole(roles);
  const roleOf = new Map([...byRole].map(([role, bone]) => [bone, role]));
  const sourceOf = (bone: string): string => ROLE_SPECS[roleOf.get(bone)!]!.source;

  const paths = new Map<string, Link[]>();
  for (const bone of skeleton) {
    if (!roleOf.has(bone.name)) continue;
    const anchor = skeleton.ancestors(bone.name).find((a) => roleOf.has(a.name))?.name;
    paths.set(
      bone.name,
      sourcePath(TREE, INVERSE, anchor !== undefined ? sourceOf(anchor) : undefined, sourceOf(bone.name)),
    );
  }
  const onPaths = new Set(
    [...paths.values()].flat().map((entry) => (typeof entry === "string" ? entry : entry.bone)),
  );

  const bones: GeneratedMapping["bones"] = {};
  for (const [boneName, path] of paths) {
    const spec = ROLE_SPECS[roleOf.get(boneName)!]!;
    const chain = [...path, ...(spec.absorb ?? []).filter((bone) => !onPaths.has(bone))];
    const entry: GeneratedBoneEntry = { from: chain };
    if (spec.translation) entry.translation = true;
    if (spec.rest) {
      const side = spec.rest.replace(/^arm_/, "") as Side;
      const correction = armCorrection(skeleton, roles.arms.get(side) ?? [], side, roleData.a_pose_degrees);
      if (correction) entry.rest_correction = { euler_deg: correction };
    }
    const only = chain[0];
    bones[boneName] =
      Object.keys(entry).length === 1 && chain.length === 1 && typeof only === "string" ? only : entry;
  }

  const solid = skeleton.bones.filter((b) => b.extent).map((b) => b.extent!);
  const ground = Math.min(...solid.map((e) => e[0][1]));
  const head = roles.head ? skeleton.get(roles.head).extent : undefined;
  const top = head ? head[1][1] : Math.max(...solid.map((e) => e[1][1]));
  const height = top - ground; // feet to the top of the head (hair excluded)
  return {
    schema_version: 1,
    name: `MMD standard bones -> ${name}`,
    description: "Generated by `miku-motion init-mapping`; review and adjust.",
    units: { translation_scale: Number((height / MMD_HEIGHT).toFixed(3)) },
    unmapped: "warn",
    ignore: [...roleData.ignore],
    bones,
    secondary_motion: suggestions.map((s) => ({ bones: [...s.bones], preset: s.preset })),
    morphs: faceRules(skeleton, roles),
  };
}

// Numbers under these keys are measurements: written with a decimal point even when whole.
const FLOAT_KEYS = new Set(["euler_deg", "translation_scale"]);

function number(value: number, asFloat: boolean): string {
  const text = String(value);
  return asFloat && Number.isInteger(value) ? `${text}.0` : text;
}

/** Compact JSON on one line, with a space after `,` and `:`. */
function line(value: unknown, asFloat = false): string {
  if (typeof value === "number") return number(value, asFloat);
  if (Array.isArray(value)) return `[${value.map((item) => line(item, asFloat)).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${line(item, asFloat || FLOAT_KEYS.has(key))}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** JSON with one bone entry / chain per line (easy to read and edit). */
export function renderMapping(mapping: GeneratedMapping): string {
  const lists = new Set(["bones", "secondary_motion", "morphs"]);
  const lines = ["{"];
  for (const [key, value] of Object.entries(mapping)) {
    if (!lists.has(key)) lines.push(`  ${line(key)}: ${line(value)},`);
  }
  const boneLines = Object.entries(mapping.bones).map(([k, v]) => `    ${line(k)}: ${line(v)}`);
  lines.push('  "bones": {', boneLines.join(",\n"), "  },");
  const chainLines = mapping.secondary_motion.map((chain) => `    ${line(chain)}`);
  lines.push('  "secondary_motion": [', chainLines.join(",\n"), "  ],");
  const morphLines = mapping.morphs.map((rule) => `    ${line(rule)}`);
  lines.push('  "morphs": [', morphLines.join(",\n"), "  ]", "}");
  return `${lines.join("\n")}\n`;
}

// --- face ---------------------------------------------------------------------------------

/** Tokens of a name, letters and digits together (`mouth_a2` -> `["mouth", "a2"]`). */
function faceTokens(name: string): string[] {
  const spaced = name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ");
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token)
    .map((token) => token.toLowerCase());
}

/**
 * Morph rules for face bones found inside the head, from their names.
 *
 * - eyelids (`eyelid`/`lid`): close with blinks, smiles and their side's wink
 * - an eyes group (`eyes`): squashes for blinks; single eyes (`eye`): their wink, and
 *   blinks too when there's no eyes group
 * - mouth shapes (`mouth_a` .. `mouth_o`, `mouth_closed`): swapped by the vowels
 * - a single mouth: scaled by each vowel
 *
 * Sides come from the bone's pivot (the model's left is -X), not its name.
 *
 * Squashing and stretching happen about the bone's pivot, so a part only gets such a rule
 * when its pivot is on the part itself; `unanimatedFaceParts` lists the others.
 */
export function faceRules(skeleton: Skeleton, roles: Roles): Record<string, unknown>[] {
  return facePlan(skeleton, roles).rules;
}

/** Face parts that were recognised but left still, because scaling would move them. */
export function unanimatedFaceParts(skeleton: Skeleton, roles: Roles): string[] {
  return facePlan(skeleton, roles).still;
}

/**
 * Whether scaling the bone about its pivot keeps it where it is, across and up. Shrinking
 * stays inside the part when the pivot is anywhere on it (`reach` 1/2: eyes may close
 * towards an edge); growing spills over the neighbours unless the pivot is in the middle
 * half (`reach` 1/4). Parts without cubes can't be judged.
 */
function scalesInPlace(skeleton: Skeleton, name: string, reach: number): boolean {
  const boxes = skeleton.bones
    .filter((b) => b.extent && (b.name === name || skeleton.ancestors(b.name).some((a) => a.name === name)))
    .map((b) => b.extent!);
  if (!boxes.length) return true;
  const { pivot } = skeleton.get(name);
  return [0, 1].every((axis) => {
    const low = Math.min(...boxes.map((box) => box[0][axis]!));
    const high = Math.max(...boxes.map((box) => box[1][axis]!));
    return Math.abs(pivot[axis]! - (low + high) / 2) <= (high - low) * reach + 1e-6;
  });
}

function facePlan(skeleton: Skeleton, roles: Roles): { rules: Record<string, unknown>[]; still: string[] } {
  if (!roles.head) return { rules: [], still: [] };
  const { head } = roles;
  const skip = new Set(faceData.skip_tokens);
  const headParts = skeleton.bones.filter((b) => skeleton.ancestors(b.name).some((a) => a.name === head));
  const closed = faceData.eyes_closed;
  const vowels: Readonly<Record<string, string[]>> = faceData.vowels;
  const mouthScale: Readonly<Record<string, number[]>> = faceData.mouth_scale;
  const threshold = faceData.swap_threshold;
  const wink = (name: string): string[] =>
    skeleton.get(name).pivot[0] < 0 ? faceData.wink_left : faceData.wink_right;

  const eyelids: string[] = [];
  const eyeGroups: string[] = [];
  const eyes: string[] = [];
  const mouthShapes = new Map<string, string>();
  const mouths: string[] = [];
  for (const bone of headParts) {
    const tokens = faceTokens(bone.name);
    if (tokens.some((token) => skip.has(token))) continue;
    if (tokens.includes("eyelid") || tokens.includes("lid")) {
      eyelids.push(bone.name);
    } else if (tokens.includes("eyes")) {
      eyeGroups.push(bone.name);
    } else if (tokens.includes("eye")) {
      eyes.push(bone.name);
    } else if (tokens.includes("mouth")) {
      const shape = tokens.find((t) => t in vowels || t === "closed" || t === "close");
      if (shape) mouthShapes.set(bone.name, shape.startsWith("clos") ? "closed" : shape);
      else mouths.push(bone.name);
    }
  }

  const still: string[] = [];
  const inPlace = (names: string[], reach: number): string[] =>
    names.filter((name) => scalesInPlace(skeleton, name, reach) || (still.push(name), false));
  const squashedGroups = inPlace(eyeGroups, 1 / 2);
  const squashedEyes = inPlace(eyes, 1 / 2);
  const scaledMouths = mouthShapes.size ? [] : inPlace(mouths, 1 / 4);

  const rules: { morph: string[]; bone: string; [effect: string]: unknown }[] = [];
  for (const name of eyelids) {
    rules.push({ morph: [...closed, ...wink(name)], bone: name, scale_from: [1, 0, 1], scale: [1, 1, 1] });
  }
  for (const name of squashedGroups) rules.push({ morph: closed, bone: name, scale: faceData.eye_squash });
  for (const name of squashedEyes) {
    rules.push({
      morph: [...wink(name), ...(squashedGroups.length ? [] : closed)],
      bone: name,
      scale: faceData.eye_squash,
    });
  }
  const allVowels = Object.values(vowels).flat();
  for (const [name, shape] of mouthShapes) {
    if (shape === "closed") rules.push({ morph: allVowels, bone: name, hide_above: threshold });
    else rules.push({ morph: vowels[shape]!, bone: name, show_above: threshold });
  }
  for (const name of scaledMouths) {
    for (const [vowel, scale] of Object.entries(mouthScale)) {
      rules.push({ morph: vowels[vowel]!, bone: name, scale });
    }
  }
  return {
    rules: rules.map((rule) => ({ ...rule, morph: rule.morph.length === 1 ? rule.morph[0] : rule.morph })),
    still,
  };
}
