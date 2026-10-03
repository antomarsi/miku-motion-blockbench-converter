"""Secondary-motion chains in the mapping: validation, presets, tips and suggestions.

Nothing here depends on the model having IK set up in Blockbench: a chain is just a
list of the model's bones. A one-bone chain (short hair, a single back ponytail) works
when the bone has cubes, since its tip is found from the geometry.
"""

import json
import math
import re
from dataclasses import dataclass
from importlib import resources
from itertools import pairwise
from pathlib import Path

import numpy as np

from miku_motion.animation.skeleton import Bone, Skeleton
from miku_motion.conversion.secondary import ChainSpec
from miku_motion.errors import MappingError
from miku_motion.geometry.quat import FloatArray
from miku_motion.mapping.resolve import unknown_targets
from miku_motion.mapping.schema import MappingFile, SecondaryMotionSpec


@dataclass(frozen=True, slots=True)
class Preset:
    stiffness: float  # 1/s^2
    bounciness: float  # 0 = settles without overshoot, 1 = keeps bouncing
    gravity: float


PRESETS: dict[str, Preset] = {
    "long_hair": Preset(stiffness=40.0, bounciness=0.5, gravity=1.0),
    "ponytail": Preset(stiffness=60.0, bounciness=0.55, gravity=1.0),
    "short_hair": Preset(stiffness=160.0, bounciness=0.3, gravity=0.6),
    "cloth": Preset(stiffness=90.0, bounciness=0.35, gravity=1.0),
    "accessory": Preset(stiffness=70.0, bounciness=0.7, gravity=1.0),
}
DEFAULT_PRESET = "long_hair"


def damping_for(stiffness: float, bounciness: float) -> float:
    """Damping giving a damping ratio of ``1 - bounciness`` (1 = no overshoot)."""
    return 2.0 * math.sqrt(stiffness) * (1.0 - bounciness)


def geometry_tip(bone: Bone) -> FloatArray | None:
    """Where the bone's cubes end, looking from its pivot through their centre."""
    if bone.extent is None:
        return None
    low, high = bone.extent
    center = 0.5 * (low + high)
    half = 0.5 * (high - low)
    direction = center - bone.pivot
    length = float(np.linalg.norm(direction))
    if length < 1e-6:
        return None
    unit = direction / length
    along = np.abs(unit)
    exits = np.divide(half, along, out=np.full(3, np.inf), where=along > 1e-9)
    tip: FloatArray = center + unit * float(np.min(exits))
    return tip


def _tip(
    spec: SecondaryMotionSpec, skeleton: Skeleton, where: str, path: Path | None
) -> FloatArray:
    if spec.tip is not None:
        return np.array(spec.tip, dtype=float)
    from_geometry = geometry_tip(skeleton[spec.bones[-1]])
    if from_geometry is not None:
        return from_geometry
    pivots = [skeleton[b].pivot for b in spec.bones]
    if len(pivots) >= 2:
        extended: FloatArray = pivots[-1] + (pivots[-1] - pivots[-2])
        return extended
    raise MappingError(
        f'{where}: {spec.bones[0]!r} has no cubes to measure, so give the chain a "tip" '
        "(where the bone ends)",
        path=path,
    )


def resolve_secondary(
    mapping: MappingFile, skeleton: Skeleton, *, mapping_path: Path | None = None
) -> list[ChainSpec]:
    """Validate ``secondary_motion`` chains against the target skeleton."""
    chains: list[ChainSpec] = []
    used: set[str] = set()
    driven = set(mapping.bones)
    for index, spec in enumerate(mapping.secondary_motion):
        where = f"secondary_motion[{index}]"
        unknown = [b for b in spec.bones if b not in skeleton]
        if unknown:
            raise MappingError(
                f"{where}: bones not found in the model:\n{unknown_targets(unknown, skeleton)}",
                path=mapping_path,
            )
        for parent, child in pairwise(spec.bones):
            if skeleton[child].parent != parent:
                raise MappingError(
                    f"{where}: {child!r} is not a child of {parent!r}; list the chain's bones "
                    "from parent to child",
                    path=mapping_path,
                )
        clash = sorted((set(spec.bones) & driven) | (set(spec.bones) & used))
        if clash:
            raise MappingError(
                f"{where}: {clash} are already driven by the motion or another chain",
                path=mapping_path,
            )
        used.update(spec.bones)
        points = [
            *(skeleton[b].pivot for b in spec.bones),
            _tip(spec, skeleton, where, mapping_path),
        ]
        if any(np.linalg.norm(b - a) < 1e-6 for a, b in pairwise(points)):
            raise MappingError(
                f"{where}: two joints share a position; give each bone its own pivot",
                path=mapping_path,
            )

        preset = PRESETS[spec.preset or DEFAULT_PRESET]
        stiffness = spec.stiffness if spec.stiffness is not None else preset.stiffness
        if spec.damping is not None:
            damping = spec.damping
        else:
            bounce = spec.bounciness if spec.bounciness is not None else preset.bounciness
            damping = damping_for(stiffness, bounce)
        chains.append(
            ChainSpec(
                tuple(spec.bones),
                points[-1],
                stiffness,
                damping,
                spec.gravity if spec.gravity is not None else preset.gravity,
                np.array(spec.offset, dtype=float),
            )
        )
    return chains


# --- suggestions ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Suggestion:
    bones: tuple[str, ...]
    preset: str


def _keyword_presets() -> list[tuple[str, list[str]]]:
    text = (resources.files("miku_motion.data") / "secondary_keywords.json").read_text("utf-8")
    return [(entry["preset"], entry["match"]) for entry in json.loads(text)["presets"]]


def _tokens(name: str) -> list[str]:
    """``SquareHair_Right2`` -> ``["square", "hair", "right", "2"]``."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+|(?<=[A-Za-z])(?=[0-9])", spaced) if t]


_COMPACT_MATCH = 5  # ASCII fragments this long may also span tokens ("TwinTail1")


def _preset_for(name: str, keywords: list[tuple[str, list[str]]]) -> str | None:
    tokens = _tokens(name)
    compact = "".join(tokens)
    for preset, fragments in keywords:
        for fragment in fragments:
            if fragment.isascii():
                word = fragment.lower()
                if any(token.startswith(word) for token in tokens) or (
                    len(word) >= _COMPACT_MATCH and word in compact
                ):
                    return preset
            elif fragment in name:
                return preset
    return None


LONG_HAIR_LENGTH = 12.0  # px; longer hair chains swing like long hair whatever their name


def suggest_chains(skeleton: Skeleton, mapping: MappingFile) -> list[Suggestion]:
    """Unconfigured bone chains whose names look like hair, cloth or accessories.

    A chain starts at a bone with a hair/cloth-like name (or below one) that isn't
    driven by the motion, and follows single children down to a leaf. Only bones with
    their own cubes are included, so pure grouping nodes don't become physics.
    """
    keywords = _keyword_presets()
    taken = set(mapping.bones) | {b for chain in mapping.secondary_motion for b in chain.bones}
    suggestions: list[Suggestion] = []
    claimed: set[str] = set()
    for bone in skeleton:
        if bone.name in taken or bone.name in claimed or bone.extent is None:
            continue
        lineage = [bone.name, *(a.name for a in skeleton.ancestors(bone.name))]
        preset = next((p for n in lineage if (p := _preset_for(n, keywords))), None)
        parent = bone.parent
        if preset is None or (parent is not None and parent in claimed):
            continue
        chain = [bone.name]
        while True:
            children = [c for c in skeleton.children(chain[-1]) if c.extent is not None]
            if len(children) != 1 or children[0].name in taken:
                break
            chain.append(children[0].name)
        tip = geometry_tip(skeleton[chain[-1]])
        if tip is None and len(chain) < 2:
            continue
        if preset == "short_hair":
            points = [*(skeleton[b].pivot for b in chain), *([tip] if tip is not None else [])]
            length = sum(float(np.linalg.norm(b - a)) for a, b in pairwise(points))
            if len(chain) >= 3 or length >= LONG_HAIR_LENGTH:
                preset = "long_hair"
        claimed.update(chain)
        suggestions.append(Suggestion(tuple(chain), preset))
    return suggestions
