from pathlib import Path
from typing import Any

import pytest

from miku_motion.blockbench.bbmodel import parse_bbmodel
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.errors import MappingError
from miku_motion.geometry import quat
from miku_motion.mapping.resolve import resolve
from miku_motion.mapping.schema import MappingFile, load_mapping
from miku_motion.vmd.adapter import to_source_motion
from tests.fixtures.builders import axis_angle, bone_key, player_rig, vmd, write_json

SKELETON = parse_bbmodel(player_rig(), Path("rig.bbmodel")).skeleton
MOTION = to_source_motion(
    vmd(
        bone_key("センター", 0, position=(0, 1, 0)),
        bone_key("上半身", 0, rotation=axis_angle((1, 0, 0), 10)),
        bone_key("左腕", 0, rotation=axis_angle((0, 0, 1), 30)),
        bone_key("左腕", 30),
        bone_key("右腕", 0, position=(0, 0.5, 0)),
        bone_key("左足ＩＫ", 0, position=(0, 0, 1)),
        bone_key("左人指１", 0, rotation=axis_angle((0, 0, 1), 5)),
        bone_key("静止", 0),  # a bone at rest: never worth a warning
    ),
    Diagnostics(),
)


def _mapping(**overrides: Any) -> MappingFile:
    data: dict[str, Any] = {
        "bones": {
            "Root": {"from": ["センター"], "translation": True},
            "Body": "上半身",
            "LeftArm": {"from": ["左腕"], "rest_correction": {"euler_deg": [0, 0, -53]}},
            "RightArm": "右腕",
        }
    }
    data.update(overrides)
    return MappingFile.model_validate(data)


def _resolve(mapping: MappingFile) -> tuple[Any, Diagnostics]:
    diagnostics = Diagnostics()
    return resolve(mapping, SKELETON, MOTION, diagnostics), diagnostics


# --- schema -------------------------------------------------------------------------------


def test_shorthand_and_long_form() -> None:
    entries = _mapping().entries()
    assert [link.bone for link in entries["Body"].chain] == ["上半身"]
    assert entries["Root"].translation
    assert entries["LeftArm"].rest_correction is not None


def test_chain_links_with_weights() -> None:
    mapping = _mapping(bones={"LeftLeg": {"from": ["腰", {"bone": "腰", "weight": -1}, "左足"]}})
    chain = mapping.entries()["LeftLeg"].chain
    assert [(link.bone, link.weight) for link in chain] == [
        ("腰", 1.0),
        ("腰", -1.0),
        ("左足", 1.0),
    ]


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"bones": {}}, "at least one"),
        ({"bones": {"A": {"form": ["x"]}}}, "form"),  # typo is caught
        ({"bones": {"A": {"from": []}}}, "at least 1"),
        ({"bones": {"A": "x"}, "schema_version": 2}, "schema_version"),
        ({"bones": {"A": "x"}, "units": {"translation_scale": 0}}, "greater than 0"),
    ],
)
def test_invalid_mappings_are_explained(tmp_path: Path, data: Any, message: str) -> None:
    path = write_json(tmp_path / "m.json", data)
    with pytest.raises(MappingError, match=message):
        load_mapping(path)


def test_load_errors(tmp_path: Path) -> None:
    with pytest.raises(MappingError, match="cannot read"):
        load_mapping(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    with pytest.raises(MappingError, match="not valid JSON"):
        load_mapping(bad)
    assert load_mapping(write_json(tmp_path / "ok.json", {"bones": {"A": "x"}})).bones == {"A": "x"}


# --- resolve ------------------------------------------------------------------------------------


def test_bindings_follow_skeleton_order_with_anchors() -> None:
    resolved, _ = _resolve(_mapping())
    assert [b.target for b in resolved.bindings] == ["Root", "Body", "LeftArm", "RightArm"]
    assert resolved.binding("Body").anchor == "Root"
    assert resolved.binding("LeftArm").anchor == "Body"
    assert resolved.binding("Root").anchor is None
    assert quat.angle(resolved.binding("LeftArm").rest_correction) == pytest.approx(0.925, abs=1e-3)


def test_anchor_skips_unmapped_ancestors() -> None:
    resolved, _ = _resolve(_mapping(bones={"Root": "センター", "LowerLeftArm": "左ひじ"}))
    assert resolved.binding("LowerLeftArm").anchor == "Root"


def test_unknown_target_suggests_close_match() -> None:
    with pytest.raises(MappingError, match="did you mean 'LeftArm'"):
        _resolve(_mapping(bones={"LeftArmm": "左腕"}))


def test_diagnostics() -> None:
    _, diagnostics = _resolve(_mapping())
    by_code = {d.code: d for d in diagnostics.items}
    assert by_code[Code.UNMAPPED_ANIMATED_BONES].bones == ("左人指１",)
    assert by_code[Code.IK_DRIVEN_BONES].bones == ("左足ＩＫ",)
    assert by_code[Code.TRANSLATION_DROPPED].bones == ("右腕",)
    assert "Head" in by_code[Code.UNMAPPED_TARGET_BONES].bones
    assert Code.MAPPED_SOURCE_MISSING not in by_code


def test_ignore_globs_silence_warnings() -> None:
    _, diagnostics = _resolve(_mapping(ignore=["*指*", "左足ＩＫ"]))
    assert Code.UNMAPPED_ANIMATED_BONES not in diagnostics.codes()
    assert Code.IK_DRIVEN_BONES not in diagnostics.codes()


def test_unmapped_policy() -> None:
    with pytest.raises(MappingError, match="not mapped"):
        _resolve(_mapping(unmapped="error"))
    _, diagnostics = _resolve(_mapping(unmapped="ignore"))
    assert Code.UNMAPPED_ANIMATED_BONES not in diagnostics.codes()


def test_missing_sources_are_reported() -> None:
    _, diagnostics = _resolve(_mapping(bones={"Head": "頭"}))
    missing = next(d for d in diagnostics.items if d.code is Code.MAPPED_SOURCE_MISSING)
    assert missing.bones == ("頭",)


def test_long_names_match_after_vmd_truncation() -> None:
    long_name = "あいうえおかきくけこ"  # stored truncated in the 15-byte VMD field
    motion = to_source_motion(
        vmd(bone_key(long_name, 0, rotation=axis_angle((0, 1, 0), 5))), Diagnostics()
    )
    diagnostics = Diagnostics()
    resolved = resolve(
        MappingFile.model_validate({"bones": {"Head": long_name}}), SKELETON, motion, diagnostics
    )
    assert resolved.binding("Head").chain[0].source in motion.tracks
    assert Code.UNMAPPED_ANIMATED_BONES not in diagnostics.codes()


# --- rig lints --------------------------------------------------------------------------------


def test_source_applied_twice_through_ancestor() -> None:
    _, diagnostics = _resolve(
        _mapping(
            bones={"Body": {"from": ["上半身", "上半身2"]}, "Head": {"from": ["上半身2", "頭"]}}
        )
    )
    doubled = next(d for d in diagnostics.items if d.code is Code.SOURCE_APPLIED_TWICE)
    assert doubled.bones == ("上半身2 (Head via Body)",)


def test_repeated_source_that_cancels_is_fine() -> None:
    """Root's 腰 (+1) plus the leg's 腰 / 腰^-1 pair (net 0) applies 腰 exactly once."""
    _, diagnostics = _resolve(
        _mapping(
            bones={
                "Root": "腰",
                "LeftLeg": {"from": ["腰", "下半身", {"bone": "腰", "weight": -1}, "左足"]},
            }
        )
    )
    assert Code.SOURCE_APPLIED_TWICE not in diagnostics.codes()


def test_pivot_shared_with_mapped_parent() -> None:
    from tests.fixtures.builders import bbmodel, group

    skeleton = parse_bbmodel(
        bbmodel(
            group("Arm", None, (4, 22, 0)),
            group("Forearm", "Arm", (4, 22, 0)),  # forgot to move the elbow pivot
            group("Hand", "Forearm", (4, 12, 0)),
        ),
        Path("rig.bbmodel"),
    ).skeleton
    diagnostics = Diagnostics()
    mapping = MappingFile.model_validate(
        {"bones": {"Arm": "左腕", "Forearm": "左ひじ", "Hand": "左手首"}}
    )
    resolve(mapping, skeleton, MOTION, diagnostics)
    shared = next(d for d in diagnostics.items if d.code is Code.PIVOT_SHARED_WITH_PARENT)
    assert shared.bones == ("Forearm (pivot of Arm)",)
