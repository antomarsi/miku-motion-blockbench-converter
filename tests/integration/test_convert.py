"""End-to-end conversion of the vertical-slice motion, pinned by a golden file."""

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from miku_motion.cli import app
from miku_motion.pipeline import ConvertOptions, convert
from miku_motion.vmd.parser import read_vmd
from miku_motion.vmd.writer import write_vmd
from tests.fixtures.builders import (
    axis_angle,
    bbmodel,
    bone_key,
    group,
    player_rig,
    vmd,
    write_json,
)

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


def _real_pairs(assets_dir: Path) -> list[tuple[Path, Path]]:
    """(model, mapping) pairs: mappings/<name>.json goes with assets/models/<name>.bbmodel."""
    models = {p.stem.lower(): p for p in (assets_dir / "models").glob("*.bbmodel")}
    mappings = sorted((Path(__file__).resolve().parents[2] / "mappings").glob("*.json"))
    return [(models[m.stem.lower()], m) for m in mappings if m.stem.lower() in models]


@pytest.mark.real_assets
def test_every_real_motion_converts(assets_dir: Path) -> None:
    """Each motion style (e.g. waist/groove-driven vs. root-offset-driven) must convert onto
    each model with a mapping, and stay near the model's origin: large root drift means a
    root bone is missing from the mapping (regression: Rolling Girl's 全ての親2 offset)."""
    motions = sorted((assets_dir / "motions").glob("*.vmd"))
    pairs = _real_pairs(assets_dir)
    if not motions or not pairs:
        pytest.skip("real assets missing")
    for model, mapping in pairs:
        mapped = json.loads(mapping.read_text(encoding="utf-8"))["bones"]
        roots = [t for t, e in mapped.items() if isinstance(e, dict) and e.get("translation")]
        for motion in motions:
            result = convert(motion, model, mapping, ConvertOptions(fps=20))
            bones = next(iter(json.loads(result.text)["animations"].values()))["bones"]
            for root in roots:
                # A motion that never moves its root writes no position channel.
                keys = bones.get(root, {}).get("position", {}).values()
                drift = max((abs(v) for key in keys for v in key), default=0.0)
                # Some dances really travel (one walks 31 MMD units, ~50 px, feet included).
                assert drift < 64, f"{motion.name} on {model.name}: {root} drifts {drift} px"


def _clip(text: str) -> dict[str, Any]:
    return next(iter(json.loads(text)["animations"].values()))


# --- secondary motion ---------------------------------------------------------------------------


def test_hair_chain_swings_when_the_head_turns(tmp_path: Path) -> None:
    motion = tmp_path / "turn.vmd"
    motion.write_bytes(
        write_vmd(
            vmd(
                bone_key("頭", 0),
                bone_key("頭", 10, rotation=axis_angle((0, 1, 0), 90)),
                bone_key("頭", 40, rotation=axis_angle((0, 1, 0), 90)),
            )
        )
    )
    rig = write_json(
        tmp_path / "rig.bbmodel",
        bbmodel(
            group("Head", None, (0, 24, 0)),
            group("Tail", "Head", (4, 32, 3)),
            group("TailEnd", "Tail", (6, 20, 3)),
        ),
    )
    mapping = write_json(
        tmp_path / "m.json",
        {"bones": {"Head": "頭"}, "secondary_motion": [{"bones": ["Tail", "TailEnd"]}]},
    )
    result = convert(motion, rig, mapping, ConvertOptions(fps=20))
    bones = _clip(result.text)["bones"]
    assert {"Head", "Tail", "TailEnd"} <= bones.keys()
    swing = [max(map(abs, v)) for v in bones["Tail"]["rotation"].values()]
    assert max(swing) > 5  # flung out by the turn
    assert swing[-1] < max(swing) / 2  # and settling afterwards
    assert "MM302" in {d.code.value for d in result.diagnostics.items}


def test_cli_inspect_model_suggests_chains(tmp_path: Path) -> None:
    rig = write_json(
        tmp_path / "rig.bbmodel",
        bbmodel(
            group("Head", None, (0, 24, 0), cube=((-4, 24, -4), (4, 32, 4))),
            group("Ponytail", "Head", (0, 30, 5), cube=((-1, 18, 4), (1, 30, 6))),
        ),
    )
    result = CliRunner().invoke(app, ["inspect-model", str(rig)])
    assert result.exit_code == 0, result.output
    assert "Ponytail  pivot 0, 30, 5" in result.output
    assert '{ "bones": ["Ponytail"], "preset": "ponytail" }' in result.output

    mapping = write_json(
        tmp_path / "m.json",
        {"bones": {"Head": "頭"}, "secondary_motion": [{"bones": ["Ponytail"]}]},
    )
    result = CliRunner().invoke(app, ["inspect-model", str(rig), "-m", str(mapping)])
    assert "No unconfigured hair/cloth-like chains found." in result.output


# --- model preparation -------------------------------------------------------------------------


def test_cli_prepare_model_and_init_mapping(tmp_path: Path) -> None:
    from tests.unit.test_model_prep import lite_like

    model = write_json(tmp_path / "lite.bbmodel", lite_like())
    original = model.read_text(encoding="utf-8")

    check = CliRunner().invoke(app, ["prepare-model", str(model), "--check"])
    assert check.exit_code == 0, check.output
    assert "split the left arm" in check.output
    assert not (tmp_path / "lite.prepared.bbmodel").exists()

    result = CliRunner().invoke(app, ["prepare-model", str(model)])
    assert result.exit_code == 0, result.output
    prepared = tmp_path / "lite.prepared.bbmodel"
    assert prepared.exists()
    assert model.read_text(encoding="utf-8") == original  # never edits the input
    refused = CliRunner().invoke(app, ["prepare-model", str(model), "-o", str(model)])
    assert refused.exit_code == 1

    mapping = tmp_path / "lite.json"
    result = CliRunner().invoke(app, ["init-mapping", str(prepared), "-o", str(mapping)])
    assert result.exit_code == 0, result.output
    assert (
        CliRunner().invoke(app, ["init-mapping", str(prepared), "-o", str(mapping)]).exit_code == 1
    )
    generated = json.loads(mapping.read_text(encoding="utf-8"))
    assert "LeftArm Lower" in generated["bones"]

    motion = tmp_path / "wave.vmd"
    motion.write_bytes(
        write_vmd(
            vmd(bone_key("左ひじ", 0), bone_key("左ひじ", 30, rotation=axis_angle((0, 1, 0), 90)))
        )
    )
    converted = convert(motion, prepared, mapping, ConvertOptions(fps=20))
    assert "LeftArm Lower" in _clip(converted.text)["bones"]


@pytest.mark.real_assets
def test_every_real_model_can_be_prepared_and_converted(assets_dir: Path, tmp_path: Path) -> None:
    from miku_motion.mapping.init import generate_mapping, render_mapping
    from miku_motion.model.document import BbmodelDocument
    from miku_motion.model.prepare import prepare

    models = sorted((assets_dir / "models").glob("*.bbmodel"))
    motions = sorted((assets_dir / "motions").glob("*.vmd"))
    if not models or not motions:
        pytest.skip("real assets missing")
    for model in models:
        document = BbmodelDocument.load(model)
        _, final = prepare(document, model)
        prepared = tmp_path / f"{model.stem}.prepared.bbmodel"
        document.save(prepared)
        roles = final.roles.by_role()
        assert {"torso", "head", "thigh_left", "upper_arm_right"} <= roles.keys(), model.name
        mapping = tmp_path / f"{model.stem}.json"
        mapping.write_text(
            render_mapping(
                generate_mapping(final.skeleton, final.roles, final.suggestions, model.stem)
            ),
            encoding="utf-8",
        )
        result = convert(motions[0], prepared, mapping, ConvertOptions(fps=20))
        assert len(_clip(result.text)["bones"]) >= 10, model.name
