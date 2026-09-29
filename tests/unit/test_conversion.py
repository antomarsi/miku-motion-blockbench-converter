import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from miku_motion.animation.clip import LoopMode
from miku_motion.animation.sampling import sample_times, sample_track
from miku_motion.animation.skeleton import Skeleton
from miku_motion.blockbench.bbmodel import parse_bbmodel
from miku_motion.conversion.coordinates import MMD_TO_CANONICAL, BasisChange
from miku_motion.conversion.retarget import retarget
from miku_motion.diagnostics import Diagnostics
from miku_motion.geometry import euler, quat
from miku_motion.mapping.resolve import resolve
from miku_motion.mapping.schema import MappingFile
from miku_motion.vmd.adapter import to_source_motion
from miku_motion.vmd.types import VmdBoneKey
from tests.fixtures.builders import axis_angle, bbmodel, bone_key, group, player_rig, vmd

component = st.floats(min_value=-1, max_value=1, allow_nan=False)
A_POSE_DEGREES = 37.0

# --- basis change -----------------------------------------------------------------------------


def test_mmd_basis_mirrors_x() -> None:
    np.testing.assert_allclose(MMD_TO_CANONICAL.points([1.0, 2.0, 3.0], scale=2), [-2, 4, 6])
    q = axis_angle((0, 0, 1), 30)
    np.testing.assert_allclose(MMD_TO_CANONICAL.rotations(q), [0, 0, -q[2], q[3]])
    assert MMD_TO_CANONICAL.determinant == pytest.approx(-1)


@given(st.lists(component, min_size=4, max_size=4), st.lists(component, min_size=3, max_size=3))
def test_basis_change_preserves_rotation_meaning(q: list[float], v: list[float]) -> None:
    """Rotating then converting equals converting then rotating."""
    if np.linalg.norm(q) < 1e-3:
        return
    q_src = quat.normalize(q)
    rotated_then_converted = MMD_TO_CANONICAL.points(quat.rotate(q_src, v))
    converted_then_rotated = quat.rotate(
        MMD_TO_CANONICAL.rotations(q_src), MMD_TO_CANONICAL.points(v)
    )
    np.testing.assert_allclose(rotated_then_converted, converted_then_rotated, atol=1e-9)


def test_basis_must_be_orthogonal() -> None:
    with pytest.raises(ValueError, match="orthogonal"):
        BasisChange("bad", np.diag([2.0, 1.0, 1.0]))


# --- retargeting ------------------------------------------------------------------------------


def _run(
    keys: list[VmdBoneKey],
    bones: dict[str, Any],
    rig: dict[str, Any] | None = None,
    scale: float = 1.0,
) -> tuple[Any, Skeleton]:
    skeleton = parse_bbmodel(rig or player_rig(), Path("rig.bbmodel")).skeleton
    motion = to_source_motion(vmd(*keys), Diagnostics())
    mapping = MappingFile.model_validate({"bones": bones, "units": {"translation_scale": scale}})
    resolved = resolve(mapping, skeleton, motion, Diagnostics())
    times = sample_times(motion.duration, 30)
    poses = {
        name: sample_track(track, times * motion.frame_rate)
        for name, track in motion.tracks.items()
    }
    animation = retarget(
        poses, times, resolved, skeleton, MMD_TO_CANONICAL, name="t", loop=LoopMode.LOOP
    )
    return animation, skeleton


def test_one_to_one_mapping_copies_converted_rotation() -> None:
    q = axis_angle((0, 0, 1), 60)
    animation, _ = _run([bone_key("頭", 0, rotation=q)], {"Head": "頭"})
    assert quat.allclose_rotation(
        animation.tracks["Head"].rotations[0], MMD_TO_CANONICAL.rotations(q)
    )
    assert animation.loop is LoopMode.LOOP
    assert animation.tracks["Head"].translations is None


def test_chain_multiplies_parent_to_child() -> None:
    a, b = axis_angle((1, 0, 0), 30), axis_angle((0, 1, 0), 40)
    animation, _ = _run(
        [bone_key("首", 0, rotation=a), bone_key("頭", 0, rotation=b)],
        {"Head": {"from": ["首", "頭"]}},
    )
    expected = MMD_TO_CANONICAL.rotations(quat.mul(a, b))
    assert quat.allclose_rotation(animation.tracks["Head"].rotations[0], expected)


def test_negative_weight_cancels_a_bone() -> None:
    waist = axis_angle((0, 1, 0), 25)
    animation, _ = _run(
        [bone_key("腰", 0, rotation=waist)],
        {"LeftLeg": {"from": ["腰", "下半身", {"bone": "腰", "weight": -1}, "左足"]}},
    )
    assert quat.allclose_rotation(animation.tracks["LeftLeg"].rotations[0], quat.identity())


def test_half_weight_halves_the_angle() -> None:
    animation, _ = _run(
        [bone_key("頭", 0, rotation=axis_angle((0, 1, 0), 40))],
        {"Head": {"from": [{"bone": "頭", "weight": 0.5}]}},
    )
    assert quat.angle(animation.tracks["Head"].rotations[0]) == pytest.approx(math.radians(20))


def test_target_rest_rotation_is_kept() -> None:
    animation, skeleton = _run([bone_key("上半身2", 0)], {"Chest": "上半身2"})
    assert quat.allclose_rotation(
        animation.tracks["Chest"].rotations[0], skeleton["Chest"].rest_rotation
    )


def test_rest_rotation_of_parent_changes_the_local_frame() -> None:
    rig = bbmodel(group("Parent", None, rotation=(0, 90, 0)), group("Child", "Parent"))
    q = axis_angle((1, 0, 0), 30)  # a world-axis rotation in the source
    animation, skeleton = _run([bone_key("子", 0, rotation=q)], {"Child": "子"}, rig=rig)
    # World orientation = the source's world-space delta applied to the rest orientation.
    world = quat.mul(skeleton["Parent"].rest_rotation, animation.tracks["Child"].rotations[0])
    expected = quat.mul(MMD_TO_CANONICAL.rotations(q), skeleton.rest_world_rotation("Child"))
    assert quat.allclose_rotation(world, expected)


def _arm_direction(animation: Any, skeleton: Skeleton, sample: int) -> np.ndarray:
    world = quat.mul(
        skeleton.rest_world_rotation("Body"), animation.tracks["LeftArm"].rotations[sample]
    )
    return quat.rotate(world, [0.0, -1.0, 0.0])  # the target arm hangs straight down


def test_rest_correction_matches_arm_direction_to_a_posed_source() -> None:
    """An arms-down target follows an A-pose source: at rest and after a raise."""
    raise_to_t_pose = axis_angle((0, 0, 1), A_POSE_DEGREES)
    animation, skeleton = _run(
        [bone_key("左腕", 0), bone_key("左腕", 30, rotation=raise_to_t_pose)],
        {
            "Body": "上半身",
            "LeftArm": {
                "from": ["左腕"],
                "rest_correction": {"euler_deg": [0, 0, -(90 - A_POSE_DEGREES)]},
            },
        },
    )
    a = math.radians(A_POSE_DEGREES)
    source_at_rest = MMD_TO_CANONICAL.points([math.cos(a), -math.sin(a), 0.0])
    np.testing.assert_allclose(_arm_direction(animation, skeleton, 0), source_at_rest, atol=1e-9)
    np.testing.assert_allclose(_arm_direction(animation, skeleton, -1), [-1, 0, 0], atol=1e-9)


def test_child_of_corrected_bone_bends_in_the_corrected_frame() -> None:
    correction = {"euler_deg": [0, 0, -53]}
    bend = axis_angle((0, 0, 1), 30)
    animation, _ = _run(
        [bone_key("左ひじ", 0, rotation=bend)],
        {
            "LeftArm": {"from": ["左腕"], "rest_correction": correction},
            "LowerLeftArm": {"from": ["左ひじ"], "rest_correction": correction},
        },
    )
    d = euler.to_quat(np.radians(correction["euler_deg"]))
    expected = quat.mul_chain(quat.inverse(d), MMD_TO_CANONICAL.rotations(bend), d)
    assert quat.allclose_rotation(animation.tracks["LowerLeftArm"].rotations[0], expected)


def test_translation_composes_chain_and_scales() -> None:
    turn = axis_angle((0, 1, 0), 90)
    animation, _ = _run(
        [
            bone_key("全ての親", 0, position=(1, 0, 0), rotation=turn),
            bone_key("センター", 0, position=(0, 0, 2)),
        ],
        {"Root": {"from": ["全ての親", "センター"], "translation": True}},
        scale=10,
    )
    # parent offset + parent rotation applied to the child's offset, then mirrored and scaled
    expected = MMD_TO_CANONICAL.points(
        np.array([1.0, 0, 0]) + quat.rotate(np.array(turn), [0, 0, 2]), scale=10
    )
    np.testing.assert_allclose(animation.tracks["Root"].translations[0], expected, atol=1e-9)


def test_missing_source_bone_stays_at_rest() -> None:
    animation, _ = _run([bone_key("頭", 0)], {"Head": {"from": ["首", "頭"]}})
    assert quat.allclose_rotation(animation.tracks["Head"].rotations, quat.identity(1))


def test_samples_cover_the_motion() -> None:
    animation, _ = _run([bone_key("頭", 0), bone_key("頭", 45)], {"Head": "頭"})
    assert animation.length == pytest.approx(1.5)
    assert len(animation.times) == 46
