/** PMX model -> source rig (the skeleton IK is solved on). */

import { SourceRig, type IkChain, type RigBone } from "../rig/model";
import { parsePmx, type PmxModel } from "./parser";

/**
 * Every bone of `model`, parents first, with its rotation inheritance and IK.
 *
 * Bone names must be unique in a rig: when a model repeats one, the first bone keeps
 * it and the others are left out (their children attach to the nearest kept ancestor).
 * IK chains whose links aren't a parent chain up from the target can't be solved and
 * are left out too.
 */
export function toSourceRig(model: PmxModel, name: string): SourceRig {
  const count = model.bones.length;
  const first = new Map<string, number>();
  model.bones.forEach((bone, index) => {
    if (!first.has(bone.name)) first.set(bone.name, index);
  });
  const kept = new Set(first.values());

  const keptParent = (index: number): number | undefined => {
    const seen = new Set([index]);
    let parent = model.bones[index]!.parent;
    while (parent >= 0 && parent < count && !seen.has(parent)) {
      if (kept.has(parent)) return parent;
      seen.add(parent);
      parent = model.bones[parent]!.parent;
    }
    return undefined;
  };

  const ordered = [...kept].sort((a, b) => a - b);
  const parents = new Map(ordered.map((index) => [index, keptParent(index)]));
  const bones = new Map<string, RigBone>();

  const add = (index: number, trail: ReadonlySet<number>): void => {
    const bone = model.bones[index]!;
    if (bones.has(bone.name)) return;
    let parent = parents.get(index);
    if (parent !== undefined && trail.has(parent)) parent = undefined; // a parent loop: a root
    if (parent !== undefined) add(parent, new Set([...trail, index]));
    let inherit: RigBone["inherit"];
    if (bone.inheritRotation) {
      const [source, weight] = bone.inheritRotation;
      if (source >= 0 && source < count && source !== index && weight !== 0) {
        inherit = { bone: model.bones[source]!.name, weight };
      }
    }
    bones.set(bone.name, {
      name: bone.name,
      parent: parent !== undefined ? model.bones[parent]!.name : undefined,
      position: bone.position,
      inherit,
    });
  };
  for (const index of ordered) add(index, new Set());

  const chains: IkChain[] = [];
  for (const index of ordered) {
    const bone = model.bones[index]!;
    const { ik } = bone;
    if (!ik || ik.target < 0 || ik.target >= count || !ik.links.length) continue;
    if (ik.links.some((link) => link.bone < 0 || link.bone >= count)) continue;
    const names = [
      model.bones[ik.target]!.name,
      ...ik.links.map((link) => model.bones[link.bone]!.name),
    ];
    if (names.some((child, i) => i + 1 < names.length && bones.get(child)!.parent !== names[i + 1])) {
      continue;
    }
    chains.push({
      bone: bone.name,
      target: names[0]!,
      links: ik.links.map((link) => ({
        bone: model.bones[link.bone]!.name,
        minAngles: link.minAngles,
        maxAngles: link.maxAngles,
      })),
      iterations: Math.max(ik.iterations, 1),
      limitAngle: ik.limitAngle,
    });
  }
  return new SourceRig(name, bones, chains);
}

/** The source rig of a `.pmx` file's bytes; `fallbackName` names unnamed models. */
export function pmxRig(data: Uint8Array, fallbackName: string, path?: string): SourceRig {
  const model = parsePmx(data, path);
  return toSourceRig(model, model.name || fallbackName);
}
