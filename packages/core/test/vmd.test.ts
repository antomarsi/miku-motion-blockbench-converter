import { describe, expect, it } from "vitest";

import { Code, Diagnostics } from "../src/diagnostics";
import { InputFormatError } from "../src/errors";
import { toSourceMotion } from "../src/vmd/adapter";
import * as interpolation from "../src/vmd/interpolation";
import {
  BONE_NAME_BYTES,
  canonicalBoneName,
  decodeName,
  encodeName,
} from "../src/vmd/names";
import { parseVmd } from "../src/vmd/parser";
import { conditionalNotes, isIkName, summarize, unsupportedNotes } from "../src/vmd/summary";
import { emptyVmd, type VmdBoneKey, type VmdFile } from "../src/vmd/types";
import { calibration } from "../src/vmd/synth";
import { writeVmd } from "../src/vmd/writer";
import { caseNames, expectClose, readCase, readReferenceJson } from "./reference";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function boneKey(
  name: string,
  frame: number,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
  curves: interpolation.BoneCurves = interpolation.LINEAR_CURVES,
): VmdBoneKey {
  return { name, frame, position, rotation, interpolation: interpolation.encode(curves) };
}

function vmd(...boneKeys: VmdBoneKey[]): VmdFile {
  return { ...emptyVmd("test"), boneKeys };
}

describe("names", () => {
  it("encodes and canonicalises like Python's cp932", () => {
    const names = readReferenceJson<{ name: string; field_hex: string; canonical: string }[]>(
      "names.json",
    );
    for (const { name, field_hex, canonical } of names) {
      expect(hex(encodeName(name, BONE_NAME_BYTES)), name).toBe(field_hex);
      expect(canonicalBoneName(name), name).toBe(canonical);
    }
  });

  it("round-trips, and drops a split double-byte character", () => {
    expect(decodeName(encodeName("左腕", BONE_NAME_BYTES))).toBe("左腕");
    // Seven 2-byte characters fill 14 bytes; the eighth is cut in half and dropped.
    expect(decodeName(encodeName("ああああああああ", BONE_NAME_BYTES))).toBe("あああああああ");
  });

  it("stops at NUL and ignores what follows", () => {
    const field = new Uint8Array([0x41, 0x42, 0x00, 0xff, 0xff]);
    expect(decodeName(field)).toBe("AB");
  });

  it("rejects names Shift-JIS can't hold", () => {
    expect(() => encodeName("😀", BONE_NAME_BYTES)).toThrow(/Shift-JIS/);
    expect(canonicalBoneName("😀")).toBe("😀");
  });
});

describe("interpolation block", () => {
  const curves: interpolation.BoneCurves = {
    x: [1, 2, 3, 4],
    y: [5, 6, 7, 8],
    z: [9, 10, 11, 12],
    rotation: [13, 14, 15, 16],
  };

  it("round-trips distinct curves and ignores the physics flag bytes", () => {
    expect(interpolation.decode(interpolation.encode(curves))).toEqual(curves);
    const flagged = interpolation.encode(curves, [99, 15]);
    expect([flagged[2], flagged[3]]).toEqual([99, 15]);
    expect(interpolation.decode(flagged)).toEqual(curves);
  });

  it("is laid out like MMD writes it", () => {
    const block = interpolation.encode(curves, [0, 0]);
    expect(Array.from(block.subarray(0, 8))).toEqual([1, 5, 0, 0, 2, 6, 10, 14]);
    expect(Array.from(block.subarray(16, 20))).toEqual([5, 9, 13, 2]);
  });

  it("validates its input", () => {
    expect(() => interpolation.encode({ ...curves, x: [0, 0, 128, 0] })).toThrow(/0\.\.127/);
    expect(() => interpolation.decode(new Uint8Array(10))).toThrow(/64 bytes/);
  });
});

describe("parser and writer", () => {
  it.each(caseNames())("parses %s like the Python reader, and writes it back", (name) => {
    const { motion, stages } = readCase(name);
    const file = parseVmd(motion);
    expect(file.modelName).toBe(stages.vmd.model_name);
    expect(file.version).toBe(stages.vmd.version);
    expect(file.boneKeys.length).toBe(stages.vmd.bone_keys.length);
    file.boneKeys.forEach((key, i) => {
      const expected = stages.vmd.bone_keys[i]!;
      expect(key.name).toBe(expected.name);
      expect(key.frame).toBe(expected.frame);
      expectClose(key.position, expected.position, 0);
      expectClose(key.rotation, expected.rotation, 0);
      const decoded = interpolation.decode(key.interpolation);
      expect([decoded.x, decoded.y, decoded.z, decoded.rotation]).toEqual(expected.curves);
    });
    expect(file.morphKeys).toEqual(stages.vmd.morph_keys);
    expect(
      file.showIkKeys.map((k) => ({
        frame: k.frame,
        show: k.show,
        ik: k.ik.map((s) => [s.name, s.enabled]),
      })),
    ).toEqual(stages.vmd.show_ik_keys);
    expect(hex(writeVmd(file))).toBe(hex(motion));
  });

  it("uses the documented bone record layout", () => {
    const bytes = writeVmd(vmd(boneKey("左腕", 7, [1, 2, 3], [0, 0, 0, 1])));
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(50, true)).toBe(1); // after magic (30) + model name (20)
    expect(view.getUint32(54 + 15, true)).toBe(7);
    expect(view.getFloat32(54 + 19, true)).toBe(1);
    expect(view.getFloat32(54 + 19 + 24, true)).toBe(1); // quaternion w
  });

  it("rejects a bad interpolation length when writing", () => {
    const key = { ...boneKey("a", 0), interpolation: new Uint8Array(3) };
    expect(() => writeVmd(vmd(key))).toThrow(/64 interp bytes/);
  });

  it("accepts a file that ends after the morph section", () => {
    const bytes = writeVmd(vmd(boneKey("a", 0)));
    const cut = bytes.subarray(0, 50 + 4 + 111 + 4);
    expect(parseVmd(cut).boneKeys).toHaveLength(1);
  });

  it("reads version 1 headers", () => {
    const magic = "Vocaloid Motion Data file";
    const bytes = new Uint8Array(30 + 10 + 4);
    for (let i = 0; i < magic.length; i++) bytes[i] = magic.charCodeAt(i);
    const file = parseVmd(bytes);
    expect(file.version).toBe(1);
    expect(file.boneKeys).toEqual([]);
  });

  it("explains a bad header", () => {
    const run = (): VmdFile => parseVmd(new TextEncoder().encode("not a motion".padEnd(60)), "x.vmd");
    expect(run).toThrow(InputFormatError);
    expect(run).toThrow(/x\.vmd: not a VMD motion file/);
  });

  it("reports where a truncated bone section ends", () => {
    const bytes = writeVmd(vmd(boneKey("a", 0), boneKey("a", 5)));
    let error: InputFormatError | undefined;
    try {
      parseVmd(bytes.subarray(0, 54 + 150));
    } catch (caught) {
      error = caught as InputFormatError;
    }
    expect(error).toBeInstanceOf(InputFormatError);
    expect(error?.message).toMatch(/2 bone keyframes/);
    expect(error?.offset).toBe(54);
  });

  it("rejects a show/IK section that is cut short", () => {
    const file = vmd(boneKey("a", 0));
    file.showIkKeys = [{ frame: 0, show: true, ik: [{ name: "左足ＩＫ", enabled: true }] }];
    const bytes = writeVmd(file);
    expect(() => parseVmd(bytes.subarray(0, bytes.length - 5))).toThrow(/show\/IK keyframe 1 of 1/);
  });
});

describe("summary", () => {
  it("classifies bones and lists what needs a mapping or skeleton", () => {
    const file = vmd(
      boneKey("センター", 0),
      boneKey("センター", 40, [0, 1, 0]),
      boneKey("左腕", 0, [0, 0, 0], [0, 0, 0.5, 0.8660254]),
      boneKey("頭", 0),
      boneKey("左足ＩＫ", 0, [0, 1, 0]),
    );
    file.morphKeys = [{ name: "あ", frame: 40, weight: 1 }];
    const summary = summarize(file);
    const bones = new Map(summary.bones.map((b) => [b.name, b]));
    expect([summary.firstFrame, summary.lastFrame]).toEqual([0, 40]);
    const centre = bones.get("センター")!;
    expect([centre.varies, centre.translates, centre.rotates]).toEqual([true, true, false]);
    expect([bones.get("左腕")!.rotates, bones.get("左腕")!.varies]).toEqual([true, false]);
    expect([bones.get("頭")!.rotates, bones.get("頭")!.varies]).toEqual([false, false]);
    expect(bones.get("左足ＩＫ")!.ik).toBe(true);
    // Morphs and IK are converted now (regression: inspect listed them as unsupported).
    expect(conditionalNotes(summary).some((note) => note.includes("morph"))).toBe(true);
    expect(conditionalNotes(summary).some((note) => note.includes("IK-driven"))).toBe(true);
    expect(unsupportedNotes(summary)).toEqual([]);
  });

  it("detects IK names written in full-width letters", () => {
    expect(isIkName("左足ＩＫ")).toBe(true);
    expect(isIkName("左足IK親")).toBe(true);
    expect(isIkName("左足")).toBe(false);
  });
});

describe("adapter", () => {
  it.each(caseNames())("builds the same source motion for %s", (name) => {
    const { motion, stages } = readCase(name);
    const source = toSourceMotion(parseVmd(motion), new Diagnostics());
    expect(source.endFrame).toBe(stages.motion.end_frame);
    expect([...source.tracks.keys()]).toEqual(stages.motion.tracks);
    expect([...source.ikBones].sort()).toEqual([...stages.motion.ik_bones].sort());
    expect(Object.fromEntries(source.ikStates)).toEqual(stages.motion.ik_states);
  });

  it("sorts keys and keeps the last duplicate", () => {
    const diagnostics = new Diagnostics();
    const source = toSourceMotion(
      vmd(boneKey("a", 10, [1, 0, 0]), boneKey("a", 0), boneKey("a", 10, [2, 0, 0])),
      diagnostics,
    );
    const track = source.tracks.get("a")!;
    expect(Array.from(track.frames)).toEqual([0, 10]);
    expect(track.translations[3]).toBe(2);
    const warning = diagnostics.items.find((d) => d.code === Code.DUPLICATE_KEYS);
    expect(warning?.bones).toEqual(["a"]);
  });

  it("normalises curves and reports unsupported sections", () => {
    const curves = { ...interpolation.LINEAR_CURVES, rotation: [127, 0, 0, 127] as const };
    const file = vmd(boneKey("a", 0), boneKey("a", 5, [0, 0, 0], [0, 0, 0, 1], curves));
    file.cameraKeyCount = 3;
    const diagnostics = new Diagnostics();
    const track = toSourceMotion(file, diagnostics).tracks.get("a")!;
    expectClose(track.curves.subarray(16 + 12, 32), [1, 0, 0, 1], 0);
    expect(diagnostics.codes().has(Code.UNSUPPORTED_CAMERA)).toBe(true);
  });

  it("falls back to names for IK bones when the file lists none", () => {
    const source = toSourceMotion(vmd(boneKey("左足ＩＫ", 0), boneKey("左足", 0)), new Diagnostics());
    expect([...source.ikBones]).toEqual(["左足ＩＫ"]);
  });
});

describe("calibration motion", () => {
  it("moves one axis at a time and returns to rest", () => {
    const { vmd, steps } = calibration("head", "centre", 90, 2);
    expect(steps.map((step) => [step.kind, step.axis, step.startFrame])).toEqual([
      ["rotate", 0, 30],
      ["rotate", 1, 90],
      ["rotate", 2, 150],
      ["move", 0, 210],
      ["move", 1, 270],
      ["move", 2, 330],
    ]);
    const parsed = parseVmd(writeVmd(vmd));
    const head = parsed.boneKeys.filter((key) => key.name === "head");
    expect(head.map((key) => key.frame)).toEqual([0, 30, 60, 90, 120, 150, 180]);
    expectClose(head[3]!.rotation, [0, Math.SQRT1_2, 0, Math.SQRT1_2], 1e-6);
    expectClose(head[4]!.rotation, [0, 0, 0, 1], 1e-6);
    const centre = parsed.boneKeys.filter((key) => key.name === "centre");
    expect(centre.map((key) => key.frame)).toEqual([180, 210, 240, 270, 300, 330, 360]);
    expectClose(centre[5]!.position, [0, 0, 2], 1e-6);
    expect(calibration("head", undefined).steps).toHaveLength(3);
  });
});
