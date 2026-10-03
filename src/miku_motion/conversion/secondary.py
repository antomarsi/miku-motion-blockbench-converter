"""Secondary motion: springy chains (hair, ties, ...) that lag and swing with the body.

A chain is a list of target bones, parent to child, with no source motion of its own.
Its joints (the bones' pivots) plus a tip point become particles:

- the first particle is pinned to the chain's parent bone, which the dance moves
- every other particle is pulled towards its *anchor*, where it would be if the chain
  were rigidly attached to that parent (``stiffness``), damped relative to the anchor's
  velocity (``damping``), and pulled down by gravity
- each segment may swing at most ``max_angle`` away from its rigid direction, which
  keeps short pieces from flipping over and long hair out of the head
- ``offset`` shifts the anchors (fully at the tip, blended along the chain) so the
  chain's natural shape can lean, e.g. hair hanging behind the body
- after each step, segment lengths are restored from root to tip

The simulated joint positions are turned back into each bone's local rotation and
become ordinary keyframes. Runs in canonical target space (pixels), after retargeting.
"""

from dataclasses import dataclass, field

import numpy as np

from miku_motion.animation.clip import Animation, BoneTrack
from miku_motion.animation.skeleton import Skeleton
from miku_motion.geometry import quat
from miku_motion.geometry.quat import FloatArray

GRAVITY = 9.81 * 16.0  # px/s^2 at Minecraft scale (16 px = 1 block = 1 m)
MAX_STEP = 1.0 / 240.0  # seconds per simulation step
PRE_ROLL = 2.0  # seconds simulated on the first pose so the chain starts settled


@dataclass(frozen=True, slots=True)
class ChainSpec:
    bones: tuple[str, ...]  # parent to child
    tip: FloatArray  # (3,) end of the last segment, model space at rest
    stiffness: float  # 1/s^2: pull towards the rigid pose
    damping: float  # 1/s: damping of motion relative to the rigid pose
    gravity: float  # multiple of GRAVITY
    offset: FloatArray = field(default_factory=lambda: np.zeros(3))  # (3,) px, tip's rest shift
    max_angle: float = 180.0  # degrees a segment may swing away from its rigid direction


def world_transforms(
    skeleton: Skeleton, animation: Animation, names: set[str]
) -> dict[str, tuple[FloatArray, FloatArray]]:
    """Animated world (rotation, pivot position) per sample for ``names`` and ancestors."""
    count = len(animation.times)
    cache: dict[str, tuple[FloatArray, FloatArray]] = {}

    def world(name: str) -> tuple[FloatArray, FloatArray]:
        if name not in cache:
            bone = skeleton[name]
            track = animation.tracks.get(name)
            local = (
                track.rotations
                if track is not None and track.rotations is not None
                else np.tile(bone.rest_rotation, (count, 1))
            )
            offset = (
                track.translations
                if track is not None and track.translations is not None
                else np.zeros((count, 3))
            )
            if bone.parent is None:
                cache[name] = (local, bone.pivot + offset)
            else:
                parent_rot, parent_pos = world(bone.parent)
                position = parent_pos + quat.rotate(
                    parent_rot, bone.pivot - skeleton[bone.parent].pivot + offset
                )
                cache[name] = (quat.mul(parent_rot, local), position)
        return cache[name]

    return {name: world(name) for name in names}


def _shortest_arc(u: FloatArray, v: FloatArray) -> FloatArray:
    """Rotations turning directions ``u`` onto ``v`` (both ``(N, 3)``)."""
    u = u / np.linalg.norm(u, axis=1, keepdims=True)
    v = v / np.linalg.norm(v, axis=1, keepdims=True)
    dot = np.sum(u * v, axis=1, keepdims=True)
    axis = np.cross(u, v)
    opposite = dot[:, 0] < -1 + 1e-9
    if np.any(opposite):  # any axis perpendicular to u works for a half turn
        helper = np.where(np.abs(u[:, :1]) < 0.9, [[1.0, 0, 0]], [[0, 1.0, 0]])
        axis = np.where(opposite[:, None], np.cross(u, helper), axis)
    q = np.concatenate([axis, 1.0 + dot], axis=1)
    return quat.normalize(np.where(opposite[:, None], np.concatenate([axis, 0 * dot], 1), q))


def _perpendicular(v: FloatArray) -> FloatArray:
    helper = np.array([1.0, 0.0, 0.0]) if abs(v[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    across = np.cross(v, helper)
    result: FloatArray = across / np.linalg.norm(across)
    return result


def _simulate(
    anchors: FloatArray, times: FloatArray, spec: ChainSpec, lengths: FloatArray
) -> FloatArray:
    """Particle positions ``(N, P, 3)`` driven by anchor positions ``(N, P, 3)``."""
    rest = anchors[0]
    gravity = np.array([0.0, -GRAVITY * spec.gravity, 0.0])
    positions = rest.copy()
    velocity = np.zeros_like(positions)
    out = np.empty_like(anchors)
    limit_cos = float(np.cos(np.radians(spec.max_angle)))
    limit_sin = float(np.sin(np.radians(spec.max_angle)))

    def step(dt: float, anchor: FloatArray, anchor_velocity: FloatArray) -> None:
        nonlocal positions, velocity
        accel = (
            spec.stiffness * (anchor - positions)
            + spec.damping * (anchor_velocity - velocity)
            + gravity
        )
        velocity = velocity + accel * dt
        moved = positions + velocity * dt
        moved[0] = anchor[0]  # pinned to the parent bone
        for j in range(1, len(moved)):  # restore lengths and swing limits, root to tip
            direction = moved[j] - moved[j - 1]
            direction = direction / np.linalg.norm(direction)
            if limit_cos > -1.0:
                rigid = anchor[j] - anchor[j - 1]
                rigid = rigid / np.linalg.norm(rigid)
                cos = float(np.dot(direction, rigid))
                if cos < limit_cos:  # swung too far: put it back on the cone's edge
                    across = direction - cos * rigid
                    norm = float(np.linalg.norm(across))
                    across = across / norm if norm > 1e-9 else _perpendicular(rigid)
                    direction = limit_cos * rigid + limit_sin * across
            moved[j] = moved[j - 1] + direction * lengths[j - 1]
        velocity = (moved - positions) / dt
        positions = moved

    pre_steps = int(np.ceil(PRE_ROLL / MAX_STEP))
    still = np.zeros_like(rest)
    for _ in range(pre_steps):
        step(MAX_STEP, anchors[0], still)
    out[0] = positions
    for i in range(1, len(times)):
        span = times[i] - times[i - 1]
        steps = max(1, int(np.ceil(span / MAX_STEP)))
        dt = span / steps
        anchor_velocity = (anchors[i] - anchors[i - 1]) / span
        for s in range(1, steps + 1):
            step(dt, anchors[i - 1] + (anchors[i] - anchors[i - 1]) * (s / steps), anchor_velocity)
        out[i] = positions
    return out


def apply_secondary_motion(
    animation: Animation, skeleton: Skeleton, chains: list[ChainSpec]
) -> None:
    """Simulate ``chains`` and add their bones' rotation tracks to ``animation``."""
    for spec in chains:
        root = skeleton[spec.bones[0]]
        parent = root.parent
        rest_points = np.stack([*(skeleton[b].pivot for b in spec.bones), spec.tip])
        count = len(animation.times)
        if parent is None:
            parent_rot, parent_pos = quat.identity(count), np.zeros((count, 3))
            parent_pivot = np.zeros(3)
        else:
            parent_rot, parent_pos = world_transforms(skeleton, animation, {parent})[parent]
            parent_pivot = skeleton[parent].pivot
        rest_parent = skeleton.rest_world_rotation(parent) if parent else quat.identity()
        # Rigid attachment: rest offsets from the parent pivot, in the parent's rest frame.
        blend = np.linspace(0.0, 1.0, len(rest_points))[:, None]
        goal_points = rest_points + blend * spec.offset
        local_offsets = quat.rotate(quat.inverse(rest_parent), goal_points - parent_pivot)
        anchors = parent_pos[:, None, :] + quat.rotate(
            parent_rot[:, None, :], local_offsets[None, :, :]
        )
        lengths = np.linalg.norm(np.diff(rest_points, axis=0), axis=1)
        points = _simulate(anchors, animation.times, spec, lengths)

        world_parent = parent_rot
        for j, name in enumerate(spec.bones):
            bone = skeleton[name]
            rest_world = skeleton.rest_world_rotation(name)
            rest_direction = quat.rotate(
                quat.inverse(rest_world), rest_points[j + 1] - rest_points[j]
            )
            rigid = quat.mul(world_parent, bone.rest_rotation)
            swing = _shortest_arc(
                quat.rotate(rigid, rest_direction), points[:, j + 1] - points[:, j]
            )
            world = quat.mul(swing, rigid)
            local = quat.mul(quat.inverse(world_parent), world)
            animation.tracks[name] = BoneTrack(quat.make_continuous(local), None)
            world_parent = world
