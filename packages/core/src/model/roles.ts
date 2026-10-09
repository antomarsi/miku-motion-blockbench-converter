/**
 * Find body parts (roles) in an arbitrary rig from its geometry.
 *
 * Works in canonical model space (Y up, faces -Z, model's left at -X). Names are only
 * tie-breakers, so any naming style works. Hair, cloth and accessories (secondary-motion
 * candidates) are set aside first so they are never mistaken for limbs.
 *
 * - legs: bones whose cubes reach the ground, off-centre; a leg's segments are that bone
 *   and its same-side ancestors above it (thigh, shin, foot from the top)
 * - head: the highest centred block (a "head" name token wins ties, then volume)
 * - torso: the head's nearest centred ancestor with cubes (not carrying the legs); with
 *   a waist and chest stacked, the waist is the torso and the upper one the chest
 * - hips: a centred bone carrying both legs, outside the torso and not above it
 * - chest: a centred child of the torso whose cubes are mostly outside the torso's
 * - arms: off-centre bones in the torso's subtree (outside the head's) reaching shoulder
 *   height, followed down through children below them (upper arm, forearm, hand); for
 *   flat rigs (everything at top level) anywhere outside the legs and head
 * - torso fallback for flat rigs: the largest centred block below the head
 * - root: the nearest group containing the torso and both legs
 */

import type { Bone, Skeleton } from "../animation/skeleton";
import type { Vec3 } from "../geometry/quat";

const CENTRED = 1.5; // px: |x| of a centred part's cube centre
const GROUND_TOLERANCE = 0.75; // px
const SHOULDER_HEIGHT = 0.55; // arms reach above this fraction of the model's height
const LIMB_NAMES = {
  arm: ["upper_arm", "forearm", "hand"],
  leg: ["thigh", "shin", "foot"],
} as const;

export type Side = "left" | "right";
type Extent = readonly [Vec3, Vec3];
type Solid = Bone & { readonly extent: Extent };

export interface Roles {
  root?: string;
  torso?: string;
  chest?: string;
  /** A lower-body bone carrying the legs, separate from the torso. */
  hips?: string;
  head?: string;
  /** Side -> segments, top first. */
  arms: Map<Side, string[]>;
  legs: Map<Side, string[]>;
}

/** Role name (as in `mmd_roles.json`) -> bone name. */
export function rolesByRole(roles: Roles): Map<string, string> {
  const out = new Map<string, string>();
  for (const role of ["root", "torso", "chest", "hips", "head"] as const) {
    const bone = roles[role];
    if (bone) out.set(role, bone);
  }
  for (const kind of ["arm", "leg"] as const) {
    for (const [side, segments] of kind === "arm" ? roles.arms : roles.legs) {
      LIMB_NAMES[kind].forEach((role, i) => {
        const bone = segments[i];
        if (bone !== undefined) out.set(`${role}_${side}`, bone);
      });
    }
  }
  return out;
}

function isSolid(bone: Bone): bone is Solid {
  return bone.extent !== undefined;
}

function center(extent: Extent): Vec3 {
  return [
    0.5 * (extent[0][0] + extent[1][0]),
    0.5 * (extent[0][1] + extent[1][1]),
    0.5 * (extent[0][2] + extent[1][2]),
  ];
}

function volume(extent: Extent): number {
  return [0, 1, 2].reduce((v, axis) => v * Math.max(extent[1][axis]! - extent[0][axis]!, 0), 1);
}

function overlap(a: Extent, b: Extent): number {
  return [0, 1, 2].reduce(
    (v, axis) =>
      v * Math.max(Math.min(a[1][axis]!, b[1][axis]!) - Math.max(a[0][axis]!, b[0][axis]!), 0),
    1,
  );
}

function hasToken(name: string, word: string): boolean {
  const spaced = name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ");
  return spaced
    .split(/[^A-Za-z]+/)
    .filter((token) => token)
    .some((token) => token.toLowerCase() === word);
}

/**
 * The bone's cubes stay inside the parent's cross-section (a next limb segment, not a
 * cuff or other piece wrapped around it).
 */
function withinColumn(bone: Bone, parent: Bone): boolean {
  if (!bone.extent || !parent.extent) return false;
  const slack = 0.1; // a next segment shares the column; a cuff is wider
  return [0, 2].every(
    (axis) =>
      bone.extent![0][axis]! >= parent.extent![0][axis]! - slack &&
      bone.extent![1][axis]! <= parent.extent![1][axis]! + slack,
  );
}

const sideOf = (x: number): Side => (x < 0 ? "left" : "right");

function descendants(skeleton: Skeleton, name: string): Set<string> {
  const out = new Set<string>();
  const stack = [name];
  while (stack.length) {
    for (const child of skeleton.children(stack.pop()!)) {
      out.add(child.name);
      stack.push(child.name);
    }
  }
  return out;
}

/** The first element with the greatest key (keys compare element by element). */
function maxBy<T>(items: readonly T[], key: (item: T) => readonly number[]): T | undefined {
  let best: T | undefined;
  let bestKey: readonly number[] = [];
  for (const item of items) {
    const k = key(item);
    let greater = best === undefined;
    for (let i = 0; !greater && i < k.length; i++) {
      if (k[i]! > bestKey[i]!) greater = true;
      else if (k[i]! < bestKey[i]!) break;
    }
    if (greater) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** Body parts of `skeleton`; bones in `exclude` (and below) are never limbs. */
export function detectRoles(skeleton: Skeleton, exclude: ReadonlySet<string>): Roles {
  const excluded = new Set(exclude);
  for (const name of exclude) for (const below of descendants(skeleton, name)) excluded.add(below);
  const solid = skeleton.bones.filter((b): b is Solid => isSolid(b) && !excluded.has(b.name));
  const roles: Roles = { arms: new Map(), legs: new Map() };
  if (!solid.length) return roles;
  const ground = Math.min(...solid.map((b) => b.extent[0][1]));
  const top = Math.max(...solid.map((b) => b.extent[1][1]));

  // Legs: off-centre bones reaching the ground, with their same-side ancestors.
  for (const bone of solid) {
    const x = center(bone.extent)[0];
    if (bone.extent[0][1] > ground + GROUND_TOLERANCE || Math.abs(x) < 0.5) continue;
    const side = sideOf(x);
    if (roles.legs.has(side)) continue;
    const segments = [bone.name];
    for (const ancestor of skeleton.ancestors(bone.name)) {
      if (!isSolid(ancestor) || excluded.has(ancestor.name)) break;
      const ax = center(ancestor.extent)[0];
      if (Math.abs(ax) < 0.5 || sideOf(ax) !== side || ancestor.extent[0][1] < bone.extent[0][1]) {
        break;
      }
      segments.unshift(ancestor.name);
    }
    roles.legs.set(side, segments);
  }
  const legBones = new Set([...roles.legs.values()].flat());

  // Head: highest centred block.
  const centred = solid.filter(
    (b) => Math.abs(center(b.extent)[0]) <= CENTRED && !legBones.has(b.name),
  );
  const head = maxBy(centred, (b) => [
    Math.round(b.extent[1][1] * 10) / 10,
    hasToken(b.name, "head") ? 1 : 0,
    volume(b.extent),
  ]);
  if (head) roles.head = head.name;

  // Torso: the head's nearest centred ancestor with cubes that doesn't also carry the
  // legs; when two are stacked (waist and chest), the lower one is the torso.
  const legAncestors = new Set(
    [...legBones].flatMap((leg) => skeleton.ancestors(leg).map((a) => a.name)),
  );
  if (roles.head) {
    const trunk = skeleton
      .ancestors(roles.head)
      .filter(
        (a): a is Solid =>
          isSolid(a) && Math.abs(center(a.extent)[0]) <= CENTRED && !legAncestors.has(a.name),
      );
    if (trunk.length >= 2 && center(trunk[0]!.extent)[1] > center(trunk[1]!.extent)[1]) {
      roles.chest = trunk[0]!.name;
      roles.torso = trunk[1]!.name;
    } else if (trunk.length) {
      roles.torso = trunk[0]!.name;
    }
    if (roles.torso === undefined) {
      // Flat rigs: the largest centred block below the head.
      const headBone = skeleton.get(roles.head) as Solid;
      const headParts = descendants(skeleton, roles.head).add(roles.head);
      const below = centred.filter(
        (b) => !headParts.has(b.name) && b.extent[1][1] <= headBone.extent[0][1] + 0.5,
      );
      const largest = maxBy(below, (b) => [volume(b.extent)]);
      if (largest) roles.torso = largest.name;
    }
  }
  if (roles.torso && roles.chest === undefined) {
    const torso = skeleton.get(roles.torso);
    if (isSolid(torso)) {
      const candidates = skeleton
        .children(roles.torso)
        .filter(
          (c): c is Solid =>
            isSolid(c) &&
            !excluded.has(c.name) &&
            c.name !== roles.head &&
            Math.abs(center(c.extent)[0]) <= CENTRED &&
            overlap(c.extent, torso.extent) < 0.5 * volume(c.extent) &&
            center(c.extent)[1] > center(torso.extent)[1],
        );
      const chest = maxBy(candidates, (c) => [volume(c.extent)]);
      if (chest) roles.chest = chest.name;
    }
  }

  // Arms: off-centre bones under the torso (not the head) reaching shoulder height; in
  // flat rigs (arms beside the torso, not under it) anywhere outside the legs and head.
  if (roles.torso) {
    const headParts = roles.head ? descendants(skeleton, roles.head).add(roles.head) : new Set<string>();
    let region = new Set(
      [...descendants(skeleton, roles.torso)].filter((b) => !legBones.has(b) && !headParts.has(b)),
    );
    const shoulder = ground + SHOULDER_HEIGHT * (top - ground);
    const hasSideParts = [...region].some((name) => {
      const bone = skeleton.get(name);
      return !excluded.has(name) && isSolid(bone) && Math.abs(center(bone.extent)[0]) > CENTRED;
    });
    if (!hasSideParts) {
      region = new Set(
        skeleton.names.filter((b) => !legBones.has(b) && !headParts.has(b) && b !== roles.torso),
      );
    }
    for (const bone of skeleton) {
      if (!region.has(bone.name) || !isSolid(bone) || excluded.has(bone.name)) continue;
      const x = center(bone.extent)[0];
      const side = sideOf(x);
      if (Math.abs(x) <= CENTRED || roles.arms.has(side) || bone.extent[1][1] < shoulder) continue;
      const segments = [bone.name];
      for (;;) {
        const parent = skeleton.get(segments[segments.length - 1]!);
        let below = skeleton
          .children(parent.name)
          .filter((c) => isSolid(c) && !excluded.has(c.name) && c.pivot[1] < parent.pivot[1] - 1e-6);
        // Prefer the piece continuing the limb's column.
        if (below.length > 1) below = below.filter((c) => withinColumn(c, parent));
        if (below.length !== 1) break;
        segments.push(below[0]!.name);
      }
      roles.arms.set(side, segments);
    }
  }

  // Hips: a centred bone carrying both legs that is neither the torso (or part of it)
  // nor above it, e.g. a pelvis group, with or without cubes of its own.
  const tops = [...roles.legs.values()].map((segments) => segments[0]!);
  const parents = new Set(tops.map((name) => skeleton.get(name).parent));
  const hips = [...parents][0];
  if (tops.length === 2 && parents.size === 1 && hips !== undefined) {
    const bone = skeleton.get(hips);
    const torsoParts = roles.torso ? descendants(skeleton, roles.torso).add(roles.torso) : new Set<string>();
    const aboveTorso = new Set(roles.torso ? skeleton.ancestors(roles.torso).map((a) => a.name) : []);
    const x = isSolid(bone) ? center(bone.extent)[0] : bone.pivot[0];
    if (Math.abs(x) <= CENTRED && !torsoParts.has(hips) && !aboveTorso.has(hips)) roles.hips = hips;
  }

  // Root: nearest group containing the torso and the legs.
  const members = [roles.torso, ...legBones].filter((b): b is string => Boolean(b));
  if (members.length) {
    const lineages = members.map((m) => skeleton.ancestors(m).map((a) => a.name));
    const common = lineages[0]!.find((a) => lineages.slice(1).every((line) => line.includes(a)));
    if (common !== undefined) roles.root = common;
  }
  return roles;
}
