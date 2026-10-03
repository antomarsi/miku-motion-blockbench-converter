"""Find body parts (roles) in an arbitrary rig from its geometry.

Works in canonical model space (Y up, faces -Z, model's left at -X). Names are only
tie-breakers, so any naming style works. Hair, cloth and accessories (secondary-motion
candidates) are set aside first so they are never mistaken for limbs.

- legs: bones whose cubes reach the ground, off-centre; a leg's segments are that bone
  and its same-side ancestors above it (thigh, shin, foot from the top)
- head: the highest centred block (a "head" name token wins ties, then volume)
- torso: the head's nearest centred ancestor with cubes (not carrying the legs); with
  a waist and chest stacked, the waist is the torso and the upper one the chest
- hips: a centred bone carrying both legs, outside the torso and not above it
- chest: a centred child of the torso whose cubes are mostly outside the torso's
- arms: off-centre bones in the torso's subtree (outside the head's) reaching shoulder
  height, followed down through children below them (upper arm, forearm, hand); for
  flat rigs (everything at top level) anywhere outside the legs and head
- torso fallback for flat rigs: the largest centred block below the head
- root: the nearest group containing the torso and both legs
"""

import re
from dataclasses import dataclass, field

import numpy as np

from miku_motion.animation.skeleton import Bone, Skeleton
from miku_motion.geometry.quat import FloatArray

CENTRED = 1.5  # px: |x| of a centred part's cube centre
GROUND_TOLERANCE = 0.75  # px
SHOULDER_HEIGHT = 0.55  # arms reach above this fraction of the model's height
LIMB_NAMES = {"arm": ("upper_arm", "forearm", "hand"), "leg": ("thigh", "shin", "foot")}


@dataclass(slots=True)
class Roles:
    root: str | None = None
    torso: str | None = None
    chest: str | None = None
    hips: str | None = None  # a lower-body bone carrying the legs, separate from the torso
    head: str | None = None
    arms: dict[str, list[str]] = field(default_factory=dict)  # side -> segments, top first
    legs: dict[str, list[str]] = field(default_factory=dict)

    def by_role(self) -> dict[str, str]:
        """Role name (as in ``mmd_roles.json``) -> bone name."""
        out = {
            r: b
            for r, b in (
                ("root", self.root),
                ("torso", self.torso),
                ("chest", self.chest),
                ("hips", self.hips),
                ("head", self.head),
            )
            if b
        }
        for kind, limbs in (("arm", self.arms), ("leg", self.legs)):
            for side, segments in limbs.items():
                for role, bone in zip(LIMB_NAMES[kind], segments, strict=False):
                    out[f"{role}_{side}"] = bone
        return out


def _center(bone: Bone) -> FloatArray:
    assert bone.extent is not None
    result: FloatArray = 0.5 * (bone.extent[0] + bone.extent[1])
    return result


def _volume(extent: FloatArray) -> float:
    return float(np.prod(np.maximum(extent[1] - extent[0], 0.0)))


def _overlap(a: FloatArray, b: FloatArray) -> float:
    low, high = np.maximum(a[0], b[0]), np.minimum(a[1], b[1])
    return float(np.prod(np.maximum(high - low, 0.0)))


def _has_token(name: str, word: str) -> bool:
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return word in [t.lower() for t in re.split(r"[^A-Za-z]+", spaced) if t]


def _within_column(bone: Bone, parent: Bone) -> bool:
    """The bone's cubes stay inside the parent's cross-section (a next limb segment,
    not a cuff or other piece wrapped around it)."""
    if bone.extent is None or parent.extent is None:
        return False
    slack = 0.1  # a next segment shares the column; a cuff is wider
    return all(
        bone.extent[0][axis] >= parent.extent[0][axis] - slack
        and bone.extent[1][axis] <= parent.extent[1][axis] + slack
        for axis in (0, 2)
    )


def _side(x: float) -> str:
    return "left" if x < 0 else "right"


def _descendants(skeleton: Skeleton, name: str) -> set[str]:
    out: set[str] = set()
    stack = [name]
    while stack:
        for child in skeleton.children(stack.pop()):
            out.add(child.name)
            stack.append(child.name)
    return out


def detect_roles(skeleton: Skeleton, exclude: set[str]) -> Roles:
    """Body parts of ``skeleton``; bones in ``exclude`` (and below) are never limbs."""
    excluded = set(exclude)
    for name in exclude:
        excluded |= _descendants(skeleton, name)
    solid = [b for b in skeleton if b.extent is not None and b.name not in excluded]
    roles = Roles()
    if not solid:
        return roles
    ground = min(float(b.extent[0][1]) for b in solid if b.extent is not None)
    top = max(float(b.extent[1][1]) for b in solid if b.extent is not None)

    # Legs: off-centre bones reaching the ground, with their same-side ancestors.
    for bone in solid:
        assert bone.extent is not None
        x = float(_center(bone)[0])
        if bone.extent[0][1] > ground + GROUND_TOLERANCE or abs(x) < 0.5:
            continue
        side = _side(x)
        if side in roles.legs:
            continue
        segments = [bone.name]
        for ancestor in skeleton.ancestors(bone.name):
            if ancestor.extent is None or ancestor.name in excluded:
                break
            ax = float(_center(ancestor)[0])
            if abs(ax) < 0.5 or _side(ax) != side or ancestor.extent[0][1] < bone.extent[0][1]:
                break
            segments.insert(0, ancestor.name)
        roles.legs[side] = segments
    leg_bones = {b for segments in roles.legs.values() for b in segments}

    # Head: highest centred block.
    centred = [b for b in solid if abs(float(_center(b)[0])) <= CENTRED and b.name not in leg_bones]
    if centred:

        def head_rank(b: Bone) -> tuple[float, bool, float]:
            assert b.extent is not None
            return (round(float(b.extent[1][1]), 1), _has_token(b.name, "head"), _volume(b.extent))

        roles.head = max(centred, key=head_rank).name

    # Torso: the head's nearest centred ancestor with cubes that doesn't also carry the
    # legs; when two are stacked (waist and chest), the lower one is the torso.
    leg_ancestors = {a.name for leg in leg_bones for a in skeleton.ancestors(leg)}
    if roles.head:
        trunk = [
            a
            for a in skeleton.ancestors(roles.head)
            if a.extent is not None
            and abs(float(_center(a)[0])) <= CENTRED
            and a.name not in leg_ancestors
        ]
        if len(trunk) >= 2 and _center(trunk[0])[1] > _center(trunk[1])[1]:
            roles.chest, roles.torso = trunk[0].name, trunk[1].name
        elif trunk:
            roles.torso = trunk[0].name
        if roles.torso is None:  # flat rigs: the largest centred block below the head
            head = skeleton[roles.head]
            assert head.extent is not None
            head_parts = _descendants(skeleton, roles.head) | {roles.head}
            below = [
                b
                for b in centred
                if b.name not in head_parts
                and b.extent is not None
                and b.extent[1][1] <= head.extent[0][1] + 0.5
            ]
            if below:
                roles.torso = max(below, key=lambda b: _volume(b.extent)).name  # type: ignore[arg-type]
    if roles.torso and roles.chest is None:
        torso = skeleton[roles.torso]
        assert torso.extent is not None
        candidates = [
            c
            for c in skeleton.children(roles.torso)
            if c.extent is not None
            and c.name not in excluded
            and c.name != roles.head
            and abs(float(_center(c)[0])) <= CENTRED
            and _overlap(c.extent, torso.extent) < 0.5 * _volume(c.extent)
            and float(_center(c)[1]) > float(_center(torso)[1])
        ]
        if candidates:
            roles.chest = max(candidates, key=lambda c: _volume(c.extent)).name  # type: ignore[arg-type]

    # Arms: off-centre bones under the torso (not the head) reaching shoulder height; in
    # flat rigs (arms beside the torso, not under it) anywhere outside the legs and head.
    if roles.torso:
        head_parts = (_descendants(skeleton, roles.head) | {roles.head}) if roles.head else set()
        region = _descendants(skeleton, roles.torso) - leg_bones - head_parts
        shoulder = ground + SHOULDER_HEIGHT * (top - ground)
        if not any(
            skeleton[b].extent is not None and abs(float(_center(skeleton[b])[0])) > CENTRED
            for b in region
            if b not in excluded
        ):
            region = set(skeleton.names) - leg_bones - head_parts - {roles.torso}
        for bone in skeleton:
            if bone.name not in region or bone.extent is None or bone.name in excluded:
                continue
            x = float(_center(bone)[0])
            side = _side(x)
            if abs(x) <= CENTRED or side in roles.arms or bone.extent[1][1] < shoulder:
                continue
            segments = [bone.name]
            while True:
                parent = skeleton[segments[-1]]
                below = [
                    c
                    for c in skeleton.children(segments[-1])
                    if c.extent is not None
                    and c.name not in excluded
                    and c.pivot[1] < parent.pivot[1] - 1e-6
                ]
                if len(below) > 1:  # prefer the piece continuing the limb's column
                    below = [c for c in below if _within_column(c, parent)]
                if len(below) != 1:
                    break
                segments.append(below[0].name)
            roles.arms[side] = segments

    # Hips: a centred bone carrying both legs that is neither the torso (or part of it)
    # nor above it, e.g. a pelvis group, with or without cubes of its own.
    tops = [segments[0] for segments in roles.legs.values()]
    parents = {skeleton[t].parent for t in tops}
    if len(tops) == 2 and len(parents) == 1 and (hips := parents.pop()) is not None:
        bone = skeleton[hips]
        torso_parts = (
            (_descendants(skeleton, roles.torso) | {roles.torso}) if roles.torso else set()
        )
        above_torso = {a.name for a in skeleton.ancestors(roles.torso)} if roles.torso else set()
        x = float(_center(bone)[0]) if bone.extent is not None else float(bone.pivot[0])
        if abs(x) <= CENTRED and hips not in torso_parts and hips not in above_torso:
            roles.hips = hips

    # Root: nearest group containing the torso and the legs.
    members = [b for b in (roles.torso, *leg_bones) if b]
    if members:
        lineages = [[a.name for a in skeleton.ancestors(m)] for m in members]
        common = [a for a in lineages[0] if all(a in line for line in lineages[1:])]
        roles.root = common[0] if common else None
    return roles
