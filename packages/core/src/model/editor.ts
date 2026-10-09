/**
 * What model preparation needs to do to a rig, independent of where the rig lives.
 *
 * Two implementations exist: `BbmodelDocument` edits a `.bbmodel` file's JSON (the CLI),
 * and the plugin edits the open Blockbench project directly, with undo. Bones are
 * addressed by name; cubes, locators and nulls by an opaque id.
 */

import type { BlockbenchModel } from "../blockbench/bbmodel";
import type { Vec3 } from "../geometry/quat";

export interface EditorCube {
  readonly id: string;
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface NullLinks {
  /** Id of the locator the IK chain should reach. */
  readonly target?: string;
  /** Name of the bone the IK chain starts at. */
  readonly source?: string;
  /** Id of the null that points the joint. */
  readonly pole?: string;
}

export interface ModelEditor {
  /** The rig as it is now (re-read after edits). */
  model(): BlockbenchModel;
  /** Names of the groups at the top level of the outliner, in order. */
  topLevelGroups(): string[];
  /** `base`, or `base 2`, `base 3`... when the name is taken by a group or element. */
  uniqueName(base: string): string;
  /** A new empty group; display settings are copied from the group `like`. */
  addGroup(name: string, parent: string | undefined, pivot: Vec3, like: string): void;
  /** Re-parent a group (positions are absolute, so nothing moves). */
  move(name: string, newParent: string | undefined): void;
  setPivot(name: string, pivot: Vec3): void;
  /** The cubes directly inside a group. */
  cubes(name: string): EditorCube[];
  moveElement(id: string, newParent: string): void;
  /**
   * Cut a cube horizontally at height `y`; the part below goes to `lowerParent`.
   * Face UVs are kept exactly. Returns the lower part's id.
   */
  splitCube(id: string, y: number, lowerParent: string): string;
  /** Whether a Blockbench IK null already starts at this bone. */
  hasIk(chainRoot: string): boolean;
  addLocator(name: string, position: Vec3, parent: string): string;
  addNull(name: string, position: Vec3, parent: string, links?: NullLinks): string;
}

export const SIDE_FACES = ["north", "east", "south", "west"] as const;

/**
 * Divide the face UVs of a cube cut at `fraction` of its height, measured from the top.
 *
 * Side faces are divided at the same fraction, the outer top and bottom faces stay, and
 * the new cut faces reuse them. `upper` and `lower` start as copies of the cube's faces
 * and are edited in place.
 */
export function splitFaceUvs(
  upper: Record<string, { uv?: number[] } | undefined>,
  lower: Record<string, { uv?: number[] } | undefined>,
  fraction: number,
): void {
  for (const face of SIDE_FACES) {
    const uv = upper[face]?.uv;
    if (!uv || !lower[face]) continue;
    const [u1, vTop, u2, vBottom] = uv as [number, number, number, number];
    const vCut = vTop + fraction * (vBottom - vTop);
    upper[face]!.uv = [u1, vTop, u2, vCut];
    lower[face]!.uv = [u1, vCut, u2, vBottom];
  }
  if (upper.down && lower.up) {
    // Cut faces reuse the outer ones.
    const outerDown = structuredClone(lower.down);
    const outerUp = structuredClone(upper.up);
    upper.down = outerDown;
    lower.up = outerUp;
  }
}
