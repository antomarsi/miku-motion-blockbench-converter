"""Batch conversion of a group of performers sharing one target rig and mapping."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from typer.testing import CliRunner

from miku_motion.cli import app
from miku_motion.diagnostics import Code
from miku_motion.errors import MikuMotionError
from miku_motion.geometry.quat import FloatArray
from miku_motion.pipeline import (
    ConvertOptions,
    Formation,
    GroupResult,
    collect_group,
    convert,
    convert_group,
)
from miku_motion.vmd.writer import write_vmd
from tests.fixtures.builders import axis_angle, bone_key, player_rig, vmd, write_json

MAPPING = {"schema_version": 1, "bones": {"LeftArm": "左腕"}}


def _motion(path: Path, last_frame: int) -> Path:
    path.write_bytes(
        write_vmd(
            vmd(
                bone_key("左腕", 0),
                bone_key("左腕", last_frame, rotation=axis_angle((0, 0, 1), 60)),
            )
        )
    )
    return path


def test_group_matches_individual_conversions(tmp_path: Path) -> None:
    """Batch conversion must be a convenience, not a different code path: each member's
    output has to be byte-identical to converting it alone with `convert`."""
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    motion_a = _motion(tmp_path / "a.vmd", 20)
    motion_b = _motion(tmp_path / "b.vmd", 20)

    options = ConvertOptions(fps=20)
    group = convert_group([motion_a, motion_b], model, mapping, options)

    assert [m.motion_path for m in group.members] == [motion_a, motion_b]
    assert group.members[0].result.text == convert(motion_a, model, mapping, options).text
    assert group.members[1].result.text == convert(motion_b, model, mapping, options).text


def test_group_flags_a_member_whose_duration_diverges(tmp_path: Path) -> None:
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    in_sync_a = _motion(tmp_path / "in_sync_a.vmd", 20)
    in_sync_b = _motion(tmp_path / "in_sync_b.vmd", 21)  # 1 frame off: well within tolerance
    out_of_sync = _motion(tmp_path / "out_of_sync.vmd", 80)  # 3 seconds longer at 20 fps source

    group = convert_group(
        [in_sync_a, in_sync_b, out_of_sync], model, mapping, ConvertOptions(fps=20)
    )

    messages = [
        d.message for d in group.diagnostics.items if d.code is Code.GROUP_DURATION_MISMATCH
    ]
    assert any("out_of_sync.vmd" in m for m in messages)
    assert not any("in_sync_a.vmd" in m for m in messages)
    assert not any("in_sync_b.vmd" in m for m in messages)


def test_group_single_member_never_warns(tmp_path: Path) -> None:
    """No "group" to be out of sync with when there's only one performer."""
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    motion = _motion(tmp_path / "solo.vmd", 20)

    group = convert_group([motion], model, mapping, ConvertOptions(fps=20))
    assert group.diagnostics.items == []


def test_cli_convert_group(tmp_path: Path) -> None:
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    motion_a = _motion(tmp_path / "a.vmd", 20)
    motion_b = _motion(tmp_path / "b.vmd", 200)
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    result = CliRunner().invoke(
        app,
        [
            "convert-group",
            str(motion_a),
            str(motion_b),
            "-t",
            str(model),
            "-m",
            str(mapping),
            "-o",
            str(out_dir),
        ],
    )
    assert result.exit_code == 0, result.output
    assert (out_dir / "a.animation.json").exists()
    assert (out_dir / "b.animation.json").exists()
    assert "MM501" in result.output  # the duration mismatch

    strict = CliRunner().invoke(
        app,
        [
            "convert-group",
            str(motion_a),
            str(motion_b),
            "-t",
            str(model),
            "-m",
            str(mapping),
            "-o",
            str(out_dir),
            "--strict",
        ],
    )
    assert strict.exit_code == 1


# --- one performance: folders, formation, shared length ----------------------------------------

STAGE_MAPPING = {
    "schema_version": 1,
    "units": {"translation_scale": 2},
    "bones": {"Root": {"from": ["センター"], "translation": True}, "LeftArm": "左腕"},
}


def _performer(path: Path, x: float, z: float, last_frame: int = 20) -> Path:
    """Stands at (x, z) on the stage, crouches by 1 and walks 3 units along X."""
    path.write_bytes(
        write_vmd(
            vmd(
                bone_key("センター", 0, position=(x, -1, z)),
                bone_key("センター", last_frame, position=(x + 3, -1, z)),
                bone_key("左腕", 0),
                bone_key("左腕", last_frame, rotation=axis_angle((0, 0, 1), 60)),
            )
        )
    )
    return path


def _stage(tmp_path: Path) -> tuple[Path, Path, list[Path]]:
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", STAGE_MAPPING)
    motions = [_performer(tmp_path / "a.vmd", 10, 4), _performer(tmp_path / "b.vmd", 30, -2)]
    return model, mapping, motions


def _root(group: GroupResult, index: int) -> FloatArray:
    translations = group.members[index].result.animation.tracks["Root"].translations
    assert translations is not None
    return translations


def _clip(text: str) -> dict[str, Any]:
    clip: dict[str, Any] = next(iter(json.loads(text)["animations"].values()))
    return clip


def test_start_reports_where_each_motion_puts_its_performer(tmp_path: Path) -> None:
    model, mapping, motions = _stage(tmp_path)
    group = convert_group(motions, model, mapping, ConvertOptions(fps=20))
    # MMD +X is the model's left, canonical -X; 2 px per MMD unit.
    assert group.members[0].start == pytest.approx((-20, -2, 8))
    assert group.members[1].start == pytest.approx((-60, -2, -4))
    assert group.diagnostics.items == []


def test_formation_origin_starts_every_performer_at_its_own_origin(tmp_path: Path) -> None:
    model, mapping, motions = _stage(tmp_path)
    group = convert_group(
        motions, model, mapping, ConvertOptions(fps=20), formation=Formation.ORIGIN
    )
    for index in range(2):
        root = _root(group, index)
        np.testing.assert_allclose(root[0], [0, -2, 0], atol=1e-9)  # height is kept
        np.testing.assert_allclose(root[-1], [-6, -2, 0], atol=1e-9)  # the walk is kept
    assert group.members[1].start == pytest.approx((-60, -2, -4))  # still what the motion said
    assert Code.GROUP_FORMATION in group.diagnostics.codes()


def test_formation_center_moves_the_group_as_one(tmp_path: Path) -> None:
    model, mapping, motions = _stage(tmp_path)
    kept = convert_group(motions, model, mapping, ConvertOptions(fps=20))
    centred = convert_group(
        motions, model, mapping, ConvertOptions(fps=20), formation=Formation.CENTER
    )
    np.testing.assert_allclose(_root(centred, 0)[0], [20, -2, 6], atol=1e-9)
    np.testing.assert_allclose(_root(centred, 1)[0], [-20, -2, -6], atol=1e-9)
    spacing = _root(kept, 1) - _root(kept, 0)
    np.testing.assert_allclose(_root(centred, 1) - _root(centred, 0), spacing, atol=1e-9)


def test_formation_leaves_motions_without_a_stage_position_alone(tmp_path: Path) -> None:
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    motion = _motion(tmp_path / "a.vmd", 20)
    options = ConvertOptions(fps=20)
    group = convert_group([motion], model, mapping, options, formation=Formation.ORIGIN)
    assert group.members[0].result.text == convert(motion, model, mapping, options).text
    assert group.members[0].start == (0.0, 0.0, 0.0)


def test_sync_length_pads_shorter_members(tmp_path: Path) -> None:
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    short = _motion(tmp_path / "short.vmd", 30)
    long = _motion(tmp_path / "long.vmd", 90)
    options = ConvertOptions(fps=20)
    group = convert_group([short, long], model, mapping, options, sync_length=True)

    clips = [_clip(m.result.text) for m in group.members]
    assert [c["animation_length"] for c in clips] == [3, 3]
    alone = _clip(convert(short, model, mapping, options).text)
    assert alone["animation_length"] == 1
    assert clips[0]["bones"] == alone["bones"]  # only the length changes; the last pose holds
    synced = next(d for d in group.diagnostics.items if d.code is Code.GROUP_LENGTH_SYNCED)
    assert "short.vmd" in synced.message
    assert "long.vmd" not in synced.message
    assert Code.GROUP_DURATION_MISMATCH not in group.diagnostics.codes()  # handled by the sync


def test_collect_group_expands_folders(tmp_path: Path) -> None:
    crew = tmp_path / "Crew Night"
    crew.mkdir()
    for name in ("b.vmd", "A.VMD", "notes.txt"):
        (crew / name).write_bytes(b"")
    solo = tmp_path / "solo.vmd"
    solo.write_bytes(b"")

    entries = collect_group([crew, solo])
    assert [(e.motion_path.name, e.label) for e in entries] == [
        ("A.VMD", "Crew Night_A"),
        ("b.vmd", "Crew Night_b"),
        ("solo.vmd", "solo"),
    ]


def test_collect_group_rejects_empty_folders_and_name_clashes(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(MikuMotionError, match=r"no \.vmd motions"):
        collect_group([empty])
    first, second = tmp_path / "one" / "miku.vmd", tmp_path / "two" / "Miku.vmd"
    for path in (first, second):
        path.parent.mkdir()
        path.write_bytes(b"")
    with pytest.raises(MikuMotionError, match="same animation name"):
        collect_group([first, second])


def test_cli_converts_a_folder_as_one_performance(tmp_path: Path) -> None:
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", STAGE_MAPPING)
    crew = tmp_path / "Crew"
    crew.mkdir()
    _performer(crew / "Ena.vmd", 10, 0, last_frame=30)
    _performer(crew / "Kanade.vmd", -10, 0, last_frame=60)
    out_dir = tmp_path / "out" / "crew"  # created on demand

    result = CliRunner().invoke(
        app,
        [
            *("convert-group", str(crew), "-t", str(model), "-m", str(mapping)),
            *("-o", str(out_dir), "--formation", "origin", "--sync-length"),
        ],
    )
    assert result.exit_code == 0, result.output
    for name in ("Ena", "Kanade"):
        text = (out_dir / f"Crew_{name}.animation.json").read_text(encoding="utf-8")
        assert list(json.loads(text)["animations"]) == [f"animation.player_rig.crew_{name.lower()}"]
        clip = _clip(text)
        assert clip["animation_length"] == 2, name
        assert clip["bones"]["Root"]["position"]["0.0"] == [0, -2, 0], name
    assert "MM502" in result.output
    assert "MM503" in result.output
