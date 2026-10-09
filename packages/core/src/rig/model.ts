/**
 * The source model's skeleton: what a motion file assumes but doesn't contain.
 *
 * A VMD stores bone deltas only. Solving IK needs the source model's bone positions,
 * hierarchy, inherited ("append") rotations and IK chain definitions. These come from a
 * skeleton file (a built-in standard template) or the model's own PMX.
 *
 * Everything here is in the source (MMD) coordinate space and units.
 */

import type { Vec3 } from "../geometry/quat";

/** Adds `weight` times another bone's local rotation (MMD's rotation append). */
export interface Inherit {
  readonly bone: string;
  readonly weight: number;
}

export interface RigBone {
  readonly name: string;
  readonly parent: string | undefined;
  /** Rest position, model space. */
  readonly position: Vec3;
  readonly inherit: Inherit | undefined;
}

export interface IkLink {
  readonly bone: string;
  /**
   * Local rotation limits (radians, per axis). When exactly one axis has a range the
   * link rotates about that axis only ("hinge"), like MMD knees.
   */
  readonly minAngles: Vec3 | undefined;
  readonly maxAngles: Vec3 | undefined;
}

/** The single axis a limited link may rotate about, if it is a hinge. */
export function hingeAxis(link: IkLink): number | undefined {
  const { minAngles, maxAngles } = link;
  if (!minAngles || !maxAngles) return undefined;
  const free = [0, 1, 2].filter((i) => minAngles[i] !== 0 || maxAngles[i] !== 0);
  return free.length === 1 ? free[0] : undefined;
}

export interface IkChain {
  /** The IK bone; its position is the goal. */
  readonly bone: string;
  /** The effector bone that should reach the goal. */
  readonly target: string;
  /** From the effector's parent up towards the root. */
  readonly links: readonly IkLink[];
  readonly iterations: number;
  /** Max rotation per link per iteration, radians. */
  readonly limitAngle: number;
}

export class SourceRig {
  constructor(
    readonly name: string,
    /** Parents come before their children. */
    readonly bones: ReadonlyMap<string, RigBone>,
    readonly ik: readonly IkChain[] = [],
  ) {}

  bone(name: string): RigBone {
    const bone = this.bones.get(name);
    if (!bone) throw new RangeError(`no source bone named '${name}'`);
    return bone;
  }

  ancestors(name: string): string[] {
    const chain: string[] = [];
    let parent = this.bone(name).parent;
    while (parent !== undefined) {
      chain.push(parent);
      parent = this.bone(parent).parent;
    }
    return chain;
  }

  /** Rest offset from the parent's position (the bone's own position for roots). */
  offset(name: string): Vec3 {
    const bone = this.bone(name);
    if (bone.parent === undefined) return bone.position;
    const parent = this.bone(bone.parent).position;
    return [
      bone.position[0] - parent[0],
      bone.position[1] - parent[1],
      bone.position[2] - parent[2],
    ];
  }

  /**
   * This rig with only the IK chains that rotate one of `bones`.
   *
   * A model's own skeleton often has helper chains (hair, twist bones) that affect
   * nothing a conversion uses. `key` maps rig bone names to the names in `bones`.
   */
  driving(bones: ReadonlySet<string>, key: (name: string) => string = (name) => name): SourceRig {
    const chains = this.ik.filter((chain) => chain.links.some((link) => bones.has(key(link.bone))));
    return new SourceRig(this.name, this.bones, chains);
  }

  /** Every bone whose motion affects some IK chain. */
  requiredBones(): Set<string> {
    const names = new Set<string>();
    for (const chain of this.ik) {
      for (const bone of [chain.bone, chain.target, ...chain.links.map((link) => link.bone)]) {
        names.add(bone);
        for (const ancestor of this.ancestors(bone)) names.add(ancestor);
      }
    }
    for (const bone of this.bones.values()) {
      if (bone.inherit && names.has(bone.name)) names.add(bone.inherit.bone);
    }
    return names;
  }
}
