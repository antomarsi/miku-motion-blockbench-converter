"""Read the bone hierarchy of a Blockbench project (.bbmodel).

Only the skeleton is read: group names, parents, pivots (``origin``) and rest rotations.
Two layouts exist:

- Blockbench 4.x: groups are nested objects inside ``outliner`` (``name``, ``origin``,
  ``rotation``, ``children``); cubes appear as uuid strings.
- Blockbench 5.x: groups live in a top-level ``groups`` array; ``outliner`` holds
  ``{"uuid", "children"}`` references to them, and cube uuids as strings.

Group rotations are ZYX Euler degrees in Blockbench's own (canonical) space.
"""

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from miku_motion.animation.skeleton import Bone, Skeleton, make_bone
from miku_motion.errors import TargetModelError
from miku_motion.geometry.quat import FloatArray

GECKOLIB_FORMATS = frozenset({"geckolib_model", "animated_entity_model"})


@dataclass(frozen=True, slots=True)
class BlockbenchModel:
    name: str
    format_version: str
    model_format: str
    skeleton: Skeleton

    @property
    def is_geckolib(self) -> bool:
        return self.model_format in GECKOLIB_FORMATS


def _vector(value: Any, what: str, path: Path) -> tuple[float, float, float]:
    if value is None:
        return (0.0, 0.0, 0.0)
    try:
        x, y, z = (float(v) for v in value)
    except (TypeError, ValueError) as exc:
        raise TargetModelError(f"{what} must be three numbers, got {value!r}", path=path) from exc
    return (x, y, z)


def parse_bbmodel(data: dict[str, Any], path: Path) -> BlockbenchModel:
    meta = data.get("meta")
    if not isinstance(meta, dict) or "outliner" not in data:
        raise TargetModelError(
            "not a Blockbench project (missing 'meta' or 'outliner')",
            path=path,
            hint="pass the .bbmodel file saved by Blockbench (File > Save Project)",
        )
    groups_by_uuid: dict[str, dict[str, Any]] = {
        g["uuid"]: g for g in data.get("groups", []) if isinstance(g, dict) and "uuid" in g
    }
    cubes: dict[str, tuple[tuple[float, ...], tuple[float, ...]]] = {
        e["uuid"]: (tuple(e["from"]), tuple(e["to"]))
        for e in data.get("elements", [])
        if isinstance(e, dict)
        and "uuid" in e
        and len(e.get("from", ())) == 3
        and len(e.get("to", ())) == 3
    }
    bones: list[Bone] = []

    def extent(children: list[Any]) -> FloatArray | None:
        """Bounding box of the cubes directly inside a group (cube rotation ignored)."""
        corners = [np.array(c, dtype=float) for u in children if u in cubes for c in cubes[u]]
        if not corners:
            return None
        points = np.stack(corners)
        return np.stack([points.min(axis=0), points.max(axis=0)])

    def visit(node: Any, parent: str | None) -> None:
        if isinstance(node, str):  # a cube (or other element) reference
            return
        if not isinstance(node, dict):
            raise TargetModelError(f"unexpected outliner entry {node!r}", path=path)
        group = groups_by_uuid.get(node.get("uuid", ""), node)
        if "name" not in group:  # 5.x reference to a group that doesn't exist
            raise TargetModelError(
                f"outliner references unknown group uuid {node.get('uuid')!r}", path=path
            )
        name = str(group["name"])
        what = f"group {name!r}"
        bones.append(
            make_bone(
                name,
                parent,
                _vector(group.get("origin"), f"{what} origin", path),
                _vector(group.get("rotation"), f"{what} rotation", path),
                extent([c for c in node.get("children", []) if isinstance(c, str)]),
            )
        )
        for child in node.get("children", []):
            visit(child, name)

    for root in data["outliner"]:
        visit(root, None)

    if not bones:
        raise TargetModelError(
            "the model has no groups (bones) to animate",
            path=path,
            hint="animations target groups; put cubes inside named groups in Blockbench",
        )
    counts = Counter(b.name for b in bones)
    duplicates = sorted(name for name, n in counts.items() if n > 1)
    if duplicates:
        raise TargetModelError(
            f"group names must be unique, but these appear more than once: {duplicates}",
            path=path,
            hint="GeckoLib addresses bones by name; rename the duplicates in Blockbench",
        )

    return BlockbenchModel(
        name=str(data.get("name") or path.stem),
        format_version=str(meta.get("format_version", "?")),
        model_format=str(meta.get("model_format", "?")),
        skeleton=Skeleton(tuple(bones)),
    )


def read_bbmodel(path: Path | str) -> BlockbenchModel:
    file_path = Path(path)
    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise TargetModelError(f"cannot read file: {exc.strerror}", path=file_path) from exc
    except json.JSONDecodeError as exc:
        raise TargetModelError(
            f"not valid JSON (line {exc.lineno}, column {exc.colno}): {exc.msg}", path=file_path
        ) from exc
    if not isinstance(data, dict):
        raise TargetModelError("not a Blockbench project (top level is not an object)", path=path)
    return parse_bbmodel(data, file_path)
