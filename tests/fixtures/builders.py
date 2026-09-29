"""Builders for synthetic test inputs. Real assets are never committed; tests use these."""

import json
import math
import struct
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

type GroupSpec = tuple[str, str | None, tuple[float, float, float], tuple[float, float, float]]


def group(
    name: str,
    parent: str | None,
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> GroupSpec:
    return (name, parent, origin, rotation)


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
        kids: list[Any] = [cube_ids[name]] + [node(c) for c in children.get(name, [])]
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
            {"uuid": cube_ids[g[0]], "name": g[0], "from": [0, 0, 0], "to": [1, 1, 1]}
            for g in groups
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


# --- audio ------------------------------------------------------------------------------------


def _ogg_page(payload: bytes, granule: int, serial: int = 7, sequence: int = 0) -> bytes:
    segments = [255] * (len(payload) // 255) + [len(payload) % 255]
    header = struct.pack("<4sBBqIIIB", b"OggS", 0, 0, granule, serial, sequence, 0, len(segments))
    return header + bytes(segments) + payload


def ogg_vorbis(seconds: float, rate: int = 44_100, channels: int = 2) -> bytes:
    """A structurally valid Ogg Vorbis stream (headers + end page, no real audio)."""
    ident = b"\x01vorbis" + struct.pack("<IBI", 0, channels, rate) + bytes(13)
    return _ogg_page(ident, 0) + _ogg_page(b"\x00" * 300, round(seconds * rate), sequence=1)


def ogg_opus(seconds: float, pre_skip: int = 312) -> bytes:
    head = b"OpusHead" + struct.pack("<BBHIhB", 1, 2, pre_skip, 48_000, 0, 0)
    return _ogg_page(head, 0) + _ogg_page(b"\x00", round(seconds * 48_000) + pre_skip, sequence=1)
