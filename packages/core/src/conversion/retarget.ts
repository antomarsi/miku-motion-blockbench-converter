/**
 * Retarget sampled source poses onto a target skeleton.
 *
 * Model: source bones have identity rest rotations (true for MMD), so a source bone's
 * local rotation is a delta in world-aligned axes. For a target bone `b` whose nearest
 * mapped ancestor is `a` and whose parent is `p`:
 *
 * - `C(b)`: product of the chain's source local rotations (parent to child), i.e. the
 *   source rotation of `b` relative to `a`, converted to canonical space
 * - `D`: a binding's rest correction (target rest pose -> source rest pose, world axes)
 * - `Wr`: target rest orientation relative to the model
 *
 * Requiring the target's world orientation to be `G_src(b) · D_b · Wr(b)` gives the
 * local rotation (rest included):
 *
 *     L(b) = Wr(p)^-1 · D_a^-1 · C(b) · D_b · Wr(p) · R_rest(b)
 *
 * With no corrections and no rest rotations this is simply `C(b)`. Translation follows
 * the same frames: `T(b) = scale · Wr(p)^-1 · D_a^-1 · P(b)`, where `P` composes the
 * chain's offsets (`p1 + R1 p2 + R1 R2 p3 ...`).
 */

import type { Animation, BoneTrack, LoopMode } from "../animation/clip";
import type { PoseSamples } from "../animation/sampling";
import type { Skeleton } from "../animation/skeleton";
import {
  getQuat,
  getVec3,
  IDENTITY,
  inverse,
  makeContinuous,
  mul,
  mulChain,
  power,
  rotate,
  setQuat,
  setVec3,
  type Quat,
  type Vec3,
} from "../geometry/quat";
import type { ResolvedMapping } from "../mapping/resolve";
import type { BasisChange } from "./coordinates";

export interface RetargetOptions {
  readonly name: string;
  readonly loop: LoopMode;
}

/**
 * Build the target animation from source poses sampled at `times`.
 *
 * Source bones missing from `poses` are treated as being at rest.
 */
export function retarget(
  poses: ReadonlyMap<string, PoseSamples>,
  times: Float64Array,
  mapping: ResolvedMapping,
  skeleton: Skeleton,
  basis: BasisChange,
  options: RetargetOptions,
): Animation {
  const count = times.length;
  const corrections = new Map(mapping.bindings.map((b) => [b.target, b.restCorrection]));

  const tracks = new Map<string, BoneTrack>();
  for (const binding of mapping.bindings) {
    const bone = skeleton.get(binding.target);
    const parentRest = bone.parent !== undefined ? skeleton.restWorldRotation(bone.parent) : IDENTITY;
    const anchorFix = binding.anchor !== undefined ? corrections.get(binding.anchor)! : IDENTITY;
    const toLocal = mul(inverse(parentRest), inverse(anchorFix));
    // The part of L(b) after C(b): D_b · Wr(p) · R_rest(b).
    const tail = mulChain(binding.restCorrection, parentRest, bone.restRotation);
    const links = binding.chain
      .map((link) => ({ pose: poses.get(link.source), weight: link.weight }))
      .filter((link) => link.pose !== undefined); // a bone without keys is at rest

    const rotations = new Float64Array(4 * count);
    const translations = binding.translation ? new Float64Array(3 * count) : undefined;
    for (let n = 0; n < count; n++) {
      // Compose the chain's (rotation, offset) in source space, parent to child.
      let rotation: Quat = IDENTITY;
      let offset: Vec3 = [0, 0, 0];
      for (const { pose, weight } of links) {
        const moved = rotate(rotation, getVec3(pose!.translations, n));
        offset = [offset[0] + moved[0], offset[1] + moved[1], offset[2] + moved[2]];
        const local = getQuat(pose!.rotations, n);
        rotation = mul(rotation, weight === 1 ? local : power(local, weight));
      }
      setQuat(rotations, n, mulChain(toLocal, basis.rotation(rotation), tail));
      if (translations) {
        setVec3(translations, n, rotate(toLocal, basis.point(offset, mapping.translationScale)));
      }
    }
    tracks.set(binding.target, { rotations: makeContinuous(rotations), translations });
  }

  return {
    name: options.name,
    times,
    length: times[count - 1] ?? 0,
    loop: options.loop,
    tracks,
  };
}
