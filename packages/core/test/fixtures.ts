/** Builders for synthetic test inputs. Real assets are never committed; tests use these. */

import { makeTrack, type SourceBoneTrack, type SourceMotion } from "../src/animation/source";
import { LINEAR } from "../src/animation/curves";
import * as quat from "../src/geometry/quat";
import type { Quat, Vec3 } from "../src/geometry/quat";
import { canonicalBoneName } from "../src/vmd/names";

export type GroupSpec = readonly [
  name: string,
  parent: string | undefined,
  origin: Vec3,
  rotation: Vec3,
  cube: readonly [Vec3, Vec3] | undefined,
];

/** A group (bone), optionally holding one cube given as `[from, to]`. */
export function group(
  name: string,
  parent?: string,
  origin: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
  cube?: readonly [Vec3, Vec3],
): GroupSpec {
  return [name, parent, origin, rotation, cube];
}

/** A minimal .bbmodel document with one cube per group, in 4.x or 5.x layout. */
export function bbmodel(
  groups: readonly GroupSpec[],
  options: { layout?: 4 | 5; name?: string; modelFormat?: string } = {},
): Record<string, unknown> {
  const layout = options.layout ?? 5;
  const uuid = (name: string): string =>
    `00000000-0000-0000-0000-${String(groups.findIndex((g) => g[0] === name)).padStart(12, "0")}`;
  const cubeId = (name: string): string => `cube-${groups.findIndex((g) => g[0] === name)}`;
  const node = (name: string): Record<string, unknown> => {
    const spec = groups.find((g) => g[0] === name)!;
    const children: unknown[] = [
      ...(spec[4] ? [cubeId(name)] : []),
      ...groups.filter((g) => g[1] === name).map((g) => node(g[0])),
    ];
    return layout === 5
      ? { uuid: uuid(name), isOpen: true, children }
      : { name, uuid: uuid(name), origin: spec[2], rotation: spec[3], children };
  };
  const document: Record<string, unknown> = {
    meta: { format_version: `${layout}.0`, model_format: options.modelFormat ?? "geckolib_model" },
    name: options.name ?? "test_rig",
    elements: groups
      .filter((g) => g[4])
      .map((g) => ({ uuid: cubeId(g[0]), name: g[0], from: g[4]![0], to: g[4]![1] })),
    outliner: groups.filter((g) => g[1] === undefined).map((g) => node(g[0])),
  };
  if (layout === 5) {
    document.groups = groups.map((g) => ({ uuid: uuid(g[0]), name: g[0], origin: g[2], rotation: g[3] }));
  }
  return document;
}

/** A small humanoid shaped like a Minecraft player model (legs under Root). */
export function playerRig(layout: 4 | 5 = 5): Record<string, unknown> {
  return bbmodel(
    [
      group("Root"),
      group("Body", "Root", [0, 12, 0]),
      group("Chest", "Body", [0, 23, -1], [20, 0, 0]),
      group("Head", "Body", [0, 24, 0]),
      group("LeftArm", "Body", [-4.5, 22, 0]),
      group("LowerLeftArm", "LeftArm", [-4.5, 17, 0]),
      group("RightArm", "Body", [4.5, 22, 0]),
      group("LeftLeg", "Root", [-1.9, 12, 0]),
      group("RightLeg", "Root", [1.9, 12, 0]),
    ],
    { layout, name: "player_rig" },
  );
}

export interface KeySpec {
  frame: number;
  position?: Vec3;
  rotation?: Quat;
}

/** A source track with linear easing. */
export function sourceTrack(name: string, keys: readonly KeySpec[]): SourceBoneTrack {
  const curves = new Float64Array(16 * keys.length);
  for (let i = 0; i < 4 * keys.length; i++) curves.set(LINEAR, 4 * i);
  return makeTrack({
    name,
    frames: Float64Array.from(keys, (k) => k.frame),
    translations: quat.vec3Array(keys.map((k) => k.position ?? [0, 0, 0])),
    rotations: quat.quatArray(keys.map((k) => k.rotation ?? quat.IDENTITY)),
    curves,
  });
}

/** A source motion from tracks; names are stored the way a VMD would hold them. */
export function sourceMotion(
  tracks: Record<string, readonly KeySpec[]>,
  extra: Partial<SourceMotion> = {},
): SourceMotion {
  const map = new Map<string, SourceBoneTrack>();
  let endFrame = 0;
  for (const [name, keys] of Object.entries(tracks)) {
    const canonical = canonicalBoneName(name);
    map.set(canonical, sourceTrack(canonical, keys));
    endFrame = Math.max(endFrame, ...keys.map((k) => k.frame));
  }
  return {
    name: "test",
    frameRate: 30,
    endFrame,
    tracks: map,
    morphs: new Map(),
    ikBones: new Set(),
    ikStates: new Map(),
    canonicalName: canonicalBoneName,
    ...extra,
  };
}

export const degrees = (value: number): number => (value * Math.PI) / 180;
