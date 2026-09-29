"""The source model's skeleton: what a motion file assumes but doesn't contain.

A VMD stores bone deltas only. Solving IK needs the source model's bone positions,
hierarchy, inherited ("append") rotations and IK chain definitions. These come from a
skeleton file (a built-in standard template, or later the model's PMX).

Everything here is in the source (MMD) coordinate space and units.
"""

from dataclasses import dataclass, field

from miku_motion.geometry.quat import FloatArray


@dataclass(frozen=True, slots=True)
class Inherit:
    """Adds ``weight`` times another bone's local rotation (MMD's rotation append)."""

    bone: str
    weight: float


@dataclass(frozen=True, slots=True, eq=False)
class RigBone:
    name: str
    parent: str | None
    position: FloatArray  # (3,) rest position, model space
    inherit: Inherit | None = None


@dataclass(frozen=True, slots=True, eq=False)
class IkLink:
    bone: str
    # Local rotation limits (radians, per axis). When exactly one axis has a range the
    # link rotates about that axis only ("hinge"), like MMD knees.
    min_angles: FloatArray | None = None
    max_angles: FloatArray | None = None

    @property
    def hinge_axis(self) -> int | None:
        if self.min_angles is None or self.max_angles is None:
            return None
        free = [i for i in range(3) if self.min_angles[i] != 0 or self.max_angles[i] != 0]
        return free[0] if len(free) == 1 else None


@dataclass(frozen=True, slots=True, eq=False)
class IkChain:
    bone: str  # the IK bone; its position is the goal
    target: str  # the effector bone that should reach the goal
    links: tuple[IkLink, ...]  # from the effector's parent up towards the root
    iterations: int
    limit_angle: float  # max rotation per link per iteration, radians


@dataclass(frozen=True, slots=True)
class SourceRig:
    name: str
    bones: dict[str, RigBone]
    ik: tuple[IkChain, ...] = field(default=())

    def ancestors(self, name: str) -> list[str]:
        chain = []
        parent = self.bones[name].parent
        while parent is not None:
            chain.append(parent)
            parent = self.bones[parent].parent
        return chain

    def offset(self, name: str) -> FloatArray:
        """Rest offset from the parent's position (the bone's own position for roots)."""
        bone = self.bones[name]
        if bone.parent is None:
            return bone.position
        result: FloatArray = bone.position - self.bones[bone.parent].position
        return result

    def required_bones(self) -> set[str]:
        """Every bone whose motion affects some IK chain."""
        names: set[str] = set()
        for chain in self.ik:
            for bone in (chain.bone, chain.target, *(link.bone for link in chain.links)):
                names.add(bone)
                names.update(self.ancestors(bone))
        names.update(b.inherit.bone for b in self.bones.values() if b.inherit and b.name in names)
        return names
