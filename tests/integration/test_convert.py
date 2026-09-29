"""End-to-end conversion of the vertical-slice motion, pinned by a golden file."""

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from miku_motion.cli import app
from miku_motion.errors import MikuMotionError
from miku_motion.pipeline import ConvertOptions, convert
from miku_motion.vmd.parser import read_vmd
from miku_motion.vmd.writer import write_vmd
from tests.fixtures.builders import axis_angle, bone_key, ogg_vorbis, player_rig, vmd, write_json

GOLDEN = Path(__file__).resolve().parents[1] / "golden" / "arm_wave.animation.json"
MAPPING = {
    "schema_version": 1,
    "units": {"translation_scale": 1.6},
    "bones": {"Root": {"from": ["センター"], "translation": True}, "LeftArm": "左腕"},
}


@pytest.fixture
def inputs(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Left arm raises 60° over one second (MMD +Z) while the body rises 2 units."""
    motion = tmp_path / "arm_wave.vmd"
    motion.write_bytes(
        write_vmd(
            vmd(
                bone_key("左腕", 0),
                bone_key("左腕", 30, rotation=axis_angle((0, 0, 1), 60)),
                bone_key("センター", 0),
                bone_key("センター", 30, position=(0, 2, 0)),
                bone_key("右手首", 0, rotation=axis_angle((1, 0, 0), 10)),  # unmapped, animated
            )
        )
    )
    model = write_json(tmp_path / "player_rig.bbmodel", player_rig())
    mapping = write_json(tmp_path / "mapping.json", MAPPING)
    return motion, model, mapping


def test_matches_golden(inputs: tuple[Path, Path, Path], update_golden: bool) -> None:
    result = convert(*inputs, ConvertOptions(fps=20))
    if update_golden:
        GOLDEN.write_text(result.text, encoding="utf-8", newline="\n")
    assert result.text == GOLDEN.read_text(encoding="utf-8"), (
        "output changed; if intended, rerun with --update-golden and review the diff"
    )


def test_slice_semantics(inputs: tuple[Path, Path, Path]) -> None:
    result = convert(*inputs, ConvertOptions(fps=20))
    clip = json.loads(result.text)["animations"]["animation.player_rig.arm_wave"]
    assert clip["animation_length"] == 1
    arm = clip["bones"]["LeftArm"]["rotation"]
    assert len(arm) == 21
    # MMD +Z raises the model's left arm; in Blockbench space that is -Z, and the Bedrock
    # encoding keeps Z's sign: the file says -60 at the end.
    assert arm["1.0"] == [0, 0, -60]
    assert arm["0.5"] == [0, 0, -30]
    root = clip["bones"]["Root"]["position"]
    assert root["1.0"] == [0, 3.2, 0]  # 2 units * 1.6 px/unit, straight up
    warned = {d.code.value for d in result.diagnostics.warnings}
    assert "MM101" in warned  # the unmapped wrist


def test_conversion_is_deterministic(inputs: tuple[Path, Path, Path]) -> None:
    first = convert(*inputs, ConvertOptions(fps=20)).text
    assert convert(*inputs, ConvertOptions(fps=20)).text == first


def test_cli_convert(inputs: tuple[Path, Path, Path], tmp_path: Path) -> None:
    motion, model, mapping = inputs
    output = tmp_path / "out.animation.json"
    args = ["convert", str(motion), "-t", str(model), "-m", str(mapping), "-o", str(output)]
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 0, result.output
    assert "MM101" in result.output
    assert json.loads(output.read_text(encoding="utf-8"))["format_version"] == "1.8.0"

    strict = CliRunner().invoke(app, [*args, "--strict"])
    assert strict.exit_code == 1


def test_cli_convert_default_output_and_errors(inputs: tuple[Path, Path, Path]) -> None:
    motion, model, mapping = inputs
    result = CliRunner().invoke(app, ["convert", str(motion), "-t", str(model), "-m", str(mapping)])
    assert result.exit_code == 0, result.output
    assert motion.with_name("arm_wave.animation.json").exists()

    bad_mapping = write_json(mapping.with_name("bad.json"), {"bones": {"Nope": "左腕"}})
    result = CliRunner().invoke(
        app, ["convert", str(motion), "-t", str(model), "-m", str(bad_mapping)]
    )
    assert result.exit_code == 1
    assert "not found in the model" in result.output


def test_cli_synth_calibration(tmp_path: Path) -> None:
    output = tmp_path / "calibration.vmd"
    result = CliRunner().invoke(
        app, ["dev", "synth-calibration", "-o", str(output), "--rotate", "頭", "--move", "センター"]
    )
    assert result.exit_code == 0, result.output
    motion = read_vmd(output)
    assert {k.name for k in motion.bone_keys} == {"頭", "センター"}
    assert max(k.frame for k in motion.bone_keys) == 360
    # Regression: consecutive steps shared a rest key, producing duplicate-key warnings.
    frames = [(k.name, k.frame) for k in motion.bone_keys]
    assert len(frames) == len(set(frames))


@pytest.mark.real_assets
def test_every_real_motion_converts(assets_dir: Path) -> None:
    """Each motion style (e.g. waist/groove-driven vs. root-offset-driven) must convert and
    stay near the model's origin: large root drift means a root bone is missing from the
    mapping (regression: Rolling Girl's 全ての親2 offset)."""
    motions = sorted((assets_dir / "motions").glob("*.vmd"))
    models = sorted((assets_dir / "models").glob("*.bbmodel"))
    mapping = Path(__file__).resolve().parents[2] / "mappings" / "mikucraft.json"
    if not motions or not models:
        pytest.skip("real assets missing")
    for motion in motions:
        result = convert(motion, models[0], mapping, ConvertOptions(fps=20))
        clip = next(iter(json.loads(result.text)["animations"].values()))
        root = clip["bones"]["Root"]["position"].values()
        drift = max(abs(v) for key in root for v in key)
        assert drift < 48, f"{motion.name}: root moves {drift} px from the origin"


# --- sound keyframes ---------------------------------------------------------------------------


def _clip(text: str) -> dict[str, Any]:
    return next(iter(json.loads(text)["animations"].values()))


def test_audio_adds_first_frame_sound_named_after_mod_and_file(
    inputs: tuple[Path, Path, Path],
) -> None:
    motion, model, mapping = inputs
    rig = json.loads(model.read_text(encoding="utf-8"))
    rig["geckolib_modid"] = "my_mod"
    write_json(model, rig)
    audio = motion.with_name("Arm Wave!.ogg")
    audio.write_bytes(ogg_vorbis(1.5))

    result = convert(motion, model, mapping, ConvertOptions(fps=20, audio=audio))

    assert _clip(result.text)["sound_effects"] == {"0.0": {"effect": "my_mod:arm_wave"}}
    length = next(d for d in result.diagnostics.items if d.code.value == "MM301")
    assert length.severity.value == "info"  # 0.5 s difference is within tolerance


def test_audio_length_mismatch_warns(inputs: tuple[Path, Path, Path]) -> None:
    motion, model, mapping = inputs
    audio = motion.with_name("other.ogg")
    audio.write_bytes(ogg_vorbis(60.0))
    result = convert(motion, model, mapping, ConvertOptions(audio=audio, sound="x:y"))
    assert "MM301" in {d.code.value for d in result.diagnostics.warnings}
    assert _clip(result.text)["sound_effects"]["0.0"]["effect"] == "x:y"


def test_audio_without_mod_id_needs_explicit_sound(inputs: tuple[Path, Path, Path]) -> None:
    motion, model, mapping = inputs
    audio = motion.with_name("song.ogg")
    audio.write_bytes(ogg_vorbis(1.0))
    with pytest.raises(MikuMotionError, match="no GeckoLib mod id"):
        convert(motion, model, mapping, ConvertOptions(audio=audio))


def test_sound_without_audio_and_no_sound_by_default(inputs: tuple[Path, Path, Path]) -> None:
    assert "sound_effects" not in _clip(convert(*inputs, ConvertOptions()).text)
    result = convert(*inputs, ConvertOptions(sound="pack:song"))
    assert _clip(result.text)["sound_effects"] == {"0.0": {"effect": "pack:song"}}


def test_cli_audio_option(inputs: tuple[Path, Path, Path], tmp_path: Path) -> None:
    motion, model, mapping = inputs
    audio = tmp_path / "song.ogg"
    audio.write_bytes(ogg_vorbis(1.0))
    output = tmp_path / "out.json"
    args = ["convert", str(motion), "-t", str(model), "-m", str(mapping), "-o", str(output)]
    result = CliRunner().invoke(app, [*args, "--audio", str(audio), "--sound", "pack:song"])
    assert result.exit_code == 0, result.output
    assert "sound keyframe at 0 s: pack:song" in result.output
