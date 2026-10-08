"""Source skeleton files (JSON): bones, inherited rotations and IK chains.

```json
{
  "schema_version": 1,
  "name": "...",
  "bones": [
    {"name": "Hip", "parent": null, "position": [0, 10, 0]},
    {"name": "Cancel", "parent": "Hip", "position": [1, 10, 0],
     "inherit": {"bone": "Waist", "weight": -1}}
  ],
  "ik": [
    {"bone": "LegIK", "target": "Ankle", "iterations": 40, "limit_angle_deg": 114.59,
     "links": [{"bone": "Knee", "min_deg": [-180, 0, 0], "max_deg": [-0.5, 0, 0]},
               {"bone": "Thigh"}]}
  ]
}
```

Bones must be listed parents first. IK links run from the target's parent upwards,
each one the parent of the previous.
"""

import json
from importlib import resources
from pathlib import Path

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from miku_motion.errors import MikuMotionError
from miku_motion.pmx.adapter import read_pmx_rig
from miku_motion.rig.model import IkChain, IkLink, Inherit, RigBone, SourceRig

BUILTIN_PACKAGE = "miku_motion.data.skeletons"
DEFAULT_SKELETON = "mmd-standard"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class InheritSpec(_Strict):
    bone: str
    weight: float


class BoneSpec(_Strict):
    name: str = Field(min_length=1)
    parent: str | None = None
    position: tuple[float, float, float]
    inherit: InheritSpec | None = None


class LinkSpec(_Strict):
    bone: str
    min_deg: tuple[float, float, float] | None = None
    max_deg: tuple[float, float, float] | None = None


class IkSpec(_Strict):
    bone: str
    target: str
    iterations: int = Field(default=40, ge=1, le=1000)
    limit_angle_deg: float = Field(default=114.5916, gt=0)
    links: list[LinkSpec] = Field(min_length=1)


class SkeletonFile(_Strict):
    schema_version: int = Field(default=1, ge=1, le=1)
    name: str
    description: str | None = None
    bones: list[BoneSpec] = Field(min_length=1)
    ik: list[IkSpec] = Field(default_factory=list)


class SkeletonError(MikuMotionError):
    """A source skeleton file is invalid."""


def _build(spec: SkeletonFile, source: str) -> SourceRig:
    bones: dict[str, RigBone] = {}
    for b in spec.bones:
        if b.name in bones:
            raise SkeletonError(f"bone {b.name!r} is listed twice", path=source)
        if b.parent is not None and b.parent not in bones:
            raise SkeletonError(
                f"bone {b.name!r} must come after its parent {b.parent!r}", path=source
            )
        inherit = Inherit(b.inherit.bone, b.inherit.weight) if b.inherit else None
        bones[b.name] = RigBone(b.name, b.parent, np.array(b.position, dtype=float), inherit)
    for bone in bones.values():
        if bone.inherit and bone.inherit.bone not in bones:
            raise SkeletonError(
                f"bone {bone.name!r} inherits from unknown bone {bone.inherit.bone!r}",
                path=source,
            )

    chains = []
    for ik in spec.ik:
        names = [ik.bone, ik.target, *(link.bone for link in ik.links)]
        unknown = [n for n in names if n not in bones]
        if unknown:
            raise SkeletonError(f"IK {ik.bone!r} uses unknown bones {unknown}", path=source)
        expected_child = ik.target
        for link in ik.links:
            if bones[expected_child].parent != link.bone:
                raise SkeletonError(
                    f"IK {ik.bone!r}: {link.bone!r} must be the parent of {expected_child!r} "
                    "(links run from the target's parent upwards)",
                    path=source,
                )
            expected_child = link.bone
        links = tuple(
            IkLink(
                link.bone,
                np.radians(link.min_deg) if link.min_deg is not None else None,
                np.radians(link.max_deg) if link.max_deg is not None else None,
            )
            for link in ik.links
        )
        chains.append(
            IkChain(ik.bone, ik.target, links, ik.iterations, np.radians(ik.limit_angle_deg))
        )
    return SourceRig(spec.name, bones, tuple(chains))


def parse_skeleton(data: object, source: str) -> SourceRig:
    try:
        spec = SkeletonFile.model_validate(data)
    except ValidationError as exc:
        details = "\n".join(
            f"  - {'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        )
        raise SkeletonError(f"invalid skeleton file:\n{details}", path=source) from exc
    return _build(spec, source)


def load_skeleton(name_or_path: str | Path) -> SourceRig:
    """Load a built-in skeleton by name (e.g. ``mmd-standard``), or a skeleton JSON
    file or the motion's own ``.pmx`` model by path."""
    path = Path(name_or_path)
    if path.suffix.lower() == ".pmx":
        return read_pmx_rig(path)
    if path.suffix.lower() == ".json" or path.exists():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise SkeletonError(f"cannot read file: {exc.strerror}", path=path) from exc
        source = str(path)
    else:
        resource = resources.files(BUILTIN_PACKAGE) / f"{name_or_path}.json"
        if not resource.is_file():
            available = sorted(
                p.name.removesuffix(".json")
                for p in resources.files(BUILTIN_PACKAGE).iterdir()
                if p.name.endswith(".json")
            )
            raise SkeletonError(
                f"unknown built-in skeleton {str(name_or_path)!r}; available: {available}"
            )
        text = resource.read_text(encoding="utf-8")
        source = f"built-in:{name_or_path}"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SkeletonError(f"not valid JSON: {exc.msg}", path=source) from exc
    return parse_skeleton(data, source)
