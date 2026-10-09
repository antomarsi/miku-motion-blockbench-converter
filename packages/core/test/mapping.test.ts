import { describe, expect, it } from "vitest";

import { makeBone, Skeleton } from "../src/animation/skeleton";
import { parseBbmodel, parseBbmodelText } from "../src/blockbench/bbmodel";
import { Code, Diagnostics } from "../src/diagnostics";
import { MappingError, TargetModelError } from "../src/errors";
import * as quat from "../src/geometry/quat";
import { resolve, type ResolvedMapping } from "../src/mapping/resolve";
import { mappingEntries, parseMapping, parseMappingText, type MappingFile } from "../src/mapping/schema";
import { closestMatch, globMatch, listNames } from "../src/text";
import { bbmodel, degrees, group, playerRig, sourceMotion } from "./fixtures";
import { expectClose } from "./reference";

const SKELETON = parseBbmodel(playerRig(), "rig").skeleton;
const z = (angle: number): quat.Quat => quat.fromAxisAngle([0, 0, 1], degrees(angle));
const MOTION = sourceMotion(
  {
    センター: [{ frame: 0 }, { frame: 30, position: [0, 1, 0] }],
    上半身: [{ frame: 0, rotation: z(10) }],
    左腕: [{ frame: 0, rotation: z(30) }, { frame: 30 }],
    右腕: [{ frame: 0, position: [0, 0.5, 0] }],
    左足ＩＫ: [{ frame: 0, position: [0, 0, 1] }],
    左人指１: [{ frame: 0, rotation: z(5) }],
    静止: [{ frame: 0 }], // a bone at rest: never worth a warning
  },
  { ikBones: new Set(["左足ＩＫ"]) },
);

function mapping(overrides: Record<string, unknown> = {}): MappingFile {
  return parseMapping({
    bones: {
      Root: { from: ["センター"], translation: true },
      Body: "上半身",
      LeftArm: { from: ["左腕"], rest_correction: { euler_deg: [0, 0, -53] } },
      RightArm: "右腕",
    },
    ...overrides,
  });
}

function run(file: MappingFile, skeleton = SKELETON): { resolved: ResolvedMapping; diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics();
  return { resolved: resolve(file, skeleton, MOTION, diagnostics), diagnostics };
}

const binding = (resolved: ResolvedMapping, target: string) =>
  resolved.bindings.find((b) => b.target === target)!;
const byCode = (diagnostics: Diagnostics, code: Code) => diagnostics.items.find((d) => d.code === code);

describe("target model reader", () => {
  it.each([4, 5] as const)("reads layout %i", (layout) => {
    const model = parseBbmodel(playerRig(layout), "fallback");
    expect(model.name).toBe("player_rig");
    expect(model.formatVersion).toBe(`${layout}.0`);
    expect(model.skeleton.names[2]).toBe("Chest");
    const chest = model.skeleton.get("Chest");
    expect(chest.parent).toBe("Body");
    expect(chest.pivot).toEqual([0, 23, -1]);
    expect(quat.angle(chest.restRotation)).toBeCloseTo(degrees(20), 12);
  });

  it("accumulates rest rotations and answers hierarchy queries", () => {
    const skeleton = new Skeleton([
      makeBone("a", undefined, [0, 0, 0], [0, 0, 30]),
      makeBone("b", "a", [0, 1, 0], [0, 0, 20]),
      makeBone("c", "a"),
    ]);
    expect(quat.sameRotation(skeleton.restWorldRotation("b"), z(50))).toBe(true);
    expect(skeleton.ancestors("b").map((bone) => bone.name)).toEqual(["a"]);
    expect(skeleton.children("a").map((bone) => bone.name)).toEqual(["b", "c"]);
    expect([skeleton.has("c"), skeleton.has("d"), skeleton.order("c")]).toEqual([true, false, 2]);
    expect(() => new Skeleton([makeBone("b", "a")])).toThrow(/before its parent/);
  });

  it("defaults missing origin and rotation, and reads cube extents", () => {
    const document = bbmodel([group("Arm", undefined, [1, 2, 3], [0, 0, 0], [[0, 0, 0], [2, 4, 6]])]);
    delete (document.groups as Record<string, unknown>[])[0]!.origin;
    const bone = parseBbmodel(document, "rig").skeleton.get("Arm");
    expect(bone.pivot).toEqual([0, 0, 0]);
    expect(bone.extent).toEqual([[0, 0, 0], [2, 4, 6]]);
  });

  it("uses the fallback name for unnamed projects", () => {
    const document = bbmodel([group("Arm")], { modelFormat: "free" });
    document.name = "";
    const model = parseBbmodel(document, "from_file");
    expect([model.name, model.modelFormat]).toEqual(["from_file", "free"]);
  });

  it("explains unusable models", () => {
    const twice = bbmodel([group("Arm"), group("Arm2")]);
    (twice.groups as Record<string, unknown>[])[1]!.name = "Arm";
    expect(() => parseBbmodel(twice, "rig", "rig.bbmodel")).toThrow(/more than once: \['Arm'\]/);
    expect(() => parseBbmodel(bbmodel([]), "rig")).toThrow(/no groups/);
    expect(() => parseBbmodel({ elements: [] }, "rig")).toThrow(/not a Blockbench project/);
    expect(() => parseBbmodel([], "rig")).toThrow(/top level/);
    expect(() => parseBbmodelText("{", "rig", "bad.bbmodel")).toThrow(/bad\.bbmodel: not valid JSON/);

    const dangling = bbmodel([group("Arm")]);
    dangling.groups = [];
    expect(() => parseBbmodel(dangling, "rig")).toThrow(/unknown group uuid/);
    const badVector = bbmodel([group("Arm")]);
    (badVector.groups as Record<string, unknown>[])[0]!.origin = [1, "x", 3];
    expect(() => parseBbmodel(badVector, "rig")).toThrow(/origin must be three numbers/);
    const badEntry = bbmodel([group("Arm")]);
    (badEntry.outliner as unknown[]).push(42);
    expect(() => parseBbmodel(badEntry, "rig")).toThrow(TargetModelError);
    expect(() => parseBbmodel(badEntry, "rig")).toThrow(/unexpected outliner entry/);
  });
});

describe("mapping file", () => {
  it("expands the string shorthand and reads weights", () => {
    const entries = mappingEntries(mapping());
    expect(entries.get("Body")!.chain).toEqual([{ bone: "上半身", weight: 1 }]);
    expect(entries.get("Root")!.translation).toBe(true);
    expect(entries.get("LeftArm")!.restCorrectionDegrees).toEqual([0, 0, -53]);
    const leg = mapping({ bones: { LeftLeg: { from: ["腰", { bone: "腰", weight: -1 }, "左足"] } } });
    expect(mappingEntries(leg).get("LeftLeg")!.chain.map((l) => [l.bone, l.weight])).toEqual([
      ["腰", 1],
      ["腰", -1],
      ["左足", 1],
    ]);
  });

  it.each([
    [{ bones: {} }, /bones: must map at least one target bone/],
    [{ bones: { A: { form: ["x"] } } }, /form/], // a typo is caught
    [{ bones: { A: { from: [] } } }, /bones\.A/],
    [{ bones: { A: "x" }, schema_version: 2 }, /schema_version/],
    [{ bones: { A: "x" }, units: { translation_scale: 0 } }, /units\.translation_scale/],
    [{ bones: { A: "x" }, extra: 1 }, /extra/],
    [{ bones: { A: "x" }, morphs: [{ morph: "あ", bone: "m" }] }, /exactly one/],
    [
      { bones: { A: "x" }, morphs: [{ morph: "あ", bone: "m", position: [0, 1, 0], scale_from: [0, 0, 0] }] },
      /scale_from only goes with scale/,
    ],
    [{ bones: { A: "x" }, morphs: [{ morph: [], bone: "m", show_above: 0.5 }] }, /at least one morph/],
    [
      { bones: { A: "x" }, secondary_motion: [{ bones: ["h"], bounciness: 0.5, damping: 1 }] },
      /either bounciness or damping/,
    ],
  ])("explains invalid mapping %#", (data, message) => {
    const run = (): unknown => parseMapping(data, "m.json");
    expect(run).toThrow(MappingError);
    expect(run).toThrow(message);
    expect(run).toThrow(/m\.json: invalid mapping file/);
  });

  it("reports unreadable JSON", () => {
    expect(() => parseMappingText("{", "bad.json")).toThrow(/bad\.json: not valid JSON/);
    expect(parseMappingText('{"bones": {"A": "x"}}').bones).toEqual({ A: "x" });
  });

  it("fills in defaults", () => {
    const file = parseMapping({ bones: { A: "x" } });
    expect([file.schema_version, file.unmapped, file.units.translation_scale]).toEqual([1, "warn", 1]);
    expect([file.ignore, file.secondary_motion, file.morphs]).toEqual([[], [], []]);
  });
});

describe("mapping resolution", () => {
  it("orders bindings like the skeleton and finds anchors", () => {
    const { resolved } = run(mapping());
    expect(resolved.bindings.map((b) => b.target)).toEqual(["Root", "Body", "LeftArm", "RightArm"]);
    expect(binding(resolved, "Body").anchor).toBe("Root");
    expect(binding(resolved, "LeftArm").anchor).toBe("Body");
    expect(binding(resolved, "Root").anchor).toBeUndefined();
    expect(quat.angle(binding(resolved, "LeftArm").restCorrection)).toBeCloseTo(0.925, 3);
    const skipping = run(mapping({ bones: { Root: "センター", LowerLeftArm: "左ひじ" } }));
    expect(binding(skipping.resolved, "LowerLeftArm").anchor).toBe("Root");
  });

  it("suggests a close match for an unknown target", () => {
    expect(() => run(mapping({ bones: { LeftArmm: "左腕" } }))).toThrow(/did you mean 'LeftArm'/);
  });

  it("reports dropped and unmapped data", () => {
    const { diagnostics } = run(mapping());
    expect(byCode(diagnostics, Code.UNMAPPED_ANIMATED_BONES)?.bones).toEqual(["左人指１"]);
    expect(byCode(diagnostics, Code.IK_DRIVEN_BONES)?.bones).toEqual(["左足ＩＫ"]);
    expect(byCode(diagnostics, Code.TRANSLATION_DROPPED)?.bones).toEqual(["右腕"]);
    expect(byCode(diagnostics, Code.UNMAPPED_TARGET_BONES)?.bones).toContain("Head");
    expect(byCode(diagnostics, Code.MAPPED_SOURCE_MISSING)).toBeUndefined();
  });

  it("honours ignore patterns and the unmapped policy", () => {
    const ignoring = run(mapping({ ignore: ["*指*", "左足ＩＫ"] })).diagnostics;
    expect(ignoring.codes().has(Code.UNMAPPED_ANIMATED_BONES)).toBe(false);
    expect(ignoring.codes().has(Code.IK_DRIVEN_BONES)).toBe(false);
    expect(() => run(mapping({ unmapped: "error" }))).toThrow(/not mapped/);
    const silent = run(mapping({ unmapped: "ignore" })).diagnostics;
    expect(silent.codes().has(Code.UNMAPPED_ANIMATED_BONES)).toBe(false);
  });

  it("reports mapped sources the motion lacks", () => {
    const { diagnostics } = run(mapping({ bones: { Head: "頭" } }));
    expect(byCode(diagnostics, Code.MAPPED_SOURCE_MISSING)?.bones).toEqual(["頭"]);
  });

  it("matches long names after the VMD's truncation", () => {
    const longName = "あいうえおかきくけこ"; // stored truncated in the 15-byte VMD field
    const motion = sourceMotion({ [longName]: [{ frame: 0, rotation: z(5) }] });
    const diagnostics = new Diagnostics();
    const resolved = resolve(parseMapping({ bones: { Head: longName } }), SKELETON, motion, diagnostics);
    expect(motion.tracks.has(binding(resolved, "Head").chain[0]!.source)).toBe(true);
    expect(diagnostics.codes().has(Code.UNMAPPED_ANIMATED_BONES)).toBe(false);
  });

  it("warns when a source is applied twice through an ancestor", () => {
    const twice = run(
      mapping({ bones: { Body: { from: ["上半身", "上半身2"] }, Head: { from: ["上半身2", "頭"] } } }),
    ).diagnostics;
    expect(byCode(twice, Code.SOURCE_APPLIED_TWICE)?.bones).toEqual(["上半身2 (Head via Body)"]);
    // Root's 腰 (+1) plus the leg's 腰 / 腰^-1 pair (net 0) applies 腰 exactly once.
    const cancelled = run(
      mapping({
        bones: { Root: "腰", LeftLeg: { from: ["腰", "下半身", { bone: "腰", weight: -1 }, "左足"] } },
      }),
    ).diagnostics;
    expect(cancelled.codes().has(Code.SOURCE_APPLIED_TWICE)).toBe(false);
  });

  it("warns when a bone rotates around its mapped parent's pivot", () => {
    const skeleton = parseBbmodel(
      bbmodel([
        group("Arm", undefined, [4, 22, 0]),
        group("Forearm", "Arm", [4, 22, 0]), // forgot to move the elbow pivot
        group("Hand", "Forearm", [4, 12, 0]),
      ]),
      "rig",
    ).skeleton;
    const file = parseMapping({ bones: { Arm: "左腕", Forearm: "左ひじ", Hand: "左手首" } });
    const { diagnostics } = run(file, skeleton);
    expect(byCode(diagnostics, Code.PIVOT_SHARED_WITH_PARENT)?.bones).toEqual(["Forearm (pivot of Arm)"]);
  });
});

describe("text helpers", () => {
  it("matches glob patterns", () => {
    expect(globMatch("左人指１", "*指*")).toBe(true);
    expect(globMatch("左腕", "*指*")).toBe(false);
    expect(globMatch("arm.L", "arm.?")).toBe(true);
    expect(globMatch("armXL", "arm.?")).toBe(false);
    expect(globMatch("b2", "b[12]")).toBe(true);
    expect(globMatch("b3", "b[!12]")).toBe(true);
    expect(globMatch("a(b)", "a(b)")).toBe(true);
  });

  it("finds likely typos and trims long lists", () => {
    expect(closestMatch("LeftArmm", ["Head", "LeftArm", "LeftLeg"])).toBe("LeftArm");
    expect(closestMatch("zzz", ["Head", "LeftArm"])).toBeUndefined();
    const names = Array.from({ length: 15 }, (_, i) => `b${i}`);
    expect(listNames(names)).toMatch(/b11 \(\+3 more\)$/);
    expectClose([1], [1], 0);
  });
});
