import math

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from miku_motion.animation import curves
from miku_motion.animation.sampling import sample_times, sample_track
from miku_motion.animation.source import SourceBoneTrack
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.geometry import quat
from miku_motion.vmd.adapter import to_source_motion
from miku_motion.vmd.interpolation import LINEAR, BoneCurves
from miku_motion.vmd.types import VmdFile, VmdIkState, VmdMorphKey, VmdShowIkKey
from tests.fixtures.builders import axis_angle, bone_key, vmd

ARM = "左腕"
unit = st.floats(min_value=0.0, max_value=1.0)

# --- curves ------------------------------------------------------------------------------


@given(unit)
def test_linear_curve_is_identity(x: float) -> None:
    assert curves.evaluate(curves.LINEAR, x) == pytest.approx(x, abs=1e-9)
    assert curves.evaluate(np.array(LINEAR) / 127.0, x) == pytest.approx(x, abs=1e-9)


@given(unit, unit, unit, unit)
def test_curves_are_monotonic_with_fixed_endpoints(x1: float, y1: float, x2: float, y2: float):
    xs = np.linspace(0, 1, 50)
    ys = curves.evaluate([x1, y1, x2, y2], xs)
    assert ys[0] == pytest.approx(0.0, abs=1e-9)
    assert ys[-1] == pytest.approx(1.0, abs=1e-9)
    if 0 <= y1 <= 1 and 0 <= y2 <= 1:
        assert np.all(np.diff(ys) >= -1e-9)


def test_ease_in_curve_is_below_diagonal() -> None:
    ease_in = [0.42, 0.0, 1.0, 1.0]  # CSS ease-in
    assert curves.evaluate(ease_in, 0.5) < 0.4


def test_is_linear() -> None:
    assert curves.is_linear(curves.LINEAR)
    assert not curves.is_linear([0.42, 0.0, 1.0, 1.0])


# --- sample_times --------------------------------------------------------------------------


def test_sample_times_include_both_ends() -> None:
    np.testing.assert_allclose(sample_times(1.0, 20)[[0, -1]], [0.0, 1.0])
    assert len(sample_times(1.0, 20)) == 21
    times = sample_times(1.02, 20)
    assert times[-1] == pytest.approx(1.02)
    assert times[-2] == pytest.approx(1.0)


def test_sample_times_are_deterministic_and_validated() -> None:
    np.testing.assert_array_equal(sample_times(151.27, 20), sample_times(151.27, 20))
    with pytest.raises(ValueError, match="positive"):
        sample_times(1.0, 0)


# --- sample_track -------------------------------------------------------------------------------


def _track(frames, translations=None, rotations=None, curve=curves.LINEAR) -> SourceBoneTrack:
    k = len(frames)
    return SourceBoneTrack(
        name="b",
        frames=np.array(frames, dtype=float),
        translations=np.zeros((k, 3)) if translations is None else np.array(translations, float),
        rotations=quat.identity(k) if rotations is None else np.array(rotations, float),
        curves=np.tile(np.asarray(curve, float), (k, 4, 1)),
    )


def test_linear_translation_midpoint_and_holds() -> None:
    track = _track([10, 20], translations=[[0, 0, 0], [2, 4, -6]])
    samples = sample_track(track, [0, 10, 15, 20, 30])
    np.testing.assert_allclose(
        samples.translations, [[0, 0, 0], [0, 0, 0], [1, 2, -3], [2, 4, -6], [2, 4, -6]]
    )


def test_rotation_slerps_with_eased_progress() -> None:
    end = quat.from_axis_angle([0, 0, 1], math.radians(90))
    track = _track([0, 30], rotations=[quat.identity(), end])
    mid = sample_track(track, [15]).rotations[0]
    assert quat.angle(mid) == pytest.approx(math.radians(45))

    eased = _track([0, 30], rotations=[quat.identity(), end], curve=[0.42, 0.0, 1.0, 1.0])
    assert quat.angle(sample_track(eased, [15]).rotations[0]) < math.radians(40)


def test_curve_of_arriving_key_is_used() -> None:
    track = _track([0, 10, 20], translations=[[0, 0, 0], [10, 0, 0], [20, 0, 0]])
    curves_arr = track.curves.copy()
    curves_arr[2] = [0.42, 0.0, 1.0, 1.0]  # only the second segment eases in
    track = SourceBoneTrack("b", track.frames, track.translations, track.rotations, curves_arr)
    samples = sample_track(track, [5, 15])
    assert samples.translations[0, 0] == pytest.approx(5.0)
    assert samples.translations[1, 0] < 14.0


def test_per_axis_curves_are_independent() -> None:
    track = _track([0, 10], translations=[[0, 0, 0], [10, 10, 10]])
    curves_arr = track.curves.copy()
    curves_arr[1, 1] = [0.42, 0.0, 1.0, 1.0]  # Y axis eases
    track = SourceBoneTrack("b", track.frames, track.translations, track.rotations, curves_arr)
    x, y, z = sample_track(track, [5]).translations[0]
    assert x == pytest.approx(5.0)
    assert z == pytest.approx(5.0)
    assert y < 4.0


def test_single_key_track_holds() -> None:
    q = quat.from_axis_angle([1, 0, 0], 0.5)
    samples = sample_track(_track([7], rotations=[q]), [0, 7, 100])
    assert quat.allclose_rotation(samples.rotations, np.tile(q, (3, 1)))


def test_track_validation() -> None:
    with pytest.raises(ValueError, match="no keys"):
        _track([])
    with pytest.raises(ValueError, match="strictly increasing"):
        _track([5, 5])
    good = _track([0])
    with pytest.raises(ValueError, match="shape"):
        SourceBoneTrack("b", good.frames, np.zeros((2, 3)), good.rotations, good.curves)


# --- adapter -------------------------------------------------------------------------------------


def test_adapter_sorts_and_dedupes_keys() -> None:
    diagnostics = Diagnostics()
    motion = to_source_motion(
        vmd(
            bone_key(ARM, 30, position=(0, 0, 3)),
            bone_key(ARM, 0),
            bone_key(ARM, 30, position=(0, 0, 9)),  # duplicate: last wins
        ),
        diagnostics,
    )
    track = motion.tracks[ARM]
    np.testing.assert_array_equal(track.frames, [0, 30])
    assert track.translations[1, 2] == pytest.approx(9)
    assert Code.DUPLICATE_KEYS in diagnostics.codes()
    assert (motion.end_frame, motion.duration) == (30, 1.0)


def test_adapter_decodes_curves() -> None:
    custom = BoneCurves(LINEAR, (127, 0, 127, 127), LINEAR, (0, 127, 0, 127))
    motion = to_source_motion(vmd(bone_key(ARM, 0, curves=custom)), Diagnostics())
    np.testing.assert_allclose(motion.tracks[ARM].curves[0, 1], [1.0, 0.0, 1.0, 1.0])
    np.testing.assert_allclose(motion.tracks[ARM].curves[0, 3], [0.0, 1.0, 0.0, 1.0])


def test_adapter_reports_unsupported_sections_and_ik() -> None:
    source: VmdFile = vmd(
        bone_key("左足ＩＫ", 0, position=(0, 0, 1)), morphs=(VmdMorphKey("あ", 0, 1.0),)
    )
    source.camera_key_count = 2
    source.show_ik_keys.append(VmdShowIkKey(0, True, (VmdIkState("custom_solver", True),)))
    diagnostics = Diagnostics()
    motion = to_source_motion(source, diagnostics)
    assert Code.UNSUPPORTED_CAMERA in diagnostics.codes()
    # Morphs are carried through; whether they're used is decided by the mapping's rules.
    assert motion.morphs["あ"].is_animated
    np.testing.assert_array_equal(motion.morphs["あ"].weights, [1.0])
    assert motion.ik_bones == {"custom_solver"}  # the show/IK list is authoritative
    heuristic = to_source_motion(
        vmd(bone_key("左足ＩＫ", 0), bone_key("左足IK親", 0)), Diagnostics()
    )
    assert heuristic.ik_bones == {"左足ＩＫ", "左足IK親"}  # name-based fallback


def test_track_animation_flags() -> None:
    motion = to_source_motion(
        vmd(
            bone_key("static", 0),
            bone_key("posed", 0, rotation=axis_angle((0, 0, 1), 30)),
            bone_key("moved", 0, position=(1, 0, 0)),
        ),
        Diagnostics(),
    )
    assert not motion.tracks["static"].is_animated
    assert motion.tracks["posed"].rotates
    assert motion.tracks["moved"].translates
