"""Editing a Blockbench project's JSON: bones, pivots, cubes, locators and IK nulls.

Supports both outliner layouts (4.x nested groups, 5.x ``groups[]`` + uuid references).
Only structure and geometry are touched; everything else is kept as Blockbench wrote it.
"""

import copy
import json
import uuid as uuidlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

Node = dict[str, Any]
Vec = list[float]

_SIDE_FACES = ("north", "east", "south", "west")


def new_uuid() -> str:
    return str(uuidlib.uuid4())


class BbmodelDocument:
    def __init__(self, data: dict[str, Any]):
        self.data = data
        self.layout5 = "groups" in data
        self._group_data = {g["uuid"]: g for g in data.get("groups", [])}

    @classmethod
    def load(cls, path: Path) -> "BbmodelDocument":
        return cls(json.loads(path.read_text(encoding="utf-8")))

    def save(self, path: Path) -> None:
        path.write_text(
            json.dumps(self.data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

    # --- lookup -------------------------------------------------------------------------

    def _walk(self, nodes: list[Any], parent: Node | None) -> Iterator[tuple[Node, Node | None]]:
        for node in nodes:
            if isinstance(node, dict):
                yield node, parent
                yield from self._walk(node.get("children", []), node)

    def group(self, node: Node) -> Node:
        """The group's data (name, origin, rotation) for an outliner node."""
        data: Node = self._group_data.get(node["uuid"], node)
        return data

    def find(self, name: str) -> tuple[Node, Node | None]:
        """Outliner node of the group ``name`` and its parent node (None at top level)."""
        for node, parent in self._walk(self.data["outliner"], None):
            if self.group(node).get("name") == name:
                return node, parent
        raise KeyError(name)

    def names(self) -> set[str]:
        groups = {self.group(n).get("name", "") for n, _ in self._walk(self.data["outliner"], None)}
        return groups | {e.get("name", "") for e in self.data.get("elements", [])}

    def unique_name(self, base: str) -> str:
        taken = self.names()
        if base not in taken:
            return base
        index = 2
        while f"{base} {index}" in taken:
            index += 1
        return f"{base} {index}"

    def element(self, uuid: str) -> Node:
        return next(e for e in self.data["elements"] if e.get("uuid") == uuid)

    def cubes(self, name: str) -> list[Node]:
        node, _ = self.find(name)
        uuids = [c for c in node.get("children", []) if isinstance(c, str)]
        return [e for e in self.data["elements"] if e.get("uuid") in uuids and "from" in e]

    def null_objects(self) -> list[Node]:
        return [e for e in self.data["elements"] if e.get("type") == "null_object"]

    # --- structure ------------------------------------------------------------------------

    def _children_of(self, parent: Node | None) -> list[Any]:
        children: list[Any] = (
            self.data["outliner"] if parent is None else parent.setdefault("children", [])
        )
        return children

    def move(self, name: str, new_parent: str | None) -> None:
        """Re-parent a group (positions in a .bbmodel are absolute, so nothing moves)."""
        node, parent = self.find(name)
        self._children_of(parent).remove(node)
        target = None if new_parent is None else self.find(new_parent)[0]
        self._children_of(target).append(node)

    def set_pivot(self, name: str, pivot: Vec) -> None:
        self.group(self.find(name)[0])["origin"] = [float(v) for v in pivot]

    def add_group(self, name: str, parent: str | None, pivot: Vec, like: str) -> Node:
        """A new empty group, copying display settings from the group ``like``."""
        template = copy.deepcopy(self.group(self.find(like)[0]))
        template.update(
            name=name, uuid=new_uuid(), origin=[float(v) for v in pivot], rotation=[0.0, 0.0, 0.0]
        )
        template.pop("children", None)
        if self.layout5:
            self.data["groups"].append(template)
            self._group_data[template["uuid"]] = template
            node: Node = {"uuid": template["uuid"], "isOpen": True, "children": []}
        else:
            node = {**template, "children": []}
        target = None if parent is None else self.find(parent)[0]
        self._children_of(target).append(node)
        return node

    def move_element(self, uuid: str, new_parent: str) -> None:
        for node, _ in self._walk(self.data["outliner"], None):
            if uuid in node.get("children", []):
                node["children"].remove(uuid)
        self.find(new_parent)[0]["children"].append(uuid)

    # --- geometry -------------------------------------------------------------------------

    def split_cube(self, uuid: str, y: float, lower_parent: str) -> str:
        """Cut a cube horizontally at height ``y``; the part below goes to ``lower_parent``.

        Face UVs are kept exactly: side faces are divided at the same fraction, the outer
        top and bottom faces stay, and the new cut faces reuse them. Both halves switch to
        per-face UV so the texture layout no longer depends on the cube's size.
        """
        upper = self.element(uuid)
        low, high = upper["from"][1], upper["to"][1]
        fraction = (high - y) / (high - low)  # of the side faces, measured from the top
        lower = copy.deepcopy(upper)
        lower.update(uuid=new_uuid(), name=upper.get("name", "cube"))
        upper["from"][1], lower["to"][1] = y, y
        for part in (upper, lower):
            part["box_uv"] = False
        faces_upper, faces_lower = upper.get("faces", {}), lower.get("faces", {})
        for face in _SIDE_FACES:
            if face in faces_upper and "uv" in faces_upper[face]:
                u1, v_top, u2, v_bottom = faces_upper[face]["uv"]
                v_cut = v_top + fraction * (v_bottom - v_top)
                faces_upper[face]["uv"] = [u1, v_top, u2, v_cut]
                faces_lower[face]["uv"] = [u1, v_cut, u2, v_bottom]
        if "down" in faces_upper and "up" in faces_lower:  # cut faces reuse the outer ones
            faces_upper["down"], faces_lower["up"] = (
                copy.deepcopy(faces_lower["down"]),
                copy.deepcopy(faces_upper["up"]),
            )
        self.data["elements"].append(lower)
        self.find(lower_parent)[0]["children"].append(lower["uuid"])
        return str(lower["uuid"])

    def add_locator(self, name: str, position: Vec, parent: str) -> str:
        locator = {
            "name": name,
            "position": [float(v) for v in position],
            "rotation": [0, 0, 0],
            "ignore_inherited_scale": False,
            "visibility": True,
            "locked": False,
            "scope": 0,
            "uuid": new_uuid(),
            "type": "locator",
        }
        self.data["elements"].append(locator)
        self.find(parent)[0]["children"].append(locator["uuid"])
        return str(locator["uuid"])

    def add_null(
        self,
        name: str,
        position: Vec,
        parent: str,
        target: str = "",
        source: str = "",
        pole: str = "",
    ) -> str:
        null = {
            "name": name,
            "position": [float(v) for v in position],
            "ik_target": target,
            "ik_source": source,
            "ik_pole": pole,
            "lock_ik_target_rotation": False,
            "visibility": True,
            "locked": False,
            "scope": 0,
            "uuid": new_uuid(),
            "type": "null_object",
        }
        self.data["elements"].append(null)
        self.find(parent)[0]["children"].append(null["uuid"])
        return str(null["uuid"])

    def group_uuid(self, name: str) -> str:
        return str(self.find(name)[0]["uuid"])
