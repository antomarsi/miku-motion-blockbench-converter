"""Builders for synthetic test inputs. Real assets are never committed; tests use these."""

import json
import math
from pathlib import Path
from typing import Any

from miku_motion.vmd import interpolation
from miku_motion.vmd.interpolation import BoneCurves
from miku_motion.vmd.types import Quat, Vec3, VmdBoneKey, VmdFile, VmdMorphKey

IDENTITY: Quat = (0.0, 0.0, 0.0, 1.0)


def axis_angle(axis: Vec3, degrees: float) -> Quat:
    """Quaternion (xyzw) for a rotation in the file's own (MMD) coordinate space."""
    norm = math.sqrt(sum(c * c for c in axis))
    half = math.radians(degrees) / 2
    s = math.sin(half) / norm
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(half))


def bone_key(
    name: str,
    frame: int,
    position: Vec3 = (0.0, 0.0, 0.0),
    rotation: Quat = IDENTITY,
    curves: BoneCurves = interpolation.LINEAR_CURVES,
) -> VmdBoneKey:
    return VmdBoneKey(name, frame, position, rotation, interpolation.encode(curves))


def vmd(
    *bone_keys: VmdBoneKey, morphs: tuple[VmdMorphKey, ...] = (), model: str = "test"
) -> VmdFile:
    return VmdFile(model_name=model, bone_keys=list(bone_keys), morph_keys=list(morphs))


# --- Blockbench models ---------------------------------------------------------------------

type Vec = tuple[float, float, float]
type GroupSpec = tuple[str, str | None, Vec, Vec, tuple[Vec, Vec] | None]


def group(
    name: str,
    parent: str | None,
    origin: Vec = (0.0, 0.0, 0.0),
    rotation: Vec = (0.0, 0.0, 0.0),
    cube: tuple[Vec, Vec] | None = None,
) -> GroupSpec:
    """A group (bone), optionally holding one cube given as ``(from, to)``."""
    return (name, parent, origin, rotation, cube)


def bbmodel(
    *groups: GroupSpec,
    layout: int = 5,
    name: str = "test_rig",
    model_format: str = "geckolib_model",
) -> dict[str, Any]:
    """A minimal .bbmodel document with one cube per group, in 4.x or 5.x layout."""
    uuids = {spec[0]: f"00000000-0000-0000-0000-{i:012d}" for i, spec in enumerate(groups)}
    cube_ids = {spec[0]: f"cube-{i}" for i, spec in enumerate(groups)}
    children: dict[str | None, list[str]] = {}
    for spec in groups:
        children.setdefault(spec[1], []).append(spec[0])

    def node(name: str) -> dict[str, Any]:
        spec = next(g for g in groups if g[0] == name)
        own_cube = [cube_ids[name]] if spec[4] is not None else []
        kids: list[Any] = own_cube + [node(c) for c in children.get(name, [])]
        if layout == 5:
            return {"uuid": uuids[name], "isOpen": True, "children": kids}
        return {
            "name": name,
            "uuid": uuids[name],
            "origin": list(spec[2]),
            "rotation": list(spec[3]),
            "children": kids,
        }

    document: dict[str, Any] = {
        "meta": {"format_version": f"{layout}.0", "model_format": model_format},
        "name": name,
        "elements": [
            {"uuid": cube_ids[g[0]], "name": g[0], "from": list(g[4][0]), "to": list(g[4][1])}
            for g in groups
            if g[4] is not None
        ],
        "outliner": [node(name) for name in children.get(None, [])],
    }
    if layout == 5:
        document["groups"] = [
            {"uuid": uuids[g[0]], "name": g[0], "origin": list(g[2]), "rotation": list(g[3])}
            for g in groups
        ]
    return document


def player_rig(layout: int = 5) -> dict[str, Any]:
    """A small humanoid shaped like a Minecraft player model (legs under Root)."""
    return bbmodel(
        group("Root", None),
        group("Body", "Root", (0, 12, 0)),
        group("Chest", "Body", (0, 23, -1), (20, 0, 0)),
        group("Head", "Body", (0, 24, 0)),
        group("LeftArm", "Body", (-4.5, 22, 0)),
        group("LowerLeftArm", "LeftArm", (-4.5, 17, 0)),
        group("RightArm", "Body", (4.5, 22, 0)),
        group("LeftLeg", "Root", (-1.9, 12, 0)),
        group("RightLeg", "Root", (1.9, 12, 0)),
        layout=layout,
        name="player_rig",
    )


def write_json(path: Path, data: Any) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
