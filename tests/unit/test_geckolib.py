import json
import math

import numpy as np
import pytest

from miku_motion.animation.clip import Animation, BoneTrack, LoopMode
from miku_motion.animation.skeleton import Skeleton, make_bone
from miku_motion.geckolib import encoding
from miku_motion.geckolib.writer import format_number, format_time, write_animation
from miku_motion.geometry import quat

SKELETON = Skeleton(
    (
        make_bone("root", None),
        make_bone("tilted", "root", (0, 10, 0), (20, 0, 0)),
        make_bone("still", "root"),
    )
)


def _z(degrees: float) -> np.ndarray:
    return quat.from_axis_angle([0, 0, 1], math.radians(degrees))


# --- encoding ----------------------------------------------------------------------------------


def test_rotation_is_delta_from_rest_with_bedrock_signs() -> None:
    x10 = quat.from_axis_angle([1, 0, 0], math.radians(10))
    values = encoding.rotation_channel(SKELETON["root"], np.stack([_z(10), x10]))
    np.testing.assert_allclose(values, [[0, 0, 10], [-10, 0, 0]], atol=1e-9)


def test_rest_rotation_encodes_as_zero() -> None:
    tilted = SKELETON["tilted"]
    values = encoding.rotation_channel(tilted, np.stack([tilted.rest_rotation]))
    np.testing.assert_allclose(values, [[0, 0, 0]], atol=1e-9)


def test_rotation_stays_continuous_past_180() -> None:
    values = encoding.rotation_channel(SKELETON["root"], np.stack([_z(170), _z(190), _z(210)]))
    np.testing.assert_allclose(values[:, 2], [170, 190, 210], atol=1e-9)


def test_position_flips_x() -> None:
    np.testing.assert_allclose(encoding.position_channel(np.array([[1.0, 2, 3]])), [[-1, 2, 3]])


# --- number formatting -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "text"),
    [(0.0, "0"), (-0.0, "0"), (-0.00001, "0"), (1.0, "1"), (12.5, "12.5"), (1 / 3, "0.3333")],
)
def test_format_number(value: float, text: str) -> None:
    assert format_number(value) == text


def test_format_time() -> None:
    assert [format_time(t) for t in (0.0, 0.05, 1.0, 151.26666)] == [
        "0.0",
        "0.05",
        "1.0",
        "151.2667",
    ]


# --- writer --------------------------------------------------------------------------------------


def _animation(**tracks: BoneTrack) -> Animation:
    return Animation(
        name="animation.rig.test", times=np.array([0.0, 0.5, 1.0]), length=1.0, tracks=tracks
    )


def test_document_structure() -> None:
    animation = _animation(
        root=BoneTrack(
            np.stack([_z(0), _z(45), _z(90)]), np.array([[0, 0, 0], [0, 1, 0], [0, 2, 0]])
        )
    )
    text = write_animation(animation, SKELETON)
    document = json.loads(text)
    clip = document["animations"]["animation.rig.test"]
    assert document["format_version"] == "1.8.0"
    assert clip["loop"] is False
    assert clip["animation_length"] == 1
    assert clip["bones"]["root"]["rotation"] == {
        "0.0": [0, 0, 0],
        "0.5": [0, 0, 45],
        "1.0": [0, 0, 90],
    }
    assert clip["bones"]["root"]["position"]["1.0"] == [0, 2, 0]
    assert list(clip["bones"]["root"]) == ["rotation", "position"]
    assert '        "0.5": [0, 0, 45],\n' in text  # one keyframe per line


def test_constant_channel_is_one_key_and_rest_channel_is_omitted() -> None:
    tilted = SKELETON["tilted"].rest_rotation
    animation = _animation(
        root=BoneTrack(np.stack([_z(30)] * 3)),
        tilted=BoneTrack(np.stack([tilted] * 3), np.zeros((3, 3))),
    )
    bones = json.loads(write_animation(animation, SKELETON))["animations"]["animation.rig.test"][
        "bones"
    ]
    assert bones == {"root": {"rotation": {"0.0": [0, 0, 30]}}}


def test_bones_follow_skeleton_order_and_loop_modes() -> None:
    animation = _animation(
        tilted=BoneTrack(np.stack([_z(5)] * 3)), root=BoneTrack(np.stack([_z(5)] * 3))
    )
    animation.loop = LoopMode.HOLD
    clip = json.loads(write_animation(animation, SKELETON))["animations"]["animation.rig.test"]
    assert list(clip["bones"]) == ["root", "tilted"]
    assert clip["loop"] == "hold_on_last_frame"


def test_empty_bones_is_valid_json() -> None:
    clip = json.loads(write_animation(_animation(), SKELETON))["animations"]["animation.rig.test"]
    assert clip["bones"] == {}


def test_time_collision_is_rejected() -> None:
    animation = Animation(name="a", times=np.array([0.0, 0.00001]), length=0.00001)
    with pytest.raises(ValueError, match="collide"):
        write_animation(animation, SKELETON)


def test_output_is_deterministic() -> None:
    animation = _animation(root=BoneTrack(np.stack([_z(0.1), _z(-0.00001), _z(33.33333)])))
    assert write_animation(animation, SKELETON) == write_animation(animation, SKELETON)
    assert "-0" not in write_animation(animation, SKELETON)
