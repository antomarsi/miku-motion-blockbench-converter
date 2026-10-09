/**
 * Secondary motion: springy chains (hair, ties, ...) that lag and swing with the body.
 *
 * A chain is a list of target bones, parent to child, with no source motion of its own.
 * Its joints (the bones' pivots) plus a tip point become particles:
 *
 * - the first particle is pinned to the chain's parent bone, which the dance moves
 * - every other particle is pulled towards its *anchor*, where it would be if the chain
 *   were rigidly attached to that parent (`stiffness`), damped relative to the anchor's
 *   velocity (`damping`), and pulled down by gravity
 * - each segment may swing at most `maxAngle` away from its rigid direction, which
 *   keeps short pieces from flipping over and long hair out of the head
 * - `offset` shifts the anchors (fully at the tip, blended along the chain) so the
 *   chain's natural shape can lean, e.g. hair hanging behind the body
 * - after each step, segment lengths are restored from root to tip
 *
 * The simulated joint positions are turned back into each bone's local rotation and
 * become ordinary keyframes. Runs in canonical target space (pixels), after retargeting.
 */

import type { Animation } from "../animation/clip";
import { RADIANS, type Skeleton } from "../animation/skeleton";
import {
  cross,
  getQuat,
  getVec3,
  IDENTITY,
  inverse,
  makeContinuous,
  mul,
  norm3,
  normalize,
  rotate,
  setQuat,
  type Quat,
  type QuatArray,
  type Vec3,
  type Vec3Array,
} from "../geometry/quat";

export const GRAVITY = 9.81 * 16.0; // px/s^2 at Minecraft scale (16 px = 1 block = 1 m)
export const MAX_STEP = 1.0 / 240.0; // seconds per simulation step
export const PRE_ROLL = 2.0; // seconds simulated on the first pose so the chain starts settled

export interface ChainSpec {
  /** Parent to child. */
  readonly bones: readonly string[];
  /** End of the last segment, model space at rest. */
  readonly tip: Vec3;
  /** 1/s^2: pull towards the rigid pose. */
  readonly stiffness: number;
  /** 1/s: damping of motion relative to the rigid pose. */
  readonly damping: number;
  /** Multiple of `GRAVITY`. */
  readonly gravity: number;
  /** Pixels: the tip's rest shift. */
  readonly offset: Vec3;
  /** Degrees a segment may swing away from its rigid direction. */
  readonly maxAngle: number;
}

interface World {
  readonly rotations: QuatArray;
  readonly positions: Vec3Array;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => {
  const n = norm3(v);
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** Animated world rotation and pivot position per sample of `name`. */
export function worldTransform(skeleton: Skeleton, animation: Animation, name: string): World {
  const count = animation.times.length;
  const cache = new Map<string, World>();
  const world = (boneName: string): World => {
    const known = cache.get(boneName);
    if (known) return known;
    const bone = skeleton.get(boneName);
    const track = animation.tracks.get(boneName);
    const parent = bone.parent !== undefined ? world(bone.parent) : undefined;
    const parentPivot = bone.parent !== undefined ? skeleton.get(bone.parent).pivot : undefined;
    const rotations = new Float64Array(4 * count);
    const positions = new Float64Array(3 * count);
    for (let n = 0; n < count; n++) {
      const local = track?.rotations ? getQuat(track.rotations, n) : bone.restRotation;
      const offset: Vec3 = track?.translations ? getVec3(track.translations, n) : [0, 0, 0];
      let rotation: Quat;
      let position: Vec3;
      if (!parent || !parentPivot) {
        rotation = local;
        position = add(bone.pivot, offset);
      } else {
        const parentRotation = getQuat(parent.rotations, n);
        position = add(
          getVec3(parent.positions, n),
          rotate(parentRotation, add(sub(bone.pivot, parentPivot), offset)),
        );
        rotation = mul(parentRotation, local);
      }
      setQuat(rotations, n, rotation);
      positions.set(position, 3 * n);
    }
    const result = { rotations, positions };
    cache.set(boneName, result);
    return result;
  };
  return world(name);
}

/** Rotation turning direction `from` onto `to`. */
function shortestArc(from: Vec3, to: Vec3): Quat {
  const u = unit(from);
  const v = unit(to);
  const dot = dot3(u, v);
  if (dot < -1 + 1e-9) {
    // Any axis perpendicular to u works for a half turn.
    const helper: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const axis = cross(u, helper);
    return normalize([axis[0], axis[1], axis[2], 0]);
  }
  const axis = cross(u, v);
  return normalize([axis[0], axis[1], axis[2], 1 + dot]);
}

function perpendicular(v: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(v, helper));
}

/**
 * Particle positions (`particles` points per sample, flat) driven by anchor positions
 * of the same shape.
 */
function simulate(
  anchors: Float64Array,
  times: Float64Array,
  spec: ChainSpec,
  lengths: readonly number[],
  particles: number,
): Float64Array {
  const size = 3 * particles;
  const gravity = -GRAVITY * spec.gravity;
  let positions = anchors.slice(0, size);
  const velocity = new Float64Array(size);
  const out = new Float64Array(anchors.length);
  const limitCos = Math.cos(spec.maxAngle * RADIANS);
  const limitSin = Math.sin(spec.maxAngle * RADIANS);
  const anchor = new Float64Array(size);
  const anchorVelocity = new Float64Array(size);
  const point = (array: Float64Array, j: number): Vec3 => [array[3 * j]!, array[3 * j + 1]!, array[3 * j + 2]!];

  const step = (dt: number): void => {
    const moved = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      let acceleration =
        spec.stiffness * (anchor[i]! - positions[i]!) +
        spec.damping * (anchorVelocity[i]! - velocity[i]!);
      if (i % 3 === 1) acceleration += gravity;
      velocity[i] = velocity[i]! + acceleration * dt;
      moved[i] = positions[i]! + velocity[i]! * dt;
    }
    moved.set(anchor.subarray(0, 3)); // pinned to the parent bone
    for (let j = 1; j < particles; j++) {
      // Restore lengths and swing limits, root to tip.
      const previous = point(moved, j - 1);
      let direction = unit(sub(point(moved, j), previous));
      if (limitCos > -1) {
        const rigid = unit(sub(point(anchor, j), point(anchor, j - 1)));
        const cos = dot3(direction, rigid);
        if (cos < limitCos) {
          // Swung too far: put it back on the cone's edge.
          let across: Vec3 = [
            direction[0] - cos * rigid[0],
            direction[1] - cos * rigid[1],
            direction[2] - cos * rigid[2],
          ];
          const norm = norm3(across);
          across = norm > 1e-9 ? [across[0] / norm, across[1] / norm, across[2] / norm] : perpendicular(rigid);
          direction = [
            limitCos * rigid[0] + limitSin * across[0],
            limitCos * rigid[1] + limitSin * across[1],
            limitCos * rigid[2] + limitSin * across[2],
          ];
        }
      }
      const length = lengths[j - 1]!;
      moved[3 * j] = previous[0] + direction[0] * length;
      moved[3 * j + 1] = previous[1] + direction[1] * length;
      moved[3 * j + 2] = previous[2] + direction[2] * length;
    }
    for (let i = 0; i < size; i++) velocity[i] = (moved[i]! - positions[i]!) / dt;
    positions = moved;
  };

  const preSteps = Math.ceil(PRE_ROLL / MAX_STEP);
  anchor.set(anchors.subarray(0, size));
  for (let s = 0; s < preSteps; s++) step(MAX_STEP);
  out.set(positions, 0);
  for (let i = 1; i < times.length; i++) {
    const span = times[i]! - times[i - 1]!;
    const steps = Math.max(1, Math.ceil(span / MAX_STEP));
    const dt = span / steps;
    const from = anchors.subarray(size * (i - 1), size * i);
    const to = anchors.subarray(size * i, size * (i + 1));
    for (let k = 0; k < size; k++) anchorVelocity[k] = (to[k]! - from[k]!) / span;
    for (let s = 1; s <= steps; s++) {
      for (let k = 0; k < size; k++) anchor[k] = from[k]! + (to[k]! - from[k]!) * (s / steps);
      step(dt);
    }
    out.set(positions, size * i);
  }
  return out;
}

/** Simulate `chains` and add their bones' rotation tracks to `animation`. */
export function applySecondaryMotion(
  animation: Animation,
  skeleton: Skeleton,
  chains: readonly ChainSpec[],
): void {
  const count = animation.times.length;
  for (const spec of chains) {
    const root = skeleton.get(spec.bones[0]!);
    const parent = root.parent;
    const restPoints: Vec3[] = [...spec.bones.map((name) => skeleton.get(name).pivot), spec.tip];
    const particles = restPoints.length;
    const size = 3 * particles;
    const parentWorld = parent !== undefined ? worldTransform(skeleton, animation, parent) : undefined;
    const parentPivot: Vec3 = parent !== undefined ? skeleton.get(parent).pivot : [0, 0, 0];
    const restParent = parent !== undefined ? skeleton.restWorldRotation(parent) : IDENTITY;

    // Rigid attachment: rest offsets from the parent pivot, in the parent's rest frame.
    const stepSize = particles > 1 ? 1 / (particles - 1) : 0;
    const localOffsets = restPoints.map((rest, k) => {
      const blend = k === particles - 1 ? 1 : k * stepSize;
      const goal: Vec3 = [
        rest[0] + blend * spec.offset[0],
        rest[1] + blend * spec.offset[1],
        rest[2] + blend * spec.offset[2],
      ];
      return rotate(inverse(restParent), sub(goal, parentPivot));
    });
    const anchors = new Float64Array(size * count);
    for (let n = 0; n < count; n++) {
      const rotation = parentWorld ? getQuat(parentWorld.rotations, n) : IDENTITY;
      const position: Vec3 = parentWorld ? getVec3(parentWorld.positions, n) : [0, 0, 0];
      localOffsets.forEach((offset, k) => {
        anchors.set(add(position, rotate(rotation, offset)), size * n + 3 * k);
      });
    }
    const lengths = restPoints.slice(1).map((p, k) => norm3(sub(p, restPoints[k]!)));
    const points = simulate(anchors, animation.times, spec, lengths, particles);

    // Each bone's world rotation per sample; starts as the chain parent's.
    let worldParent = parentWorld ? parentWorld.rotations : undefined;
    spec.bones.forEach((name, j) => {
      const bone = skeleton.get(name);
      const restWorld = skeleton.restWorldRotation(name);
      const restDirection = rotate(inverse(restWorld), sub(restPoints[j + 1]!, restPoints[j]!));
      const locals = new Float64Array(4 * count);
      const worlds = new Float64Array(4 * count);
      for (let n = 0; n < count; n++) {
        const above = worldParent ? getQuat(worldParent, n) : IDENTITY;
        const rigid = mul(above, bone.restRotation);
        const o = size * n + 3 * j;
        const segment: Vec3 = [
          points[o + 3]! - points[o]!,
          points[o + 4]! - points[o + 1]!,
          points[o + 5]! - points[o + 2]!,
        ];
        const world = mul(shortestArc(rotate(rigid, restDirection), segment), rigid);
        setQuat(worlds, n, world);
        setQuat(locals, n, mul(inverse(above), world));
      }
      animation.tracks.set(name, { rotations: makeContinuous(locals) });
      worldParent = worlds;
    });
  }
}
