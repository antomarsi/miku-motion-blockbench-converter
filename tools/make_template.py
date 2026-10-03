"""Build the template dancer: templates/template.bbmodel and templates/template_skin.png.

    uv run --with pillow python tools/make_template.py

The template is the standard Minecraft player model (classic 4 px arms) cut into dance
segments, so any Minecraft skin fits it:

- the top 64x64 of the 64x128 skin is exactly the Minecraft skin layout: head, body,
  arms and legs with their hat / jacket / sleeve / pants overlay layers. Paste your own
  skin there.
- every Minecraft box is cut at the joints without moving or resizing anything: body ->
  waist + chest, arm -> upper arm + forearm + hand, leg -> thigh + shin + foot. Each
  piece keeps exactly its slice of the Minecraft texture.
- root > hips (legs, skirt) and root > waist > chest (head, arms, tie): the upper body
  bends at the waist while the hips stay with the legs
- extras use the bottom half of the skin and are hidden by default (a plain Minecraft
  skin looks right): hair styles (twintails, ponytail, long hair, short bob), skirt
  panels, tie and detached sleeve cuffs. The mapping still animates them, so showing
  one in a mod or in Blockbench just works.
- Blockbench IK (tip locators, IK and pole nulls) is added by `prepare-model`'s logic
- two variants: template.bbmodel (classic 4 px arms) and template_slim.bbmodel (slim
  3 px arms, for Alex-style skins); `miku-motion apply-skin` picks the right one

The default skin is painted in a pastel style with 1 px outlines.
"""

import base64
import io
import json
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from miku_motion.model import document as document_module
from miku_motion.model.document import BbmodelDocument
from miku_motion.model.prepare import PrepareOptions, prepare

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "templates"
NEWLINE = chr(10)
VARIANTS = (("template", 4), ("template_slim", 3))  # (file name, arm width in px)
WIDTH, HEIGHT = 64, 128  # top 64x64: Minecraft skin; bottom: extras
EXTRAS_TOP = 64

type Vec = tuple[float, float, float]
type RGB = tuple[int, int, int]
type Rect = tuple[float, float, float, float]

MATERIALS: dict[str, tuple[RGB, RGB]] = {  # fill, outline
    "skin": ((255, 226, 208), (222, 170, 146)),
    "shirt": ((236, 240, 244), (172, 182, 196)),
    "dark": ((74, 78, 92), (40, 42, 52)),
    "teal": ((110, 218, 214), (48, 158, 166)),
    "hair": ((126, 226, 218), (58, 168, 172)),
}
PINK: RGB = (255, 140, 170)
EYE_WHITE: RGB = (250, 252, 255)
EYE: RGB = (40, 150, 170)
MOUTH: RGB = (214, 130, 120)


# --- UV layout ------------------------------------------------------------------------------


def box_faces(u: float, v: float, w: float, h: float, d: float) -> dict[str, list[float]]:
    """Face UVs of a box at ``(u, v)``, exactly as Blockbench computes Minecraft box UV."""
    return {
        "north": [u + d, v + d, u + d + w, v + d + h],
        "east": [u, v + d, u + d, v + d + h],
        "south": [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
        "west": [u + d + w, v + d, u + 2 * d + w, v + d + h],
        "up": [u + d + w, v + d, u + d, v],
        "down": [u + d + 2 * w, v, u + d + w, v + d],
    }


def slice_faces(
    faces: dict[str, list[float]], top: float, bottom: float, height: float, first: bool, last: bool
) -> dict[str, list[float]]:
    """The faces of a horizontal slice (``top``..``bottom`` measured down from the box's top).

    Side faces take the matching rows; the top slice keeps the box's top face, the
    bottom slice its bottom face, and cut faces reuse them (hidden inside the joint).
    """
    out = {}
    for name in ("north", "east", "south", "west"):
        u1, v1, u2, v2 = faces[name]
        out[name] = [u1, v1 + (v2 - v1) * top / height, u2, v1 + (v2 - v1) * bottom / height]
    out["up"] = list(faces["up"])
    out["down"] = list(faces["down"])
    if not first:
        out["up"] = list(faces["up"])  # cut face
    if not last:
        out["down"] = list(faces["down"])  # cut face
    return out


# --- model description ------------------------------------------------------------------------


@dataclass
class Cube:
    name: str
    start: Vec
    end: Vec
    faces: dict[str, list[float]]
    inflate: float = 0.0


@dataclass
class Part:
    name: str
    parent: str | None
    pivot: Vec
    cubes: list[Cube] = field(default_factory=list)
    hidden: bool = False
    color: int = 0


@dataclass
class McBox:
    """A Minecraft player box and its overlay layer, cut into segments at given heights."""

    start: Vec
    end: Vec
    base_uv: tuple[int, int]
    overlay_uv: tuple[int, int]
    overlay_inflate: float
    segments: list[tuple[str, float]]  # (bone name, bottom y), top to bottom


def cut_box(box: McBox, label: str) -> dict[str, list[Cube]]:
    w, h, d = (box.end[i] - box.start[i] for i in range(3))
    cubes: dict[str, list[Cube]] = {}
    top_y = box.end[1]
    for index, (bone, bottom_y) in enumerate(box.segments):
        first, last = index == 0, index == len(box.segments) - 1
        rows = (box.end[1] - top_y, box.end[1] - bottom_y)
        start = (box.start[0], bottom_y, box.start[2])
        end = (box.end[0], top_y, box.end[2])
        for layer, uv, inflate in (
            ("", box.base_uv, 0.0),
            (" layer", box.overlay_uv, box.overlay_inflate),
        ):
            faces = slice_faces(box_faces(*uv, w, h, d), *rows, h, first, last)
            cubes.setdefault(bone, []).append(Cube(f"{label}{layer}", start, end, faces, inflate))
        top_y = bottom_y
    return cubes


def mirror_x(v: Vec) -> Vec:
    return (-v[0], v[1], v[2])


def player_parts(arm: int = 4) -> list[Part]:
    """The Minecraft player cut into dance segments (classic 4 px arms, or slim 3 px)."""
    centre = 4 + arm / 2  # x of the arm's middle
    boxes = {
        "head": McBox((-4, 24, -4), (4, 32, 4), (0, 0), (32, 0), 0.5, [("head", 24)]),
        "body": McBox(
            (-4, 12, -2), (4, 24, 2), (16, 16), (16, 32), 0.25, [("chest", 18), ("waist", 12)]
        ),
        # Minecraft's "right" limbs are the model's right: +X (the model faces -Z).
        "arm_right": McBox(
            (4, 12, -2),
            (4 + arm, 24, 2),
            (40, 16),
            (40, 32),
            0.25,
            [("arm_right", 18), ("forearm_right", 14), ("hand_right", 12)],
        ),
        "arm_left": McBox(
            (-4 - arm, 12, -2),
            (-4, 24, 2),
            (32, 48),
            (48, 48),
            0.25,
            [("arm_left", 18), ("forearm_left", 14), ("hand_left", 12)],
        ),
        "leg_right": McBox(
            (-0.1, 0, -2),
            (3.9, 12, 2),
            (0, 16),
            (0, 32),
            0.25,
            [("leg_right", 6), ("shin_right", 2), ("foot_right", 0)],
        ),
        "leg_left": McBox(
            (-3.9, 0, -2),
            (0.1, 12, 2),
            (16, 48),
            (0, 48),
            0.25,
            [("leg_left", 6), ("shin_left", 2), ("foot_left", 0)],
        ),
    }
    cubes: dict[str, list[Cube]] = {}
    for label, box in boxes.items():
        for bone, bone_cubes in cut_box(box, label).items():
            cubes.setdefault(bone, []).extend(bone_cubes)
    body, limb, head = 1, 2, 4
    return [
        Part("root", None, (0, 0, 0)),
        Part("hips", "root", (0, 12, 0), color=body),
        Part("leg_left", "hips", (-1.9, 12, 0), cubes["leg_left"], color=3),
        Part("shin_left", "leg_left", (-1.9, 6, 0), cubes["shin_left"], color=3),
        Part("foot_left", "shin_left", (-1.9, 2, 0), cubes["foot_left"], color=3),
        Part("leg_right", "hips", (1.9, 12, 0), cubes["leg_right"], color=3),
        Part("shin_right", "leg_right", (1.9, 6, 0), cubes["shin_right"], color=3),
        Part("foot_right", "shin_right", (1.9, 2, 0), cubes["foot_right"], color=3),
        Part("waist", "root", (0, 12, 0), cubes["waist"], color=body),
        Part("chest", "waist", (0, 18, 0), cubes["chest"], color=body),
        Part("head", "chest", (0, 24, 0), cubes["head"], color=head),
        Part("arm_left", "chest", (-5, 22, 0), cubes["arm_left"], color=limb),
        Part("forearm_left", "arm_left", (-centre, 18, 0), cubes["forearm_left"], color=limb),
        Part("hand_left", "forearm_left", (-centre, 14, 0), cubes["hand_left"], color=limb),
        Part("arm_right", "chest", (5, 22, 0), cubes["arm_right"], color=limb),
        Part("forearm_right", "arm_right", (centre, 18, 0), cubes["forearm_right"], color=limb),
        Part("hand_right", "forearm_right", (centre, 14, 0), cubes["hand_right"], color=limb),
    ]


@dataclass
class Extra:
    """An optional piece textured from the bottom half of the skin."""

    bone: str
    parent: str
    pivot: Vec
    start: Vec
    end: Vec
    material: str
    details: str = ""


def extras() -> list[Extra]:
    left = [
        Extra(
            "twintail_left",
            "twintails",
            (-4.5, 30, 2.5),
            (-7, 23, 1),
            (-4, 31, 4),
            "hair",
            "tie_ring",
        ),
        Extra(
            "twintail_left_mid",
            "twintail_left",
            (-5.5, 23, 2.5),
            (-7.5, 15, 1),
            (-4.5, 23, 4),
            "hair",
        ),
        Extra(
            "twintail_left_end",
            "twintail_left_mid",
            (-6, 15, 2.5),
            (-7.5, 9, 1.5),
            (-5, 15, 3.5),
            "hair",
        ),
        Extra(
            "short_hair_left", "short_hair", (-4.25, 28, 0), (-4.75, 23, -3), (-4, 28, 4), "hair"
        ),
        Extra("skirt_left", "hips", (-4, 13, 0), (-4.5, 7, -2), (-4, 13, 2), "dark", "trim"),
        Extra(
            "sleeve_left",
            "forearm_left",
            (-6, 16, 0),
            (-8.5, 11, -2.5),
            (-3.5, 16, 2.5),
            "dark",
            "trim",
        ),
    ]
    right = [
        Extra(
            e.bone.replace("left", "right"),
            e.parent.replace("left", "right"),
            mirror_x(e.pivot),
            (-e.end[0], e.start[1], e.start[2]),
            (-e.start[0], e.end[1], e.end[2]),
            e.material,
            e.details,
        )
        for e in left
    ]
    return [
        *left,
        *right,
        Extra(
            "ponytail_top",
            "ponytail",
            (0, 29, 5.5),
            (-1.5, 23, 5),
            (1.5, 30, 8),
            "hair",
            "tie_ring",
        ),
        Extra("ponytail_mid", "ponytail_top", (0, 23, 6.5), (-1.5, 16, 5), (1.5, 23, 8), "hair"),
        Extra("ponytail_end", "ponytail_mid", (0, 16, 6.5), (-1, 11, 5.5), (1, 16, 7.5), "hair"),
        Extra("long_hair_top", "long_hair", (0, 26, 5), (-4.5, 18, 4.5), (4.5, 26, 5.5), "hair"),
        Extra(
            "long_hair_end", "long_hair_top", (0, 18, 5), (-4.5, 11, 4.5), (4.5, 18, 5.5), "hair"
        ),
        Extra(
            "short_hair_back", "short_hair", (0, 27, 4.75), (-4.5, 23, 4.5), (4.5, 27, 5.25), "hair"
        ),
        Extra("skirt_front", "hips", (0, 13, -2), (-4.5, 7, -2.5), (4.5, 13, -2), "dark", "trim"),
        Extra("skirt_back", "hips", (0, 13, 2), (-4.5, 7, 2), (4.5, 13, 2.5), "dark", "trim"),
        Extra("tie", "chest", (0, 23, -2.25), (-1, 19, -2.5), (1, 23, -2), "teal"),
        Extra("tie_end", "tie", (0, 19, -2.25), (-1, 15, -2.5), (1, 19, -2), "teal"),
    ]


EXTRA_GROUPS = [  # cube-less groups that organise the hair styles
    ("hair", "head", (0, 28, 0)),
    ("twintails", "hair", (0, 30, 2.5)),
    ("ponytail", "hair", (0, 29, 4.5)),
    ("long_hair", "hair", (0, 26, 4.75)),
    ("short_hair", "hair", (0, 28, 0)),
]


def pixel_size(e: Extra) -> tuple[int, int, int]:
    return tuple(max(1, round(e.end[i] - e.start[i] + 0.49)) for i in range(3))  # type: ignore[return-value]


def pack_extras(items: list[Extra]) -> dict[str, tuple[int, int]]:
    """Shelf-pack the extras' box nets into the bottom half of the skin."""
    order = sorted(items, key=lambda e: (-(pixel_size(e)[2] + pixel_size(e)[1]), e.bone))
    origins: dict[str, tuple[int, int]] = {}
    x, y, shelf = 0, EXTRAS_TOP, 0
    for item in order:
        w, h, d = pixel_size(item)
        width, height = 2 * d + 2 * w, d + h
        if x + width > WIDTH:
            x, y, shelf = 0, y + shelf, 0
        if y + height > HEIGHT:
            raise SystemExit("the extras don't fit in the bottom half of the skin")
        origins[item.bone] = (x, y)
        x += width
        shelf = max(shelf, height)
    return origins


# --- painting ----------------------------------------------------------------------------------


def _rect(uv: list[float]) -> tuple[int, int, int, int]:
    u1, v1, u2, v2 = uv
    return int(min(u1, u2)), int(min(v1, v2)), int(max(u1, u2)), int(max(v1, v2))


def fill(
    image: Image.Image, uv: list[float], material: str, outline: bool = True
) -> tuple[int, int, int, int]:
    px = image.load()
    body, edge = MATERIALS[material]
    x0, y0, x1, y1 = _rect(uv)
    for yy in range(y0, y1):
        for xx in range(x0, x1):
            border = outline and (
                (x1 - x0 >= 3 and xx in (x0, x1 - 1)) or (y1 - y0 >= 3 and yy in (y0, y1 - 1))
            )
            px[xx, yy] = (*(edge if border else body), 255)
    return x0, y0, x1, y1


def row(image: Image.Image, x0: int, x1: int, y: int, color: RGB) -> None:
    px = image.load()
    for xx in range(x0, x1):
        px[xx, y] = (*color, 255)


def paint_player(image: Image.Image, arm: int = 4) -> None:
    """The default character on the Minecraft layout (base layer + overlay layer)."""
    head = box_faces(0, 0, 8, 8, 8)
    for name, uv in head.items():
        fill(image, uv, "hair" if name in ("up", "south") else "skin")
    for name in ("east", "west"):  # hair on the upper half of the sides
        x0, y0, x1, _ = _rect(head[name])
        for yy in range(y0, y0 + 4):
            row(image, x0, x1, yy, MATERIALS["hair"][0])
    x0, y0, x1, _ = _rect(head["north"])  # face: bangs, eyes, mouth
    for yy in (y0, y0 + 1):
        row(image, x0, x1, yy, MATERIALS["hair"][0])
    px = image.load()
    for ex in (x0 + 1, x1 - 3):
        px[ex, y0 + 4] = (*EYE_WHITE, 255)
        px[ex + 1, y0 + 4] = (*EYE, 255)
        px[ex, y0 + 5] = (*EYE, 255)
        px[ex + 1, y0 + 5] = (*EYE, 255)
    px[x0 + 3, y0 + 6] = (*MOUTH, 255)
    px[x0 + 4, y0 + 6] = (*MOUTH, 255)

    # Hat layer (the head's overlay): hair volume over the base head. Top and back are
    # full; the sides cover the upper part; the front has bangs and side locks that
    # frame the face, which stays clear.
    hat = box_faces(32, 0, 8, 8, 8)
    for name in ("up", "south"):
        fill(image, hat[name], "hair")
    for name in ("east", "west"):
        x0, y0, x1, y1 = _rect(hat[name])
        fill(image, [x0, y0, x1, y0 + 6], "hair")
        row(image, x0 + 1, x1 - 1, y0 + 6, MATERIALS["hair"][1])  # ragged ends
    x0, y0, x1, y1 = _rect(hat["north"])
    fill(image, [x0, y0, x1, y0 + 3], "hair")
    for xx in (x0, x1 - 1):  # side locks down to the cheeks
        for yy in range(y0 + 3, y0 + 7):
            px[xx, yy] = (*MATERIALS["hair"][1], 255)
    for xx in (x0 + 2, x0 + 5):  # a few strands below the bangs
        px[xx, y0 + 3] = (*MATERIALS["hair"][0], 255)

    body = box_faces(16, 16, 8, 12, 4)
    for name, uv in body.items():
        x0, y0, x1, y1 = fill(image, uv, "shirt")
        if name in ("north", "east", "south", "west"):
            for yy in range(y1 - 3, y1):  # skirt waistband on the hips
                row(image, x0, x1, yy, MATERIALS["dark"][0])
            row(image, x0, x1, y1 - 1, MATERIALS["teal"][0])
        if name == "north":  # tie
            mid = (x0 + x1) // 2
            for yy in range(y0, y1 - 3):
                row(image, mid - 1, mid + 1, yy, MATERIALS["teal"][0])

    for u, v in ((40, 16), (32, 48)):  # arms: skin, dark sleeve on the forearm, skin hand
        for name, uv in box_faces(u, v, arm, 12, 4).items():
            x0, y0, x1, y1 = fill(image, uv, "skin")
            if name in ("north", "east", "south", "west"):
                for yy in range(y0 + 6, y0 + 10):
                    row(image, x0, x1, yy, MATERIALS["dark"][0])
                row(image, x0, x1, y0 + 9, MATERIALS["teal"][0])

    for u, v in ((0, 16), (16, 48)):  # legs: skirt edge, skin, boots
        for name, uv in box_faces(u, v, 4, 12, 4).items():
            x0, y0, x1, y1 = fill(image, uv, "dark" if name == "down" else "skin")
            if name in ("north", "east", "south", "west"):
                row(image, x0, x1, y0, MATERIALS["dark"][0])
                for yy in range(y0 + 6, y1):
                    row(image, x0, x1, yy, MATERIALS["dark"][0])
                row(image, x0, x1, y0 + 6, MATERIALS["teal"][0])

    for u, v in ((0, 32), (0, 48)):  # pants layer: a short skirt over the thighs
        for name, uv in box_faces(u, v, 4, 12, 4).items():
            if name in ("north", "east", "south", "west"):
                x0, y0, x1, _ = _rect(uv)
                for yy in range(y0, y0 + 3):
                    row(image, x0, x1, yy, MATERIALS["dark"][0])
                row(image, x0, x1, y0 + 3, MATERIALS["teal"][0])


def paint_extra(image: Image.Image, item: Extra, faces: dict[str, list[float]]) -> None:
    for name, uv in faces.items():
        x0, y0, x1, y1 = fill(image, uv, item.material)
        if name in ("up", "down"):
            continue
        if item.details == "trim":
            row(image, x0, x1, y1 - 1, MATERIALS["teal"][0])
        if item.details == "tie_ring" and y1 - y0 > 2:
            row(image, x0, x1, y0 + 1, PINK)


# --- bbmodel ------------------------------------------------------------------------------------


def _ids() -> Iterator[int]:
    i = 0
    while True:
        i += 1
        yield i


_counter = _ids()


def uid() -> str:
    """Deterministic ids, so regenerating the template gives the same file."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"miku-motion-template/{next(_counter)}"))


def build(name: str = "template", arm: int = 4) -> tuple[dict, Image.Image]:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    paint_player(image, arm)
    parts = player_parts(arm)
    hidden_bones = {name for name, _, _ in EXTRA_GROUPS if name != "hair"} | {"hair"}
    parts += [
        Part(name, parent, pivot, hidden=True, color=5) for name, parent, pivot in EXTRA_GROUPS
    ]
    items = extras()
    origins = pack_extras(items)
    for item in items:
        faces = box_faces(*origins[item.bone], *pixel_size(item))
        paint_extra(image, item, faces)
        color = 5 if item.material == "hair" else 6
        parts.append(
            Part(
                item.bone,
                item.parent,
                item.pivot,
                [Cube(item.bone, item.start, item.end, faces)],
                hidden=True,
                color=color,
            )
        )
    del hidden_bones

    elements, groups, nodes = [], [], {}
    for part in parts:
        group_id = uid()
        groups.append(
            {
                "name": part.name,
                "origin": list(part.pivot),
                "color": part.color,
                "uuid": group_id,
                "export": True,
                "mirror_uv": False,
                "isOpen": not part.hidden,
                "locked": False,
                "visibility": not part.hidden,
                "autouv": 0,
                "selected": False,
                "rotation": [0, 0, 0],
            }
        )
        node = {"uuid": group_id, "isOpen": not part.hidden, "children": []}
        nodes[part.name] = node
        for cube in part.cubes:
            element_id = uid()
            element = {
                "name": cube.name,
                "box_uv": False,
                "render_order": "default",
                "locked": False,
                "allow_mirror_modeling": True,
                "from": list(cube.start),
                "to": list(cube.end),
                "autouv": 0,
                "color": part.color,
                "origin": list(part.pivot),
                "faces": {f: {"uv": uv, "texture": 0} for f, uv in cube.faces.items()},
                "type": "cube",
                "uuid": element_id,
                "visibility": not part.hidden,
            }
            if cube.inflate:
                element["inflate"] = cube.inflate
            elements.append(element)
            node["children"].append(element_id)
        if part.parent is not None:
            nodes[part.parent]["children"].append(node)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    source = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    document = {
        "meta": {"format_version": "5.0", "model_format": "geckolib_model", "box_uv": False},
        "name": name,
        "model_identifier": "",
        "visible_box": [1, 2.5, 0.75],
        "variable_placeholders": "",
        "variable_placeholder_buttons": [],
        "timeline_setups": [],
        "unhandled_root_fields": {},
        "geckolib_modid": "template",
        "geckolib_model_type": "Entity",
        "resolution": {"width": WIDTH, "height": HEIGHT},
        "elements": elements,
        "groups": groups,
        "outliner": [nodes["root"]],
        "textures": [
            {
                "path": "",
                "name": f"{name}_skin.png",
                "folder": "",
                "namespace": "",
                "id": "0",
                "group": "",
                "width": WIDTH,
                "height": HEIGHT,
                "uv_width": WIDTH,
                "uv_height": HEIGHT,
                "particle": False,
                "use_as_default": False,
                "layers_enabled": False,
                "sync_to_project": "",
                "render_mode": "default",
                "render_sides": "auto",
                "pbr_channel": "color",
                "frame_time": 1,
                "frame_order_type": "loop",
                "frame_order": "",
                "frame_interpolate": False,
                "visible": True,
                "internal": True,
                "saved": True,
                "uuid": uid(),
                "relative_path": f"{name}_skin.png",
                "source": source,
            }
        ],
    }
    return document, image


def main() -> None:
    global _counter
    OUT_DIR.mkdir(exist_ok=True)
    for name, arm in VARIANTS:
        _counter = _ids()  # each file's ids start fresh, so each is reproducible alone
        document, image = build(name, arm)
        doc = BbmodelDocument(document)
        document_module.new_uuid = uid  # deterministic ids for the IK nulls too
        model, skin = OUT_DIR / f"{name}.bbmodel", OUT_DIR / f"{name}_skin.png"
        findings, final = prepare(doc, model, PrepareOptions(split_limbs=False))
        for finding in findings:
            if not finding.fixed:
                print("to do: " + finding.message)
        image.save(skin)
        text = json.dumps(doc.data, ensure_ascii=False, indent=1) + NEWLINE
        model.write_text(text, encoding="utf-8", newline=NEWLINE)  # LF on every OS
        parts = ", ".join(f"{r}={b}" for r, b in final.roles.by_role().items())
        print(f"wrote {model.name} and {skin.name} ({arm} px arms): {parts}")


if __name__ == "__main__":
    main()
