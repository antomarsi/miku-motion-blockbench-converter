"""PMX model -> source rig (the skeleton IK is solved on)."""

from itertools import pairwise
from pathlib import Path

import numpy as np

from miku_motion.pmx.parser import PmxModel, read_pmx
from miku_motion.rig.model import IkChain, IkLink, Inherit, RigBone, SourceRig


def to_source_rig(model: PmxModel, name: str) -> SourceRig:
    """Every bone of ``model``, parents first, with its rotation inheritance and IK.

    Bone names must be unique in a rig: when a model repeats one, the first bone keeps
    it and the others are left out (their children attach to the nearest kept ancestor).
    IK chains whose links aren't a parent chain up from the target can't be solved and
    are left out too.
    """
    count = len(model.bones)
    first: dict[str, int] = {}
    for index, bone in enumerate(model.bones):
        first.setdefault(bone.name, index)
    kept = set(first.values())

    def kept_parent(index: int) -> int | None:
        seen = {index}
        parent = model.bones[index].parent
        while 0 <= parent < count and parent not in seen:
            if parent in kept:
                return parent
            seen.add(parent)
            parent = model.bones[parent].parent
        return None

    parents = {index: kept_parent(index) for index in kept}
    bones: dict[str, RigBone] = {}

    def add(index: int, trail: frozenset[int]) -> None:
        bone = model.bones[index]
        if bone.name in bones:
            return
        parent = parents[index]
        if parent is not None and parent in trail:
            parent = None  # a parent loop: treat the bone as a root
        if parent is not None:
            add(parent, trail | {index})
        inherit = None
        if bone.inherit_rotation is not None:
            source, weight = bone.inherit_rotation
            if 0 <= source < count and source != index and weight != 0:
                inherit = Inherit(model.bones[source].name, weight)
        bones[bone.name] = RigBone(
            bone.name,
            model.bones[parent].name if parent is not None else None,
            np.array(bone.position, dtype=float),
            inherit,
        )

    for index in sorted(kept):
        add(index, frozenset())

    chains = []
    for index in sorted(kept):
        bone = model.bones[index]
        ik = bone.ik
        if ik is None or not 0 <= ik.target < count or not ik.links:
            continue
        if any(not 0 <= link.bone < count for link in ik.links):
            continue
        names = [model.bones[ik.target].name, *(model.bones[link.bone].name for link in ik.links)]
        if any(bones[child].parent != parent for child, parent in pairwise(names)):
            continue
        links = tuple(
            IkLink(
                model.bones[link.bone].name,
                np.array(link.min_angles) if link.min_angles is not None else None,
                np.array(link.max_angles) if link.max_angles is not None else None,
            )
            for link in ik.links
        )
        chains.append(IkChain(bone.name, names[0], links, max(ik.iterations, 1), ik.limit_angle))
    return SourceRig(name, bones, tuple(chains))


def read_pmx_rig(path: Path) -> SourceRig:
    model = read_pmx(path)
    return to_source_rig(model, model.name or path.stem)
