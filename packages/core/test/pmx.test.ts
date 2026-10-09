import { describe, expect, it } from "vitest";

import { InputFormatError } from "../src/errors";
import { parsePmx } from "../src/pmx/parser";
import { expectClose, readReferenceBytes, readReferenceJson } from "./reference";

interface PmxDump {
  name: string;
  bones: {
    name: string;
    position: number[];
    parent: number;
    inherit_rotation: [number, number] | null;
    ik: {
      target: number;
      iterations: number;
      limit_angle: number;
      links: { bone: number; min: number[] | null; max: number[] | null }[];
    } | null;
  }[];
  morphs: [string, number][];
}

const expected = readReferenceJson<PmxDump>("pmx", "legs.json");

describe("PMX reader", () => {
  // The same model in UTF-16 with 2-byte indices, UTF-8 with 1-byte, and 4-byte indices.
  it.each(["legs", "legs_utf8_1", "legs_4"])("reads bones, IK and morphs of %s.pmx", (file) => {
    const model = parsePmx(readReferenceBytes("pmx", `${file}.pmx`));
    expect(model.name).toBe(expected.name);
    expect(model.bones.map((b) => b.name)).toEqual(expected.bones.map((b) => b.name));
    model.bones.forEach((bone, i) => {
      const want = expected.bones[i]!;
      expectClose(bone.position, want.position, 0, bone.name);
      expect(bone.parent, bone.name).toBe(want.parent);
      expect(bone.inheritRotation ?? null, bone.name).toEqual(want.inherit_rotation);
      if (want.ik === null) {
        expect(bone.ik, bone.name).toBeUndefined();
        return;
      }
      expect(bone.ik?.target).toBe(want.ik.target);
      expect(bone.ik?.iterations).toBe(want.ik.iterations);
      expect(bone.ik?.limitAngle).toBe(want.ik.limit_angle);
      expect(
        bone.ik?.links.map((l) => ({
          bone: l.bone,
          min: l.minAngles ?? null,
          max: l.maxAngles ?? null,
        })),
      ).toEqual(want.ik.links);
    });
    expect(model.morphs.map((m) => [m.name, m.panel])).toEqual(expected.morphs);
  });

  it("explains files that aren't PMX or end early", () => {
    const good = readReferenceBytes("pmx", "legs.pmx");
    const cases: [Uint8Array, RegExp][] = [
      [new TextEncoder().encode("Pmd\0rest"), /not a PMX file/],
      [good.subarray(0, 60), /file ends inside/],
      [good.subarray(0, good.length - 40), /file ends inside/],
    ];
    for (const [data, message] of cases) {
      const run = (): unknown => parsePmx(data, "broken.pmx");
      expect(run).toThrow(InputFormatError);
      expect(run).toThrow(message);
      expect(run).toThrow(/broken\.pmx/);
    }
  });
});
