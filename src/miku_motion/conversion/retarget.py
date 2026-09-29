"""Retarget sampled source poses onto a target skeleton.

Model: source bones have identity rest rotations (true for MMD), so a source bone's
local rotation is a delta in world-aligned axes. For a target bone ``b`` whose nearest
mapped ancestor is ``a`` and whose parent is ``p``:

- ``C(b)``: product of the chain's source local rotations (parent to child), i.e. the
  source rotation of ``b`` relative to ``a``, converted to canonical space
- ``D``: a binding's rest correction (target rest pose -> source rest pose, world axes)
- ``Wr``: target rest orientation relative to the model

Requiring the target's world orientation to be ``G_src(b) · D_b · Wr(b)`` gives the
local rotation (rest included)::

    L(b) = Wr(p)^-1 · D_a^-1 · C(b) · D_b · Wr(p) · R_rest(b)

With no corrections and no rest rotations this is simply ``C(b)``. Translation follows
the same frames: ``T(b) = scale · Wr(p)^-1 · D_a^-1 · P(b)``, where ``P`` composes the
chain's offsets (``p1 + R1 p2 + R1 R2 p3 ...``).
"""

import numpy as np

from miku_motion.animation.clip import Animation, BoneTrack, LoopMode
from miku_motion.animation.sampling import PoseSamples
from miku_motion.animation.skeleton import Skeleton
from miku_motion.conversion.coordinates import BasisChange
from miku_motion.geometry import quat
from miku_motion.geometry.quat import FloatArray
from miku_motion.mapping.resolve import Binding, ResolvedMapping


def _chain(
    binding: Binding, poses: dict[str, PoseSamples], count: int
) -> tuple[FloatArray, FloatArray]:
    """Compose the chain's (rotation, offset) in source space, parent to child."""
    rotation = quat.identity(count)
    offset = np.zeros((count, 3))
    for link in binding.chain:
        pose = poses.get(link.source)
        if pose is None:  # bone without keys: at rest
            continue
        offset = offset + quat.rotate(rotation, pose.translations)
        local = pose.rotations if link.weight == 1.0 else quat.power(pose.rotations, link.weight)
        rotation = quat.mul(rotation, local)
    return rotation, offset


def retarget(
    poses: dict[str, PoseSamples],
    times: FloatArray,
    mapping: ResolvedMapping,
    skeleton: Skeleton,
    basis: BasisChange,
    *,
    name: str,
    loop: LoopMode = LoopMode.ONCE,
) -> Animation:
    """Build the target animation from source poses sampled at ``times``.

    Source bones missing from ``poses`` are treated as being at rest.
    """
    corrections = {b.target: b.rest_correction for b in mapping.bindings}

    tracks: dict[str, BoneTrack] = {}
    for binding in mapping.bindings:
        bone = skeleton[binding.target]
        parent_rest = skeleton.rest_world_rotation(bone.parent) if bone.parent else quat.identity()
        anchor_fix = corrections[binding.anchor] if binding.anchor else quat.identity()
        to_local = quat.mul(quat.inverse(parent_rest), quat.inverse(anchor_fix))

        rotation, offset = _chain(binding, poses, len(times))
        rotation = basis.rotations(rotation)
        local = quat.mul_chain(
            to_local, rotation, binding.rest_correction, parent_rest, bone.rest_rotation
        )
        translations = None
        if binding.translation:
            translations = quat.rotate(
                to_local, basis.points(offset, scale=mapping.translation_scale)
            )
        tracks[binding.target] = BoneTrack(quat.make_continuous(local), translations)

    return Animation(name=name, times=times, length=float(times[-1]), loop=loop, tracks=tracks)
