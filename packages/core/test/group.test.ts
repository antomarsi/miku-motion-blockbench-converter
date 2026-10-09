import { describe, expect, it } from "vitest";

import { Code } from "../src/diagnostics";
import * as interpolation from "../src/vmd/interpolation";
import { parseMapping } from "../src/mapping/schema";
import {
  checkGroupLabels,
  convert,
  convertGroup,
  Formation,
  type GroupResult,
  type MotionInput,
} from "../src/pipeline";
import { parseBbmodel } from "../src/blockbench/bbmodel";
import { emptyVmd, type VmdBoneKey } from "../src/vmd/types";
import { writeVmd } from "../src/vmd/writer";
import { loadModel } from "./cases";
import { playerRig } from "./fixtures";
import { expectClose, readCaseText, readReferenceBytes, readReferenceJson } from "./reference";

interface GroupCase {
  group: string[];
  model: string;
  mapping: string;
  fps: number;
  formation: Formation;
  sync_length: boolean;
}
interface GroupStages {
  members: { motion: string; label: string; start: number[]; expected: string }[];
  diagnostics: { code: string; severity: string; message: string }[];
}

function runReference(name: string): { result: GroupResult; stages: GroupStages } {
  const spec = readReferenceJson<GroupCase>("cases", name, "case.json");
  const motions = spec.group.map((file) => ({
    data: readReferenceBytes("cases", name, file),
    label: file.replace(/\.vmd$/, ""),
    path: file,
  }));
  const result = convertGroup(
    motions,
    { model: loadModel(name, spec.model), mapping: parseMapping(JSON.parse(readCaseText(name, spec.mapping))) },
    { fps: spec.fps },
    { formation: spec.formation, syncLength: spec.sync_length },
  );
  return { result, stages: readReferenceJson<GroupStages>("cases", name, "stages.json") };
}

const MODEL = parseBbmodel(playerRig(), "rig");
const MAPPING = parseMapping({ bones: { LeftArm: "左腕" } });
const STAGE_MAPPING = parseMapping({
  units: { translation_scale: 2 },
  bones: { Root: { from: ["センター"], translation: true }, LeftArm: "左腕" },
});
const key = (name: string, frame: number, position: [number, number, number] = [0, 0, 0]): VmdBoneKey => ({
  name,
  frame,
  position,
  rotation: [0, 0, frame ? 0.5 : 0, frame ? Math.sqrt(0.75) : 1],
  interpolation: interpolation.encode(),
});
const motion = (label: string, lastFrame: number, keys?: VmdBoneKey[]): MotionInput => ({
  data: writeVmd({ ...emptyVmd("test"), boneKeys: keys ?? [key("左腕", 0), key("左腕", lastFrame)] }),
  label,
  path: `${label}.vmd`,
});
const performer = (label: string, x: number, z: number, lastFrame = 20): MotionInput =>
  motion(label, lastFrame, [
    key("センター", 0, [x, -1, z]),
    key("センター", lastFrame, [x + 3, -1, z]),
    key("左腕", 0),
    key("左腕", lastFrame),
  ]);
const root = (group: GroupResult, index: number): Float64Array =>
  group.members[index]!.result.animation.tracks.get("Root")!.translations!;

describe("performer groups match the Python version", () => {
  it.each(["group_keep", "group_center", "group_origin"])("%s", (name) => {
    const { result, stages } = runReference(name);
    expect(result.members.map((m) => m.label)).toEqual(stages.members.map((m) => m.label));
    result.members.forEach((member, i) => {
      const expected = stages.members[i]!;
      expectClose(member.start, expected.start, 1e-9, `${member.label} start`);
      expect(member.result.text).toBe(readCaseText(name, expected.expected));
    });
    expect(
      result.diagnostics.items.map(({ code, severity, message }) => ({ code, severity, message })),
    ).toEqual(stages.diagnostics);
  });
});

describe("performer groups", () => {
  it("by default converts each member exactly as alone", () => {
    const a = motion("a", 20);
    const b = motion("b", 20);
    const group = convertGroup([a, b], { model: MODEL, mapping: MAPPING }, { fps: 20 });
    expect(group.members.map((m) => m.label)).toEqual(["a", "b"]);
    for (const member of group.members) {
      const alone = convert({ motion: member.motion, model: MODEL, mapping: MAPPING }, { fps: 20 });
      expect(member.result.text).toBe(alone.text);
    }
    expect(group.diagnostics.items).toEqual([]);
  });

  it("flags a member whose length diverges, but never a single performer", () => {
    const members = [motion("in_sync_a", 20), motion("in_sync_b", 21), motion("out_of_sync", 80)];
    const group = convertGroup(members, { model: MODEL, mapping: MAPPING }, { fps: 20 });
    const messages = group.diagnostics.items
      .filter((d) => d.code === Code.GROUP_DURATION_MISMATCH)
      .map((d) => d.message);
    expect(messages.some((m) => m.includes("out_of_sync.vmd"))).toBe(true);
    expect(messages.some((m) => m.includes("in_sync"))).toBe(false);
    const solo = convertGroup([motion("solo", 20)], { model: MODEL, mapping: MAPPING }, { fps: 20 });
    expect(solo.diagnostics.items).toEqual([]);
  });

  it("reports where each motion puts its performer", () => {
    const group = convertGroup(
      [performer("a", 10, 4), performer("b", 30, -2)],
      { model: MODEL, mapping: STAGE_MAPPING },
      { fps: 20 },
    );
    // MMD +X is the model's left, canonical -X; 2 px per MMD unit.
    expectClose(group.members[0]!.start, [-20, -2, 8], 1e-9);
    expectClose(group.members[1]!.start, [-60, -2, -4], 1e-9);
  });

  it("formation origin starts every performer at its own origin", () => {
    const group = convertGroup(
      [performer("a", 10, 4), performer("b", 30, -2)],
      { model: MODEL, mapping: STAGE_MAPPING },
      { fps: 20 },
      { formation: Formation.ORIGIN },
    );
    for (const index of [0, 1]) {
      const track = root(group, index);
      expectClose(track.subarray(0, 3), [0, -2, 0], 1e-9); // height is kept
      expectClose(track.subarray(track.length - 3), [-6, -2, 0], 1e-9); // the walk is kept
    }
    expectClose(group.members[1]!.start, [-60, -2, -4], 1e-9); // still what the motion said
    expect(group.diagnostics.codes().has(Code.GROUP_FORMATION)).toBe(true);
  });

  it("formation center moves the group as one", () => {
    const members = [performer("a", 10, 4), performer("b", 30, -2)];
    const target = { model: MODEL, mapping: STAGE_MAPPING };
    const kept = convertGroup(members, target, { fps: 20 });
    const centred = convertGroup(members, target, { fps: 20 }, { formation: Formation.CENTER });
    expectClose(root(centred, 0).subarray(0, 3), [20, -2, 6], 1e-9);
    expectClose(root(centred, 1).subarray(0, 3), [-20, -2, -6], 1e-9);
    const spacing = (group: GroupResult): number[] => Array.from(root(group, 1), (v, i) => v - root(group, 0)[i]!);
    expectClose(spacing(centred), spacing(kept), 1e-9);
  });

  it("sync length pads shorter members and silences the length warning", () => {
    const group = convertGroup(
      [motion("short", 30), motion("long", 90)],
      { model: MODEL, mapping: MAPPING },
      { fps: 20 },
      { syncLength: true },
    );
    const lengths = group.members.map(
      (m) => Object.values(JSON.parse(m.result.text).animations as Record<string, { animation_length: number }>)[0]!.animation_length,
    );
    expect(lengths).toEqual([3, 3]);
    const synced = group.diagnostics.items.find((d) => d.code === Code.GROUP_LENGTH_SYNCED)!;
    expect(synced.message).toContain("short.vmd");
    expect(synced.message).not.toContain("long.vmd");
    expect(group.diagnostics.codes().has(Code.GROUP_DURATION_MISMATCH)).toBe(false);
  });

  it("skips motions without performers, such as a camera file", () => {
    // Regression: a camera-only file was written as an empty animation and set the length.
    const camera: MotionInput = { data: writeVmd(emptyVmd("camera")), label: "camera", path: "camera.vmd" };
    const dancer = motion("dancer", 20);
    const group = convertGroup([camera, dancer], { model: MODEL, mapping: MAPPING }, { fps: 20 }, { syncLength: true });
    expect(group.members.map((m) => m.label)).toEqual(["dancer"]);
    const skipped = group.diagnostics.items.find((d) => d.code === Code.GROUP_MEMBER_SKIPPED)!;
    expect(skipped.message).toContain("camera.vmd");
  });

  it("rejects labels that would give the same animation name", () => {
    const first = { ...motion("miku", 5), path: "one/miku.vmd" };
    const second = { ...motion("Miku", 5), path: "two/Miku.vmd" };
    expect(() => checkGroupLabels([first, second])).toThrow(/same animation name as one\/miku\.vmd/);
    expect(() => checkGroupLabels([first, motion("rin", 5)])).not.toThrow();
  });
});
