"""Batch conversion of a group of performers sharing one target rig and mapping."""

from pathlib import Path

from typer.testing import CliRunner

from miku_motion.cli import app
from miku_motion.diagnostics import Code
from miku_motion.pipeline import ConvertOptions, convert, convert_group
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
