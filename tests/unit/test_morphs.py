"""Facial animation: morph rules, the scale channel and generated face rules."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from miku_motion.animation.clip import Animation, BoneTrack
from miku_motion.animation.sampling import sample_morph
from miku_motion.animation.skeleton import Skeleton, make_bone
from miku_motion.animation.source import MorphTrack, SourceMotion
from miku_motion.blockbench.bbmodel import parse_bbmodel
from miku_motion.conversion.morphs import apply_morph_rules, resolve_morph_rules
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.errors import MappingError
from miku_motion.geckolib.writer import write_animation
from miku_motion.mapping.init import face_rules
from miku_motion.mapping.schema import MorphRule
from miku_motion.model.roles import detect_roles
from tests.fixtures.builders import bbmodel, group

SKELETON = Skeleton(
    (
        make_bone("head", None, (0, 24, 0)),
        make_bone("lid", "head", (-2, 28, -4)),
        make_bone("mouth", "head", (0, 25, -4)),
        make_bone("mouth_a", "head", (0, 25, -4)),
        make_bone("mouth_closed", "head", (0, 25, -4)),
    )
)


def _motion(**morphs: list[tuple[int, float]]) -> SourceMotion:
    tracks = {
        name: MorphTrack(
            name, np.array([f for f, _ in keys], float), np.array([w for _, w in keys])
        )
        for name, keys in morphs.items()
    }
    return SourceMotion("m", 30.0, 30, morphs=tracks)


def _run(rules: list[dict[str, Any]], motion: SourceMotion) -> tuple[Animation, Diagnostics]:
    diagnostics = Diagnostics()
    parsed = [MorphRule.model_validate(r) for r in rules]
    resolved = resolve_morph_rules(parsed, SKELETON, motion, diagnostics)
    animation = Animation("a", np.array([0.0, 0.5, 1.0]), 1.0)
    apply_morph_rules(animation, SKELETON, motion, resolved)
    return animation, diagnostics


def _scales(animation: Animation, bone: str) -> np.ndarray:
    scales = animation.tracks[bone].scales
    assert scales is not None
    return scales


# --- schema ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rule", "message"),
    [
        ({"morph": "あ", "bone": "mouth"}, "exactly one"),
        ({"morph": "あ", "bone": "mouth", "scale": [1, 2, 1], "show_above": 0.5}, "exactly one"),
        (
            {"morph": "あ", "bone": "mouth", "position": [0, 1, 0], "scale_from": [0, 0, 0]},
            "scale_from",
        ),
        ({"morph": [], "bone": "mouth", "show_above": 0.5}, "at least one morph"),
    ],
)
def test_invalid_rules_are_explained(rule: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        MorphRule.model_validate(rule)


# --- applying rules -------------------------------------------------------------------------


def test_scale_blends_with_the_morph_weight() -> None:
    animation, _ = _run(
        [{"morph": "まばたき", "bone": "lid", "scale_from": [1, 0, 1], "scale": [1, 1, 1]}],
        _motion(まばたき=[(0, 0.0), (30, 1.0)]),
    )
    expected = np.array([[1, 0, 1], [1, 0.5, 1], [1, 1, 1]])
    np.testing.assert_allclose(_scales(animation, "lid"), expected)


def test_strongest_listed_morph_counts_and_rules_combine() -> None:
    animation, _ = _run(
        [
            {"morph": ["あ", "お"], "bone": "mouth", "scale": [1, 3, 1]},
            {"morph": "い", "bone": "mouth", "scale": [2, 1, 1]},
        ],
        _motion(あ=[(0, 0.5)], お=[(0, 1.0)], い=[(0, 1.0)]),
    )
    np.testing.assert_allclose(_scales(animation, "mouth")[0], [2, 3, 1])  # multiplied


def test_swaps_show_and_hide_bones() -> None:
    animation, _ = _run(
        [
            {"morph": "あ", "bone": "mouth_a", "show_above": 0.5},
            {"morph": "あ", "bone": "mouth_closed", "hide_above": 0.5},
        ],
        _motion(あ=[(0, 0.0), (30, 1.0)]),
    )
    np.testing.assert_allclose(_scales(animation, "mouth_a")[:, 1], [0, 1, 1])
    np.testing.assert_allclose(_scales(animation, "mouth_closed")[:, 1], [1, 0, 0])


def test_position_and_rotation_use_blockbench_values() -> None:
    animation, _ = _run(
        [
            {"morph": "あ", "bone": "mouth", "position": [0, -1, 0]},
            {"morph": "あ", "bone": "mouth", "rotation": [20, 0, 0]},
        ],
        _motion(あ=[(0, 1.0)]),
    )
    clip = json.loads(write_animation(animation, SKELETON))
    bones = clip["animations"]["a"]["bones"]["mouth"]
    assert bones["position"] == {"0.0": [0, -1, 0]}
    assert bones["rotation"] == {"0.0": [20, 0, 0]}


def test_scale_channel_is_written_and_rest_is_omitted() -> None:
    animation, _ = _run(
        [{"morph": "あ", "bone": "mouth_a", "show_above": 0.5}], _motion(あ=[(0, 0.0), (30, 1.0)])
    )
    animation.tracks["mouth"] = BoneTrack(scales=np.ones((3, 3)))
    bones = json.loads(write_animation(animation, SKELETON))["animations"]["a"]["bones"]
    assert bones["mouth_a"]["scale"] == {"0.0": [0, 0, 0], "0.5": [1, 1, 1], "1.0": [1, 1, 1]}
    assert "mouth" not in bones  # scale 1 everywhere is the rest pose


def test_diagnostics_and_unknown_bones() -> None:
    motion = _motion(あ=[(0, 1.0)], まばたき=[(0, 1.0)])
    _, diagnostics = _run([], motion)
    assert (
        "no morph rules"
        in next(d for d in diagnostics.items if d.code is Code.UNSUPPORTED_MORPHS).message
    )
    _, diagnostics = _run([{"morph": "あ", "bone": "mouth", "scale": [1, 2, 1]}], motion)
    dropped = next(d for d in diagnostics.items if d.code is Code.UNSUPPORTED_MORPHS)
    assert dropped.bones == ("まばたき",)
    assert Code.FACIAL_ANIMATION in diagnostics.codes()
    with pytest.raises(MappingError, match="did you mean 'mouth'"):
        _run([{"morph": "あ", "bone": "mouht", "scale": [1, 2, 1]}], motion)


def test_sample_morph_is_linear_and_held() -> None:
    track = MorphTrack("あ", np.array([10.0, 20.0]), np.array([0.0, 1.0]))
    np.testing.assert_allclose(sample_morph(track, [0, 15, 30]), [0, 0.5, 1])


# --- generated face rules ----------------------------------------------------------------------


def _face(*groups: Any) -> list[dict[str, Any]]:
    skeleton = parse_bbmodel(
        bbmodel(
            group("body", None, (0, 12, 0), cube=((-4, 12, -2), (4, 24, 2))),
            group("head", "body", (0, 24, 0), cube=((-4, 24, -4), (4, 32, 4))),
            group("leg_l", None, (-2, 12, 0), cube=((-4, 0, -2), (0, 12, 2))),
            group("leg_r", None, (2, 12, 0), cube=((0, 0, -2), (4, 12, 2))),
            *groups,
        ),
        Path("face.bbmodel"),
    ).skeleton
    return face_rules(skeleton, detect_roles(skeleton, set()))


def test_eyes_group_single_eyes_and_lashes() -> None:
    rules = _face(
        group("Eyes", "head", (0, 27, -4)),
        group("LeftEye", "Eyes", (-2, 27, -4)),
        group("RightEye", "Eyes", (2, 27, -4)),
        group("LeftEyeLash", "LeftEye", (-2, 28, -4)),
        group("Mouth", "head", (0, 25, -4)),
    )
    by_bone: dict[str, list[dict[str, Any]]] = {}
    for rule in rules:
        by_bone.setdefault(rule["bone"], []).append(rule)
    assert "まばたき" in by_bone["Eyes"][0]["morph"]
    assert "ウィンク" in by_bone["LeftEye"][0]["morph"]  # side from the pivot (x < 0)
    assert "まばたき" not in by_bone["LeftEye"][0]["morph"]  # the group already blinks
    assert "LeftEyeLash" not in by_bone
    assert len(by_bone["Mouth"]) == 5  # one scale per vowel


def test_eyelids_and_mouth_shapes() -> None:
    rules = _face(
        group("eyelid_right", "head", (2, 28, -4)),
        group("mouth_closed", "head", (0, 25, -4)),
        group("mouth_o", "head", (0, 25, -4)),
    )
    lid = next(r for r in rules if r["bone"] == "eyelid_right")
    assert lid["scale_from"] == [1, 0, 1]
    assert "ウィンク右" in lid["morph"]
    mouth_o = next(r for r in rules if r["bone"] == "mouth_o")
    assert mouth_o["morph"][0] == "お"
    assert "お２" in mouth_o["morph"]  # variant names drive the same shape
    assert mouth_o["show_above"] == 0.5
    assert next(r for r in rules if r["bone"] == "mouth_closed")["hide_above"] == 0.5
