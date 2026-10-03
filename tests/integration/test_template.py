"""The committed template model: Minecraft-compatible, ready to dance, mapping in sync."""

import json
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

from miku_motion.blockbench.bbmodel import read_bbmodel
from miku_motion.mapping.init import generate_mapping, render_mapping
from miku_motion.mapping.schema import MappingFile
from miku_motion.mapping.secondary import suggest_chains
from miku_motion.model.document import BbmodelDocument
from miku_motion.model.prepare import prepare
from miku_motion.model.roles import detect_roles
from miku_motion.pipeline import ConvertOptions, convert
from miku_motion.vmd.writer import write_vmd
from tests.fixtures.builders import axis_angle, bone_key, vmd

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "templates"
VARIANTS = {"template": 4, "template_slim": 3}  # name -> arm width (classic / slim)
TEMPLATE = TEMPLATES / "template.bbmodel"
MAPPING = ROOT / "mappings" / "template.json"
TEMPLATE_FILES = (
    "template.bbmodel",
    "template_slim.bbmodel",
    "template_skin.png",
    "template_slim_skin.png",
)


def minecraft(arm: int) -> dict[str, Any]:
    """Minecraft player boxes: (from, to, base-layer UV origin, size w/h/d)."""
    return {
        "head": ((-4, 24, -4), (4, 32, 4), (0, 0), (8, 8, 8)),
        "body": ((-4, 12, -2), (4, 24, 2), (16, 16), (8, 12, 4)),
        "arm_right": ((4, 12, -2), (4 + arm, 24, 2), (40, 16), (arm, 12, 4)),
        "arm_left": ((-4 - arm, 12, -2), (-4, 24, 2), (32, 48), (arm, 12, 4)),
        "leg_right": ((-0.1, 0, -2), (3.9, 12, 2), (0, 16), (4, 12, 4)),
        "leg_left": ((-3.9, 0, -2), (0.1, 12, 2), (16, 48), (4, 12, 4)),
    }


def _document(name: str = "template") -> dict[str, Any]:
    path = TEMPLATES / f"{name}.bbmodel"
    result: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return result


def _cubes(label: str, name: str = "template") -> list[dict[str, Any]]:
    return [e for e in _document(name)["elements"] if e.get("name") == label]


@pytest.mark.parametrize("variant", sorted(VARIANTS))
@pytest.mark.parametrize("label", sorted(minecraft(4)))
def test_body_boxes_keep_minecraft_size_position_and_skin_region(label: str, variant: str) -> None:
    start, end, (u, v), (w, h, d) = minecraft(VARIANTS[variant])[label]
    pieces = _cubes(label, variant)
    assert pieces, label
    # The segments stack up into exactly the Minecraft box.
    assert min(p["from"][1] for p in pieces) == start[1]
    assert max(p["to"][1] for p in pieces) == end[1]
    for p in pieces:
        assert (p["from"][0], p["from"][2], p["to"][0], p["to"][2]) == (
            start[0],
            start[2],
            end[0],
            end[2],
        )
    # Their front faces tile the Minecraft front region top to bottom, without gaps.
    fronts = sorted((p["faces"]["north"]["uv"] for p in pieces), key=lambda uv: uv[1])
    assert fronts[0][:2] == [u + d, v + d]
    assert fronts[-1][3] == v + d + h
    for upper, lower in pairwise(fronts):
        assert upper[3] == lower[1]
    assert {(f[0], f[2]) for f in fronts} == {(u + d, u + d + w)}


def test_overlay_layers_exist_for_every_body_box() -> None:
    for label in minecraft(4):
        layers = _cubes(f"{label} layer")
        assert layers, label
        assert all(layer.get("inflate", 0) > 0 for layer in layers)


def test_texture_is_a_minecraft_skin_plus_an_extras_area() -> None:
    document = _document()
    assert document["resolution"] == {"width": 64, "height": 128}
    assert document["meta"]["model_format"] == "geckolib_model"
    assert (ROOT / "templates" / "template_skin.png").exists()


def test_extras_are_hidden_but_exported() -> None:
    groups = {g["name"]: g for g in _document()["groups"]}
    for name in ("hair", "twintail_left", "ponytail_top", "skirt_front", "tie", "sleeve_left"):
        assert groups[name]["visibility"] is False, name
        assert groups[name]["export"] is True, name
    assert groups["head"]["visibility"] is True


def test_template_is_already_ready_to_dance() -> None:
    document = BbmodelDocument(_document())
    findings, final = prepare(document, TEMPLATE)
    assert [f.message for f in findings if f.fixed] == []
    roles = final.roles.by_role()
    for role in ("root", "hips", "torso", "chest", "head", "hand_left", "foot_right"):
        assert role in roles, role


@pytest.mark.parametrize("variant", sorted(VARIANTS))
def test_committed_mapping_matches_init_mapping(variant: str) -> None:
    model = read_bbmodel(TEMPLATES / f"{variant}.bbmodel")
    suggestions = suggest_chains(model.skeleton, MappingFile(bones={"": ""}))
    roles = detect_roles(model.skeleton, {b for s in suggestions for b in s.bones})
    expected = render_mapping(generate_mapping(model.skeleton, roles, suggestions, model.name))
    mapping = ROOT / "mappings" / f"{variant}.json"
    assert mapping.read_text(encoding="utf-8") == expected, (
        f"mappings/{variant}.json is out of date: run `miku-motion init-mapping "
        f"templates/{variant}.bbmodel -o mappings/{variant}.json --force`"
    )


def test_template_dances(tmp_path: Path) -> None:
    motion = tmp_path / "wave.vmd"
    motion.write_bytes(
        write_vmd(
            vmd(
                bone_key("左腕", 0),
                bone_key("左腕", 30, rotation=axis_angle((0, 0, 1), 60)),
                bone_key("左ひじ", 30, rotation=axis_angle((0, 1, 0), 45)),
                bone_key("センター", 30, position=(0, -2, 0)),
                bone_key("頭", 30, rotation=axis_angle((0, 1, 0), 30)),
            )
        )
    )
    result = convert(motion, TEMPLATE, MAPPING, ConvertOptions(fps=10))
    bones = next(iter(json.loads(result.text)["animations"].values()))["bones"]
    for bone in ("arm_left", "forearm_left", "head", "root", "shin_left", "twintail_left"):
        assert bone in bones, bone


def test_generator_reproduces_the_committed_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("PIL")
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "make_template", ROOT / "tools" / "make_template.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "OUT_DIR", tmp_path)
    module.main()
    for name in TEMPLATE_FILES:
        assert (tmp_path / name).read_bytes() == (ROOT / "templates" / name).read_bytes(), name


def test_template_face_follows_morphs(tmp_path: Path) -> None:
    from miku_motion.vmd.types import VmdMorphKey

    motion = tmp_path / "sing.vmd"
    motion.write_bytes(
        write_vmd(
            vmd(
                bone_key("頭", 0),
                bone_key("頭", 30),
                morphs=(
                    VmdMorphKey("まばたき", 0, 0.0),
                    VmdMorphKey("まばたき", 30, 1.0),
                    VmdMorphKey("あ", 0, 0.0),
                    VmdMorphKey("あ", 30, 1.0),
                ),
            )
        )
    )
    result = convert(motion, TEMPLATE, MAPPING, ConvertOptions(fps=10))
    bones = next(iter(json.loads(result.text)["animations"].values()))["bones"]
    assert bones["eyelid_left"]["scale"]["0.0"] == [1, 0, 1]  # open ...
    assert bones["eyelid_left"]["scale"]["1.0"] == [1, 1, 1]  # ... closed
    assert bones["mouth_a"]["scale"]["0.0"] == [0, 0, 0]  # hidden until あ passes 0.5
    assert bones["mouth_a"]["scale"]["1.0"] == [1, 1, 1]
    assert bones["mouth_closed"]["scale"]["1.0"] == [0, 0, 0]
    assert "MM108" in {d.code.value for d in result.diagnostics.items}
