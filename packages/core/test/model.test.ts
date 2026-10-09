import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBbmodel } from "../src/blockbench/bbmodel";
import { makeBone, Skeleton } from "../src/animation/skeleton";
import { faceRules, generateMapping, renderMapping, sourcePath, unanimatedFaceParts } from "../src/mapping/init";
import { parseMappingText } from "../src/mapping/schema";
import { BbmodelDocument } from "../src/model/document";
import { analyzeModel, prepare, type Analysis } from "../src/model/prepare";
import { detectRoles, rolesByRole } from "../src/model/roles";
import roleData from "../src/data/mmd_roles.json";
import { bbmodel, group } from "./fixtures";
import { expectClose, readReferenceJson, REFERENCE_DIR, REPO_ROOT } from "./reference";

interface AnalysisDump {
  roles: Record<string, string>;
  arms: Record<string, string[]>;
  legs: Record<string, string[]>;
  suggestions: { bones: string[]; preset: string }[];
  mapping_text?: string;
}
interface ElementDump {
  parent: string | null;
  name: string;
  type: string;
  from?: number[];
  to?: number[];
  position?: number[];
  box_uv?: boolean;
  faces?: Record<string, number[] | null>;
  ik_target?: string;
  ik_source?: string;
  ik_pole?: string;
}
interface Expected extends AnalysisDump {
  model: string;
  prepare: {
    options: { split_limbs: boolean; hair_ik: boolean; limb_ik: boolean };
    findings: { message: string; fixed: boolean }[];
    document: {
      bones: { name: string; parent: string | null; pivot: number[]; extent: number[][] | null }[];
      elements: ElementDump[];
    };
    after: AnalysisDump;
    fixed_again: string[];
  };
}

const RIGS = readdirSync(resolve(REFERENCE_DIR, "models")).sort();

function load(rig: string): { expected: Expected; data: unknown } {
  const expected = readReferenceJson<Expected>("models", rig, "expected.json");
  const path = expected.model.startsWith("@")
    ? resolve(REPO_ROOT, expected.model.slice(1))
    : resolve(REFERENCE_DIR, "models", rig, expected.model);
  return { expected, data: JSON.parse(readFileSync(path, "utf8")) };
}

function dump(analysis: Analysis): AnalysisDump {
  const out: AnalysisDump = {
    roles: Object.fromEntries(rolesByRole(analysis.roles)),
    arms: Object.fromEntries(analysis.roles.arms),
    legs: Object.fromEntries(analysis.roles.legs),
    suggestions: analysis.suggestions.map((s) => ({ bones: [...s.bones], preset: s.preset })),
  };
  if (Object.keys(out.roles).length) {
    out.mapping_text = renderMapping(
      generateMapping(analysis.model.skeleton, analysis.roles, analysis.suggestions, analysis.model.name),
    );
  }
  return out;
}

type Node = Record<string, unknown>;

/** Elements with their parent's name and references resolved to names (uuids are random). */
function elements(document: BbmodelDocument): ElementDump[] {
  const data = document.data as { outliner: unknown[]; elements: Node[]; groups?: Node[] };
  const groups = new Map((data.groups ?? []).map((g) => [g.uuid as string, g]));
  const groupName = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const n = node as Node;
      const name = String((groups.get(n.uuid as string) ?? n).name);
      groupName.set(n.uuid as string, name);
      const children = (n.children as unknown[] | undefined) ?? [];
      for (const child of children) if (typeof child === "string") parentOf.set(child, name);
      walk(children);
    }
  };
  walk(data.outliner);
  const elementName = new Map(data.elements.map((e) => [e.uuid as string, String(e.name ?? "")]));
  return data.elements.map((element) => {
    const entry: ElementDump = {
      parent: parentOf.get(element.uuid as string) ?? null,
      name: String(element.name ?? ""),
      type: String(element.type ?? "cube"),
    };
    for (const key of ["from", "to", "position", "box_uv"] as const) {
      if (key in element) (entry as unknown as Node)[key] = element[key];
    }
    if (element.faces) {
      entry.faces = Object.fromEntries(
        Object.entries(element.faces as Record<string, { uv?: number[] }>).map(([f, v]) => [f, v.uv ?? null]),
      );
    }
    if (element.type === "null_object") {
      entry.ik_target = elementName.get(element.ik_target as string) ?? "";
      entry.ik_source = groupName.get(element.ik_source as string) ?? "";
      entry.ik_pole = elementName.get(element.ik_pole as string) ?? "";
    }
    return entry;
  });
}

/** A key that orders elements the same way whatever order they were created in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const sorted = (list: ElementDump[]): ElementDump[] =>
  [...list].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));

describe("body parts and generated mappings match the Python version", () => {
  it.each(RIGS)("%s", (rig) => {
    const { expected, data } = load(rig);
    const actual = dump(analyzeModel(parseBbmodel(data, "rig")));
    expect(actual.roles).toEqual(expected.roles);
    expect(actual.arms).toEqual(expected.arms);
    expect(actual.legs).toEqual(expected.legs);
    expect(actual.suggestions).toEqual(expected.suggestions);
    expect(actual.mapping_text).toBe(expected.mapping_text);
    if (actual.mapping_text) parseMappingText(actual.mapping_text); // a valid mapping file
  });

  it("the committed template mappings are what gets generated", () => {
    for (const variant of ["template", "template_slim"]) {
      const { data } = load(variant);
      const committed = readFileSync(resolve(REPO_ROOT, "mappings", `${variant}.json`), "utf8");
      expect(dump(analyzeModel(parseBbmodel(data, variant))).mapping_text, variant).toBe(committed);
    }
  });
});

describe("model preparation matches the Python version", () => {
  it.each(RIGS)("%s", (rig) => {
    const { expected, data } = load(rig);
    const options = expected.prepare.options;
    const settings = { splitLimbs: options.split_limbs, hairIk: options.hair_ik, limbIk: options.limb_ik };
    const document = new BbmodelDocument(structuredClone(data), "rig");
    const { findings, analysis } = prepare(document, settings);

    expect(findings).toEqual(expected.prepare.findings);
    const { skeleton } = analysis.model;
    expect(skeleton.names).toEqual(expected.prepare.document.bones.map((b) => b.name));
    for (const bone of expected.prepare.document.bones) {
      const actual = skeleton.get(bone.name);
      expect(actual.parent ?? null, bone.name).toBe(bone.parent);
      expectClose(actual.pivot, bone.pivot, 0, `${bone.name} pivot`);
      if (bone.extent === null) expect(actual.extent, bone.name).toBeUndefined();
      else expectClose(actual.extent, bone.extent, 0, `${bone.name} extent`);
    }
    expect(sorted(elements(document))).toEqual(sorted(expected.prepare.document.elements));

    const after = dump(analysis);
    expect(after.roles).toEqual(expected.prepare.after.roles);
    expect(after.mapping_text).toBe(expected.prepare.after.mapping_text);
    // Preparing a prepared model changes nothing more.
    const again = prepare(new BbmodelDocument(structuredClone(document.data), "rig"), settings);
    expect(again.findings.filter((f) => f.fixed).map((f) => f.message)).toEqual(expected.prepare.fixed_again);
  });

  it("the committed templates are already ready to dance", () => {
    for (const variant of ["template", "template_slim"]) {
      const { data } = load(variant);
      const { findings, analysis } = prepare(new BbmodelDocument(structuredClone(data), variant));
      expect(findings, variant).toEqual([]);
      const roles = rolesByRole(analysis.roles);
      for (const role of ["root", "hips", "torso", "chest", "head", "hand_left", "foot_right"]) {
        expect(roles.has(role), `${variant} ${role}`).toBe(true);
      }
    }
  });
});

describe("mapping generation", () => {
  it("walks the MMD tree, going up with inverses", () => {
    const { tree, inverse } = roleData;
    expect(sourcePath(tree, inverse, undefined, "グルーブ")).toEqual(["全ての親", "全ての親2", "センター", "グルーブ"]);
    // Extra spine bones some model families add are on the path (at rest when absent).
    expect(sourcePath(tree, inverse, "上半身", "頭")).toEqual(["上半身1", "上半身2", "上半身3", "首", "頭"]);
    // Up from the torso to the waist, then down the leg; the cancel node is the waist inverted.
    expect(sourcePath(tree, inverse, "上半身", "左足")).toEqual([
      { bone: "上半身", weight: -1 },
      "下半身",
      { bone: "腰", weight: -1 },
      "左足",
    ]);
  });
});

describe("document edits", () => {
  it("splits a cube keeping its UVs exact", () => {
    const data = bbmodel([group("Arm", undefined, [0, 10, 0], [0, 0, 0], [[0, 0, 0], [2, 10, 2]])]);
    const cube = (data.elements as Node[])[0]!;
    const side = (): { uv: number[]; texture: number } => ({ uv: [0, 0, 2, 10], texture: 0 });
    cube.faces = {
      north: side(),
      east: side(),
      south: side(),
      west: side(),
      up: { uv: [2, 0, 4, 2], texture: 0 },
      down: { uv: [4, 0, 6, 2], texture: 0 },
    };
    cube.box_uv = true;
    const document = new BbmodelDocument(data, "rig");
    document.addGroup("Lower", "Arm", [0, 4, 0], "Arm");
    const lowerId = document.splitCube(String(cube.uuid), 4, "Lower");
    const lower = (data.elements as Node[]).find((e) => e.uuid === lowerId)!;
    const uv = (element: Node, face: string): number[] => (element.faces as Record<string, { uv: number[] }>)[face]!.uv;

    expect([(cube.from as number[])[1], (cube.to as number[])[1]]).toEqual([4, 10]);
    expect([(lower.from as number[])[1], (lower.to as number[])[1]]).toEqual([0, 4]);
    expect(uv(cube, "north")).toEqual([0, 0, 2, 6]); // top 6 px of the side
    expect(uv(lower, "north")).toEqual([0, 6, 2, 10]);
    expect(uv(cube, "up")).toEqual([2, 0, 4, 2]);
    expect(uv(lower, "down")).toEqual([4, 0, 6, 2]);
    expect([cube.box_uv, lower.box_uv]).toEqual([false, false]);
    expect(document.cubes("Lower").map((c) => c.id)).toEqual([lowerId]);
  });

  it("finds unique names and rejects non-projects", () => {
    const document = new BbmodelDocument(bbmodel([group("root"), group("root 2", "root")]), "rig");
    expect(document.uniqueName("root")).toBe("root 3");
    expect(document.uniqueName("hips")).toBe("hips");
    expect(() => new BbmodelDocument({ elements: [] })).toThrow(/not a Blockbench project/);
  });
});

describe("face rules", () => {
  // A head whose face parts are flat panels pivoting at the neck, next to parts that pivot
  // at their own middle.
  const skeleton = new Skeleton([
    makeBone("body", undefined, [0, 12, 0], [0, 0, 0], [[-4, 12, -2], [4, 24, 2]]),
    makeBone("head", "body", [0, 24, 0], [0, 0, 0], [[-4, 24, -4], [4, 32, 4]]),
    makeBone("panel eyes", "head", [0, 24, 0], [0, 0, 0], [[-4, 26, -4], [4, 30, -4]]),
    makeBone("panel mouth", "head", [0, 24, 0], [0, 0, 0], [[-4, 24, -4], [4, 26, -4]]),
    makeBone("small mouth", "head", [0, 25, -4], [0, 0, 0], [[-1, 24.5, -4], [1, 25.5, -4]]),
    makeBone("small eyes", "head", [0, 28, -4]),
    makeBone("small eye l", "small eyes", [-2, 27, -4], [0, 0, 0], [[-3, 27, -4], [-1, 29, -4]]), // closes downwards
    makeBone("small eye r", "small eyes", [2, 28, -4], [0, 0, 0], [[1, 27, -4], [3, 29, -4]]),
  ]);
  const roles = detectRoles(skeleton, new Set());

  it("leaves parts still when scaling would move them", () => {
    expect(roles.head).toBe("head");
    const scaled = new Set(faceRules(skeleton, roles).map((rule) => rule.bone));
    expect([...scaled].sort()).toEqual(["small eye l", "small eye r", "small eyes", "small mouth"]);
    expect(unanimatedFaceParts(skeleton, roles)).toEqual(["panel eyes", "panel mouth"]);
  });
});
