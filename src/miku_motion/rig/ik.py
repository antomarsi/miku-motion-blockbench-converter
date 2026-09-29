"""Forward kinematics and MMD-style CCD inverse kinematics on sampled source poses.

Runs in the source (MMD) space before retargeting and is vectorized over samples: each
CCD step updates every sample at once. The algorithm follows MMD's IK:

- chains are solved in skeleton order, each starting from the forward-kinematics pose
- per iteration, links are visited from the effector's parent towards the root; each
  rotates so the effector points at the goal, by at most ``limit_angle``
- a link limited to one axis (a knee) works in "plane mode": it only accumulates an
  angle about that axis, clamped to its range
- IK can be switched off over time by the motion (VMD show/IK keys)

Results replace the link bones' sampled rotations, so mapping and retargeting are
unaware IK happened.
"""

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from miku_motion.animation.sampling import PoseSamples
from miku_motion.animation.source import SourceMotion
from miku_motion.geometry import euler, quat
from miku_motion.geometry.quat import FloatArray
from miku_motion.rig.model import IkChain, IkLink, SourceRig

type BoolArray = npt.NDArray[np.bool_]

_TINY = 1e-9
_AXES = np.eye(3)


@dataclass(frozen=True, slots=True, eq=False)
class ChainResult:
    chain: IkChain
    enabled_fraction: float
    residuals: FloatArray  # (N,) effector-to-goal distance where solved, else 0


def rest_pose(count: int) -> PoseSamples:
    return PoseSamples(np.zeros((count, 3)), quat.identity(count))


class _Kinematics:
    """World transforms from local sampled poses (MMD parent-child composition)."""

    def __init__(self, rig: SourceRig, poses: dict[str, PoseSamples], count: int):
        self.rig = rig
        self.poses = poses
        self.count = count
        self._cache: dict[str, tuple[FloatArray, FloatArray]] = {}

    def local_rotation(self, name: str) -> FloatArray:
        own = self.poses[name].rotations
        inherit = self.rig.bones[name].inherit
        if inherit is None or inherit.weight == 0:
            return own
        source = self.poses[inherit.bone].rotations
        appended = source if inherit.weight == 1 else quat.power(source, inherit.weight)
        return quat.mul(appended, own)

    def world(self, name: str | None) -> tuple[FloatArray, FloatArray]:
        """World (rotation, position) of ``name``; ``None`` is the model origin."""
        if name is None:
            return quat.identity(self.count), np.zeros((self.count, 3))
        if name not in self._cache:
            parent_rot, parent_pos = self.world(self.rig.bones[name].parent)
            offset = self.rig.offset(name) + self.poses[name].translations
            position = parent_pos + quat.rotate(parent_rot, offset)
            self._cache[name] = (quat.mul(parent_rot, self.local_rotation(name)), position)
        return self._cache[name]


def ik_enabled(motion: SourceMotion, bone: str, frames: FloatArray) -> BoolArray:
    """Per-sample on/off state of an IK bone (on unless the motion switches it off)."""
    states = motion.ik_states.get(bone, ())
    enabled = np.ones(len(frames), dtype=bool)
    for frame, on in states:  # sorted by frame; each state holds until the next one
        enabled[frames >= frame] = on
    return enabled


def _hinge_angle(rotations: FloatArray, axis: int, link: IkLink) -> FloatArray:
    assert link.min_angles is not None
    assert link.max_angles is not None
    twist = 2.0 * np.arctan2(rotations[:, axis], rotations[:, 3])
    twist = (twist + np.pi) % (2 * np.pi) - np.pi
    result: FloatArray = np.clip(twist, link.min_angles[axis], link.max_angles[axis])
    return result


def _clamp_euler(rotations: FloatArray, link: IkLink) -> FloatArray:
    """Approximate multi-axis limits by clamping ZYX Euler angles."""
    assert link.min_angles is not None
    assert link.max_angles is not None
    angles = np.clip(euler.from_quat(rotations), link.min_angles, link.max_angles)
    return euler.to_quat(angles)


def solve_chain(
    rig: SourceRig, chain: IkChain, poses: dict[str, PoseSamples], enabled: BoolArray
) -> FloatArray:
    """Solve one chain in place (updates ``poses`` of its links); returns residuals."""
    count = len(enabled)
    kinematics = _Kinematics(rig, poses, count)
    root = chain.links[-1].bone
    base_rot, base_pos = kinematics.world(rig.bones[root].parent)
    _, goal = kinematics.world(chain.bone)

    order = [link.bone for link in reversed(chain.links)]  # root ... effector's parent
    offsets = {name: rig.offset(name) + poses[name].translations for name in [*order, chain.target]}
    local = {link.bone: quat.normalize(poses[link.bone].rotations) for link in chain.links}
    hinge = {
        link.bone: _hinge_angle(local[link.bone], axis, link)
        for link in chain.links
        if (axis := link.hinge_axis) is not None
    }
    for link in chain.links:
        if link.hinge_axis is not None:
            local[link.bone] = quat.from_axis_angle(_AXES[link.hinge_axis], hinge[link.bone])

    def forward() -> tuple[dict[str, tuple[FloatArray, FloatArray]], FloatArray]:
        rot, pos = base_rot, base_pos
        world = {}
        for name in order:
            pos = pos + quat.rotate(rot, offsets[name])
            rot = quat.mul(rot, local[name])
            world[name] = (rot, pos)
        return world, pos + quat.rotate(rot, offsets[chain.target])

    for iteration in range(chain.iterations):
        for link in chain.links:
            world, effector = forward()
            link_rot, link_pos = world[link.bone]
            to_local = quat.inverse(link_rot)
            e = quat.rotate(to_local, effector - link_pos)
            t = quat.rotate(to_local, goal - link_pos)
            e_len = np.linalg.norm(e, axis=1, keepdims=True)
            t_len = np.linalg.norm(t, axis=1, keepdims=True)
            usable = enabled & (e_len[:, 0] > _TINY) & (t_len[:, 0] > _TINY)
            e = e / np.maximum(e_len, _TINY)
            t = t / np.maximum(t_len, _TINY)
            angle = np.minimum(
                np.arccos(np.clip(np.sum(e * t, axis=1), -1.0, 1.0)), chain.limit_angle
            )
            active = usable & (angle > 1e-7)
            if not np.any(active):
                continue

            axis_index = link.hinge_axis
            if axis_index is not None:
                assert link.min_angles is not None
                assert link.max_angles is not None
                axis = _AXES[axis_index]
                plus = quat.rotate(quat.from_axis_angle(axis, angle), e)
                minus = quat.rotate(quat.from_axis_angle(axis, -angle), e)
                step = np.where(np.sum(plus * t, 1) >= np.sum(minus * t, 1), angle, -angle)
                lo, hi = link.min_angles[axis_index], link.max_angles[axis_index]
                new = hinge[link.bone] + step
                if iteration == 0:  # MMD: on the first pass, try bending the other way
                    outside = (new < lo) | (new > hi)
                    flip = outside & (-new >= lo) & (-new <= hi)
                    new = np.where(flip, -new, new)
                new = np.clip(new, lo, hi)
                hinge[link.bone] = np.where(active, new, hinge[link.bone])
                local[link.bone] = quat.from_axis_angle(axis, hinge[link.bone])
            else:
                cross = np.cross(e, t)
                cross_len = np.linalg.norm(cross, axis=1, keepdims=True)
                active &= cross_len[:, 0] > _TINY
                safe_axis = np.where(
                    active[:, None], cross / np.maximum(cross_len, _TINY), _AXES[0]
                )
                rotated = quat.normalize(
                    quat.mul(local[link.bone], quat.from_axis_angle(safe_axis, angle))
                )
                if link.min_angles is not None and link.max_angles is not None:
                    rotated = _clamp_euler(rotated, link)
                local[link.bone] = np.where(active[:, None], rotated, local[link.bone])

    _, effector = forward()
    residuals: FloatArray = np.where(enabled, np.linalg.norm(effector - goal, axis=1), 0.0)
    for link in chain.links:
        original = poses[link.bone]
        solved = np.where(enabled[:, None], local[link.bone], original.rotations)
        poses[link.bone] = PoseSamples(original.translations, solved)
    return residuals


def solve_ik(
    rig: SourceRig, motion: SourceMotion, poses: dict[str, PoseSamples], frames: FloatArray
) -> list[ChainResult]:
    """Solve every chain of ``rig`` in order, updating ``poses`` in place.

    Bones the rig needs but the motion never keys are filled in at rest.
    """
    count = len(frames)
    for name in rig.required_bones():
        if name not in poses:
            poses[name] = rest_pose(count)
    results = []
    for chain in rig.ik:
        enabled = ik_enabled(motion, chain.bone, frames)
        residuals = solve_chain(rig, chain, poses, enabled)
        results.append(ChainResult(chain, float(np.mean(enabled)), residuals))
    return results
