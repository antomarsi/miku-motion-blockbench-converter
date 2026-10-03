"""A generic bone hierarchy (target rigs now, PMX source rigs later).

Positions are in the skeleton's own units, rotations are xyzw quaternions, both in the
canonical space (right-handed, Y-up, model faces -Z, model's left at -X).
"""

from collections.abc import Iterator
from dataclasses import dataclass, field

import numpy as np

from miku_motion.geometry import euler, quat
from miku_motion.geometry.quat import FloatArray


@dataclass(frozen=True, slots=True, eq=False)
class Bone:
    name: str
    parent: str | None
    pivot: FloatArray  # (3,) rotation origin, in model space
    rest_rotation: FloatArray  # (4,) local rotation relative to the parent, at rest
    rest_euler_degrees: FloatArray  # (3,) the same rest rotation as authored (ZYX, degrees)
    # (2, 3) min/max corner of the bone's own geometry (cubes directly inside it), if any.
    extent: FloatArray | None = None


@dataclass(frozen=True, slots=True)
class Skeleton:
    """Bones in topological order: every parent comes before its children."""

    bones: tuple[Bone, ...]
    _index: dict[str, int] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        index: dict[str, int] = {}
        for i, bone in enumerate(self.bones):
            if bone.name in index:
                raise ValueError(f"duplicate bone name {bone.name!r}")
            if bone.parent is not None and bone.parent not in index:
                raise ValueError(f"bone {bone.name!r} listed before its parent {bone.parent!r}")
            index[bone.name] = i
        object.__setattr__(self, "_index", index)

    def __iter__(self) -> Iterator[Bone]:
        return iter(self.bones)

    def __len__(self) -> int:
        return len(self.bones)

    def __contains__(self, name: object) -> bool:
        return name in self._index

    def __getitem__(self, name: str) -> Bone:
        return self.bones[self._index[name]]

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(b.name for b in self.bones)

    def order(self, name: str) -> int:
        return self._index[name]

    def ancestors(self, name: str) -> Iterator[Bone]:
        """Parent, grandparent, ... up to the root."""
        parent = self[name].parent
        while parent is not None:
            bone = self[parent]
            yield bone
            parent = bone.parent

    def children(self, name: str) -> tuple[Bone, ...]:
        return tuple(b for b in self.bones if b.parent == name)

    def rest_world_rotation(self, name: str) -> FloatArray:
        """Rest orientation of ``name`` relative to the model (product down the chain)."""
        chain = [self[name], *self.ancestors(name)]
        return quat.mul_chain(*(b.rest_rotation for b in reversed(chain)))


def make_bone(
    name: str,
    parent: str | None,
    pivot: tuple[float, float, float] | FloatArray = (0.0, 0.0, 0.0),
    rest_euler_degrees: tuple[float, float, float] | FloatArray = (0.0, 0.0, 0.0),
    extent: FloatArray | None = None,
) -> Bone:
    """Build a bone from a ZYX Euler rest rotation in degrees (Blockbench's convention)."""
    degrees = np.asarray(rest_euler_degrees, dtype=np.float64)
    return Bone(
        name=name,
        parent=parent,
        pivot=np.asarray(pivot, dtype=np.float64),
        rest_rotation=euler.to_quat(np.radians(degrees)),
        rest_euler_degrees=degrees,
        extent=extent,
    )
