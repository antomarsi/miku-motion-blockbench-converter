/**
 * Read the bone hierarchy of a Blockbench project (.bbmodel).
 *
 * Only the skeleton is read: group names, parents, pivots (`origin`) and rest rotations.
 * Two layouts exist:
 *
 * - Blockbench 4.x: groups are nested objects inside `outliner` (`name`, `origin`,
 *   `rotation`, `children`); cubes appear as uuid strings.
 * - Blockbench 5.x: groups live in a top-level `groups` array; `outliner` holds
 *   `{"uuid", "children"}` references to them, and cube uuids as strings.
 *
 * Group rotations are ZYX Euler degrees in Blockbench's own (canonical) space.
 */

import { makeBone, Skeleton, type Bone } from "../animation/skeleton";
import { TargetModelError } from "../errors";
import type { Vec3 } from "../geometry/quat";

export const GECKOLIB_FORMATS: ReadonlySet<string> = new Set([
  "geckolib_model",
  "animated_entity_model",
]);

export interface BlockbenchModel {
  readonly name: string;
  readonly formatVersion: string;
  readonly modelFormat: string;
  readonly skeleton: Skeleton;
}

export function isGeckolib(model: BlockbenchModel): boolean {
  return GECKOLIB_FORMATS.has(model.modelFormat);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vector(value: unknown, what: string, path: string | undefined): Vec3 {
  if (value === undefined || value === null) return [0, 0, 0];
  if (Array.isArray(value) && value.length === 3) {
    const numbers = value.map((v) => (typeof v === "boolean" ? NaN : Number(v)));
    if (numbers.every((n) => Number.isFinite(n))) return numbers as unknown as Vec3;
  }
  throw new TargetModelError(`${what} must be three numbers, got ${JSON.stringify(value)}`, {
    path,
  });
}

function corner(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  return value.map(Number) as unknown as Vec3;
}

/** Skeleton and metadata of a parsed `.bbmodel` document; `fallbackName` names unnamed projects. */
export function parseBbmodel(data: unknown, fallbackName: string, path?: string): BlockbenchModel {
  if (!isObject(data)) {
    throw new TargetModelError("not a Blockbench project (top level is not an object)", { path });
  }
  const { meta } = data;
  if (!isObject(meta) || !("outliner" in data) || !Array.isArray(data.outliner)) {
    throw new TargetModelError("not a Blockbench project (missing 'meta' or 'outliner')", {
      path,
      hint: "pass the .bbmodel file saved by Blockbench (File > Save Project)",
    });
  }
  const groupsByUuid = new Map<string, Json>();
  for (const group of Array.isArray(data.groups) ? data.groups : []) {
    if (isObject(group) && typeof group.uuid === "string") groupsByUuid.set(group.uuid, group);
  }
  const cubes = new Map<string, [Vec3, Vec3]>();
  for (const element of Array.isArray(data.elements) ? data.elements : []) {
    if (!isObject(element) || typeof element.uuid !== "string") continue;
    const from = corner(element.from);
    const to = corner(element.to);
    if (from && to) cubes.set(element.uuid, [from, to]);
  }
  const bones: Bone[] = [];

  /** Bounding box of the cubes directly inside a group (cube rotation ignored). */
  const extent = (children: unknown[]): [Vec3, Vec3] | undefined => {
    const corners = children.flatMap((child) =>
      typeof child === "string" ? (cubes.get(child) ?? []) : [],
    );
    if (!corners.length) return undefined;
    const axis = (pick: (...values: number[]) => number, i: number): number =>
      pick(...corners.map((c) => c[i]!));
    return [
      [axis(Math.min, 0), axis(Math.min, 1), axis(Math.min, 2)],
      [axis(Math.max, 0), axis(Math.max, 1), axis(Math.max, 2)],
    ];
  };

  const visit = (node: unknown, parent: string | undefined): void => {
    if (typeof node === "string") return; // a cube (or other element) reference
    if (!isObject(node)) {
      throw new TargetModelError(`unexpected outliner entry ${JSON.stringify(node)}`, { path });
    }
    const uuid = typeof node.uuid === "string" ? node.uuid : "";
    const group = groupsByUuid.get(uuid) ?? node;
    if (!("name" in group)) {
      // 5.x reference to a group that doesn't exist
      throw new TargetModelError(
        `outliner references unknown group uuid ${JSON.stringify(node.uuid ?? null)}`,
        { path },
      );
    }
    const name = String(group.name);
    const what = `group '${name}'`;
    const children = Array.isArray(node.children) ? node.children : [];
    bones.push(
      makeBone(
        name,
        parent,
        vector(group.origin, `${what} origin`, path),
        vector(group.rotation, `${what} rotation`, path),
        extent(children),
      ),
    );
    for (const child of children) visit(child, name);
  };

  for (const root of data.outliner) visit(root, undefined);

  if (!bones.length) {
    throw new TargetModelError("the model has no groups (bones) to animate", {
      path,
      hint: "animations target groups; put cubes inside named groups in Blockbench",
    });
  }
  checkUniqueNames(bones, path);

  return {
    name: String(data.name || fallbackName),
    formatVersion: String(meta.format_version ?? "?"),
    modelFormat: String(meta.model_format ?? "?"),
    skeleton: new Skeleton(bones),
  };
}

/** GeckoLib addresses bones by name, so a rig can't use one twice. */
export function checkUniqueNames(bones: readonly Bone[], path?: string): void {
  const counts = new Map<string, number>();
  for (const bone of bones) counts.set(bone.name, (counts.get(bone.name) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicates.length) {
    const list = duplicates
      .sort()
      .map((name) => `'${name}'`)
      .join(", ");
    throw new TargetModelError(
      `group names must be unique, but these appear more than once: [${list}]`,
      { path, hint: "GeckoLib addresses bones by name; rename the duplicates in Blockbench" },
    );
  }
}

/** Parse the text of a `.bbmodel` file. */
export function parseBbmodelText(text: string, fallbackName: string, path?: string): BlockbenchModel {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TargetModelError(`not valid JSON: ${reason}`, { path });
  }
  return parseBbmodel(data, fallbackName, path);
}
