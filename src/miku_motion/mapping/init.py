"""Generate a starter mapping from a model's detected body parts.

Each target bone's ``from`` chain is the path, in the standard MMD bone tree
(``data/mmd_roles.json``), from its nearest mapped ancestor's source bone to its own.
Going *up* the tree emits inverses, so e.g. legs parented to the torso get the upper
body's rotation cancelled; MMD's waist-cancel node becomes the waist bone with weight -1.
"""

import json
import math
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
    }


def render_mapping(mapping: dict[str, Any]) -> str:
    """JSON with one bone entry / chain per line (easy to read and edit)."""

    def line(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))

    head = {k: v for k, v in mapping.items() if k not in ("bones", "secondary_motion")}
    lines = ["{"] + [f"  {line(k)}: {line(v)}," for k, v in head.items()]
    bone_lines = [f"    {line(k)}: {line(v)}" for k, v in mapping["bones"].items()]
    lines += ['  "bones": {', ",\n".join(bone_lines), "  },"]
    chain_lines = [f"    {line(c)}" for c in mapping["secondary_motion"]]
    lines += ['  "secondary_motion": [', ",\n".join(chain_lines), "  ]", "}"]
    return "\n".join(lines) + "\n"
