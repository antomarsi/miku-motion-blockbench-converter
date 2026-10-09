import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { motionDuration } from "../src/animation/source";
import { parseBbmodelText, type BlockbenchModel } from "../src/blockbench/bbmodel";
import { Diagnostics } from "../src/diagnostics";
import { resolve } from "../src/mapping/resolve";
import { parseMappingText } from "../src/mapping/schema";
import { convert, type ConversionResult } from "../src/pipeline";
import { toSourceMotion } from "../src/vmd/adapter";
import { parseVmd } from "../src/vmd/parser";
import { caseFile, caseNames, expectClose, readCase, readCaseText } from "./reference";

function loadModel(name: string, reference: string): BlockbenchModel {
  const stem = basename(caseFile(name, reference)).replace(/\.[^.]+$/, "");
  return parseBbmodelText(readCaseText(name, reference), stem, reference);
}

function run(name: string): ConversionResult {
  const { spec, motion } = readCase(name);
  return convert(
    {
      motion: { data: motion, label: "motion" },
      model: loadModel(name, spec.model),
      mapping: parseMappingText(readCaseText(name, spec.mapping)),
    },
    { fps: spec.fps },
  );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Same structure and keys; numbers may differ by `tolerance` (rounding at the last digit). */
function expectSameDocument(actual: Json, expected: Json, tolerance: number, where = "$"): void {
  if (typeof expected === "number") {
    expect(typeof actual, where).toBe("number");
    expect(Math.abs((actual as number) - expected), where).toBeLessThanOrEqual(tolerance);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), where).toBe(true);
    expect((actual as Json[]).length, where).toBe(expected.length);
    expected.forEach((item, i) => expectSameDocument((actual as Json[])[i]!, item, tolerance, `${where}[${i}]`));
  } else if (expected !== null && typeof expected === "object") {
    expect(Object.keys(actual as object), where).toEqual(Object.keys(expected));
    for (const [key, value] of Object.entries(expected)) {
      expectSameDocument((actual as { [key: string]: Json })[key]!, value, tolerance, `${where}.${key}`);
    }
  } else {
    expect(actual, where).toBe(expected);
  }
}

// Cases that need nothing beyond Phase 2: no IK, hair simulation or face.
const BODY_CASES = caseNames().filter((name) => readCase(name).spec.source_skeleton === null);

describe("target model", () => {
  it.each(caseNames())("reads the same skeleton for %s", (name) => {
    const { spec, stages } = readCase(name);
    const { skeleton } = loadModel(name, spec.model);
    expect(skeleton.names).toEqual(stages.skeleton.map((b) => b.name));
    for (const expected of stages.skeleton) {
      const bone = skeleton.get(expected.name);
      expect(bone.parent ?? null, bone.name).toBe(expected.parent);
      expectClose(bone.pivot, expected.pivot, 0, `${bone.name} pivot`);
      expectClose(bone.restRotation, expected.rest_rotation, 1e-12, `${bone.name} rest`);
      if (expected.extent === null) expect(bone.extent, bone.name).toBeUndefined();
      else expectClose(bone.extent, expected.extent, 0, `${bone.name} extent`);
    }
  });
});

describe("mapping resolution", () => {
  it.each(caseNames())("gives the same bindings for %s", (name) => {
    const { spec, stages, motion } = readCase(name);
    const { skeleton } = loadModel(name, spec.model);
    const source = toSourceMotion(parseVmd(motion), new Diagnostics());
    const mapping = parseMappingText(readCaseText(name, spec.mapping));
    const resolved = resolve(mapping, skeleton, source, new Diagnostics());
    expect(resolved.translationScale).toBe(stages.translation_scale);
    expect(resolved.bindings.map((b) => b.target)).toEqual(stages.bindings.map((b) => b.target));
    resolved.bindings.forEach((binding, i) => {
      const expected = stages.bindings[i]!;
      expect(binding.anchor ?? null, binding.target).toBe(expected.anchor);
      expect(binding.translation, binding.target).toBe(expected.translation);
      expect(binding.chain.map((l) => [l.source, l.weight])).toEqual(expected.chain);
      expectClose(binding.restCorrection, expected.rest_correction, 1e-12, binding.target);
    });
    expect(motionDuration(source)).toBeGreaterThan(0);
  });
});

describe("conversion without IK", () => {
  it("covers the body cases", () => {
    expect(BODY_CASES).toEqual(["arm_wave", "arm_wave_layout4", "body_chains", "body_chains_60fps"]);
  });

  it.each(BODY_CASES)("retargets %s like the Python version", (name) => {
    const { stages } = readCase(name);
    const { animation } = run(name);
    expect(animation.name).toBe(stages.animation.name.replace(/motion$/, "motion"));
    expect(animation.length).toBe(stages.animation.length);
    expect([...animation.tracks.keys()]).toEqual(Object.keys(stages.animation.tracks));
    for (const [bone, expected] of Object.entries(stages.animation.tracks)) {
      const track = animation.tracks.get(bone)!;
      expectClose(track.rotations, expected.rotations, 1e-9, `${bone} rotations`);
      if (expected.translations === null) expect(track.translations, bone).toBeUndefined();
      else expectClose(track.translations, expected.translations, 1e-9, `${bone} translations`);
    }
  });

  it.each(BODY_CASES)("writes the same animation file for %s", (name) => {
    const expected = readCaseText(name, "expected.animation.json");
    const { text } = run(name);
    expectSameDocument(JSON.parse(text) as Json, JSON.parse(expected) as Json, 1.01e-4);
    expect(text.split("\n").length).toBe(expected.split("\n").length);
  });

  it("reproduces the arm wave byte for byte", () => {
    expect(run("arm_wave").text).toBe(readCaseText("arm_wave", "expected.animation.json"));
    expect(run("arm_wave_layout4").text).toBe(run("arm_wave").text);
  });

  it.each(BODY_CASES)("reports the same diagnostics for %s", (name) => {
    const { stages } = readCase(name);
    const { diagnostics } = run(name);
    expect(diagnostics.items.map((d) => ({ ...d, bones: [...d.bones] }))).toEqual(stages.diagnostics);
  });

  it("is deterministic", () => {
    expect(run("body_chains").text).toBe(run("body_chains").text);
  });
});
