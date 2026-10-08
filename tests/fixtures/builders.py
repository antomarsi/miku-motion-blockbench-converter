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


# --- PMX models -------------------------------------------------------------------------------

type PmxIkSpec = tuple[str, int, float, list[tuple[str, tuple[Vec, Vec] | None]]]


def pmx_bone(
    name: str,
    parent: str | None,
    position: Vec,
    *,
    inherit: tuple[str, float] | None = None,
    ik: PmxIkSpec | None = None,
) -> dict[str, Any]:
    """``ik`` is (target, iterations, limit radians, [(link bone, (min, max) radians or None)])."""
    return {"name": name, "parent": parent, "position": position, "inherit": inherit, "ik": ik}


def pmx_bytes(
    *bones: dict[str, Any],
    morphs: tuple[tuple[str, int], ...] = (),
    name: str = "test model",
    utf8: bool = False,
    index_size: int = 2,
) -> bytes:
    """A minimal PMX 2.0 file: one vertex, one face, one material, then bones and morphs."""
    encoding = "utf-8" if utf8 else "utf-16-le"
    index = {1: "b", 2: "h", 4: "i"}[index_size]
    order = [b["name"] for b in bones]

    def text(value: str) -> bytes:
        raw = value.encode(encoding)
        return struct.pack("<i", len(raw)) + raw

    def ref(bone: str | None) -> bytes:
        return struct.pack("<" + index, order.index(bone) if bone is not None else -1)

    out = [b"PMX ", struct.pack("<f", 2.0), bytes([8, 1 if utf8 else 0, 0])]
    out.append(bytes([index_size] * 6))  # vertex, texture, material, bone, morph, rigid body
    out += [text(name), text(""), text(""), text("")]
    # One BDEF1 vertex, one triangle, one texture and one material to skip over.
    out += [struct.pack("<i", 1), struct.pack("<8f", *[0.0] * 8), b"\x00", ref(None)]
    out.append(struct.pack("<f", 1.0))
    out += [struct.pack("<i", 3), struct.pack("<" + index.upper() * 3, 0, 0, 0)]
    out += [struct.pack("<i", 1), text("tex.png")]
    out += [struct.pack("<i", 1), text("material"), text("")]
    out.append(struct.pack("<11f", *[0.0] * 11) + b"\x00" + struct.pack("<5f", *[0.0] * 5))
    out.append(struct.pack("<" + index * 2, 0, -1) + b"\x00\x01\x00")  # shared toon 0
    out += [text("memo"), struct.pack("<i", 3)]

    out.append(struct.pack("<i", len(bones)))
    for bone in bones:
        flags = 0x0002 | 0x0004  # rotatable, movable; tail given as an offset
        if bone["inherit"]:
            flags |= 0x0100
        if bone["ik"]:
            flags |= 0x0020
        out += [text(bone["name"]), text(""), struct.pack("<3f", *bone["position"])]
        out += [ref(bone["parent"]), struct.pack("<i", 0), struct.pack("<H", flags)]
        out.append(struct.pack("<3f", 0.0, 1.0, 0.0))
        if bone["inherit"]:
            out += [ref(bone["inherit"][0]), struct.pack("<f", bone["inherit"][1])]
        if bone["ik"]:
            target, iterations, limit, links = bone["ik"]
            out += [ref(target), struct.pack("<if", iterations, limit)]
            out.append(struct.pack("<i", len(links)))
            for link, limits in links:
                out += [ref(link), bytes([1 if limits else 0])]
                if limits:
                    out.append(struct.pack("<6f", *limits[0], *limits[1]))

    out.append(struct.pack("<i", len(morphs)))
    for morph, panel in morphs:  # vertex morphs with one offset each
        out += [text(morph), text(""), bytes([panel, 1]), struct.pack("<i", 1)]
        out.append(struct.pack("<" + index.upper(), 0) + struct.pack("<3f", 0.0, 0.1, 0.0))
    out.append(struct.pack("<i", 0))  # display frames: never read
    return b"".join(out)
