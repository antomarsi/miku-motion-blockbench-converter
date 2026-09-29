import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from miku_motion.animation.sampling import PoseSamples
from miku_motion.animation.source import SourceMotion
from miku_motion.geometry import quat
from miku_motion.rig.ik import _Kinematics, ik_enabled, rest_pose, solve_chain, solve_ik
from miku_motion.rig.schema import SkeletonError, load_skeleton, parse_skeleton
from tests.fixtures.builders import write_json


def _leg(**ik_overrides: Any) -> dict[str, Any]:
    """A straight 10-unit leg: hip at y=10, knee at y=5 (slightly forward), ankle at 0."""
    ik = {
        "bone": "LegIK",
        "target": "Ankle",
        "links": [
            {"bone": "Knee", "min_deg": [-180, 0, 0], "max_deg": [-0.5, 0, 0]},
            {"bone": "Thigh"},
        ],
    }
    ik.update(ik_overrides)
    return {
        "name": "leg",
        "bones": [
            {"name": "Hip", "parent": None, "position": [0, 10, 0]},
            {"name": "Thigh", "parent": "Hip", "position": [0, 10, 0]},
            {"name": "Knee", "parent": "Thigh", "position": [0, 5, -0.1]},
            {"name": "Ankle", "parent": "Knee", "position": [0, 0, 0]},
            {"name": "LegIK", "parent": None, "position": [0, 0, 0]},
        ],
        "ik": [ik],
    }


def _poses(n: int, goal_offsets: list[list[float]]) -> dict[str, PoseSamples]:
    poses = {name: rest_pose(n) for name in ("Hip", "Thigh", "Knee", "Ankle")}
    poses["LegIK"] = PoseSamples(np.array(goal_offsets, dtype=float), quat.identity(n))
    return poses


def _effector(rig: Any, poses: dict[str, PoseSamples], n: int) -> np.ndarray:
    return _Kinematics(rig, poses, n).world("Ankle")[1]


# --- skeleton files ---------------------------------------------------------------------------


def test_builtin_skeleton_loads() -> None:
    rig = load_skeleton("mmd-standard")
    assert [c.bone for c in rig.ik][:2] == ["左足ＩＫ", "右足ＩＫ"]
    knee = rig.ik[0].links[0]
    assert knee.hinge_axis == 0
    assert "腰" in rig.required_bones()  # inherited by the waist-cancel bones


def test_skeleton_from_file_and_unknown_builtin(tmp_path: Path) -> None:
    rig = load_skeleton(write_json(tmp_path / "leg.json", _leg()))
    assert rig.name == "leg"
    with pytest.raises(SkeletonError, match="available: \\['mmd-standard'\\]"):
        load_skeleton("nope")
    with pytest.raises(SkeletonError, match="cannot read"):
        load_skeleton(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    with pytest.raises(SkeletonError, match="not valid JSON"):
        load_skeleton(bad)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: d["bones"].reverse(), "must come after its parent"),
        (lambda d: d["bones"].append(d["bones"][0]), "listed twice"),
        (lambda d: d["bones"][1].update(inherit={"bone": "X", "weight": 1}), "unknown bone 'X'"),
        (lambda d: d["ik"][0]["links"].reverse(), "must be the parent of"),
        (lambda d: d["ik"][0].update(target="Nope"), "unknown bones"),
        (lambda d: d.update(bones=[]), "invalid skeleton file"),
    ],
)
def test_invalid_skeletons_are_explained(mutate: Any, message: str) -> None:
    data = _leg()
    mutate(data)
    with pytest.raises(SkeletonError, match=message):
        parse_skeleton(data, "test")


# --- forward kinematics ---------------------------------------------------------------------------


def test_forward_kinematics_composes_offsets_and_rotations() -> None:
    rig = parse_skeleton(_leg(), "t")
    poses = _poses(1, [[0, 0, 0]])
    turn = quat.from_axis_angle([0, 0, 1], math.pi / 2)[None]
    poses["Thigh"] = PoseSamples(np.zeros((1, 3)), turn)
    poses["Hip"] = PoseSamples(np.array([[1.0, 0, 0]]), quat.identity(1))
    # The thigh points down 5 units to the knee; rotated 90 deg about Z it points +X
    # (the knee's small forward -Z offset is unaffected).
    np.testing.assert_allclose(
        _Kinematics(rig, poses, 1).world("Knee")[1], [[1 + 5, 10, -0.1]], atol=1e-9
    )


def test_inherit_with_negative_weight_cancels() -> None:
    data = _leg()
    data["bones"].insert(1, {"name": "Waist", "parent": "Hip", "position": [0, 10, 0]})
    data["bones"][2] = {
        "name": "Thigh",
        "parent": "Waist",
        "position": [0, 10, 0],
        "inherit": {"bone": "Waist", "weight": -1},
    }
    rig = parse_skeleton(data, "t")
    poses = _poses(1, [[0, 0, 0]])
    poses["Waist"] = PoseSamples(np.zeros((1, 3)), quat.from_axis_angle([0, 1, 0], 0.7)[None])
    world_rot = _Kinematics(rig, poses, 1).world("Thigh")[0]
    assert quat.allclose_rotation(world_rot, quat.identity(1))


# --- solving ------------------------------------------------------------------------------------


def test_reachable_goals_are_reached_by_bending_the_knee_backwards() -> None:
    rig = parse_skeleton(_leg(), "t")
    goals: list[list[float]] = [[0, 0, 0], [0, 2, 0], [0, 4, 1], [1, 3, -1]]
    poses = _poses(4, goals)
    residuals = solve_chain(rig, rig.ik[0], poses, np.ones(4, dtype=bool))

    assert residuals.max() < 1e-3
    np.testing.assert_allclose(_effector(rig, poses, 4), goals, atol=1e-3)
    knee_x = 2 * np.arctan2(poses["Knee"].rotations[:, 0], poses["Knee"].rotations[:, 3])
    assert np.all(knee_x <= math.radians(-0.5) + 1e-9)  # MMD knees bend with negative X
    assert knee_x[1] < math.radians(-30)  # raising the foot 2 units bends it clearly


def test_unreachable_goal_straightens_towards_it() -> None:
    rig = parse_skeleton(_leg(), "t")
    poses = _poses(1, [[0, -3, 0]])
    residuals = solve_chain(rig, rig.ik[0], poses, np.ones(1, dtype=bool))
    assert residuals[0] == pytest.approx(3.0, abs=0.05)


def test_disabled_samples_keep_forward_kinematics() -> None:
    rig = parse_skeleton(_leg(), "t")
    poses = _poses(2, [[0, 3, 0], [0, 3, 0]])
    residuals = solve_chain(rig, rig.ik[0], poses, np.array([True, False]))
    assert residuals[1] == 0
    assert quat.allclose_rotation(poses["Knee"].rotations[1], quat.identity())
    assert not quat.allclose_rotation(poses["Knee"].rotations[0], quat.identity())


def test_free_link_with_euler_limits_is_clamped() -> None:
    data = _leg()
    data["ik"][0]["links"][1] = {
        "bone": "Thigh",
        "min_deg": [-10, -10, -10],
        "max_deg": [10, 10, 10],
    }
    rig = parse_skeleton(data, "t")
    poses = _poses(1, [[4, 5, 0]])
    solve_chain(rig, rig.ik[0], poses, np.ones(1, dtype=bool))
    assert math.degrees(quat.angle(poses["Thigh"].rotations[0])) <= 10 * math.sqrt(3) + 1e-6


def test_ik_switches_follow_the_motion() -> None:
    motion = SourceMotion("m", 30.0, 60, ik_states={"LegIK": ((0, True), (30, False))})
    np.testing.assert_array_equal(
        ik_enabled(motion, "LegIK", np.array([0.0, 29.5, 30.0, 45.0])), [True, True, False, False]
    )
    assert ik_enabled(motion, "Other", np.array([0.0])).all()


def test_solve_ik_fills_missing_bones_at_rest() -> None:
    rig = parse_skeleton(_leg(), "t")
    poses = {"LegIK": PoseSamples(np.array([[0.0, 1.0, 0.0]]), quat.identity(1))}
    results = solve_ik(rig, SourceMotion("m", 30.0, 0), poses, np.array([0.0]))
    assert {"Hip", "Thigh", "Knee", "Ankle"} <= poses.keys()
    assert results[0].enabled_fraction == 1.0
    # A goal just inside a straight leg's reach converges slowly with CCD (MMD too);
    # the result is within the pipeline's 0.1-unit reach tolerance.
    assert results[0].residuals[0] < 0.1
