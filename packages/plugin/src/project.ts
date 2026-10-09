/// <reference types="blockbench-types" />

/**
 * Reads the open Blockbench project as a conversion target.
 *
 * This is one of the few places that touches Blockbench's own objects. It builds the
 * same `Skeleton` the core reads from a saved `.bbmodel`, so unsaved edits count.
 */

import {
  checkUniqueNames,
  makeBone,
  Skeleton,
  TargetModelError,
  type BlockbenchModel,
  type Bone,
  type Vec3,
} from "@miku-motion/core";

function vec3(value: ArrayLike<number>): Vec3 {
  return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
}

/** Bounding box of the cubes directly inside a group (cube rotation ignored). */
function extent(group: Group): [Vec3, Vec3] | undefined {
  const corners = group.children
    .filter((child): child is Cube => child instanceof Cube)
    .flatMap((cube) => [vec3(cube.from), vec3(cube.to)]);
  if (!corners.length) return undefined;
  const pick = (choose: (...values: number[]) => number, axis: number): number =>
    choose(...corners.map((corner) => corner[axis]!));
  return [
    [pick(Math.min, 0), pick(Math.min, 1), pick(Math.min, 2)],
    [pick(Math.max, 0), pick(Math.max, 1), pick(Math.max, 2)],
  ];
}

/** The open project's groups as a skeleton, parents first. */
export function projectModel(): BlockbenchModel {
  if (!Project) {
    throw new TargetModelError("no project is open", {
      hint: "open the model you want to animate first",
    });
  }
  const bones: Bone[] = [];
  const visit = (node: OutlinerNode, parent: string | undefined): void => {
    if (!(node instanceof Group)) return; // cubes, locators, null objects...
    bones.push(makeBone(node.name, parent, vec3(node.origin), vec3(node.rotation), extent(node)));
    for (const child of node.children) visit(child, node.name);
  };
  for (const node of Outliner.root) visit(node, undefined);

  if (!bones.length) {
    throw new TargetModelError("the model has no groups (bones) to animate", {
      hint: "animations target groups; put cubes inside named groups",
    });
  }
  checkUniqueNames(bones);
  return {
    name: Project.name || Project.geometry_name || "model",
    formatVersion: Blockbench.version,
    modelFormat: Format?.id ?? "?",
    skeleton: new Skeleton(bones),
  };
}
