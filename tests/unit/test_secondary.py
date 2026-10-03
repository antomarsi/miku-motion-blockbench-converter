import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from miku_motion.animation.clip import Animation, BoneTrack
from miku_motion.animation.skeleton import Skeleton, make_bone
from miku_motion.blockbench.bbmodel import parse_bbmodel
from miku_motion.conversion.secondary import ChainSpec, apply_secondary_motion, world_transforms
from miku_motion.errors import MappingError
from miku_motion.geometry import quat
from miku_motion.mapping.schema import MappingFile
from miku_motion.mapping.secondary import (
    PRESETS,
    _tokens,
    damping_for,
    resolve_secondary,
    suggest_chains,
)
from tests.fixtures.builders import bbmodel, group

SKELETON = Skeleton(
    (
        make_bone("Head", None, (0, 10, 0)),
        make_bone("Strand", "Head", (2, 10, 0)),
        make_bone("Strand2", "Strand", (2, 5, 0)),
    )
)
TIP = np.array([2.0, 0.0, 0.0])


def _chain(**overrides: Any) -> ChainSpec:
    values: dict[str, Any] = {"stiffness": 40.0, "damping": 6.0, "gravity": 1.0}
    values.update(overrides)
    return ChainSpec(("Strand", "Strand2"), TIP, **values)


def _animation(head_x: np.ndarray, fps: float = 60.0) -> Animation:
    times = np.arange(len(head_x)) / fps
    offsets = np.stack([head_x, np.zeros_like(head_x), np.zeros_like(head_x)], axis=1)
    track = BoneTrack(quat.identity(len(times)), offsets)
    return Animation("a", times, float(times[-1]), tracks={"Head": track})


def _tip(animation: Animation) -> np.ndarray:
    """World position of the strand's tip, through the generated rotations."""
    rot, pos = world_transforms(SKELETON, animation, {"Strand2"})["Strand2"]
    rest = SKELETON.rest_world_rotation("Strand2")
    return pos + quat.rotate(rot, quat.rotate(quat.inverse(rest), TIP - SKELETON["Strand2"].pivot))


def _swing_degrees(animation: Animation) -> np.ndarray:
    rotations = animation.tracks["Strand"].rotations
    assert rotations is not None
    return np.degrees(quat.angle(rotations))


def test_still_body_leaves_the_chain_hanging_at_rest() -> None:
    animation = _animation(np.zeros(120))
    apply_secondary_motion(animation, SKELETON, [_chain()])
    assert _swing_degrees(animation).max() < 0.01
    np.testing.assert_allclose(_tip(animation), np.tile(TIP, (120, 1)), atol=1e-3)


def test_segment_lengths_are_kept() -> None:
    head_x = np.concatenate([np.linspace(0, 8, 15), np.full(60, 8.0)])
    animation = _animation(head_x)
    apply_secondary_motion(animation, SKELETON, [_chain()])
    joints = world_transforms(SKELETON, animation, {"Strand", "Strand2"})
    first = np.linalg.norm(joints["Strand2"][1] - joints["Strand"][1], axis=1)
    second = np.linalg.norm(_tip(animation) - joints["Strand2"][1], axis=1)
    np.testing.assert_allclose(first, 5.0, atol=1e-6)
    np.testing.assert_allclose(second, 5.0, atol=1e-6)


def test_chain_lags_behind_then_settles() -> None:
    head_x = np.concatenate([np.linspace(0, 8, 15), np.full(300, 8.0)])  # quick step, then hold
    animation = _animation(head_x)
    apply_secondary_motion(animation, SKELETON, [_chain()])
    tip_x = _tip(animation)[:, 0]
    assert tip_x[14] < 2 + 8 - 1  # trails the moving head
    assert _swing_degrees(animation)[14] > 5
    assert abs(tip_x[-1] - (2 + 8)) < 0.05  # hangs straight again
    assert _swing_degrees(animation)[-1] < 0.5


def test_stiffer_chains_lag_less() -> None:
    head_x = np.concatenate([np.linspace(0, 8, 15), np.full(60, 8.0)])
    soft, stiff = _animation(head_x), _animation(head_x)
    apply_secondary_motion(soft, SKELETON, [_chain(stiffness=20.0)])
    apply_secondary_motion(stiff, SKELETON, [_chain(stiffness=400.0)])
    # Inertia dominates the first instant either way; stiffer hair swings less and
    # settles much sooner.
    assert _swing_degrees(stiff).max() < 0.7 * _swing_degrees(soft).max()
    assert _swing_degrees(stiff)[30:].max() < 0.5 * _swing_degrees(soft)[30:].max()


def test_simulation_is_deterministic() -> None:
    head_x = np.sin(np.linspace(0, 6, 90)) * 4
    first, second = _animation(head_x), _animation(head_x)
    apply_secondary_motion(first, SKELETON, [_chain()])
    apply_secondary_motion(second, SKELETON, [_chain()])
    np.testing.assert_array_equal(
        first.tracks["Strand2"].rotations, second.tracks["Strand2"].rotations
    )


# --- mapping validation ---------------------------------------------------------------------

RIG = parse_bbmodel(
    bbmodel(
        group("Head", None, (0, 24, 0)),
        group("Tail", "Head", (4, 32, 3)),
        group("TailMid", "Tail", (6, 24, 3)),
        group("TailEnd", "TailMid", (6, 15, 3), cube=((4, 6, 0.5), (8, 15, 5.5))),
        group("Ponytail", "Head", (0, 30, 5), cube=((-1, 18, 4), (1, 30, 6))),  # one bone
        group("Ribbon", "Head", (0, 30, 3)),  # no cubes
    ),
    Path("rig.bbmodel"),
).skeleton


def _resolve(chains: list[dict[str, Any]], bones: dict[str, Any] | None = None) -> list[ChainSpec]:
    mapping = MappingFile.model_validate(
        {"bones": bones or {"Head": "頭"}, "secondary_motion": chains}
    )
    return resolve_secondary(mapping, RIG)


def test_tip_comes_from_the_last_bones_cubes() -> None:
    (chain,) = _resolve([{"bones": ["Tail", "TailMid", "TailEnd"], "stiffness": 30}])
    np.testing.assert_allclose(chain.tip, [6, 6, 3])  # bottom of the end cube
    assert chain.stiffness == 30
    assert chain.damping == pytest.approx(damping_for(30, PRESETS["long_hair"].bounciness))


def test_single_bone_ponytail_needs_no_configuration() -> None:
    (chain,) = _resolve([{"bones": ["Ponytail"], "preset": "ponytail"}])
    np.testing.assert_allclose(chain.tip, [0, 18, 5])
    assert chain.stiffness == PRESETS["ponytail"].stiffness


def test_tip_falls_back_to_extending_the_last_segment() -> None:
    (chain,) = _resolve([{"bones": ["Tail", "TailMid"]}])  # TailMid has no cubes
    np.testing.assert_allclose(chain.tip, [8, 16, 3])


def test_bounciness_and_presets() -> None:
    bouncy, still = _resolve(
        [
            {"bones": ["Tail"], "tip": [4, 24, 3], "bounciness": 0.9},
            {"bones": ["Ponytail"], "bounciness": 0},
        ]
    )
    assert bouncy.damping == pytest.approx(2 * math.sqrt(40) * 0.1)
    assert still.damping == pytest.approx(2 * math.sqrt(40))  # critically damped
    (short,) = _resolve([{"bones": ["Ponytail"], "preset": "short_hair", "gravity": 0}])
    assert (short.stiffness, short.gravity) == (PRESETS["short_hair"].stiffness, 0)


def test_bounciness_and_damping_are_exclusive() -> None:
    with pytest.raises(ValidationError, match="either bounciness or damping"):
        MappingFile.model_validate(
            {
                "bones": {"Head": "x"},
                "secondary_motion": [{"bones": ["Tail"], "bounciness": 0.5, "damping": 3}],
            }
        )


@pytest.mark.parametrize(
    ("chains", "message"),
    [
        ([{"bones": ["Tial"]}], "did you mean 'Tail'"),
        ([{"bones": ["Tail", "TailEnd"]}], "not a child of 'Tail'"),
        ([{"bones": ["Head", "Tail"]}], "already driven"),
        ([{"bones": ["Tail", "TailMid"]}, {"bones": ["TailMid", "TailEnd"]}], "already driven"),
        ([{"bones": ["Ribbon"]}], "has no cubes to measure"),
        ([{"bones": ["Ribbon"], "tip": [0, 30, 3]}], "share a position"),
    ],
)
def test_invalid_chains_are_explained(chains: list[dict[str, Any]], message: str) -> None:
    with pytest.raises(MappingError, match=message):
        _resolve(chains)


def test_offset_makes_the_chain_lean_without_stretching() -> None:
    animation = _animation(np.zeros(120))
    apply_secondary_motion(animation, SKELETON, [_chain(offset=np.array([0.0, 0.0, 4.0]))])
    tip = _tip(animation)
    assert tip[-1, 2] > 2.5  # pulled back towards +Z (behind the body)
    joints = world_transforms(SKELETON, animation, {"Strand2"})["Strand2"][1]
    np.testing.assert_allclose(np.linalg.norm(tip - joints, axis=1), 5.0, atol=1e-6)
    assert np.ptp(tip, axis=0).max() < 0.05  # settled before the first frame, then still


def test_offset_is_read_from_the_mapping() -> None:
    (chain,) = _resolve([{"bones": ["Tail", "TailMid", "TailEnd"], "offset": [0, 0, 4]}])
    np.testing.assert_array_equal(chain.offset, [0, 0, 4])


# --- suggestions ------------------------------------------------------------------------------

LOOKS = parse_bbmodel(
    bbmodel(
        group("Head", None, (0, 24, 0), cube=((-4, 24, -4), (4, 32, 4))),
        group("Hair PRNT", "Head", (0, 30, 0)),  # grouping node without cubes
        group("TwinTail1 L", "Hair PRNT", (-5, 28, 3), cube=((-7, 19, 1), (-3, 28, 5))),
        group("TwinTail2 L", "TwinTail1 L", (-5, 19, 3), cube=((-7, 8, 1), (-3, 19, 5))),
        group("Bangs", "Hair PRNT", (0, 31, -3), cube=((-4, 26, -4), (4, 31, -3))),
        group("RightElbow", "Head", (4, 18, 0), cube=((3, 12, -1), (5, 18, 1))),
        group("NeckTie", "Head", (0, 23, -2), cube=((-1, 18, -3), (1, 23, -2))),
    ),
    Path("looks.bbmodel"),
).skeleton


def _suggest(
    bones: dict[str, Any] | None = None, chains: list[Any] | None = None
) -> dict[str, Any]:
    mapping = MappingFile.model_validate(
        {"bones": bones or {"Head": "頭"}, "secondary_motion": chains or []}
    )
    return {" > ".join(s.bones): s.preset for s in suggest_chains(LOOKS, mapping)}


def test_suggests_hair_and_accessories_by_name_and_shape() -> None:
    assert _suggest() == {
        "TwinTail1 L > TwinTail2 L": "long_hair",  # "TwinTail" spans tokens; long chain
        "Bangs": "short_hair",
        "NeckTie": "accessory",
    }  # "RightElbow" is not a "bow"; "Hair PRNT" has no cubes of its own


def test_suggestions_skip_bones_already_in_use() -> None:
    suggested = _suggest(
        bones={"Head": "頭", "NeckTie": "ネクタイ"},
        chains=[{"bones": ["Bangs"], "tip": [0, 26, -3]}],
    )
    assert suggested == {"TwinTail1 L > TwinTail2 L": "long_hair"}


def test_token_split() -> None:
    assert _tokens("SquareHair_Right2") == ["square", "hair", "right", "2"]
    assert _tokens("TwinTail1 L") == ["twin", "tail", "1", "l"]
