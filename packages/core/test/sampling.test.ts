import fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as curves from "../src/animation/curves";
import { sampleMorph, sampleTimes, sampleTrack } from "../src/animation/sampling";
import {
  makeTrack,
  motionDuration,
  trackIsAnimated,
  trackRotates,
  trackTranslates,
  type SourceBoneTrack,
} from "../src/animation/source";
import { Diagnostics } from "../src/diagnostics";
import * as quat from "../src/geometry/quat";
import { toSourceMotion } from "../src/vmd/adapter";
import { parseVmd } from "../src/vmd/parser";
import { caseNames, expectClose, readCase, readReferenceJson } from "./reference";

const unit = fc.double({ min: 0, max: 1, noNaN: true });

function track(
  frames: number[],
  options: {
    translations?: [number, number, number][];
    rotations?: quat.Quat[];
    curve?: curves.Curve;
    curveOf?: (key: number, channel: number) => curves.Curve;
  } = {},
): SourceBoneTrack {
  const k = frames.length;
  const curveData = new Float64Array(16 * k);
  for (let key = 0; key < k; key++) {
    for (let channel = 0; channel < 4; channel++) {
      const curve = options.curveOf?.(key, channel) ?? options.curve ?? curves.LINEAR;
      curveData.set(curve, 16 * key + 4 * channel);
    }
  }
  return makeTrack({
    name: "bone",
    frames: Float64Array.from(frames),
    translations: quat.vec3Array(options.translations ?? frames.map(() => [0, 0, 0])),
    rotations: quat.quatArray(options.rotations ?? frames.map(() => quat.IDENTITY)),
    curves: curveData,
  });
}

describe("easing curves", () => {
  it("match the Python reference", () => {
    const ref = readReferenceJson<{ curves: number[][]; curve_x: number[]; curve_y: number[][] }>(
      "geometry.json",
    );
    ref.curves.forEach((curve, i) => {
      const ys = ref.curve_x.map((x) => curves.evaluate(curve as unknown as curves.Curve, x));
      expectClose(ys, ref.curve_y[i], 1e-12, `curve ${i}`);
    });
  });

  it("the linear curve is the identity", () => {
    fc.assert(
      fc.property(unit, (x) => {
        expect(curves.evaluate(curves.LINEAR, x)).toBeCloseTo(x, 9);
        expect(curves.evaluate([20 / 127, 20 / 127, 107 / 127, 107 / 127], x)).toBeCloseTo(x, 9);
      }),
    );
  });

  it("are monotonic with fixed endpoints", () => {
    fc.assert(
      fc.property(unit, unit, unit, unit, (x1, y1, x2, y2) => {
        const curve: curves.Curve = [x1, y1, x2, y2];
        expect(curves.evaluate(curve, 0)).toBe(0);
        expect(curves.evaluate(curve, 1)).toBe(1);
        let previous = 0;
        for (let i = 1; i <= 20; i++) {
          const y = curves.evaluate(curve, i / 20);
          expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
          previous = y;
        }
      }),
    );
  });

  it("an ease-in curve stays below the diagonal", () => {
    expect(curves.evaluate([0.8, 0, 1, 0.2], 0.5)).toBeLessThan(0.5);
    expect(curves.isLinear(curves.LINEAR)).toBe(true);
    expect(curves.isLinear([0.5, 0, 0.5, 1])).toBe(false);
  });
});

describe("sample times", () => {
  it("include both ends", () => {
    expectClose(sampleTimes(1, 20).subarray(0, 3), [0, 0.05, 0.1], 0);
    expect(sampleTimes(1, 20)).toHaveLength(21);
    const odd = sampleTimes(1.02, 20);
    expect(odd).toHaveLength(22);
    expect(odd[21]).toBe(1.02);
    expect(Array.from(sampleTimes(0, 20))).toEqual([0]);
  });

  it("are validated", () => {
    expect(() => sampleTimes(1, 0)).toThrow(/positive/);
  });

  it.each(caseNames())("match the Python reference for %s", (name) => {
    const { motion, spec, stages } = readCase(name);
    const source = toSourceMotion(parseVmd(motion), new Diagnostics());
    const times = sampleTimes(motionDuration(source), spec.fps);
    expectClose(times, stages.times, 0, "times");
  });
});

describe("track sampling", () => {
  it.each(caseNames())("matches the Python reference for %s", (name) => {
    const { motion, stages } = readCase(name);
    const source = toSourceMotion(parseVmd(motion), new Diagnostics());
    const frames = Float64Array.from(stages.frames);
    const bones = Object.keys(stages.sampled);
    expect(bones.length).toBeGreaterThan(0);
    for (const bone of bones) {
      const samples = sampleTrack(source.tracks.get(bone)!, frames);
      expectClose(samples.translations, stages.sampled[bone]!.translations, 1e-9, `${bone} t`);
      expectClose(samples.rotations, stages.sampled[bone]!.rotations, 1e-9, `${bone} r`);
    }
    for (const [morph, weights] of Object.entries(stages.morphs)) {
      expectClose(sampleMorph(source.morphs.get(morph)!, frames), weights, 1e-12, morph);
    }
    for (const [bone, [rotates, translates, animated]] of Object.entries(stages.motion.flags)) {
      const sourceTrack = source.tracks.get(bone)!;
      expect(
        [trackRotates(sourceTrack), trackTranslates(sourceTrack), trackIsAnimated(sourceTrack)],
        bone,
      ).toEqual([rotates, translates, animated]);
    }
  });

  it("interpolates translation linearly and holds outside the keys", () => {
    const samples = sampleTrack(
      track([10, 20], { translations: [[0, 0, 0], [2, 4, 6]] }),
      Float64Array.from([0, 10, 15, 20, 99]),
    );
    expectClose(samples.translations, [[0, 0, 0], [0, 0, 0], [1, 2, 3], [2, 4, 6], [2, 4, 6]], 1e-12);
  });

  it("slerps rotation with the eased progress of the arriving key", () => {
    const end = quat.fromAxisAngle([0, 0, 1], 1.0);
    const easeIn: curves.Curve = [0.8, 0, 1, 0.2];
    const eased = track([0, 10], { rotations: [quat.IDENTITY, end], curve: easeIn });
    const mid = quat.getQuat(sampleTrack(eased, Float64Array.from([5])).rotations, 0);
    expect(quat.angle(mid)).toBeCloseTo(curves.evaluate(easeIn, 0.5), 9);

    // The curve stored on the key a segment arrives at is the one that applies.
    const arriving = track([0, 10, 20], {
      translations: [[0, 0, 0], [10, 0, 0], [20, 0, 0]],
      curveOf: (key) => (key === 2 ? easeIn : curves.LINEAR),
    });
    const samples = sampleTrack(arriving, Float64Array.from([5, 15]));
    expect(samples.translations[0]).toBeCloseTo(5, 9);
    expect(samples.translations[3]).toBeLessThan(15);
  });

  it("eases each axis independently", () => {
    const easeIn: curves.Curve = [0.8, 0, 1, 0.2];
    const mixed = track([0, 10], {
      translations: [[0, 0, 0], [10, 10, 10]],
      curveOf: (_key, channel) => (channel === 1 ? easeIn : curves.LINEAR),
    });
    const [x, y, z] = sampleTrack(mixed, Float64Array.from([5])).translations;
    expect(x).toBeCloseTo(5, 9);
    expect(z).toBeCloseTo(5, 9);
    expect(y).toBeLessThan(5);
  });

  it("holds a single-key track", () => {
    const single = track([7], { translations: [[1, 2, 3]] });
    expectClose(sampleTrack(single, Float64Array.from([0, 7, 50])).translations, [[1, 2, 3], [1, 2, 3], [1, 2, 3]], 0);
  });

  it("validates tracks", () => {
    expect(() => track([])).toThrow(/no keys/);
    expect(() => track([5, 5])).toThrow(/strictly increasing/);
    expect(() =>
      makeTrack({
        name: "bone",
        frames: Float64Array.from([0]),
        translations: new Float64Array(2),
        rotations: new Float64Array(4),
        curves: new Float64Array(16),
      }),
    ).toThrow(/shape/);
  });

  it("holds and interpolates morph weights", () => {
    const morph = { name: "あ", frames: Float64Array.from([10, 20]), weights: Float64Array.from([0, 1]) };
    expectClose(sampleMorph(morph, Float64Array.from([0, 15, 30])), [0, 0.5, 1], 1e-12);
  });
});
