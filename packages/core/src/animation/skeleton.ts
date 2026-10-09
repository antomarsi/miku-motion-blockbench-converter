/**
 * A generic bone hierarchy (target rigs).
 *
 * Positions are in the skeleton's own units, rotations are xyzw quaternions, both in the
 * canonical space (right-handed, Y-up, model faces -Z, model's left at -X).
 */

import { toQuat } from "../geometry/euler";
import { mulChain, type Quat, type Vec3 } from "../geometry/quat";

export const RADIANS = Math.PI / 180;
export const DEGREES = 180 / Math.PI;

export interface Bone {
  readonly name: string;
  readonly parent: string | undefined;
  /** Rotation origin, in model space. */
  readonly pivot: Vec3;
  /** Local rotation relative to the parent, at rest. */
  readonly restRotation: Quat;
  /** The same rest rotation as authored (ZYX, degrees). */
  readonly restEulerDegrees: Vec3;
  /** Min/max corner of the bone's own geometry (cubes directly inside it), if any. */
  readonly extent: readonly [Vec3, Vec3] | undefined;
}

/** Build a bone from a ZYX Euler rest rotation in degrees (Blockbench's convention). */
export function makeBone(
  name: string,
  parent: string | undefined,
  pivot: Vec3 = [0, 0, 0],
  restEulerDegrees: Vec3 = [0, 0, 0],
  extent?: readonly [Vec3, Vec3],
): Bone {
  const [x, y, z] = restEulerDegrees;
  return {
    name,
    parent,
    pivot,
    restRotation: toQuat([x * RADIANS, y * RADIANS, z * RADIANS]),
    restEulerDegrees,
    extent,
  };
}

/** Bones in topological order: every parent comes before its children. */
export class Skeleton implements Iterable<Bone> {
  private readonly index = new Map<string, number>();

  constructor(readonly bones: readonly Bone[]) {
    bones.forEach((bone, i) => {
      if (this.index.has(bone.name)) throw new RangeError(`duplicate bone name '${bone.name}'`);
      if (bone.parent !== undefined && !this.index.has(bone.parent)) {
        throw new RangeError(`bone '${bone.name}' listed before its parent '${bone.parent}'`);
      }
      this.index.set(bone.name, i);
    });
  }

  [Symbol.iterator](): Iterator<Bone> {
    return this.bones[Symbol.iterator]();
  }

  get length(): number {
    return this.bones.length;
  }

  get names(): string[] {
    return this.bones.map((b) => b.name);
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  get(name: string): Bone {
    const i = this.index.get(name);
    if (i === undefined) throw new RangeError(`no bone named '${name}'`);
    return this.bones[i]!;
  }

  order(name: string): number {
    return this.index.get(name) ?? -1;
  }

  /** Parent, grandparent, ... up to the root. */
  ancestors(name: string): Bone[] {
    const out: Bone[] = [];
    let parent = this.get(name).parent;
    while (parent !== undefined) {
      const bone = this.get(parent);
      out.push(bone);
      parent = bone.parent;
    }
    return out;
  }

  children(name: string): Bone[] {
    return this.bones.filter((b) => b.parent === name);
  }

  /** Rest orientation of `name` relative to the model (product down the chain). */
  restWorldRotation(name: string): Quat {
    const chain = [this.get(name), ...this.ancestors(name)].reverse();
    return mulChain(...chain.map((b) => b.restRotation));
  }
}
