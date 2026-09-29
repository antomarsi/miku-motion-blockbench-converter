import json
from pathlib import Path

import numpy as np
import pytest

from miku_motion.blockbench.bbmodel import parse_bbmodel, read_bbmodel
from miku_motion.errors import TargetModelError
from miku_motion.geometry import euler, quat
from tests.fixtures.builders import bbmodel, group, player_rig, write_json

PATH = Path("rig.bbmodel")


@pytest.mark.parametrize("layout", [4, 5])
def test_both_layouts_give_the_same_skeleton(layout: int) -> None:
    model = parse_bbmodel(player_rig(layout), PATH)
    skeleton = model.skeleton
    assert skeleton.names[:3] == ("Root", "Body", "Chest")
    assert skeleton["LowerLeftArm"].parent == "LeftArm"
    assert skeleton["LeftLeg"].parent == "Root"
    np.testing.assert_allclose(skeleton["LeftArm"].pivot, [-4.5, 22, 0])
    np.testing.assert_allclose(skeleton["Chest"].rest_euler_degrees, [20, 0, 0])
    assert quat.allclose_rotation(
        skeleton["Chest"].rest_rotation, euler.to_quat(np.radians([20, 0, 0]))
    )
    assert model.is_geckolib
    assert model.format_version == f"{layout}.0"


def test_rest_world_rotation_accumulates() -> None:
    model = parse_bbmodel(
        bbmodel(group("A", None, rotation=(0, 0, 30)), group("B", "A", rotation=(0, 0, 15))), PATH
    )
    assert quat.angle(model.skeleton.rest_world_rotation("B")) == pytest.approx(np.radians(45))


def test_skeleton_queries() -> None:
    skeleton = parse_bbmodel(player_rig(), PATH).skeleton
    assert [b.name for b in skeleton.ancestors("LowerLeftArm")] == ["LeftArm", "Body", "Root"]
    assert {b.name for b in skeleton.children("Root")} == {"Body", "LeftLeg", "RightLeg"}
    assert "Head" in skeleton
    assert len(skeleton) == 9
    assert skeleton.order("Body") == 1


def test_missing_rotation_and_origin_default_to_zero() -> None:
    data = bbmodel(group("A", None))
    del data["groups"][0]["rotation"]
    del data["groups"][0]["origin"]
    bone = parse_bbmodel(data, PATH).skeleton["A"]
    np.testing.assert_array_equal(bone.pivot, [0, 0, 0])


def test_non_geckolib_format_is_accepted() -> None:
    model = parse_bbmodel(bbmodel(group("A", None), model_format="free"), PATH)
    assert not model.is_geckolib


def test_duplicate_group_names_are_rejected() -> None:
    with pytest.raises(TargetModelError, match="more than once: \\['Arm'\\]"):
        parse_bbmodel(bbmodel(group("Arm", None), group("Arm", None)), PATH)


def test_model_without_groups_is_rejected() -> None:
    data = bbmodel(group("A", None))
    data["outliner"] = ["cube-0"]
    with pytest.raises(TargetModelError, match="no groups"):
        parse_bbmodel(data, PATH)


def test_not_a_bbmodel() -> None:
    with pytest.raises(TargetModelError, match="not a Blockbench project"):
        parse_bbmodel({"format_version": "1.12.0"}, PATH)


def test_unknown_group_reference() -> None:
    data = bbmodel(group("A", None))
    data["groups"] = []
    with pytest.raises(TargetModelError, match="unknown group uuid"):
        parse_bbmodel(data, PATH)


def test_bad_vector_and_outliner_entry() -> None:
    data = bbmodel(group("A", None))
    data["groups"][0]["origin"] = [1, 2]
    with pytest.raises(TargetModelError, match="origin must be three numbers"):
        parse_bbmodel(data, PATH)
    data = bbmodel(group("A", None))
    data["outliner"].append(42)
    with pytest.raises(TargetModelError, match="unexpected outliner entry"):
        parse_bbmodel(data, PATH)


def test_read_errors(tmp_path: Path) -> None:
    with pytest.raises(TargetModelError, match="cannot read file"):
        read_bbmodel(tmp_path / "missing.bbmodel")
    bad = tmp_path / "bad.bbmodel"
    bad.write_text("{nope", encoding="utf-8")
    with pytest.raises(TargetModelError, match="not valid JSON"):
        read_bbmodel(bad)
    bad.write_text("[]", encoding="utf-8")
    with pytest.raises(TargetModelError, match="top level"):
        read_bbmodel(bad)
    good = write_json(tmp_path / "rig.bbmodel", player_rig())
    assert read_bbmodel(good).name == "player_rig"


@pytest.mark.real_assets
def test_real_model_reads(assets_dir: Path) -> None:
    models = sorted((assets_dir / "models").glob("*.bbmodel"))
    if not models:
        pytest.skip("no .bbmodel in assets/models")
    model = read_bbmodel(models[0])
    assert len(model.skeleton) > 0
    json.dumps(model.skeleton.names)  # names are plain strings
