import json
import struct
from pathlib import Path

import pytest
from typer.testing import CliRunner

from miku_motion.cli import app
from miku_motion.errors import InputFormatError
from miku_motion.vmd import interpolation
from miku_motion.vmd.interpolation import LINEAR, BoneCurves
from miku_motion.vmd.names import canonical_bone_name, decode_name, encode_name
from miku_motion.vmd.parser import MAGIC_V1, parse_vmd, read_vmd
from miku_motion.vmd.summary import is_ik_name, summarize
from miku_motion.vmd.types import VmdIkState, VmdMorphKey, VmdShowIkKey
from miku_motion.vmd.writer import write_vmd
from tests.fixtures.builders import axis_angle, bone_key, vmd

ARM = "左腕"
CENTER = "センター"


# --- names ---------------------------------------------------------------------------------


def test_name_round_trip() -> None:
    assert decode_name(encode_name(ARM, 15)) == ARM


def test_truncated_double_byte_name_drops_half_character() -> None:
    long_name = "あいうえおかきくけこ"  # 20 bytes in cp932
    raw = long_name.encode("cp932")[:15]  # cuts the 8th character in half
    assert decode_name(raw) == "あいうえおかき"
    assert canonical_bone_name(long_name) == "あいうえおかき"


def test_decode_stops_at_nul_and_ignores_garbage() -> None:
    assert decode_name(ARM.encode("cp932") + b"\0\xfd\xfd") == ARM


def test_encode_rejects_unrepresentable_names() -> None:
    with pytest.raises(ValueError, match="Shift-JIS"):
        encode_name("\U0001f600", 15)
    assert canonical_bone_name("\U0001f600") == "\U0001f600"


# --- interpolation ---------------------------------------------------------------------------


def test_interpolation_round_trip_with_distinct_curves() -> None:
    curves = BoneCurves((1, 2, 3, 4), (5, 6, 7, 8), (9, 10, 11, 12), (13, 14, 15, 16))
    assert interpolation.decode(interpolation.encode(curves)) == curves


def test_interpolation_ignores_physics_flag_bytes() -> None:
    curves = BoneCurves(LINEAR, LINEAR, (64, 0, 64, 127), (0, 127, 127, 0))
    block = interpolation.encode(curves, physics_flags=bytes([99, 15]))
    assert block[2:4] == bytes([99, 15])
    assert interpolation.decode(block) == curves


def test_interpolation_layout_matches_mmd() -> None:
    block = interpolation.encode()
    assert list(block[:16]) == [20, 20, 0, 0, 20, 20, 20, 20] + [107] * 8
    assert list(block[16:32]) == [20] * 7 + [107] * 8 + [0]


def test_interpolation_validates_input() -> None:
    with pytest.raises(ValueError, match=r"0\.\.127"):
        interpolation.encode(BoneCurves(LINEAR, LINEAR, LINEAR, (0, 0, 200, 0)))
    with pytest.raises(ValueError, match="64 bytes"):
        interpolation.decode(b"\0" * 10)


# --- parser / writer ---------------------------------------------------------------------------


def test_round_trip_preserves_keys() -> None:
    source = vmd(
        bone_key(CENTER, 0, position=(1.0, 2.0, -3.5)),
        bone_key(ARM, 15, rotation=axis_angle((0, 0, 1), 60)),
        morphs=(VmdMorphKey("まばたき", 3, 0.5),),
        model="初音ミク",
    )
    source.show_ik_keys.append(VmdShowIkKey(0, True, (VmdIkState("左足ＩＫ", False),)))

    parsed = parse_vmd(write_vmd(source))

    assert parsed.model_name == "初音ミク"
    assert [(k.name, k.frame, k.interpolation) for k in parsed.bone_keys] == [
        (k.name, k.frame, k.interpolation) for k in source.bone_keys
    ]
    assert parsed.bone_keys[0].position == (1.0, 2.0, -3.5)
    assert parsed.bone_keys[1].rotation == pytest.approx(source.bone_keys[1].rotation, abs=1e-7)
    assert parse_vmd(write_vmd(parsed)).bone_keys == parsed.bone_keys  # float32-stable
    assert parsed.morph_keys == source.morph_keys
    assert parsed.show_ik_keys == source.show_ik_keys
    assert (parsed.camera_key_count, parsed.light_key_count, parsed.shadow_key_count) == (0, 0, 0)


def test_bone_record_byte_layout() -> None:
    data = write_vmd(vmd(bone_key(ARM, 7, position=(1.0, 2.0, 3.0))))
    record = data[50 + 4 : 50 + 4 + 111]
    assert record[:15].split(b"\0")[0].decode("cp932") == ARM
    assert struct.unpack_from("<I3f4f", record, 15) == (7, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0)


def test_writer_rejects_bad_interpolation_length() -> None:
    key = bone_key(ARM, 0)
    bad = type(key)(key.name, key.frame, key.position, key.rotation, b"\0")
    with pytest.raises(ValueError, match="64 interp bytes"):
        write_vmd(vmd(bad))


def test_file_ending_after_morphs_is_accepted() -> None:
    data = write_vmd(vmd(bone_key(ARM, 0)))
    trimmed = data[: 50 + 4 + 111 + 4]  # header + bones + empty morph section
    parsed = parse_vmd(trimmed)
    assert len(parsed.bone_keys) == 1
    assert parsed.show_ik_keys == []


def test_version_1_header() -> None:
    header = MAGIC_V1.ljust(30, b"\0") + encode_name("old", 10)
    parsed = parse_vmd(header + struct.pack("<I", 0))
    assert (parsed.version, parsed.model_name) == (1, "old")


def test_bad_magic_is_a_clear_error() -> None:
    with pytest.raises(InputFormatError, match="not a VMD motion file"):
        parse_vmd(b"PMX " + b"\0" * 60, Path("model.pmx"))


def test_truncated_bone_section_reports_offset() -> None:
    data = write_vmd(vmd(bone_key(ARM, 0), bone_key(ARM, 1)))
    with pytest.raises(InputFormatError, match="2 bone keyframes") as info:
        parse_vmd(data[: 50 + 4 + 150], Path("broken.vmd"))
    assert info.value.offset == 54
    assert "broken.vmd" in str(info.value)


def test_truncated_show_ik_section_is_an_error() -> None:
    source = vmd()
    source.show_ik_keys.append(VmdShowIkKey(0, True, (VmdIkState("x", True),)))
    with pytest.raises(InputFormatError, match="show/IK keyframe 1 of 1"):
        parse_vmd(write_vmd(source)[:-5])


def test_read_missing_file(tmp_path: Path) -> None:
    with pytest.raises(InputFormatError, match="cannot read file"):
        read_vmd(tmp_path / "missing.vmd")


# --- summary ---------------------------------------------------------------------------------


def test_summary_classifies_bones() -> None:
    motion = vmd(
        bone_key(CENTER, 0, position=(0, 1, 0)),
        bone_key(CENTER, 30, position=(0, 2, 0)),
        bone_key(ARM, 0, rotation=axis_angle((0, 0, 1), 30)),  # static pose, rotated
        bone_key("頭", 0),  # static rest pose
        bone_key("左足ＩＫ", 0, position=(0, 0, 1)),
        bone_key("左足ＩＫ", 10, position=(0, 0, 2)),
        morphs=(VmdMorphKey("あ", 40, 1.0),),
    )
    summary = summarize(motion)
    bones = {b.name: b for b in summary.bones}

    assert (summary.first_frame, summary.last_frame) == (0, 40)
    assert (bones[CENTER].varies, bones[CENTER].translates, bones[CENTER].rotates) == (
        True,
        True,
        False,
    )
    assert (bones[ARM].rotates, bones[ARM].varies) == (True, False)
    assert (bones["頭"].rotates, bones["頭"].varies) == (False, False)
    assert bones["左足ＩＫ"].ik
    # Morphs and IK are converted now (regression: inspect listed them as unsupported).
    assert any("morph" in note for note in summary.conditional)
    assert any("IK-driven" in note for note in summary.conditional)
    assert summary.unsupported == ()


def test_ik_name_detection_handles_full_width() -> None:
    assert is_ik_name("右足ＩＫ")
    assert is_ik_name("leg_ik")
    assert not is_ik_name("右ひざ")


# --- CLI -------------------------------------------------------------------------------------


def _write(tmp_path: Path) -> Path:
    path = tmp_path / "wave.vmd"
    path.write_bytes(
        write_vmd(
            vmd(
                bone_key(ARM, 0),
                bone_key(ARM, 30, rotation=axis_angle((0, 0, 1), 60)),
                bone_key("頭", 0),
            )
        )
    )
    return path


def test_cli_inspect_table(tmp_path: Path) -> None:
    result = CliRunner().invoke(app, ["inspect", str(_write(tmp_path))])
    assert result.exit_code == 0, result.output
    assert ARM in result.output
    assert "0-30 @ 30 fps" in result.output
    assert "1 static-pose bones hidden" in result.output


def test_cli_inspect_json(tmp_path: Path) -> None:
    result = CliRunner().invoke(app, ["inspect", "--json", str(_write(tmp_path))])
    data = json.loads(result.output)
    assert data["duration_seconds"] == 1.0
    assert {b["name"] for b in data["bones"]} == {ARM, "頭"}


def test_cli_inspect_reports_errors_without_traceback(tmp_path: Path) -> None:
    bad = tmp_path / "bad.vmd"
    bad.write_bytes(b"nope")
    result = CliRunner().invoke(app, ["inspect", str(bad)])
    assert result.exit_code == 1
    assert "unexpected end of file" in result.output
    assert "Traceback" not in result.output


# --- real assets (git-ignored; skipped when absent) --------------------------------------------


@pytest.mark.real_assets
def test_real_vmd_matches_pypmxvmd(assets_dir: Path) -> None:
    pypmxvmd = pytest.importorskip("pypmxvmd")
    motions = sorted((assets_dir / "motions").glob("*.vmd"))
    if not motions:
        pytest.skip("no .vmd files in assets/motions")
    ours = read_vmd(motions[0])
    theirs = pypmxvmd.load_vmd(str(motions[0]))
    assert len(ours.bone_keys) == len(theirs.bone_frames)
    for mine, other in zip(ours.bone_keys[:2000], theirs.bone_frames[:2000], strict=True):
        assert mine.name == other.bone_name
        assert mine.frame == other.frame_number
        assert mine.position == pytest.approx(tuple(other.position), abs=1e-5)
