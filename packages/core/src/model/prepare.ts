/**
 * Check whether a model is ready for dancing, and fix what can be fixed automatically.
 *
 * Everything is generic: body parts come from `detectRoles` (geometry), hair and cloth
 * from `suggestChains`. Fixes go through a `ModelEditor`, so the same logic edits a
 * project file or the open Blockbench project:
 *
 * - no root group around the body -> add one
 * - head or arms not under the torso (flat rigs) -> attach them to it
 * - legs parented to the torso (torso bends would swing them) -> move them under the root
 * - torso pivoting above its middle (e.g. at the neck) -> pivot at the waist
 * - single-segment arms/legs -> split at the elbow/knee (cubes and UVs split exactly)
 * - a limb segment sharing its parent's pivot -> pivot at its own joint
 * - hair/limb chains without Blockbench IK -> tip locator, IK null and pole null
 */

import type { Skeleton } from "../animation/skeleton";
import { isGeckolib, type BlockbenchModel } from "../blockbench/bbmodel";
import type { Vec3 } from "../geometry/quat";
import { geometryTip, suggestChains, type Suggestion } from "../mapping/secondary";
import type { ModelEditor } from "./editor";
import { detectRoles, type Roles, type Side } from "./roles";

const NEW_ROOT = "root"; // name of the group added around a body that has none
const POLE_DISTANCE = 8; // px from the joint
const HAIR_POLE_OUTWARD = 4; // px sideways, away from the head

export interface Finding {
  readonly message: string;
  /** False: needs a manual step (the message says which). */
  readonly fixed: boolean;
}

export interface PrepareOptions {
  /** Split one-piece arms/legs at the joint. */
  readonly splitLimbs?: boolean;
  /** Add Blockbench IK to hair/cloth chains. */
  readonly hairIk?: boolean;
  /** Add Blockbench IK to arms and legs. */
  readonly limbIk?: boolean;
}

export interface Analysis {
  readonly model: BlockbenchModel;
  readonly roles: Roles;
  readonly suggestions: Suggestion[];
}

/** Body parts and hair/cloth chains of a rig. */
export function analyzeModel(model: BlockbenchModel): Analysis {
  const suggestions = suggestChains(model.skeleton, undefined);
  const roles = detectRoles(model.skeleton, new Set(suggestions.flatMap((s) => s.bones)));
  return { model, roles, suggestions };
}

/** A `%g`-like number: up to 6 significant digits, no trailing zeros. */
function g(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function allClose(a: Vec3, b: Vec3): boolean {
  return a.every((value, i) => Math.abs(value - b[i]!) <= 1e-8 + 1e-5 * Math.abs(b[i]!));
}

function isUnder(skeleton: Skeleton, bone: string, ancestor: string): boolean {
  return skeleton.ancestors(bone).some((a) => a.name === ancestor);
}

function fixStructure(editor: ModelEditor, a: Analysis, out: Finding[]): void {
  const { roles } = a;
  const { skeleton } = a.model;
  if (roles.root === undefined && roles.torso && roles.legs.size) {
    const tops = editor.topLevelGroups();
    const rootName = editor.uniqueName(NEW_ROOT);
    editor.addGroup(rootName, undefined, [0, 0, 0], tops[0]!);
    for (const name of tops) editor.move(name, rootName);
    out.push({
      message:
        `added a '${rootName}' group around the body (it carries the dance's ` +
        "movement across the floor)",
      fixed: true,
    });
    roles.root = rootName;
  }
  if (!roles.torso) return;
  const { torso: torsoName } = roles;
  const attach: [string, string | undefined][] = [
    ["head", roles.head],
    ...[...roles.arms].map(([side, segments]): [string, string] => [`${side} arm`, segments[0]!]),
  ];
  for (const [what, bone] of attach) {
    if (bone && !isUnder(skeleton, bone, torsoName)) {
      editor.move(bone, torsoName);
      out.push({
        message: `attached the ${what} '${bone}' to the torso '${torsoName}' so it follows the upper body`,
        fixed: true,
      });
    }
  }
  const newParent = roles.root ?? skeleton.get(torsoName).parent;
  for (const [side, segments] of roles.legs) {
    const leg = segments[0]!;
    if (isUnder(skeleton, leg, torsoName)) {
      editor.move(leg, newParent);
      out.push({
        message:
          `moved the ${side} leg '${leg}' out of the torso ` +
          `'${torsoName}' (torso bends no longer swing it)`,
        fixed: true,
      });
    }
  }
  const torso = skeleton.get(torsoName);
  if (torso.extent) {
    const middle = 0.5 * (torso.extent[0][1] + torso.extent[1][1]);
    if (torso.pivot[1] > middle + 0.5) {
      const waist: Vec3 = [torso.pivot[0], torso.extent[0][1], torso.pivot[2]];
      editor.setPivot(torsoName, waist);
      out.push({
        message:
          `moved the torso '${torsoName}' pivot from y=${g(torso.pivot[1])} ` +
          `to the waist (y=${g(waist[1])}) so it bends at the hips`,
        fixed: true,
      });
    }
  }
}

function splitLimbs(editor: ModelEditor, a: Analysis, out: Finding[]): void {
  const { skeleton } = a.model;
  const kinds: [string, Map<Side, string[]>, string][] = [
    ["arm", a.roles.arms, "elbow"],
    ["leg", a.roles.legs, "knee"],
  ];
  for (const [kind, limbs, joint] of kinds) {
    for (const [side, segments] of limbs) {
      if (segments.length !== 1) continue;
      const bone = skeleton.get(segments[0]!);
      if (!bone.extent) continue;
      const y = roundHalfEven(0.5 * (bone.extent[0][1] + bone.extent[1][1]));
      const lower = editor.uniqueName(`${bone.name} Lower`);
      editor.addGroup(lower, bone.name, [bone.pivot[0], y, bone.pivot[2]], bone.name);
      for (const cube of editor.cubes(bone.name)) {
        const bottom = cube.from[1];
        const top = cube.to[1];
        if (bottom >= y) continue;
        if (top <= y) editor.moveElement(cube.id, lower);
        else editor.splitCube(cube.id, y, lower);
      }
      for (const child of skeleton.children(bone.name)) {
        const height = child.extent ? 0.5 * (child.extent[0][1] + child.extent[1][1]) : child.pivot[1];
        if (height < y) editor.move(child.name, lower);
      }
      out.push({
        message:
          `split the ${side} ${kind} '${bone.name}' at the ${joint} (y=${g(y)}) ` +
          `into '${bone.name}' and '${lower}', keeping the texture`,
        fixed: true,
      });
    }
  }
}

function fixJoints(editor: ModelEditor, a: Analysis, out: Finding[]): void {
  const { skeleton } = a.model;
  for (const limbs of [a.roles.arms, a.roles.legs]) {
    for (const segments of limbs.values()) {
      for (let i = 1; i < segments.length; i++) {
        const parent = segments[i - 1]!;
        const child = segments[i]!;
        const bone = skeleton.get(child);
        if (bone.extent && allClose(bone.pivot, skeleton.get(parent).pivot)) {
          const pivot: Vec3 = [bone.pivot[0], bone.extent[1][1], bone.pivot[2]];
          editor.setPivot(child, pivot);
          out.push({
            message: `moved '${child}' pivot to its joint (y=${g(pivot[1])}); it shared '${parent}''s pivot`,
            fixed: true,
          });
        }
      }
    }
  }
}

function addIk(
  editor: ModelEditor,
  skeleton: Skeleton,
  chain: readonly string[],
  parent: string,
  poleOffset: Vec3,
  what: string,
  out: Finding[],
): void {
  const first = chain[0]!;
  const last = chain[chain.length - 1]!;
  const tip = geometryTip(skeleton.get(last), skeleton.get(first).pivot);
  if (!tip || editor.hasIk(first)) return;
  const joints = chain.slice(1).map((bone) => skeleton.get(bone).pivot);
  const middle = [0, 1, 2].map(
    (axis) => joints.reduce((sum, pivot) => sum + pivot[axis]!, 0) / joints.length,
  );
  const locator = editor.addLocator(editor.uniqueName(`${last} tip`), tip, last);
  const pole = editor.addNull(
    editor.uniqueName(`${first} IK pole`),
    [middle[0]! + poleOffset[0], middle[1]! + poleOffset[1], middle[2]! + poleOffset[2]],
    parent,
  );
  editor.addNull(editor.uniqueName(`${first} IK`), tip, parent, {
    target: locator,
    source: first,
    pole,
  });
  out.push({
    message: `added Blockbench IK for ${what} ${chain.join(" > ")} (tip locator, IK null, pole null)`,
    fixed: true,
  });
}

function addIks(editor: ModelEditor, a: Analysis, options: Required<PrepareOptions>, out: Finding[]): void {
  const { skeleton } = a.model;
  if (options.hairIk) {
    for (const suggestion of a.suggestions) {
      const chain = suggestion.bones;
      const root = skeleton.get(chain[0]!);
      if (chain.length < 2 || root.parent === undefined) continue;
      const outward = HAIR_POLE_OUTWARD * Math.sign(root.pivot[0]);
      addIk(editor, skeleton, chain, root.parent, [outward, 0, POLE_DISTANCE], suggestion.preset, out);
    }
  }
  if (options.limbIk) {
    const anchor = a.roles.root ?? a.roles.torso;
    for (const [side, segments] of a.roles.arms) {
      if (segments.length >= 2 && a.roles.torso) {
        // Elbows point back.
        addIk(editor, skeleton, segments, a.roles.torso, [0, 0, POLE_DISTANCE], `the ${side} arm`, out);
      }
    }
    for (const [side, segments] of a.roles.legs) {
      if (segments.length >= 2 && anchor) {
        // Knees point forward.
        addIk(editor, skeleton, segments, anchor, [0, 0, -POLE_DISTANCE], `the ${side} leg`, out);
      }
    }
  }
}

export interface PrepareResult {
  readonly findings: Finding[];
  /** The rig after the fixes. */
  readonly analysis: Analysis;
}

/** Apply every automatic fix through `editor`; returns findings and the final analysis. */
export function prepare(editor: ModelEditor, options: PrepareOptions = {}): PrepareResult {
  const settings = {
    splitLimbs: options.splitLimbs ?? true,
    hairIk: options.hairIk ?? true,
    limbIk: options.limbIk ?? true,
  };
  const findings: Finding[] = [];
  const first = analyzeModel(editor.model());
  const parts: [string, unknown][] = [
    ["torso", first.roles.torso],
    ["head", first.roles.head],
    ["legs", first.roles.legs.size],
    ["arms", first.roles.arms.size],
  ];
  const missing = parts.filter(([, found]) => !found).map(([part]) => part);
  if (missing.length) {
    findings.push({
      message: `couldn't find the model's ${missing.join(", ")}; map those bones by hand`,
      fixed: false,
    });
  }
  fixStructure(editor, first, findings);
  if (settings.splitLimbs) splitLimbs(editor, analyzeModel(editor.model()), findings);
  fixJoints(editor, analyzeModel(editor.model()), findings);
  addIks(editor, analyzeModel(editor.model()), settings, findings);
  const analysis = analyzeModel(editor.model());
  if (!isGeckolib(analysis.model)) {
    findings.push({
      message:
        `the project format is '${analysis.model.modelFormat}': in Blockbench use ` +
        "File > Convert Project > GeckoLib Animated Model before exporting " +
        "for the mod",
      fixed: false,
    });
  }
  return { findings, analysis };
}
