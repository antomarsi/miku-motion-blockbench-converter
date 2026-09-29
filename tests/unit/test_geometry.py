import math

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from miku_motion.geometry import euler, quat

finite = st.floats(min_value=-1.0, max_value=1.0, allow_nan=False)
angles = st.floats(min_value=-3 * math.pi, max_value=3 * math.pi, allow_nan=False)


@st.composite
def unit_quats(draw: st.DrawFn) -> np.ndarray:
    q = np.array([draw(finite) for _ in range(4)])
    if np.linalg.norm(q) < 1e-3:
        q = np.array([0.0, 0.0, 0.0, 1.0])
    return quat.normalize(q)


# --- quaternion basics -------------------------------------------------------------------


def test_rotate_about_z_by_90_degrees() -> None:
    q = quat.from_axis_angle([0, 0, 1], math.pi / 2)
    np.testing.assert_allclose(quat.rotate(q, [1, 0, 0]), [0, 1, 0], atol=1e-12)


def test_mul_applies_right_operand_first() -> None:
    qx = quat.from_axis_angle([1, 0, 0], math.pi / 2)
    qz = quat.from_axis_angle([0, 0, 1], math.pi / 2)
    v = np.array([0.0, 1.0, 0.0])
    # qz * qx: rotate about X first (y -> z), then about Z (z stays z).
    np.testing.assert_allclose(quat.rotate(quat.mul(qz, qx), v), [0, 0, 1], atol=1e-12)
    np.testing.assert_allclose(
        quat.rotate(quat.mul(qz, qx), v), quat.rotate(qz, quat.rotate(qx, v)), atol=1e-12
    )


@given(unit_quats())
def test_inverse_cancels(q: np.ndarray) -> None:
    assert quat.allclose_rotation(quat.mul(q, quat.inverse(q)), quat.identity(), atol=1e-9)


@given(unit_quats(), st.lists(finite, min_size=3, max_size=3))
def test_rotation_preserves_length(q: np.ndarray, v: list[float]) -> None:
    assert np.linalg.norm(quat.rotate(q, v)) == pytest.approx(np.linalg.norm(v), abs=1e-9)


def test_batched_operations_match_single() -> None:
    qs = quat.normalize(np.random.default_rng(1).normal(size=(5, 4)))
    batched = quat.mul(qs, qs[::-1])
    for i in range(5):
        np.testing.assert_allclose(batched[i], quat.mul(qs[i], qs[4 - i]))


def test_normalize_rejects_zero() -> None:
    with pytest.raises(ValueError, match="zero-length"):
        quat.normalize([0, 0, 0, 0])


def test_as_quat_rejects_wrong_shape() -> None:
    with pytest.raises(ValueError, match="trailing axis of 4"):
        quat.as_quat([1, 2, 3])


def test_mul_chain_empty_is_identity() -> None:
    np.testing.assert_array_equal(quat.mul_chain(), quat.identity())


def test_identity_batch() -> None:
    assert quat.identity(3).shape == (3, 4)


def test_from_axis_angle_rejects_zero_axis() -> None:
    with pytest.raises(ValueError, match="non-zero"):
        quat.from_axis_angle([0, 0, 0], 1.0)


def test_angle_between() -> None:
    a = quat.from_axis_angle([0, 1, 0], 0.25)
    b = quat.from_axis_angle([0, 1, 0], 1.0)
    assert quat.angle_between(a, b) == pytest.approx(0.75)
    assert quat.angle_between(a, -a) == pytest.approx(0.0, abs=1e-7)


# --- slerp / power / continuity -----------------------------------------------------------


def test_slerp_endpoints_and_midpoint() -> None:
    a = quat.identity()
    b = quat.from_axis_angle([0, 0, 1], math.pi / 2)
    assert quat.allclose_rotation(quat.slerp(a, b, 0.0), a)
    assert quat.allclose_rotation(quat.slerp(a, b, 1.0), b)
    assert quat.allclose_rotation(
        quat.slerp(a, b, 0.5), quat.from_axis_angle([0, 0, 1], math.pi / 4)
    )


def test_slerp_takes_shortest_path() -> None:
    a = quat.identity()
    b = -quat.from_axis_angle([0, 0, 1], 0.2)  # same rotation, opposite hemisphere
    mid = quat.slerp(a, b, 0.5)
    assert quat.angle(mid) == pytest.approx(0.1)


def test_slerp_nearly_equal_inputs() -> None:
    a = quat.from_axis_angle([1, 0, 0], 0.3)
    assert quat.allclose_rotation(quat.slerp(a, a, 0.7), a)


def test_power_scales_and_inverts() -> None:
    q = quat.from_axis_angle([0, 1, 0], 0.8)
    assert quat.allclose_rotation(quat.power(q, 0.5), quat.from_axis_angle([0, 1, 0], 0.4))
    assert quat.allclose_rotation(quat.power(q, -1.0), quat.inverse(q))


def test_make_continuous_flips_hemisphere() -> None:
    q = quat.from_axis_angle([0, 0, 1], 0.1)
    seq = quat.make_continuous(np.stack([q, -q, q]))
    assert np.all(np.sum(seq[1:] * seq[:-1], axis=-1) > 0)


def test_make_continuous_requires_sequence() -> None:
    with pytest.raises(ValueError, match=r"\(N, 4\)"):
        quat.make_continuous(quat.identity())


# --- Euler ZYX ------------------------------------------------------------------------------


def test_euler_order_is_x_then_y_then_z() -> None:
    e = np.array([math.pi / 2, math.pi / 2, 0.0])
    q = euler.to_quat(e)
    # X first: y-axis -> z-axis; then Y(90): z-axis -> x-axis.
    np.testing.assert_allclose(quat.rotate(q, [0, 1, 0]), [1, 0, 0], atol=1e-12)


@given(angles, st.floats(min_value=-1.5, max_value=1.5), angles)
def test_euler_round_trip(x: float, y: float, z: float) -> None:
    q = euler.to_quat([x, y, z])
    assert quat.allclose_rotation(euler.to_quat(euler.from_quat(q)), q, atol=1e-9)


@given(unit_quats())
def test_from_quat_principal_range(q: np.ndarray) -> None:
    e = euler.from_quat(q)
    assert -math.pi / 2 - 1e-9 <= e[1] <= math.pi / 2 + 1e-9
    assert quat.allclose_rotation(euler.to_quat(e), q, atol=1e-8)


@pytest.mark.parametrize("pitch", [math.pi / 2, -math.pi / 2])
def test_gimbal_lock_uses_reference_z(pitch: float) -> None:
    q = euler.to_quat([0.3, pitch, 0.5])
    e = euler.from_quat(q, reference_z=0.5)
    assert e[2] == pytest.approx(0.5)
    assert quat.allclose_rotation(euler.to_quat(e), q, atol=1e-9)


def test_closest_to_unwraps_past_pi() -> None:
    previous = np.array([0.0, 0.0, math.radians(179)])
    q = euler.to_quat([0.0, 0.0, math.radians(-179)])  # really +181 degrees
    e = euler.closest_to(q, previous)
    assert math.degrees(e[2]) == pytest.approx(181)


def test_closest_to_prefers_alternate_solution_when_nearer() -> None:
    # (x, y, z) = (180, 80, 180) is the alternate form of (0, 100, 0).
    previous = np.radians([0.0, 95.0, 0.0])
    q = euler.to_quat(np.radians([0.0, 100.0, 0.0]))
    np.testing.assert_allclose(np.degrees(euler.closest_to(q, previous)), [0, 100, 0], atol=1e-7)


def test_continuous_sequence_has_no_jumps() -> None:
    zs = np.radians(np.arange(0, 720, 10.0))
    qs = euler.to_quat(np.stack([np.zeros_like(zs), np.zeros_like(zs), zs], axis=-1))
    curve = euler.continuous_from_quats(quat.make_continuous(qs))
    assert np.max(np.abs(np.diff(curve, axis=0))) < math.radians(10.001)
    assert math.degrees(curve[-1, 2]) == pytest.approx(710)


def test_continuous_requires_sequence() -> None:
    with pytest.raises(ValueError, match=r"\(N, 4\)"):
        euler.continuous_from_quats(quat.identity())
