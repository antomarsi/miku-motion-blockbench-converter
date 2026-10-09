/**
 * Forward kinematics and MMD-style CCD inverse kinematics on sampled source poses.
 *
 * Runs in the source (MMD) space before retargeting. The algorithm follows MMD's IK:
 *
 * - chains are solved in skeleton order, each starting from the forward-kinematics pose
 * - per iteration, links are visited from the effector's parent towards the root; each
 *   rotates so the effector points at the goal, by at most `limitAngle`
 * - a link limited to one axis (a knee) works in "plane mode": it only accumulates an
 *   angle about that axis, clamped to its range
 * - IK can be switched off over time by the motion (VMD show/IK keys)
 *
 * Results replace the link bones' sampled rotations, so mapping and retargeting are
 * unaware IK happened.
 */

import type { PoseSamples } from "../animation/sampling";
import type { SourceMotion } from "../animation/source";
import { fromQuat, toQuat } from "../geometry/euler";
import {
  cross,
  fromAxisAngle,
  getQuat,
  getVec3,
  identityArray,
  inverse,
  mul,
  norm3,
  normalize,
  power,
  rotate,
  setQuat,
  setVec3,
  type Quat,
  type QuatArray,
  type Vec3,
  type Vec3Array,
} from "../geometry/quat";
import { hingeAxis, type IkChain, type IkLink, type SourceRig } from "./model";

const TINY = 1e-9;
const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface ChainResult {
  readonly chain: IkChain;
  /** Share of the samples the chain was switched on for. */
  readonly enabledFraction: number;
  /** Effector-to-goal distance where solved, else 0. */
  readonly residuals: Float64Array;
}

export function restPose(count: number): PoseSamples {
  return { translations: new Float64Array(3 * count), rotations: identityArray(count) };
}

interface World {
  readonly rotations: QuatArray;
  readonly positions: Vec3Array;
}

/** World transforms from local sampled poses (MMD parent-child composition). */
class Kinematics {
  private readonly cache = new Map<string, World>();

  constructor(
    private readonly rig: SourceRig,
    private readonly poses: ReadonlyMap<string, PoseSamples>,
    private readonly count: number,
  ) {}

  private localRotation(name: string, n: number): Quat {
    const own = getQuat(this.poses.get(name)!.rotations, n);
    const inherit = this.rig.bone(name).inherit;
    if (!inherit || inherit.weight === 0) return own;
    const source = getQuat(this.poses.get(inherit.bone)!.rotations, n);
    return mul(inherit.weight === 1 ? source : power(source, inherit.weight), own);
  }

  /** World rotation and position of `name` per sample; `undefined` is the model origin. */
  world(name: string | undefined): World {
    if (name === undefined) {
      return { rotations: identityArray(this.count), positions: new Float64Array(3 * this.count) };
    }
    let cached = this.cache.get(name);
    if (!cached) {
      const parent = this.world(this.rig.bone(name).parent);
      const rest = this.rig.offset(name);
      const pose = this.poses.get(name)!;
      const rotations = new Float64Array(4 * this.count);
      const positions = new Float64Array(3 * this.count);
      for (let n = 0; n < this.count; n++) {
        const parentRotation = getQuat(parent.rotations, n);
        const t = getVec3(pose.translations, n);
        const moved = rotate(parentRotation, [rest[0] + t[0], rest[1] + t[1], rest[2] + t[2]]);
        const p = getVec3(parent.positions, n);
        setVec3(positions, n, [p[0] + moved[0], p[1] + moved[1], p[2] + moved[2]]);
        setQuat(rotations, n, mul(parentRotation, this.localRotation(name, n)));
      }
      cached = { rotations, positions };
      this.cache.set(name, cached);
    }
    return cached;
  }
}

/** Per-sample on/off state of an IK bone (on unless the motion switches it off). */
export function ikEnabled(motion: SourceMotion, bone: string, frames: Float64Array): Uint8Array {
  const enabled = new Uint8Array(frames.length).fill(1);
  // Sorted by frame; each state holds until the next one.
  for (const [frame, on] of motion.ikStates.get(bone) ?? []) {
    for (let n = 0; n < frames.length; n++) if (frames[n]! >= frame) enabled[n] = on ? 1 : 0;
  }
  return enabled;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function hingeAngle(rotation: Quat, axis: number, link: IkLink): number {
  let twist = 2 * Math.atan2(rotation[axis]!, rotation[3]);
  const turn = 2 * Math.PI;
  twist = ((((twist + Math.PI) % turn) + turn) % turn) - Math.PI;
  return clamp(twist, link.minAngles![axis]!, link.maxAngles![axis]!);
}

/** Approximate multi-axis limits by clamping ZYX Euler angles. */
function clampEuler(rotation: Quat, link: IkLink): Quat {
  const angles = fromQuat(rotation);
  const low = link.minAngles!;
  const high = link.maxAngles!;
  return toQuat([
    clamp(angles[0], low[0], high[0]),
    clamp(angles[1], low[1], high[1]),
    clamp(angles[2], low[2], high[2]),
  ]);
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** Solve one chain in place (updates `poses` of its links); returns residuals. */
export function solveChain(
  rig: SourceRig,
  chain: IkChain,
  poses: Map<string, PoseSamples>,
  enabled: Uint8Array,
): Float64Array {
  const count = enabled.length;
  const kinematics = new Kinematics(rig, poses, count);
  const { links } = chain;
  const linkCount = links.length;
  const root = links[linkCount - 1]!.bone;
  const base = kinematics.world(rig.bone(root).parent);
  const goals = kinematics.world(chain.bone).positions;

  // Root ... effector's parent, then the effector itself.
  const order = links.map((link) => link.bone).reverse();
  const names = [...order, chain.target];
  const restOffsets = names.map((name) => rig.offset(name));
  const posesOf = names.map((name) => poses.get(name)!);
  const axes = links.map(hingeAxis);
  const solved = links.map(() => new Float64Array(4 * count));
  const residuals = new Float64Array(count);

  const offsets: Vec3[] = names.map(() => [0, 0, 0]);
  const local: Quat[] = new Array<Quat>(linkCount); // indexed like `links`
  const hinge = new Float64Array(linkCount);
  const worldRotation: Quat[] = new Array<Quat>(linkCount); // indexed like `order`
  const worldPosition: Vec3[] = new Array<Vec3>(linkCount);

  for (let n = 0; n < count; n++) {
    if (!enabled[n]) {
      for (let l = 0; l < linkCount; l++) {
        setQuat(solved[l]!, n, getQuat(poses.get(links[l]!.bone)!.rotations, n));
      }
      continue;
    }
    const baseRotation = getQuat(base.rotations, n);
    const basePosition = getVec3(base.positions, n);
    const goal = getVec3(goals, n);
    for (let i = 0; i < names.length; i++) {
      offsets[i] = add(restOffsets[i]!, getVec3(posesOf[i]!.translations, n));
    }
    for (let l = 0; l < linkCount; l++) {
      const link = links[l]!;
      local[l] = normalize(getQuat(poses.get(link.bone)!.rotations, n));
      const axis = axes[l];
      if (axis !== undefined) {
        hinge[l] = hingeAngle(local[l]!, axis, link);
        local[l] = fromAxisAngle(AXES[axis]!, hinge[l]!);
      }
    }

    /** Fills the links' world transforms and returns the effector's position. */
    const forward = (): Vec3 => {
      let rotation = baseRotation;
      let position = basePosition;
      for (let i = 0; i < linkCount; i++) {
        position = add(position, rotate(rotation, offsets[i]!));
        rotation = mul(rotation, local[linkCount - 1 - i]!);
        worldRotation[i] = rotation;
        worldPosition[i] = position;
      }
      return add(position, rotate(rotation, offsets[linkCount]!));
    };

    for (let iteration = 0; iteration < chain.iterations; iteration++) {
      let moved = false;
      for (let l = 0; l < linkCount; l++) {
        const link = links[l]!;
        const effector = forward();
        const o = linkCount - 1 - l; // this link's place in `order`
        const toLocal = inverse(worldRotation[o]!);
        let e = rotate(toLocal, sub(effector, worldPosition[o]!));
        let t = rotate(toLocal, sub(goal, worldPosition[o]!));
        const eLength = norm3(e);
        const tLength = norm3(t);
        const usable = eLength > TINY && tLength > TINY;
        e = scale(e, 1 / Math.max(eLength, TINY));
        t = scale(t, 1 / Math.max(tLength, TINY));
        const angle = Math.min(Math.acos(clamp(dot3(e, t), -1, 1)), chain.limitAngle);
        let active = usable && angle > 1e-7;
        if (!active) continue;

        const axisIndex = axes[l];
        if (axisIndex !== undefined) {
          const axis = AXES[axisIndex]!;
          const plus = rotate(fromAxisAngle(axis, angle), e);
          const minus = rotate(fromAxisAngle(axis, -angle), e);
          const step = dot3(plus, t) >= dot3(minus, t) ? angle : -angle;
          const low = link.minAngles![axisIndex]!;
          const high = link.maxAngles![axisIndex]!;
          let next = hinge[l]! + step;
          if (iteration === 0) {
            // MMD: on the first pass, try bending the other way.
            const outside = next < low || next > high;
            if (outside && -next >= low && -next <= high) next = -next;
          }
          hinge[l] = clamp(next, low, high);
          local[l] = fromAxisAngle(axis, hinge[l]!);
          moved = true;
        } else {
          const across = cross(e, t);
          const acrossLength = norm3(across);
          active = acrossLength > TINY;
          if (!active) continue;
          let rotated = normalize(
            mul(local[l]!, fromAxisAngle(scale(across, 1 / acrossLength), angle)),
          );
          if (link.minAngles && link.maxAngles) rotated = clampEuler(rotated, link);
          local[l] = rotated;
          moved = true;
        }
      }
      // Nothing changed in a whole pass: later passes would repeat it exactly.
      if (!moved) break;
    }

    const effector = forward();
    let target = goal;
    if (linkCount === 1) {
      // One bone can only aim at its goal (toes: the goal is often keyed nearer or
      // farther than the foot is long). Judge it against the closest point it can reach.
      const pivot = worldPosition[linkCount - 1]!;
      const reach = norm3(sub(effector, pivot));
      const toGoal = sub(goal, pivot);
      const distance = norm3(toGoal);
      target = distance > TINY ? add(pivot, scale(toGoal, reach / Math.max(distance, TINY))) : effector;
    }
    residuals[n] = norm3(sub(effector, target));
    for (let l = 0; l < linkCount; l++) setQuat(solved[l]!, n, local[l]!);
  }

  links.forEach((link, l) => {
    poses.set(link.bone, {
      translations: poses.get(link.bone)!.translations,
      rotations: solved[l]!,
    });
  });
  return residuals;
}

/**
 * Solve every chain of `rig` in order, updating `poses` in place.
 *
 * Bones the rig needs but the motion never keys are filled in at rest.
 */
export function solveIk(
  rig: SourceRig,
  motion: SourceMotion,
  poses: Map<string, PoseSamples>,
  frames: Float64Array,
): ChainResult[] {
  const count = frames.length;
  for (const name of rig.requiredBones()) {
    if (!poses.has(name)) poses.set(name, restPose(count));
  }
  return rig.ik.map((chain) => {
    const enabled = ikEnabled(motion, chain.bone, frames);
    const residuals = solveChain(rig, chain, poses, enabled);
    let on = 0;
    for (const value of enabled) on += value;
    return { chain, enabledFraction: count ? on / count : 0, residuals };
  });
}
