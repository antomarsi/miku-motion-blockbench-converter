"""Generate a starter mapping from a model's detected body parts.

Each target bone's ``from`` chain is the path, in the standard MMD bone tree
(``data/mmd_roles.json``), from its nearest mapped ancestor's source bone to its own.
Going *up* the tree emits inverses, so e.g. legs parented to the torso get the upper
body's rotation cancelled; MMD's waist-cancel node becomes the waist bone with weight -1.
"""

import json
import math
import re
from importlib import resources
from typing import Any

import numpy as np

from miku_motion.animation.skeleton import Skeleton
from miku_motion.geometry import euler, quat
from miku_motion.geometry.quat import FloatArray
from miku_motion.mapping.secondary import Suggestion, geometry_tip
from miku_motion.model.roles import Roles

MMD_HEIGHT = 20.0  # MMD units from feet to the top of a standard model's head
MIN_CORRECTION_DEGREES = 1.0


def _data() -> dict[str, Any]:
    text = (resources.files("miku_motion.data") / "mmd_roles.json").read_text("utf-8")
    result: dict[str, Any] = json.loads(text)
    return result


def _lineage(tree: dict[str, str | None], bone: str) -> list[str]:
    """``bone`` and its ancestors, nearest first."""
    out = [bone]
    while (parent := tree[out[-1]]) is not None:
        out.append(parent)
    return out


def _link(node: str, inverse: dict[str, str], weight: float) -> str | dict[str, Any]:
    if node in inverse:  # a cancel node is the inverse of another bone's rotation
        node, weight = inverse[node], -weight
    return node if weight == 1 else {"bone": node, "weight": weight}


def source_path(
    tree: dict[str, str | None], inverse: dict[str, str], start: str | None, end: str
) -> list[str | dict[str, Any]]:
    """Chain from ``start`` (exclusive; ``None`` = the tree root) down to ``end``."""
    down = _lineage(tree, end)
    if start is None:
        return [_link(n, inverse, 1) for n in reversed(down)]
    up = _lineage(tree, start)
    common = next(n for n in up if n in down)
    ups = up[: up.index(common)]  # start ... child of the common ancestor
    downs = list(reversed(down[: down.index(common)]))  # below the common ancestor ... end
    return [_link(n, inverse, -1) for n in ups] + [_link(n, inverse, 1) for n in downs]


def _arm_correction(
    skeleton: Skeleton, segments: list[str], side: str, a_pose: float
) -> list[float] | None:
    """Euler degrees turning the target arm's rest direction onto MMD's A-pose."""
    first, last = skeleton[segments[0]], skeleton[segments[-1]]
    tip = geometry_tip(last, first.pivot)
    if tip is None:
        return None
    target = tip - first.pivot
    if np.linalg.norm(target) < 1e-6:
        return None
    angle = math.radians(a_pose)
    sign = -1.0 if side == "left" else 1.0  # canonical: the model's left is -X
    mmd = np.array([sign * math.cos(angle), -math.sin(angle), 0.0])
    correction = _shortest_arc(target / np.linalg.norm(target), mmd)
    if math.degrees(float(quat.angle(correction))) < MIN_CORRECTION_DEGREES:
        return None
    return [round(float(v), 1) + 0.0 for v in np.degrees(euler.from_quat(correction))]


def _shortest_arc(u: FloatArray, v: FloatArray) -> FloatArray:
    axis = np.cross(u, v)
    q = np.concatenate([axis, [1.0 + float(np.dot(u, v))]])
    return quat.normalize(q)


def generate_mapping(
    skeleton: Skeleton, roles: Roles, suggestions: list[Suggestion], name: str
) -> dict[str, Any]:
    data = _data()
    tree: dict[str, str | None] = data["tree"]
    inverse: dict[str, str] = data["inverse"]
    role_specs: dict[str, dict[str, Any]] = data["roles"]
    by_role = roles.by_role()
    role_of = {bone: role for role, bone in by_role.items()}
    sources = {bone: role_specs[role]["source"] for bone, role in role_of.items()}

    bones: dict[str, Any] = {}
    paths: dict[str, list[str | dict[str, Any]]] = {}
    for bone in skeleton:
        if bone.name not in role_of:
            continue
        anchor = next((a.name for a in skeleton.ancestors(bone.name) if a.name in role_of), None)
        paths[bone.name] = source_path(
            tree, inverse, sources.get(anchor) if anchor else None, sources[bone.name]
        )
    on_paths = {
        link if isinstance(link, str) else link["bone"] for p in paths.values() for link in p
    }

    for bone_name, path in paths.items():
        spec = role_specs[role_of[bone_name]]
        chain = path + [b for b in spec.get("absorb", []) if b not in on_paths]
        entry: dict[str, Any] = {"from": chain}
        if spec.get("translation"):
            entry["translation"] = True
        rest = spec.get("rest")
        if rest:
            side = rest.removeprefix("arm_")
            correction = _arm_correction(skeleton, roles.arms[side], side, data["a_pose_degrees"])
            if correction:
                entry["rest_correction"] = {"euler_deg": correction}
        bones[bone_name] = (
            entry["from"][0] if list(entry) == ["from"] and len(chain) == 1 else entry
        )

    solid = [b.extent for b in skeleton if b.extent is not None]
    ground = min(float(e[0][1]) for e in solid)
    head = skeleton[roles.head].extent if roles.head else None
    top = float(head[1][1]) if head is not None else max(float(e[1][1]) for e in solid)
    height = top - ground  # feet to the top of the head (hair excluded)
    return {
        "schema_version": 1,
        "name": f"MMD standard bones -> {name}",
        "description": "Generated by `miku-motion init-mapping`; review and adjust.",
        "units": {"translation_scale": round(height / MMD_HEIGHT, 3)},
        "unmapped": "warn",
        "ignore": data["ignore"],
        "bones": bones,
        "secondary_motion": [{"bones": list(s.bones), "preset": s.preset} for s in suggestions],
        "morphs": face_rules(skeleton, roles),
    }


def render_mapping(mapping: dict[str, Any]) -> str:
    """JSON with one bone entry / chain per line (easy to read and edit)."""

    def line(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))

    lists = ("bones", "secondary_motion", "morphs")
    head = {k: v for k, v in mapping.items() if k not in lists}
    lines = ["{"] + [f"  {line(k)}: {line(v)}," for k, v in head.items()]
    bone_lines = [f"    {line(k)}: {line(v)}" for k, v in mapping["bones"].items()]
    lines += ['  "bones": {', ",\n".join(bone_lines), "  },"]
    chain_lines = [f"    {line(c)}" for c in mapping["secondary_motion"]]
    lines += ['  "secondary_motion": [', ",\n".join(chain_lines), "  ],"]
    morph_lines = [f"    {line(r)}" for r in mapping.get("morphs", [])]
    lines += ['  "morphs": [', ",\n".join(morph_lines), "  ]", "}"]
    return "\n".join(lines) + "\n"


# --- face ---------------------------------------------------------------------------------


def _face_data() -> dict[str, Any]:
    text = (resources.files("miku_motion.data") / "face_morphs.json").read_text("utf-8")
    result: dict[str, Any] = json.loads(text)
    return result


def _name_tokens(name: str) -> list[str]:
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", spaced) if t]


def face_rules(skeleton: Skeleton, roles: Roles) -> list[dict[str, Any]]:
    """Morph rules for face bones found inside the head, from their names.

    - eyelids (``eyelid``/``lid``): close with blinks, smiles and their side's wink
    - an eyes group (``eyes``): squashes for blinks; single eyes (``eye``): their wink,
      and blinks too when there's no eyes group
    - mouth shapes (``mouth_a`` .. ``mouth_o``, ``mouth_closed``): swapped by the vowels
    - a single mouth: scaled by each vowel
    Sides come from the bone's pivot (the model's left is -X), not its name.
    """
    if roles.head is None:
        return []
    data = _face_data()
    skip = set(data["skip_tokens"])
    head_parts = [b for b in skeleton if roles.head in {a.name for a in skeleton.ancestors(b.name)}]
    closed: list[str] = data["eyes_closed"]
    vowels: dict[str, list[str]] = data["vowels"]
    threshold = data["swap_threshold"]

    def side(name: str) -> str:
        return "left" if skeleton[name].pivot[0] < 0 else "right"

    eyelids: list[str] = []
    eye_groups: list[str] = []
    eyes: list[str] = []
    mouth_shapes: dict[str, str] = {}
    mouths: list[str] = []
    for bone in head_parts:
        tokens = _name_tokens(bone.name)
        if skip & set(tokens):
            continue
        if "eyelid" in tokens or "lid" in tokens:
            eyelids.append(bone.name)
        elif "eyes" in tokens:
            eye_groups.append(bone.name)
        elif "eye" in tokens:
            eyes.append(bone.name)
        elif "mouth" in tokens:
            shape = next((t for t in tokens if t in vowels or t in ("closed", "close")), None)
            if shape:
                mouth_shapes[bone.name] = "closed" if shape.startswith("clos") else shape
            else:
                mouths.append(bone.name)

    rules: list[dict[str, Any]] = []
    for name in eyelids:
        morphs = closed + data[f"wink_{side(name)}"]
        rules.append({"morph": morphs, "bone": name, "scale_from": [1, 0, 1], "scale": [1, 1, 1]})
    for name in eye_groups:
        rules.append({"morph": closed, "bone": name, "scale": data["eye_squash"]})
    for name in eyes:
        morphs = data[f"wink_{side(name)}"] + ([] if eye_groups else closed)
        rules.append({"morph": morphs, "bone": name, "scale": data["eye_squash"]})
    all_vowels = [m for names in vowels.values() for m in names]
    for name, shape in mouth_shapes.items():
        if shape == "closed":
            rules.append({"morph": all_vowels, "bone": name, "hide_above": threshold})
        else:
            rules.append({"morph": vowels[shape], "bone": name, "show_above": threshold})
    if not mouth_shapes:
        for name in mouths:
            for vowel, scale in data["mouth_scale"].items():
                rules.append({"morph": vowels[vowel], "bone": name, "scale": scale})
    return [{**r, "morph": r["morph"][0] if len(r["morph"]) == 1 else r["morph"]} for r in rules]
