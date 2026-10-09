import { describe, expect, it } from "vitest";

import { sampleTrack, type PoseSamples } from "../src/animation/sampling";
import { motionDuration } from "../src/animation/source";
import { Diagnostics } from "../src/diagnostics";
import { resolve } from "../src/mapping/resolve";
import { parseMappingText } from "../src/mapping/schema";
import { solveIk } from "../src/rig/ik";
import { toSourceMotion } from "../src/vmd/adapter";
import { parseVmd } from "../src/vmd/parser";
import { caseRig, loadModel, runCase } from "./cases";
import { caseNames, expectClose, readCase, readCaseText } from "./reference";

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

const CASES = caseNames();
const OPTIMIZED = CASES.filter((name) => readCase(name).spec.optimize);
const DENSE = CASES.filter((name) => !readCase(name).spec.optimize);

describe("target model", () => {
  it.each(CASES)("reads the same skeleton for %s", (name) => {
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
  it.each(CASES)("gives the same bindings for %s", (name) => {
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

describe("inverse kinematics", () => {
  const withIk = CASES.filter((name) => readCase(name).stages.ik.length > 0);

  it("covers the standard skeleton, an IK switch, a PMX skeleton and the template", () => {
    expect(withIk).toEqual([
      "leg_ik_pmx",
      "leg_ik_standard",
      "leg_ik_switch",
      "template_dance",
      "template_dance_optimized",
      "template_dance_slim",
    ]);
  });

  it.each(withIk)("solves %s like the Python version", (name) => {
    const { spec, stages, motion } = readCase(name);
    const { skeleton } = loadModel(name, spec.model);
    const source = toSourceMotion(parseVmd(motion), new Diagnostics());
    const mapping = resolve(
      parseMappingText(readCaseText(name, spec.mapping)),
      skeleton,
      source,
      new Diagnostics(),
    );
    const needed = new Set(mapping.bindings.flatMap((b) => b.chain.map((link) => link.source)));
    const rig = caseRig(name, spec)!.driving(needed, source.canonicalName);
    for (const bone of rig.requiredBones()) needed.add(bone);
    const frames = Float64Array.from(stages.frames);
    const poses = new Map<string, PoseSamples>();
    for (const bone of needed) {
      const track = source.tracks.get(bone);
      if (track) poses.set(bone, sampleTrack(track, frames));
    }
    const results = solveIk(rig, source, poses, frames);

    expect(results.map((r) => r.chain.bone)).toEqual(stages.ik.map((r) => r.bone));
    results.forEach((result, i) => {
      const expected = stages.ik[i]!;
      expect(result.chain.links.map((l) => l.bone)).toEqual(expected.links);
      expect(result.enabledFraction).toBeCloseTo(expected.enabled_fraction, 12);
      // The solver iterates, so rounding differences of 1e-16 grow to about 1e-6 units.
      expectClose(result.residuals, expected.residuals, 1e-5, `${expected.bone} residuals`);
    });
    for (const [bone, rotations] of Object.entries(stages.solved)) {
      expectClose(poses.get(bone)!.rotations, rotations, 1e-6, `${bone} solved`);
    }
  });
});

describe("conversion", () => {
  it.each(CASES)("builds the same animation for %s", (name) => {
    const { stages } = readCase(name);
    const { animation } = runCase(name);
    expect(animation.name).toBe(stages.animation.name);
    expect(animation.length).toBe(stages.animation.length);
    expect([...animation.tracks.keys()].sort()).toEqual(Object.keys(stages.animation.tracks).sort());
    for (const [bone, expected] of Object.entries(stages.animation.tracks)) {
      const track = animation.tracks.get(bone)!;
      for (const channel of ["rotations", "translations", "scales"] as const) {
        if (expected[channel] === null) expect(track[channel], `${bone} ${channel}`).toBeUndefined();
        else expectClose(track[channel], expected[channel], 1e-6, `${bone} ${channel}`);
      }
    }
  });

  it.each(DENSE)("writes the same animation file for %s", (name) => {
    const expected = readCaseText(name, "expected.animation.json");
    const { text } = runCase(name);
    expectSameDocument(JSON.parse(text) as Json, JSON.parse(expected) as Json, 1.01e-4);
    expect(text.split("\n").length).toBe(expected.split("\n").length);
  });

  it("reproduces the arm wave byte for byte", () => {
    expect(runCase("arm_wave").text).toBe(readCaseText("arm_wave", "expected.animation.json"));
    expect(runCase("arm_wave_layout4").text).toBe(runCase("arm_wave").text);
  });

  it.each(CASES)("reports the same diagnostics for %s", (name) => {
    const { stages } = readCase(name);
    const { diagnostics } = runCase(name);
    expect(diagnostics.items.map((d) => ({ ...d, bones: [...d.bones] }))).toEqual(stages.diagnostics);
  });

  it("is deterministic", () => {
    expect(runCase("template_dance").text).toBe(runCase("template_dance").text);
  });
});

describe("keyframe reduction", () => {
  it.each(OPTIMIZED)("keeps the same keys for %s", (name) => {
    const expected = readCaseText(name, "expected.animation.json");
    const { text, stats } = runCase(name);
    expectSameDocument(JSON.parse(text) as Json, JSON.parse(expected) as Json, 1.01e-4);
    expect(stats.keys).toBeLessThan(stats.denseKeys / 2);
  });
});
