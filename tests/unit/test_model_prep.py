"""Model preparation: body-part detection, generated mappings and automatic rig fixes."""

import copy
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from miku_motion.blockbench.bbmodel import parse_bbmodel
from miku_motion.mapping.init import _data, generate_mapping, source_path
from miku_motion.mapping.schema import MappingFile
from miku_motion.mapping.secondary import suggest_chains
from miku_motion.model.document import BbmodelDocument
from miku_motion.model.prepare import PrepareOptions, prepare
from miku_motion.model.roles import detect_roles
from tests.fixtures.builders import bbmodel, group

PATH = Path("rig.bbmodel")


def lite_like() -> dict[str, Any]:
    """One-piece limbs, legs under a torso that pivots at the neck, a sleeve overlay."""
    return bbmodel(
        group("Root", None),
        group("Body", "Root", (0, 21, 0), cube=((-3.5, 11, -2), (3.5, 21, 2))),
        group("Head", "Body", (0, 21, 0), cube=((-4, 21, -4), (4, 29, 4))),
        group("Hair", "Head", (0, 21, 0)),
        group("TailL", "Hair", (-5, 28, 3), cube=((-7, 19, 2), (-4, 29, 5))),
        group("TailL2", "TailL", (-6, 19, 3), cube=((-7, 8, 2), (-4, 19, 5))),
        group("LeftArm", "Body", (-4, 19, 0), cube=((-6, 11, -1.5), (-3, 21, 1.5))),
        group("SleeveL", "LeftArm", (-4, 19, 0), cube=((-6, 12, -1.5), (-3, 16, 1.5))),
        group("CuffL", "SleeveL", (-4.5, 12, 0), cube=((-6, 8.5, -1.5), (-3, 13.5, 1.5))),
        group("RightArm", "Body", (4, 19, 0), cube=((3, 11, -1.5), (6, 21, 1.5))),
        group("LeftLeg", "Body", (-1.9, 11, 0), cube=((-3.4, 0, -2), (-0.4, 11, 2))),
        group("RightLeg", "Body", (1.9, 11, 0), cube=((0.4, 0, -2), (3.4, 11, 2))),
        name="lite_like",
    )


def miku_like() -> dict[str, Any]:
    """Two-segment limbs, legs under the root, a separate chest."""
    return bbmodel(
        group("Root", None),
        group("Body", "Root", (0, 12, 0), cube=((-3.5, 12, -2), (3.5, 19, 2))),
        group("Chest", "Body", (0, 19, 0), cube=((-3.5, 19, -2), (3.5, 24, 2))),
        group("Head", "Body", (0, 24, 0), cube=((-4, 24, -4), (4, 32, 4))),
        group("LeftArm", "Body", (-4.5, 23, 0), cube=((-6.5, 20, -1.5), (-3.5, 24, 1.5))),
        group("LowerLeftArm", "LeftArm", (-5, 20, 0), cube=((-6.5, 12, -1.5), (-3.5, 20, 1.5))),
        group("RightArm", "Body", (4.5, 23, 0), cube=((3.5, 20, -1.5), (6.5, 24, 1.5))),
        group("LowerRightArm", "RightArm", (5, 20, 0), cube=((3.5, 12, -1.5), (6.5, 20, 1.5))),
        group("LeftLeg", "Root", (-2, 12, 0), cube=((-4, 8, -2), (0, 12, 2))),
        group("LeftShin", "LeftLeg", (-2, 8, 0), cube=((-4, 0, -2), (0, 8, 2))),
        group("RightLeg", "Root", (2, 12, 0), cube=((0, 8, -2), (4, 12, 2))),
        group("RightShin", "RightLeg", (2, 8, 0), cube=((0, 0, -2), (4, 8, 2))),
        name="miku_like",
    )


def _roles(data: dict[str, Any]) -> dict[str, str]:
    skeleton = parse_bbmodel(data, PATH).skeleton
    suggestions = suggest_chains(skeleton, MappingFile(bones={"": ""}))
    return detect_roles(skeleton, {b for s in suggestions for b in s.bones}).by_role()


# --- body parts --------------------------------------------------------------------------------


def test_detects_one_piece_limbs_and_ignores_hair() -> None:
    assert _roles(lite_like()) == {
        "root": "Root",
        "torso": "Body",
        "head": "Head",
        "upper_arm_left": "LeftArm",
        "upper_arm_right": "RightArm",
        "thigh_left": "LeftLeg",
        "thigh_right": "RightLeg",
    }


def test_detects_segments_and_chest() -> None:
    roles = _roles(miku_like())
    assert roles["chest"] == "Chest"
    assert (roles["upper_arm_left"], roles["forearm_left"]) == ("LeftArm", "LowerLeftArm")
    assert (roles["thigh_right"], roles["shin_right"]) == ("RightLeg", "RightShin")


def test_overlays_are_not_physics_chains() -> None:
    skeleton = parse_bbmodel(lite_like(), PATH).skeleton
    chains = {s.bones for s in suggest_chains(skeleton, MappingFile(bones={"": ""}))}
    assert ("TailL", "TailL2") in chains
    assert not any("SleeveL" in c for c in chains)  # the tight sleeve overlay is rigid
    assert ("CuffL",) not in chains  # and so is the cuff wrapped around the arm


# --- generated mappings ----------------------------------------------------------------------


def _tree() -> tuple[dict[str, Any], dict[str, str]]:
    data = _data()
    return data["tree"], data["inverse"]


def test_source_path_walks_the_mmd_tree() -> None:
    tree, inverse = _tree()
    assert source_path(tree, inverse, None, "グルーブ") == [
        "全ての親",
        "全ての親2",
        "センター",
        "グルーブ",
    ]
    assert source_path(tree, inverse, "上半身", "頭") == ["上半身2", "首", "頭"]
    # From the root to a leg passes MMD's waist cancel.
    assert source_path(tree, inverse, "グルーブ", "左足") == [
        "腰",
        "下半身",
        {"bone": "腰", "weight": -1},
        "左足",
    ]
    # Legs parented to the torso cancel the upper body first.
    assert source_path(tree, inverse, "上半身", "左足") == [
        {"bone": "上半身", "weight": -1},
        "下半身",
        {"bone": "腰", "weight": -1},
        "左足",
    ]


def test_generated_mapping_matches_a_hand_written_one() -> None:
    data = miku_like()
    skeleton = parse_bbmodel(data, PATH).skeleton
    suggestions = suggest_chains(skeleton, MappingFile(bones={"": ""}))
    roles = detect_roles(skeleton, set())
    mapping = generate_mapping(skeleton, roles, suggestions, "miku_like")
    bones = mapping["bones"]
    assert bones["Root"] == {
        "from": ["全ての親", "全ての親2", "センター", "グルーブ"],
        "translation": True,
    }
    assert bones["Body"] == {"from": ["腰", "上半身"]}
    assert bones["Chest"] == "上半身2"
    assert bones["Head"] == {"from": ["上半身2", "首", "頭"]}
    assert bones["LowerLeftArm"]["from"] == ["左腕捩", "左ひじ", "左手捩"]
    assert bones["LeftShin"] == "左ひざ"
    z = bones["LeftArm"]["rest_correction"]["euler_deg"][2]
    assert -60 < z < -45  # arms down vs MMD's A-pose
    assert bones["RightArm"]["rest_correction"]["euler_deg"][2] == pytest.approx(-z)
    assert mapping["units"]["translation_scale"] == 1.6  # 32 px tall / 20 MMD units
    MappingFile.model_validate(mapping)  # valid mapping file


# --- document edits ----------------------------------------------------------------------------


def test_split_cube_keeps_uvs_exact() -> None:
    data = bbmodel(group("Arm", None, (0, 10, 0), cube=((0, 0, 0), (2, 10, 2))))
    faces = {f: {"uv": [0, 0, 2, 10], "texture": 0} for f in ("north", "east", "south", "west")}
    faces["up"] = {"uv": [2, 0, 4, 2], "texture": 0}
    faces["down"] = {"uv": [4, 0, 6, 2], "texture": 0}
    data["elements"][0].update(faces=faces, box_uv=True)
    doc = BbmodelDocument(data)
    doc.add_group("Lower", "Arm", [0, 4, 0], like="Arm")
    lower_uuid = doc.split_cube(data["elements"][0]["uuid"], 4.0, "Lower")
    upper, lower = data["elements"][0], doc.element(lower_uuid)

    assert (upper["from"][1], upper["to"][1], lower["from"][1], lower["to"][1]) == (4, 10, 0, 4)
    assert upper["faces"]["north"]["uv"] == [0, 0, 2, 6]  # top 6 px of the side
    assert lower["faces"]["north"]["uv"] == [0, 6, 2, 10]
    assert upper["faces"]["up"]["uv"] == [2, 0, 4, 2]
    assert lower["faces"]["down"]["uv"] == [4, 0, 6, 2]
    assert upper["box_uv"] is False
    assert lower["box_uv"] is False
    assert lower_uuid in doc.find("Lower")[0]["children"]


# --- prepare ----------------------------------------------------------------------------------


def _prepare(data: dict[str, Any], **options: bool) -> tuple[BbmodelDocument, list[str]]:
    doc = BbmodelDocument(copy.deepcopy(data))
    findings, _ = prepare(doc, PATH, PrepareOptions(**options))
    return doc, [f.message for f in findings if f.fixed]


def test_prepare_fixes_a_one_piece_rig() -> None:
    doc, fixed = _prepare(lite_like())
    skeleton = parse_bbmodel(doc.data, PATH).skeleton

    assert skeleton["LeftLeg"].parent == "Root"  # out of the torso
    np.testing.assert_allclose(skeleton["Body"].pivot, [0, 11, 0])  # bends at the waist
    assert skeleton["LeftArm Lower"].parent == "LeftArm"
    np.testing.assert_allclose(skeleton["LeftArm Lower"].pivot, [-4, 16, 0])  # elbow
    assert skeleton["SleeveL"].parent == "LeftArm Lower"  # the overlay follows the forearm
    np.testing.assert_allclose(skeleton["LeftLeg Lower"].pivot, [-1.9, 6, 0])  # knee (5.5 rounded)
    assert skeleton["LeftArm"].extent[0][1] == 16  # type: ignore[index]
    nulls = {n["name"] for n in doc.null_objects()}
    assert {"TailL IK", "TailL IK pole", "LeftArm IK", "LeftLeg IK"} <= nulls
    assert any("split the left arm" in f for f in fixed)

    roles = _roles(doc.data)
    assert (roles["upper_arm_left"], roles["forearm_left"]) == ("LeftArm", "LeftArm Lower")


def test_prepare_is_idempotent() -> None:
    doc, _ = _prepare(lite_like())
    _, fixed_again = _prepare(doc.data)
    assert fixed_again == []


def test_prepare_options_and_missing_root() -> None:
    data = lite_like()
    for node in list(data["outliner"][0]["children"]):  # take everything out of Root
        data["outliner"].append(node)
    data["outliner"].pop(0)
    data["groups"] = [g for g in data["groups"] if g["name"] != "Root"]
    doc, fixed = _prepare(data, split_limbs=False, hair_ik=False, limb_ik=False)
    skeleton = parse_bbmodel(doc.data, PATH).skeleton
    assert skeleton["Body"].parent == "root"
    assert skeleton["LeftLeg"].parent == "root"
    assert "LeftArm Lower" not in skeleton
    assert doc.null_objects() == []
    assert any("added a 'root' group" in f for f in fixed)


# --- swing limit ------------------------------------------------------------------------------


def test_swing_limit_bounds_the_angle() -> None:
    from miku_motion.animation.clip import Animation, BoneTrack
    from miku_motion.animation.skeleton import Skeleton, make_bone
    from miku_motion.conversion.secondary import ChainSpec, apply_secondary_motion
    from miku_motion.geometry import quat

    skeleton = Skeleton((make_bone("Head", None, (0, 10, 0)), make_bone("Bit", "Head", (2, 10, 0))))
    head_x = np.concatenate([np.linspace(0, 30, 6), np.full(60, 30.0)])  # a violent jerk
    times = np.arange(len(head_x)) / 60
    offsets = np.stack([head_x, np.zeros_like(head_x), np.zeros_like(head_x)], 1)
    animation = Animation(
        "a", times, float(times[-1]), tracks={"Head": BoneTrack(quat.identity(len(times)), offsets)}
    )
    spec = ChainSpec(("Bit",), np.array([2.0, 7.0, 0.0]), 40.0, 3.0, 1.0, max_angle=20.0)
    apply_secondary_motion(animation, skeleton, [spec])
    rotations = animation.tracks["Bit"].rotations
    assert rotations is not None
    assert math.degrees(float(quat.angle(rotations).max())) <= 20.0 + 1e-6


def flat_player() -> dict[str, Any]:
    """A Minecraft player model: six top-level parts, the body pivoting at the neck."""
    return bbmodel(
        group("head", None, (0, 24, 0), cube=((-4, 24, -4), (4, 32, 4))),
        group("body", None, (0, 24, 0), cube=((-4, 12, -2), (4, 24, 2))),
        group("left_arm", None, (-5, 22, 0), cube=((-8, 12, -2), (-4, 24, 2))),
        group("right_arm", None, (5, 22, 0), cube=((4, 12, -2), (8, 24, 2))),
        group("left_leg", None, (-1.9, 12, 0), cube=((-3.9, 0, -2), (0.1, 12, 2))),
        group("right_leg", None, (1.9, 12, 0), cube=((-0.1, 0, -2), (3.9, 12, 2))),
    )


def test_flat_player_rig_becomes_a_hierarchy() -> None:
    assert _roles(flat_player())["torso"] == "body"
    doc, fixed = _prepare(flat_player())
    skeleton = parse_bbmodel(doc.data, PATH).skeleton
    assert skeleton["body"].parent == "root"
    assert skeleton["head"].parent == "body"
    assert skeleton["left_arm"].parent == "body"
    assert skeleton["left_leg"].parent == "root"
    np.testing.assert_allclose(skeleton["body"].pivot, [0, 12, 0])
    assert "left_arm Lower" in skeleton
    assert any("attached the head" in f for f in fixed)
    _, again = _prepare(doc.data)
    assert again == []


def stacked_trunk() -> dict[str, Any]:
    """Hips carrying the legs; waist and chest stacked under the root."""
    return bbmodel(
        group("root", None),
        group("hips", "root", (0, 12, 0), cube=((-4, 10, -2), (4, 13, 2))),
        group("waist", "root", (0, 13, 0), cube=((-4, 13, -2), (4, 18, 2))),
        group("chest", "waist", (0, 18, 0), cube=((-4, 18, -2), (4, 24, 2))),
        group("head", "chest", (0, 24, 0), cube=((-4, 24, -4), (4, 32, 4))),
        group("arm_l", "chest", (-5, 22, 0), cube=((-7, 18, -1.5), (-4, 24, 1.5))),
        group("forearm_l", "arm_l", (-5.5, 18, 0), cube=((-7, 12, -1.5), (-4, 18, 1.5))),
        group("arm_r", "chest", (5, 22, 0), cube=((4, 18, -1.5), (7, 24, 1.5))),
        group("forearm_r", "arm_r", (5.5, 18, 0), cube=((4, 12, -1.5), (7, 18, 1.5))),
        group("leg_l", "hips", (-2, 11, 0), cube=((-4, 0, -2), (0, 11, 2))),
        group("leg_r", "hips", (2, 11, 0), cube=((0, 0, -2), (4, 11, 2))),
    )


def test_hips_and_stacked_waist_and_chest() -> None:
    roles = _roles(stacked_trunk())
    assert (roles["torso"], roles["chest"], roles["hips"]) == ("waist", "chest", "hips")
    skeleton = parse_bbmodel(stacked_trunk(), PATH).skeleton
    mapping = generate_mapping(skeleton, detect_roles(skeleton, set()), [], "stacked")
    bones = mapping["bones"]
    assert bones["hips"] == {"from": ["腰", "下半身"]}
    assert bones["waist"] == {"from": ["腰", "上半身"]}
    assert bones["chest"] == "上半身2"
    assert bones["head"] == {"from": ["首", "頭"]}  # under the chest: no 上半身2 again
    assert bones["leg_l"] == {"from": [{"bone": "腰", "weight": -1}, "左足"]}
