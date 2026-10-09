import fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as euler from "../src/geometry/euler";
import * as quat from "../src/geometry/quat";
import type { Quat, Vec3 } from "../src/geometry/quat";
import { expectClose, readReferenceJson } from "./reference";

type Rows = number[][];
interface GeometryDump {
  a: Rows;
  b: Rows;
  v: Rows;
  t: number[];
  mul: Rows;
  rotate: Rows;
  slerp: Rows;
  power_half: Rows;
  power_minus_one: Rows;
  angle: number[];
  angle_between: number[];
  axis_angle: Rows;
  eulers: Rows;
  euler_to_quat: Rows;
  euler_from_quat: Rows;
  locks: Rows;
  locks_quat: Rows;
  locks_from_quat: Rows;
  locks_from_quat_ref: Rows;
  walk_quats: Rows;
  walk_flipped: Rows;
  walk_made_continuous: Rows;
  walk_euler: Rows;
  walk_euler_from_start: Rows;
}

const ref = readReferenceJson<GeometryDump>("geometry.json");
const q = (row: number[]): Quat => row as unknown as Quat;
const v3 = (row: number[]): Vec3 => row as unknown as Vec3;

const unitQuat = fc
  .tuple(fc.double({ min: -1, max: 1 }), fc.double({ min: -1, max: 1 }), fc.double({ min: -1, max: 1 }), fc.double({ min: -1, max: 1 }))
  .filter((values) => Math.hypot(...values) > 1e-3)
  .map((values) => quat.normalize(values));
const angles = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });

describe("quaternions match the Python reference", () => {
  it("mul, rotate, slerp, power, angles, axis-angle", () => {
    expectClose(ref.a.map((a, i) => quat.mul(q(a), q(ref.b[i]!))), ref.mul, 1e-12, "mul");
    expectClose(ref.a.map((a, i) => quat.rotate(q(a), v3(ref.v[i]!))), ref.rotate, 1e-12, "rotate");
    expectClose(ref.a.map((a, i) => quat.slerp(q(a), q(ref.b[i]!), ref.t[i]!)), ref.slerp, 1e-12, "slerp");
    expectClose(ref.a.map((a) => quat.power(q(a), 0.5)), ref.power_half, 1e-12, "power 0.5");
    expectClose(ref.a.map((a) => quat.power(q(a), -1)), ref.power_minus_one, 1e-12, "power -1");
    expectClose(ref.a.map((a) => quat.angle(q(a))), ref.angle, 1e-12, "angle");
    expectClose(ref.a.map((a, i) => quat.angleBetween(q(a), q(ref.b[i]!))), ref.angle_between, 1e-12, "between");
    expectClose(ref.v.map((v, i) => quat.fromAxisAngle(v3(v), ref.t[i]! * 3)), ref.axis_angle, 1e-12, "axis");
  });

  it("makeContinuous flips the same samples", () => {
    const flipped = quat.quatArray(ref.walk_flipped.map(q));
    expectClose(quat.makeContinuous(flipped), ref.walk_made_continuous, 0, "continuous");
  });
});

describe("Euler angles match the Python reference", () => {
  it("toQuat and fromQuat", () => {
    expectClose(ref.eulers.map((e) => euler.toQuat(v3(e))), ref.euler_to_quat, 1e-12, "toQuat");
    expectClose(ref.a.map((a) => euler.fromQuat(q(a))), ref.euler_from_quat, 1e-11, "fromQuat");
  });

  it("gimbal locks use the reference z", () => {
    expectClose(ref.locks.map((e) => euler.toQuat(v3(e))), ref.locks_quat, 1e-12, "lock quats");
    expectClose(ref.locks_quat.map((l) => euler.fromQuat(q(l))), ref.locks_from_quat, 1e-9, "locks");
    expectClose(ref.locks_quat.map((l) => euler.fromQuat(q(l), 0.4)), ref.locks_from_quat_ref, 1e-9, "locks ref");
  });

  it("continuous curves pick the same branches", () => {
    const walk = quat.quatArray(ref.walk_quats.map(q));
    expectClose(euler.continuousFromQuats(walk), ref.walk_euler, 1e-9, "walk");
    expectClose(euler.continuousFromQuats(walk, [6, -3, 9]), ref.walk_euler_from_start, 1e-9, "walk from start");
  });
});

describe("quaternion behaviour", () => {
  it("rotates about Z by 90 degrees", () => {
    expectClose(quat.rotate(quat.fromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0], 1e-12);
  });

  it("mul applies the right operand first", () => {
    const aboutX = quat.fromAxisAngle([1, 0, 0], Math.PI / 2);
    const aboutZ = quat.fromAxisAngle([0, 0, 1], Math.PI / 2);
    // X first takes +Y to +Z, which the Z rotation then leaves alone.
    expectClose(quat.rotate(quat.mul(aboutZ, aboutX), [0, 1, 0]), [0, 0, 1], 1e-12);
  });

  it("inverse cancels and rotation preserves length", () => {
    fc.assert(
      fc.property(unitQuat, fc.tuple(angles, angles, angles), (rotation, vector) => {
        expect(quat.sameRotation(quat.mul(rotation, quat.inverse(rotation)), quat.IDENTITY)).toBe(true);
        expect(quat.norm3(quat.rotate(rotation, vector))).toBeCloseTo(quat.norm3(vector), 9);
      }),
    );
  });

  it("rejects zero-length input", () => {
    expect(() => quat.normalize([0, 0, 0, 0])).toThrow(/zero-length/);
    expect(() => quat.fromAxisAngle([0, 0, 0], 1)).toThrow(/non-zero/);
  });

  it("mulChain of nothing is the identity", () => {
    expect(quat.mulChain()).toEqual([0, 0, 0, 1]);
    expect(quat.identityArray(3)).toHaveLength(12);
  });

  it("measures the angle between rotations, ignoring sign", () => {
    const a = quat.fromAxisAngle([0, 1, 0], 0.25);
    const b = quat.fromAxisAngle([0, 1, 0], 1.0);
    expect(quat.angleBetween(a, b)).toBeCloseTo(0.75, 12);
    expect(quat.angleBetween(a, quat.negate(a))).toBeCloseTo(0, 7);
  });

  it("slerps along the shortest path", () => {
    const a = quat.fromAxisAngle([0, 0, 1], 0.2);
    const b = quat.fromAxisAngle([0, 0, 1], 1.0);
    expect(quat.sameRotation(quat.slerp(a, b, 0), a)).toBe(true);
    expect(quat.sameRotation(quat.slerp(a, b, 1), b)).toBe(true);
    expect(quat.sameRotation(quat.slerp(a, b, 0.5), quat.fromAxisAngle([0, 0, 1], 0.6))).toBe(true);
    const mid = quat.slerp(quat.IDENTITY, quat.negate(quat.fromAxisAngle([1, 0, 0], 0.2)), 0.5);
    expect(quat.angle(mid)).toBeCloseTo(0.1, 12);
    expect(quat.sameRotation(quat.slerp(a, a, 0.7), a)).toBe(true);
  });

  it("power scales and inverts", () => {
    const rotation = quat.fromAxisAngle([0, 1, 0], 0.8);
    expect(quat.sameRotation(quat.power(rotation, 0.5), quat.fromAxisAngle([0, 1, 0], 0.4))).toBe(true);
    expect(quat.sameRotation(quat.power(rotation, -1), quat.inverse(rotation))).toBe(true);
  });
});

describe("Euler behaviour", () => {
  it("applies X, then Y, then Z", () => {
    const rotation = euler.toQuat([Math.PI / 2, 0, Math.PI / 2]);
    expectClose(quat.rotate(rotation, [0, 1, 0]), [0, 0, 1], 1e-12);
  });

  it("round-trips and stays in the principal range", () => {
    fc.assert(
      fc.property(angles, fc.double({ min: -1.5, max: 1.5, noNaN: true }), angles, (x, y, z) => {
        const rotation = euler.toQuat([x, y, z]);
        expect(quat.sameRotation(euler.toQuat(euler.fromQuat(rotation)), rotation)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(unitQuat, (rotation) => {
        const e = euler.fromQuat(rotation);
        expect(Math.abs(e[1])).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
        expect(quat.sameRotation(euler.toQuat(e), rotation, 1e-8)).toBe(true);
      }),
    );
  });

  it.each([Math.PI / 2, -Math.PI / 2])("uses the reference z at gimbal lock (y = %f)", (pitch) => {
    const rotation = euler.toQuat([0.3, pitch, 0.9]);
    const e = euler.fromQuat(rotation, 0.5);
    expect(e[2]).toBeCloseTo(0.5, 12);
    expect(quat.sameRotation(euler.toQuat(e), rotation)).toBe(true);
  });

  it("unwraps past 180 degrees and prefers the nearer solution", () => {
    const degrees = (value: number) => (value * Math.PI) / 180;
    const past = euler.closestTo(euler.toQuat([0, 0, degrees(181)]), [0, 0, degrees(179)]);
    expect((past[2] * 180) / Math.PI).toBeCloseTo(181, 9);
    const previous: Vec3 = [Math.PI, Math.PI - 0.2, Math.PI];
    const alternate = euler.closestTo(euler.toQuat([0, 0.25, 0]), previous);
    expectClose(alternate, [Math.PI, Math.PI - 0.25, Math.PI], 1e-9);
  });

  it("has no jumps along a long spin", () => {
    const steps = Array.from({ length: 72 }, (_, i) => euler.toQuat([0, 0, ((i * 10) * Math.PI) / 180]));
    const curve = euler.continuousFromQuats(quat.quatArray(steps));
    for (let i = 3; i < curve.length; i++) {
      expect(Math.abs(curve[i]! - curve[i - 3]!)).toBeLessThan((10.001 * Math.PI) / 180);
    }
    expect((curve[curve.length - 1]! * 180) / Math.PI).toBeCloseTo(710, 6);
  });

  it("keeps the previous X/Z split at an exact gimbal lock", () => {
    // Regression: float noise at y = 90 degrees picked an arbitrary split.
    const sequence = [
      euler.toQuat([0.4, Math.PI / 2 - 0.05, 0.7]),
      euler.toQuat([0.4, Math.PI / 2, 0.7]),
      euler.toQuat([0.4, Math.PI / 2 - 0.05, 0.7]),
    ];
    const curve = euler.continuousFromQuats(quat.quatArray(sequence));
    expect(Math.abs(curve[5]! - curve[2]!)).toBeLessThan(1e-6);
    expect(Math.abs(curve[3]! - curve[0]!)).toBeLessThan(1e-6);
  });
});
