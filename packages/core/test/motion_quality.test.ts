import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { describe, expect, it } from "vitest";

import { LoopMode, type Animation } from "../src/animation/clip";
import { makeBone, Skeleton } from "../src/animation/skeleton";
import { parseBbmodel, parseBbmodelText } from "../src/blockbench/bbmodel";
import { applyMorphRules, resolveMorphRules } from "../src/conversion/morphs";
import { applySecondaryMotion } from "../src/conversion/secondary";
import { Code, Diagnostics } from "../src/diagnostics";
import { MappingError, SkeletonError } from "../src/errors";
import { rotationFromChannel } from "../src/geckolib/encoding";
import { reducePosition, reduceRotation } from "../src/geckolib/optimize";
import * as quat from "../src/geometry/quat";
import { parseMapping } from "../src/mapping/schema";
import { dampingFor, geometryTip, nameTokens, resolveSecondary, suggestChains } from "../src/mapping/secondary";
import { toSourceRig } from "../src/pmx/adapter";
import { parsePmx } from "../src/pmx/parser";
import { hingeAxis } from "../src/rig/model";
import { builtinSkeleton, parseSkeleton } from "../src/rig/schema";
import { bbmodel, degrees, group, sourceMotion } from "./fixtures";
import { expectClose, readReferenceBytes, REPO_ROOT } from "./reference";

const z = (angle: number): quat.Quat => quat.fromAxisAngle([0, 0, 1], degrees(angle));

describe("source skeletons", () => {
  it("loads the built-in skeleton with knee hinges", () => {
    const rig = builtinSkeleton();
    expect(rig.name).toBe("mmd-standard");
    expect(rig.ik).toHaveLength(4);
    const knee = rig.ik[0]!.links[0]!;
    expect(hingeAxis(knee)).toBe(0); // knees bend about X only
    expect(hingeAxis(rig.ik[0]!.links[1]!)).toBeUndefined();
    expect(() => builtinSkeleton("nope")).toThrow(/unknown built-in skeleton 'nope'; available: \[mmd-standard\]/);
  });

  it("explains invalid skeleton files", () => {
    const bone = (name: string, parent: string | null) => ({ name, parent, position: [0, 0, 0] });
    const cases: [unknown, RegExp][] = [
      [{ name: "x", bones: [] }, /invalid skeleton file/],
      [{ name: "x", bones: [bone("a", null), bone("a", null)] }, /listed twice/],
      [{ name: "x", bones: [bone("b", "a"), bone("a", null)] }, /must come after its parent 'a'/],
      [
        { name: "x", bones: [bone("a", null)], ik: [{ bone: "a", target: "t", links: [{ bone: "a" }] }] },
        /uses unknown bones \[t\]/,
      ],
      [
        {
          name: "x",
          bones: [bone("a", null), bone("b", null), bone("ik", null)],
          ik: [{ bone: "ik", target: "b", links: [{ bone: "a" }] }],
        },
        /'a' must be the parent of 'b'/,
      ],
    ];
    for (const [data, message] of cases) {
      const run = (): unknown => parseSkeleton(data, "rig.json");
      expect(run).toThrow(SkeletonError);
      expect(run).toThrow(message);
    }
  });

  it("builds a rig from a PMX: parents first, inheritance, solvable chains only", () => {
    const rig = toSourceRig(parsePmx(readReferenceBytes("pmx", "legs.pmx")), "legs");
    const names = [...rig.bones.keys()];
    expect(names.indexOf("左ひざ")).toBeLessThan(names.indexOf("左足首"));
    expect(rig.bone("腰キャンセル左").inherit).toEqual({ bone: "腰", weight: -1 });
    expect(rig.ik.map((c) => c.bone)).toEqual(["左足ＩＫ", "左つま先ＩＫ", "髪ＩＫ"]);
    expectClose(rig.offset("左ひざ"), [0, -5.1, -0.3], 1e-6);
    // Helper chains that move nothing the conversion uses are left out.
    const legs = rig.driving(new Set(["左足", "左ひざ"]));
    expect(legs.ik.map((c) => c.bone)).toEqual(["左足ＩＫ"]);
    expect(legs.requiredBones().has("髪1")).toBe(false);
  });

  it("drops repeated names and chains that are not a parent chain", () => {
    const model = parsePmx(readReferenceBytes("pmx", "legs.pmx"));
    const repeated = { ...model, bones: [...model.bones, model.bones[1]!] };
    expect([...toSourceRig(repeated, "dup").bones.keys()]).toHaveLength(model.bones.length);
    const broken = {
      ...model,
      bones: model.bones.map((bone) =>
        bone.ik ? { ...bone, ik: { ...bone.ik, links: [...bone.ik.links].reverse() } } : bone,
      ),
    };
    // Single-link chains are unaffected by the reversal; the two-link leg chain breaks.
    expect(toSourceRig(broken, "odd").ik.map((c) => c.bone)).toEqual(["左つま先ＩＫ", "髪ＩＫ"]);
  });
});

describe("keyframe reduction", () => {
  const bone = makeBone("b", undefined);
  const times = Float64Array.from({ length: 41 }, (_, i) => i / 20);

  it("keeps two keys of a constant-speed turn and all the turns of a zigzag", () => {
    const steady = quat.quatArray(Array.from(times, (t) => z(40 * t)));
    expect(reduceRotation(bone, times, steady, 1).times).toHaveLength(2);
    const zigzag = quat.quatArray(Array.from(times, (_, i) => z(i % 2 ? 20 : 0)));
    expect(reduceRotation(bone, times, zigzag, 1).times.length).toBeGreaterThanOrEqual(41);
  });

  it("stays within the tolerance at every sample", () => {
    const wobble = Array.from(times, (t) =>
      quat.mul(z(60 * Math.sin(3 * t)), quat.fromAxisAngle([1, 0, 0], degrees(35 * Math.cos(5 * t)))),
    );
    const reduced = reduceRotation(bone, times, quat.quatArray(wobble), 1);
    expect(reduced.times.length).toBeLessThan(times.length);
    expect(reduced.maxError).toBeLessThanOrEqual(1 + 1e-9);
    // Check the bound independently: interpolate the kept keys at each sample.
    times.forEach((t, i) => {
      let k = 0;
      while (k + 2 < reduced.times.length && reduced.times[k + 1]! < t) k++;
      const span = reduced.times[k + 1]! - reduced.times[k]!;
      const alpha = Math.min(Math.max((t - reduced.times[k]!) / span, 0), 1);
      const value = [0, 1, 2].map(
        (axis) => reduced.values[3 * k + axis]! + alpha * (reduced.values[3 * k + 3 + axis]! - reduced.values[3 * k + axis]!),
      ) as unknown as quat.Vec3;
      expect(quat.angleBetween(rotationFromChannel(bone, value), wobble[i]!)).toBeLessThanOrEqual(degrees(1.0001));
    });
  });

  it("reduces positions and survives neighbouring kept keys", () => {
    // Regression: adjacent kept keys crashed the error summary.
    const values = new Float64Array(3 * times.length);
    times.forEach((t, i) => (values[3 * i] = i === 20 ? 5 : t));
    const reduced = reducePosition(times, values, 0.05);
    expect(Array.from(reduced.times)).toEqual([0, 0.95, 1, 1.05, 2]);
    expect(reduced.maxError).toBeLessThanOrEqual(0.05);
  });
});

describe("secondary motion", () => {
  const hairRig = parseBbmodel(
    bbmodel([
      group("Head", undefined, [0, 24, 0], [0, 0, 0], [[-4, 24, -4], [4, 32, 4]]),
      group("Hair", "Head", [0, 30, 4], [0, 0, 0], [[-1, 22, 4], [1, 30, 5]]),
      group("HairEnd", "Hair", [0, 22, 4.5], [0, 0, 0], [[-1, 14, 4], [1, 22, 5]]),
      group("Cuff", "Head", [0, 24, 0], [0, 0, 0], [[-5, 24, -5], [5, 26, 5]]),
    ]),
    "rig",
  ).skeleton;

  it("finds the tip from the cubes and validates chains", () => {
    expectClose(geometryTip(hairRig.get("HairEnd"), hairRig.get("Hair").pivot), [0, 14, 4.5], 1e-12);
    expect(dampingFor(100, 0.5)).toBe(10);
    const chains = resolveSecondary(
      parseMapping({ bones: { Head: "頭" }, secondary_motion: [{ bones: ["Hair", "HairEnd"], preset: "ponytail" }] }),
      hairRig,
    );
    expect(chains[0]).toMatchObject({ stiffness: 60, gravity: 1, maxAngle: 90 });
    const invalid: [unknown, RegExp][] = [
      [[{ bones: ["Hare"] }], /bones not found[\s\S]*did you mean 'Hair'/],
      [[{ bones: ["HairEnd", "Hair"] }], /'Hair' is not a child of 'HairEnd'/],
      [[{ bones: ["Head"] }], /\['Head'\] are already driven/],
      [[{ bones: ["Hair"] }, { bones: ["Hair"] }], /\['Hair'\] are already driven/],
    ];
    for (const [chainsSpec, message] of invalid) {
      const mapping = parseMapping({ bones: { Head: "頭" }, secondary_motion: chainsSpec });
      expect(() => resolveSecondary(mapping, hairRig, "m.json")).toThrow(MappingError);
      expect(() => resolveSecondary(mapping, hairRig, "m.json")).toThrow(message);
    }
  });

  it("suggests hair chains but not pieces wrapping their parent", () => {
    expect(nameTokens("SquareHair_Right2")).toEqual(["square", "hair", "right", "2"]);
    const suggestions = suggestChains(hairRig, parseMapping({ bones: { Head: "頭" } }));
    // Two segments, 16 px long: long enough to swing like long hair.
    expect(suggestions).toEqual([{ bones: ["Hair", "HairEnd"], preset: "long_hair" }]);
  });

  it("suggests exactly the chains the committed template mapping uses", () => {
    for (const variant of ["template", "template_slim"]) {
      const model = parseBbmodelText(
        readFileSync(resolvePath(REPO_ROOT, "templates", `${variant}.bbmodel`), "utf8"),
        variant,
      );
      const mapping = parseMapping(
        JSON.parse(readFileSync(resolvePath(REPO_ROOT, "mappings", `${variant}.json`), "utf8")),
      );
      const wanted = mapping.secondary_motion.map((c) => ({ bones: c.bones, preset: c.preset }));
      expect(suggestChains(model.skeleton, undefined), variant).toEqual(wanted);
      expect(suggestChains(model.skeleton, mapping), variant).toEqual([]);
    }
  });

  it("hangs still at rest and swings when the head turns", () => {
    const chains = resolveSecondary(
      parseMapping({ bones: { Head: "頭" }, secondary_motion: [{ bones: ["Hair", "HairEnd"] }] }),
      hairRig,
    );
    const times = Float64Array.from({ length: 41 }, (_, i) => i / 20);
    const run = (head: quat.Quat[]): Animation => {
      const animation: Animation = {
        name: "a",
        times,
        length: 2,
        loop: LoopMode.ONCE,
        tracks: new Map([["Head", { rotations: quat.quatArray(head) }]]),
      };
      applySecondaryMotion(animation, hairRig, chains);
      return animation;
    };
    const still = run(Array.from(times, () => quat.IDENTITY));
    const hanging = still.tracks.get("Hair")!.rotations!;
    // Almost straight down already (half a pixel off), so gravity barely moves it.
    expect(quat.angle(quat.getQuat(hanging, 40))).toBeLessThan(degrees(3));
    const turning = run(Array.from(times, (t) => quat.fromAxisAngle([1, 0, 0], degrees(60 * t))));
    const swung = turning.tracks.get("Hair")!.rotations!;
    expect(quat.angle(quat.getQuat(swung, 40))).toBeGreaterThan(degrees(10));
  });
});

describe("facial animation", () => {
  const face = new Skeleton([
    makeBone("head", undefined, [0, 24, 0]),
    makeBone("lid", "head", [-2, 28, -4]),
    makeBone("mouth", "head", [0, 25, -4]),
    makeBone("mouth_a", "head", [0, 25, -4]),
    makeBone("mouth_closed", "head", [0, 25, -4]),
  ]);
  const morphMotion = (morphs: Record<string, [number, number][]>) =>
    sourceMotion(
      {},
      {
        endFrame: 30,
        morphs: new Map(
          Object.entries(morphs).map(([name, keys]) => [
            name,
            { name, frames: Float64Array.from(keys, (k) => k[0]), weights: Float64Array.from(keys, (k) => k[1]) },
          ]),
        ),
      },
    );

  function run(rules: unknown[], motion = morphMotion({})): { animation: Animation; diagnostics: Diagnostics } {
    const diagnostics = new Diagnostics();
    const mapping = parseMapping({ bones: { head: "頭" }, morphs: rules });
    const resolved = resolveMorphRules(mapping.morphs, face, motion, diagnostics);
    const animation: Animation = {
      name: "a",
      times: Float64Array.from([0, 0.5, 1]),
      length: 1,
      loop: LoopMode.ONCE,
      tracks: new Map(),
    };
    applyMorphRules(animation, face, motion, resolved);
    return { animation, diagnostics };
  }

  it("blends scale with the morph weight", () => {
    const { animation } = run(
      [{ morph: "まばたき", bone: "lid", scale_from: [1, 0, 1], scale: [1, 1, 1] }],
      morphMotion({ まばたき: [[0, 0], [30, 1]] }),
    );
    expectClose(animation.tracks.get("lid")!.scales, [1, 0, 1, 1, 0.5, 1, 1, 1, 1], 1e-12);
  });

  it("uses the strongest listed morph and multiplies rules on one bone", () => {
    const { animation } = run(
      [
        { morph: ["あ", "お"], bone: "mouth", scale: [1, 3, 1] },
        { morph: "い", bone: "mouth", scale: [2, 1, 1] },
      ],
      morphMotion({ あ: [[0, 0.5]], お: [[0, 1]], い: [[0, 1]] }),
    );
    expectClose(animation.tracks.get("mouth")!.scales!.subarray(0, 3), [2, 3, 1], 1e-12);
  });

  it("shows and hides swapped mouth shapes", () => {
    const { animation } = run(
      [
        { morph: "あ", bone: "mouth_a", show_above: 0.5 },
        { morph: "あ", bone: "mouth_closed", hide_above: 0.5 },
      ],
      morphMotion({ あ: [[0, 0], [30, 1]] }),
    );
    const y = (bone: string): number[] => [1, 4, 7].map((i) => animation.tracks.get(bone)!.scales![i]!);
    expect(y("mouth_a")).toEqual([0, 1, 1]);
    expect(y("mouth_closed")).toEqual([1, 0, 0]);
  });

  it("reports unused morphs and unknown bones", () => {
    const motion = morphMotion({ あ: [[0, 1]], まばたき: [[0, 1]] });
    const none = run([], motion).diagnostics;
    expect(none.items.find((d) => d.code === Code.UNSUPPORTED_MORPHS)?.message).toContain("no morph rules");
    const some = run([{ morph: "あ", bone: "mouth", scale: [1, 2, 1] }], motion).diagnostics;
    expect(some.items.find((d) => d.code === Code.UNSUPPORTED_MORPHS)?.bones).toEqual(["まばたき"]);
    expect(some.codes().has(Code.FACIAL_ANIMATION)).toBe(true);
    expect(() => run([{ morph: "あ", bone: "mouht", scale: [1, 2, 1] }], motion)).toThrow(/did you mean 'mouth'/);
  });
});
