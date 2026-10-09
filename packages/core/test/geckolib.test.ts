import { describe, expect, it } from "vitest";

import { LoopMode, type Animation, type BoneTrack } from "../src/animation/clip";
import type { PoseSamples } from "../src/animation/sampling";
import { makeBone, Skeleton } from "../src/animation/skeleton";
import { BasisChange, MMD_TO_CANONICAL } from "../src/conversion/coordinates";
import { retarget } from "../src/conversion/retarget";
import { Diagnostics } from "../src/diagnostics";
import * as encoding from "../src/geckolib/encoding";
import { validateAnimation } from "../src/geckolib/validate";
import { formatNumber, formatTime, renderAnimation } from "../src/geckolib/writer";
import * as quat from "../src/geometry/quat";
import { resolve } from "../src/mapping/resolve";
import { parseMapping } from "../src/mapping/schema";
import { degrees, sourceMotion } from "./fixtures";
import { expectClose } from "./reference";

const SKELETON = new Skeleton([
  makeBone("root", undefined),
  makeBone("tilted", "root", [0, 10, 0], [20, 0, 0]),
  makeBone("still", "root"),
]);
const z = (angle: number): quat.Quat => quat.fromAxisAngle([0, 0, 1], degrees(angle));
const x = (angle: number): quat.Quat => quat.fromAxisAngle([1, 0, 0], degrees(angle));

function animation(tracks: Record<string, BoneTrack>, loop: LoopMode = LoopMode.ONCE): Animation {
  return {
    name: "animation.rig.test",
    times: Float64Array.from([0, 0.5, 1]),
    length: 1,
    loop,
    tracks: new Map(Object.entries(tracks)),
  };
}

function clip(tracks: Record<string, BoneTrack>, loop?: LoopMode): Record<string, unknown> {
  const document = JSON.parse(renderAnimation(animation(tracks, loop), SKELETON).text);
  return document.animations["animation.rig.test"];
}

describe("GeckoLib encoding", () => {
  it("writes rotation as a delta from rest with Bedrock signs", () => {
    const values = encoding.rotationChannel(SKELETON.get("root"), quat.quatArray([z(10), x(10)]));
    expectClose(values, [0, 0, 10, -10, 0, 0], 1e-9);
    const tilted = SKELETON.get("tilted");
    expectClose(encoding.rotationChannel(tilted, quat.quatArray([tilted.restRotation])), [0, 0, 0], 1e-9);
  });

  it("stays continuous past 180 degrees and flips position X", () => {
    const values = encoding.rotationChannel(SKELETON.get("root"), quat.quatArray([z(170), z(190), z(210)]));
    expectClose([values[2], values[5], values[8]], [170, 190, 210], 1e-9);
    expectClose(encoding.positionChannel(Float64Array.from([1, 2, 3])), [-1, 2, 3], 0);
  });

  it("round-trips a keyframe value", () => {
    const tilted = SKELETON.get("tilted");
    const rotation = quat.mul(tilted.restRotation, z(35));
    const value = encoding.rotationValueNear(tilted, rotation, [0, 0, 30]);
    expect(quat.sameRotation(encoding.rotationFromChannel(tilted, value), rotation)).toBe(true);
    expectClose(encoding.positionFromChannel([-1, 2, 3]), [1, 2, 3], 0);
  });
});

describe("number formatting", () => {
  it.each([
    [0, "0"],
    [-0, "0"],
    [-0.00001, "0"],
    [1, "1"],
    [12.5, "12.5"],
    [1 / 3, "0.3333"],
  ])("formats %f as %s", (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });

  it("always shows a decimal in times", () => {
    expect([0, 0.05, 1, 151.26666].map(formatTime)).toEqual(["0.0", "0.05", "1.0", "151.2667"]);
  });
});

describe("animation file", () => {
  it("has the GeckoLib structure", () => {
    const text = renderAnimation(
      animation({ root: { rotations: quat.quatArray([z(0), z(10), z(20)]) } }),
      SKELETON,
    ).text;
    const document = JSON.parse(text);
    expect(Object.keys(document)).toEqual(["format_version", "animations", "geckolib_format_version"]);
    const first = document.animations["animation.rig.test"];
    expect(first.loop).toBe(false);
    expect(first.animation_length).toBe(1);
    expect(first.bones.root.rotation).toEqual({ "0.0": [0, 0, 0], "0.5": [0, 0, 10], "1.0": [0, 0, 20] });
    expect(text).toContain('          "0.5": [0, 0, 10],\n'); // one keyframe per line
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("writes a constant channel as one key and omits a channel at rest", () => {
    const tilted = SKELETON.get("tilted");
    const bones = clip({
      root: { rotations: quat.quatArray([z(15), z(15), z(15)]) },
      tilted: { rotations: quat.quatArray([tilted.restRotation, tilted.restRotation, tilted.restRotation]) },
      still: { translations: new Float64Array(9), scales: new Float64Array(9).fill(1) },
    }).bones as Record<string, Record<string, unknown>>;
    expect(bones.root).toEqual({ rotation: { "0.0": [0, 0, 15] } });
    expect(bones.tilted).toBeUndefined();
    expect(bones.still).toBeUndefined();
  });

  it("follows the skeleton's bone order and writes loop modes", () => {
    const tracks = {
      still: { rotations: quat.quatArray([z(1), z(2), z(3)]) },
      root: { rotations: quat.quatArray([z(1), z(2), z(3)]) },
    };
    expect(Object.keys(clip(tracks).bones as object)).toEqual(["root", "still"]);
    expect(clip(tracks, LoopMode.LOOP).loop).toBe(true);
    expect(clip(tracks, LoopMode.HOLD).loop).toBe("hold_on_last_frame");
    expect(clip({}).bones).toEqual({});
  });

  it("writes scale and rejects colliding key times", () => {
    const scales = Float64Array.from([1, 1, 1, 1, 0, 1, 0, 0, 0]);
    const bones = clip({ root: { scales } }).bones as Record<string, Record<string, unknown>>;
    expect(bones.root).toEqual({ scale: { "0.0": [1, 1, 1], "0.5": [1, 0, 1], "1.0": [0, 0, 0] } });
    const close: Animation = { ...animation({ root: { scales } }), times: Float64Array.from([0, 0.00001, 0.00002]) };
    expect(() => renderAnimation(close, SKELETON)).toThrow(/collide/);
  });
});

describe("retargeting", () => {
  const rig = new Skeleton([
    makeBone("Root", undefined),
    makeBone("Chest", "Root", [0, 20, 0], [20, 0, 0]),
    makeBone("Arm", "Chest", [-4, 22, 0]),
  ]);

  function convert(
    bones: Record<string, unknown>,
    rotations: Record<string, quat.Quat>,
    positions: Record<string, quat.Vec3> = {},
    scale = 1,
  ): Animation {
    const names = new Set([...Object.keys(rotations), ...Object.keys(positions)]);
    const motion = sourceMotion(
      Object.fromEntries(
        [...names].map((name) => [name, [{ frame: 0, rotation: rotations[name], position: positions[name] }]]),
      ) as never,
    );
    const mapping = resolve(
      parseMapping({ bones, units: { translation_scale: scale } }),
      rig,
      motion,
      new Diagnostics(),
    );
    const poses = new Map<string, PoseSamples>();
    for (const [name, track] of motion.tracks) {
      poses.set(name, { translations: track.translations, rotations: track.rotations });
    }
    return retarget(poses, Float64Array.from([0]), mapping, rig, MMD_TO_CANONICAL, {
      name: "a",
      loop: LoopMode.ONCE,
    });
  }

  const rotationOf = (result: Animation, bone: string): quat.Quat =>
    quat.getQuat(result.tracks.get(bone)!.rotations!, 0);

  it("mirrors X when leaving MMD space", () => {
    expect(MMD_TO_CANONICAL.point([1, 2, 3], 2)).toEqual([-2, 4, 6]);
    // MMD +Z raises the model's left arm; in canonical space that is -Z.
    expect(quat.sameRotation(MMD_TO_CANONICAL.rotation(z(30)), z(-30))).toBe(true);
    expect(() => new BasisChange("bad", [[2, 0, 0], [0, 1, 0], [0, 0, 1]])).toThrow(/orthogonal/);
  });

  it("copies a one-to-one rotation and multiplies chains parent to child", () => {
    expect(quat.sameRotation(rotationOf(convert({ Root: "a" }, { a: z(30) }), "Root"), z(-30))).toBe(true);
    const chained = convert({ Root: { from: ["a", "b"] } }, { a: z(30), b: x(40) });
    const expected = MMD_TO_CANONICAL.rotation(quat.mul(z(30), x(40)));
    expect(quat.sameRotation(rotationOf(chained, "Root"), expected)).toBe(true);
  });

  it("applies weights: -1 cancels, 0.5 halves", () => {
    const cancelled = convert({ Root: { from: ["a", { bone: "a", weight: -1 }] } }, { a: z(30) });
    expect(quat.sameRotation(rotationOf(cancelled, "Root"), quat.IDENTITY)).toBe(true);
    const half = convert({ Root: { from: [{ bone: "a", weight: 0.5 }] } }, { a: z(30) });
    expect(quat.sameRotation(rotationOf(half, "Root"), z(-15))).toBe(true);
  });

  it("keeps the target's rest rotation and works in the parent's rest frame", () => {
    const rest = rig.get("Chest").restRotation;
    const still = convert({ Chest: "a" }, { a: quat.IDENTITY });
    expect(quat.sameRotation(rotationOf(still, "Chest"), rest)).toBe(true);
    // The arm's world rotation must be the source's, although its parent is tilted.
    const arm = convert({ Arm: "a" }, { a: z(30) });
    const world = quat.mul(rest, rotationOf(arm, "Arm"));
    expect(quat.sameRotation(world, quat.mul(z(-30), rest))).toBe(true);
  });

  it("applies a rest correction and composes scaled translation", () => {
    const corrected = convert(
      { Root: { from: ["a"], rest_correction: { euler_deg: [0, 0, 40] } } },
      { a: quat.IDENTITY },
    );
    expect(quat.sameRotation(rotationOf(corrected, "Root"), z(40))).toBe(true);
    const moved = convert(
      { Root: { from: ["a", "b"], translation: true } },
      { a: quat.fromAxisAngle([0, 1, 0], degrees(90)) },
      { a: [1, 0, 0], b: [0, 0, 1] },
      2,
    );
    // b's offset is rotated by a (Z -> X in MMD), summed, mirrored and scaled.
    expectClose(moved.tracks.get("Root")!.translations, [-4, 0, 0], 1e-9);
  });

  it("leaves a bone at rest when its source has no keys", () => {
    const result = convert({ Root: "missing", Chest: "a" }, { a: quat.IDENTITY });
    expect(quat.sameRotation(rotationOf(result, "Root"), quat.IDENTITY)).toBe(true);
  });
});

describe("validateAnimation", () => {
  const skeleton = new Skeleton([makeBone("root", undefined), makeBone("head", "root")]);
  const valid = (): Record<string, unknown> => ({
    format_version: "1.8.0",
    animations: {
      "animation.model.dance": {
        loop: "hold_on_last_frame",
        animation_length: 1,
        bones: {
          root: { position: [0, 1, 0] },
          head: { rotation: { "0.0": [0, 0, 0], "0.5": { post: [10, 0, 0] }, "1.0": [0, 0, 0] } },
        },
      },
    },
  });

  it("accepts a well-formed file and counts its keys", () => {
    const check = validateAnimation(valid(), skeleton);
    expect(check.issues).toEqual([]);
    expect(check.animations).toEqual([{ name: "animation.model.dance", length: 1, bones: 2, keyframes: 4 }]);
  });

  it("reports bones the model lacks, bad values and late keys", () => {
    const document = valid();
    const animation = (document.animations as Record<string, { bones: Record<string, unknown> }>)["animation.model.dance"]!;
    animation.bones.tail = { rotation: { "0.0": [0, 0] } };
    animation.bones.head = { rotation: { "0.0": [0, 0, 0], "2.0": [1, 0, 0] }, colour: [1, 1, 1] };
    const messages = validateAnimation(document, skeleton).issues.map((issue) => `${issue.severity}: ${issue.message}`);
    expect(messages).toEqual([
      "warning: keyframe at 2.0 s is after the end of the animation (1 s)",
      "warning: not a rotation, position or scale channel",
      "error: keyframe at 0.0 s is not a vector of three numbers",
      "error: 1 animated bones are not in the model: tail",
    ]);
    expect(validateAnimation(document).issues).toHaveLength(3); // no model: bones are not checked
  });

  it("rejects files that are not animations", () => {
    expect(validateAnimation([]).issues[0]!.message).toBe("not a JSON object");
    expect(validateAnimation({ format_version: "1.8.0" }).issues[0]!.message).toBe('no "animations" object');
    expect(validateAnimation({ format_version: "1.8.0", animations: {} }).issues[0]!.message).toBe("contains no animation");
  });
});
