/**
 * Secondary-motion chains in the mapping: validation, presets, tips and suggestions.
 *
 * Nothing here depends on the model having IK set up in Blockbench: a chain is just a
 * list of the model's bones. A one-bone chain (short hair, a single back ponytail) works
 * when the bone has cubes, since its tip is found from the geometry.
 */

import type { Bone, Skeleton } from "../animation/skeleton";
import type { ChainSpec, Collider } from "../conversion/secondary";
import keywordData from "../data/secondary_keywords.json";
import { MappingError } from "../errors";
import type { Vec3 } from "../geometry/quat";
import { detectRoles } from "../model/roles";
import { unknownTargets } from "./resolve";
import type { MappingFile, SecondaryMotionSpec } from "./schema";

export interface Preset {
  /** 1/s^2 */
  readonly stiffness: number;
  /** 0 = settles without overshoot, 1 = keeps bouncing. */
  readonly bounciness: number;
  readonly gravity: number;
  /** Degrees a segment may swing from its resting direction. */
  readonly maxAngle: number;
}

export const PRESETS: Readonly<Record<string, Preset>> = {
  long_hair: { stiffness: 40, bounciness: 0.5, gravity: 1, maxAngle: 100 },
  ponytail: { stiffness: 60, bounciness: 0.55, gravity: 1, maxAngle: 90 },
  short_hair: { stiffness: 160, bounciness: 0.3, gravity: 0.6, maxAngle: 45 },
  cloth: { stiffness: 90, bounciness: 0.35, gravity: 1, maxAngle: 60 },
  accessory: { stiffness: 70, bounciness: 0.7, gravity: 1, maxAngle: 75 },
};
export const DEFAULT_PRESET = "long_hair";

/** Damping giving a damping ratio of `1 - bounciness` (1 = no overshoot). */
export function dampingFor(stiffness: number, bounciness: number): number {
  return 2 * Math.sqrt(stiffness) * (1 - bounciness);
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Where the bone's cubes end: the centre of their bounding box's face farthest from
 * `origin` (default: the bone's pivot). Pass the chain's first pivot for multi-bone
 * chains: a short last piece (a 2 px hand) may be wider than tall, so measured from
 * its own pivot a side face could look farthest.
 */
export function geometryTip(bone: Bone, origin?: Vec3): Vec3 | undefined {
  if (!bone.extent) return undefined;
  const [low, high] = bone.extent;
  const center: Vec3 = [0.5 * (low[0] + high[0]), 0.5 * (low[1] + high[1]), 0.5 * (low[2] + high[2])];
  const start = origin ?? bone.pivot;
  let best: Vec3 | undefined;
  let bestDistance = -1;
  for (let axis = 0; axis < 3; axis++) {
    for (const bound of [low[axis]!, high[axis]!]) {
      const face = [...center] as [number, number, number];
      face[axis] = bound;
      const d = distance(face, start);
      if (d > bestDistance) {
        bestDistance = d;
        best = face;
      }
    }
  }
  return bestDistance < 1e-6 ? undefined : best;
}

const quoted = (name: string): string => `'${name}'`;

function tipOf(
  spec: SecondaryMotionSpec,
  skeleton: Skeleton,
  where: string,
  path: string | undefined,
): Vec3 {
  if (spec.tip) return spec.tip;
  const first = skeleton.get(spec.bones[0]!);
  const last = skeleton.get(spec.bones[spec.bones.length - 1]!);
  const fromGeometry = geometryTip(last, first.pivot);
  if (fromGeometry) return fromGeometry;
  if (spec.bones.length >= 2) {
    const before = skeleton.get(spec.bones[spec.bones.length - 2]!).pivot;
    const end = last.pivot;
    return [end[0] + (end[0] - before[0]), end[1] + (end[1] - before[1]), end[2] + (end[2] - before[2])];
  }
  throw new MappingError(
    `${where}: ${quoted(first.name)} has no cubes to measure, so give the chain a "tip" ` +
      "(where the bone ends)",
    { path },
  );
}

const DEFAULT_PADDING = 0.5; // px, for chains without cubes to measure
const EMBEDDED = 1.0; // px: a joint deeper than this inside a part at rest belongs there
const CLEARANCE = 0.01; // px kept between a resting chain and a padded collider

/** Half the thickness of the chain's pieces: how far its joints stay from the body. */
function chainPadding(skeleton: Skeleton, bones: readonly string[]): number {
  let thickest = 0;
  for (const name of bones) {
    const extent = skeleton.get(name).extent;
    if (!extent) continue;
    const [low, high] = extent;
    thickest = Math.max(thickest, Math.min(high[0] - low[0], high[1] - low[1], high[2] - low[2]));
  }
  return thickest > 0 ? 0.5 * thickest : DEFAULT_PADDING;
}

/**
 * The box around `bone`'s cubes, grown by `padding` but never so far that the resting
 * chain would touch it: the rest shape must stay as modelled.
 */
function colliderFor(bone: Bone, points: readonly Vec3[], padding: number): Collider | undefined {
  if (!bone.extent) return undefined;
  const [low, high] = bone.extent;
  const center: Vec3 = [0.5 * (low[0] + high[0]), 0.5 * (low[1] + high[1]), 0.5 * (low[2] + high[2])];
  const half: Vec3 = [0.5 * (high[0] - low[0]), 0.5 * (high[1] - low[1]), 0.5 * (high[2] - low[2])];
  // How far outside the box a point is (negative: that deep inside).
  const outside = (p: Vec3): number =>
    Math.max(
      Math.abs(p[0] - center[0]) - half[0],
      Math.abs(p[1] - center[1]) - half[1],
      Math.abs(p[2] - center[2]) - half[2],
    );
  const free: number[] = [];
  let room = padding;
  points.forEach((point, j) => {
    const gap = outside(point);
    if (gap < -EMBEDDED) {
      free.push(j);
      return;
    }
    room = Math.min(room, gap - CLEARANCE);
    const before = points[j - 1];
    if (before && !free.includes(j - 1)) {
      const middle: Vec3 = [
        0.5 * (before[0] + point[0]),
        0.5 * (before[1] + point[1]),
        0.5 * (before[2] + point[2]),
      ];
      room = Math.min(room, outside(middle) - CLEARANCE);
    }
  });
  const grown: Vec3 = [half[0] + room, half[1] + room, half[2] + room];
  if (grown.some((value) => value <= 0)) return undefined;
  return { bone: bone.name, center, half: grown, ...(free.length ? { free } : {}) };
}

export interface SecondaryOptions {
  /** Keep chains out of the body (default). `false` ignores every chain's `collide`. */
  readonly collide?: boolean;
}

/** Validate `secondary_motion` chains against the target skeleton. */
export function resolveSecondary(
  mapping: MappingFile,
  skeleton: Skeleton,
  mappingPath?: string,
  options: SecondaryOptions = {},
): ChainSpec[] {
  const chains: ChainSpec[] = [];
  const swinging = new Set(mapping.secondary_motion.flatMap((spec) => spec.bones));
  let trunk: string[] | undefined;
  /** The head and trunk, found from the model's shape. */
  const bodyParts = (): string[] => {
    if (!trunk) {
      const loose = new Set([...swinging, ...suggestChains(skeleton, mapping).flatMap((s) => s.bones)]);
      const roles = detectRoles(skeleton, loose);
      trunk = [roles.head, roles.chest, roles.torso, roles.hips].filter(
        (name): name is string => name !== undefined,
      );
    }
    return trunk;
  };
  const used = new Set<string>();
  const driven = new Set(Object.keys(mapping.bones));
  mapping.secondary_motion.forEach((spec, index) => {
    const where = `secondary_motion[${index}]`;
    const unknown = spec.bones.filter((bone) => !skeleton.has(bone));
    if (unknown.length) {
      throw new MappingError(
        `${where}: bones not found in the model:\n${unknownTargets(unknown, skeleton)}`,
        { path: mappingPath },
      );
    }
    for (let i = 1; i < spec.bones.length; i++) {
      const parent = spec.bones[i - 1]!;
      const child = spec.bones[i]!;
      if (skeleton.get(child).parent !== parent) {
        throw new MappingError(
          `${where}: ${quoted(child)} is not a child of ${quoted(parent)}; list the chain's ` +
            "bones from parent to child",
          { path: mappingPath },
        );
      }
    }
    const clash = [...new Set(spec.bones.filter((bone) => driven.has(bone) || used.has(bone)))].sort();
    if (clash.length) {
      throw new MappingError(
        `${where}: [${clash.map(quoted).join(", ")}] are already driven by the motion or ` +
          "another chain",
        { path: mappingPath },
      );
    }
    for (const bone of spec.bones) used.add(bone);
    const tip = tipOf(spec, skeleton, where, mappingPath);
    const points = [...spec.bones.map((bone) => skeleton.get(bone).pivot), tip];
    if (points.some((point, i) => i > 0 && distance(point, points[i - 1]!) < 1e-6)) {
      throw new MappingError(
        `${where}: two joints share a position; give each bone its own pivot`,
        { path: mappingPath },
      );
    }

    const colliders: Collider[] = [];
    if (options.collide !== false && spec.collide !== false) {
      const named = Array.isArray(spec.collide) ? spec.collide : undefined;
      const missing = (named ?? []).filter((bone) => !skeleton.has(bone));
      if (missing.length) {
        throw new MappingError(
          `${where}: "collide" bones not found in the model:\n${unknownTargets(missing, skeleton)}`,
          { path: mappingPath },
        );
      }
      const hollow = (named ?? []).filter((bone) => !skeleton.get(bone).extent);
      if (hollow.length) {
        throw new MappingError(
          `${where}: "collide" bones [${hollow.map(quoted).join(", ")}] have no cubes to avoid`,
          { path: mappingPath },
        );
      }
      const padding = spec.collision_padding ?? chainPadding(skeleton, spec.bones);
      for (const name of named ?? bodyParts()) {
        if (swinging.has(name)) continue;
        const collider = colliderFor(skeleton.get(name), points, padding);
        if (collider) colliders.push(collider);
      }
    }

    const preset = PRESETS[spec.preset ?? DEFAULT_PRESET]!;
    const stiffness = spec.stiffness ?? preset.stiffness;
    chains.push({
      bones: spec.bones,
      tip,
      stiffness,
      damping: spec.damping ?? dampingFor(stiffness, spec.bounciness ?? preset.bounciness),
      gravity: spec.gravity ?? preset.gravity,
      offset: spec.offset,
      maxAngle: spec.max_angle ?? preset.maxAngle,
      colliders,
    });
  });
  return chains;
}

// --- suggestions ----------------------------------------------------------------------------

export interface Suggestion {
  readonly bones: readonly string[];
  readonly preset: string;
}

type Keywords = readonly { preset: string; match: readonly string[] }[];
const KEYWORDS: Keywords = keywordData.presets;

/** `SquareHair_Right2` -> `["square", "hair", "right", "2"]`. */
export function nameTokens(name: string): string[] {
  const spaced = name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ");
  return spaced
    .split(/[^A-Za-z0-9]+|(?<=[A-Za-z])(?=[0-9])/)
    .filter((token) => token)
    .map((token) => token.toLowerCase());
}

const COMPACT_MATCH = 5; // ASCII fragments this long may also span tokens ("TwinTail1")

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return false;
  return true;
}

function presetFor(name: string): string | undefined {
  const tokens = nameTokens(name);
  const compact = tokens.join("");
  for (const { preset, match } of KEYWORDS) {
    for (const fragment of match) {
      if (isAscii(fragment)) {
        const word = fragment.toLowerCase();
        if (
          tokens.some((token) => token.startsWith(word)) ||
          (word.length >= COMPACT_MATCH && compact.includes(word))
        ) {
          return preset;
        }
      } else if (name.includes(fragment)) {
        return preset;
      }
    }
  }
  return undefined;
}

export const LONG_HAIR_LENGTH = 12; // px; longer hair chains swing like long hair whatever their name
export const MIN_CHAIN_LENGTH = 2; // px; shorter pieces are decoration, too small to swing visibly

type Extent = readonly [Vec3, Vec3];

function parentExtents(skeleton: Skeleton, bone: Bone): [Extent, Extent] | undefined {
  const parent = bone.parent !== undefined ? skeleton.get(bone.parent) : undefined;
  if (!parent?.extent || !bone.extent) return undefined;
  return [bone.extent, parent.extent];
}

/** Cubes mostly inside the parent's (a sleeve or shirt layer), not a dangling part. */
function isOverlay(skeleton: Skeleton, bone: Bone): boolean {
  const extents = parentExtents(skeleton, bone);
  if (!extents) return false;
  const [own, parent] = extents;
  let ownVolume = 1;
  let shared = 1;
  for (let axis = 0; axis < 3; axis++) {
    ownVolume *= Math.max(own[1][axis]! - own[0][axis]!, 0);
    const low = Math.max(own[0][axis]!, parent[0][axis]!);
    const high = Math.min(own[1][axis]!, parent[1][axis]!);
    shared *= Math.max(high - low, 0);
  }
  return ownVolume > 0 && shared >= 0.5 * ownVolume;
}

/**
 * Cubes around the parent's (a cuff, bracelet or collar): it can't swing without
 * passing through the parent, so it must stay rigid.
 */
function wrapsParent(skeleton: Skeleton, bone: Bone): boolean {
  const extents = parentExtents(skeleton, bone);
  if (!extents) return false;
  const [own, parent] = extents;
  const tolerance = 1e-6;
  // Encloses the parent sideways.
  const around = [0, 2].every(
    (axis) =>
      own[0][axis]! <= parent[0][axis]! + tolerance && own[1][axis]! >= parent[1][axis]! - tolerance,
  );
  const sharedHeight = Math.min(own[1][1], parent[1][1]) - Math.max(own[0][1], parent[0][1]);
  return around && sharedHeight > tolerance;
}

function allClose(a: Vec3, b: Vec3): boolean {
  return a.every((value, i) => Math.abs(value - b[i]!) <= 1e-8 + 1e-5 * Math.abs(b[i]!));
}

/**
 * Unconfigured bone chains whose names look like hair, cloth or accessories.
 *
 * A chain starts at a bone with a hair/cloth-like name (or below one) that isn't
 * driven by the motion, and follows single children down to a leaf. Only bones with
 * their own cubes are included, so pure grouping nodes don't become physics, and
 * overlays (cubes mostly inside the parent's, like a tight sleeve) and wrapping pieces
 * (around the parent, like a cuff) stay rigid: they'd clip through it if they swung.
 */
export function suggestChains(
  skeleton: Skeleton,
  mapping: Pick<MappingFile, "bones" | "secondary_motion"> | undefined,
): Suggestion[] {
  const taken = new Set([
    ...Object.keys(mapping?.bones ?? {}),
    ...(mapping?.secondary_motion ?? []).flatMap((chain) => chain.bones),
  ]);
  const suggestions: Suggestion[] = [];
  const claimed = new Set<string>();
  for (const bone of skeleton) {
    if (taken.has(bone.name) || claimed.has(bone.name) || !bone.extent) continue;
    if (isOverlay(skeleton, bone) || wrapsParent(skeleton, bone)) continue;
    const lineage = [bone.name, ...skeleton.ancestors(bone.name).map((a) => a.name)];
    let preset: string | undefined;
    for (const name of lineage) {
      preset = presetFor(name);
      if (preset) break;
    }
    if (!preset || (bone.parent !== undefined && claimed.has(bone.parent))) continue;
    const chain = [bone.name];
    for (;;) {
      const last = chain[chain.length - 1]!;
      const children = skeleton.children(last).filter((child) => child.extent);
      const next = children[0];
      if (children.length !== 1 || !next || taken.has(next.name)) break;
      // An overlay sharing the joint, not a further segment.
      if (allClose(next.pivot, skeleton.get(last).pivot)) break;
      if (isOverlay(skeleton, next) || wrapsParent(skeleton, next)) break;
      chain.push(next.name);
    }
    const tip = geometryTip(skeleton.get(chain[chain.length - 1]!), skeleton.get(chain[0]!).pivot);
    if (!tip && chain.length < 2) continue;
    const points = [...chain.map((name) => skeleton.get(name).pivot), ...(tip ? [tip] : [])];
    let length = 0;
    for (let i = 1; i < points.length; i++) length += distance(points[i]!, points[i - 1]!);
    if (length < MIN_CHAIN_LENGTH) continue;
    if (preset === "short_hair" && (chain.length >= 3 || length >= LONG_HAIR_LENGTH)) {
      preset = "long_hair";
    }
    for (const name of chain) claimed.add(name);
    suggestions.push({ bones: chain, preset });
  }
  return suggestions;
}
