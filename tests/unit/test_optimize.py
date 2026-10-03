import math
from typing import Any

import numpy as np
import pytest

from miku_motion.animation.skeleton import make_bone
from miku_motion.geckolib import encoding
from miku_motion.geckolib.optimize import reduce_position, reduce_rotation
from miku_motion.geometry import euler, quat

BONE = make_bone("b", None)
TILTED = make_bone("t", None, rest_euler_degrees=(20, 0, 0))


def _interp(times: Any, key_times: Any, key_values: Any) -> Any:
    return np.stack([np.interp(times, key_times, key_values[:, i]) for i in range(3)], 1)


def _shown_error(bone: Any, times: Any, rotations: Any, reduced: Any) -> float:
    """Independent check: GeckoLib's linear Euler blend vs the intended rotations."""
    shown = encoding.rotation_from_channel(bone, _interp(times, reduced.times, reduced.values))
    return float(np.degrees(quat.angle_between(shown, rotations)).max())


# --- position ---------------------------------------------------------------------------------


def test_linear_motion_keeps_only_endpoints() -> None:
    times = np.linspace(0, 1, 61)
    values = np.outer(times, [1.0, 2.0, 3.0])
    reduced = reduce_position(times, values, 0.01)
    np.testing.assert_array_equal(reduced.times, [0, 1])
    assert reduced.max_error < 1e-9


def test_position_error_stays_within_tolerance() -> None:
    times = np.linspace(0, 2, 121)
    values = np.stack([np.sin(3 * times), np.cos(5 * times), times**2], 1) * 4
    reduced = reduce_position(times, values, 0.05)
    assert len(reduced.times) < len(times) / 2
    assert np.abs(_interp(times, reduced.times, reduced.values) - values).max() <= 0.05 + 1e-9


def test_position_keeping_neighbouring_keys_does_not_crash() -> None:
    """Regression: keys kept side by side (no samples between) broke the error summary."""
    times = np.array([0.0, 0.1, 0.2, 0.3])
    values = np.array([[0, 0, 0], [5, 0, 0], [0, 0, 0], [5, 0, 0]], dtype=float)
    reduced = reduce_position(times, values, 0.01)
    assert len(reduced.times) == 4
    assert reduced.max_error == 0.0


# --- rotation --------------------------------------------------------------------------------


def test_steady_spin_keeps_few_keys() -> None:
    times = np.linspace(0, 1, 61)
    rotations = quat.from_axis_angle([0, 0, 1], np.radians(90) * times)
    reduced = reduce_rotation(BONE, times, rotations, 0.5)
    assert len(reduced.times) == 2
    assert _shown_error(BONE, times, rotations, reduced) < 1e-6


@pytest.mark.parametrize("bone", [BONE, TILTED])
def test_wobbly_rotation_stays_within_tolerance(bone: Any) -> None:
    times = np.linspace(0, 2, 121)
    angles = np.stack([0.6 * np.sin(4 * times), 0.4 * np.cos(3 * times), 0.8 * times], 1)
    rotations = quat.mul(euler.to_quat(angles), bone.rest_rotation)
    reduced = reduce_rotation(bone, times, rotations, 0.5)
    assert len(reduced.times) < len(times) / 2
    assert reduced.max_error <= 0.5 + 1e-9
    assert _shown_error(bone, times, rotations, reduced) <= 0.5 + 1e-6


def test_refinement_never_makes_a_gimbal_crossing_worse() -> None:
    """Crossing y = 90 deg between two samples: no linear Euler blend fits perfectly, and
    inserting keys must never increase the error over the plain two-key blend."""
    a = euler.to_quat(np.radians([20.0, 75.0, 60.0]))
    b = euler.to_quat(np.radians([-10.0, 105.0, 30.0]))
    rotations = np.stack([a, b])
    plain = encoding.rotation_channel(BONE, rotations)
    shown_mid = encoding.rotation_from_channel(BONE, plain.mean(axis=0))
    detour = math.degrees(quat.angle_between(shown_mid, quat.slerp(a, b, 0.5)))
    assert detour > 0.5

    reduced = reduce_rotation(BONE, np.array([0.0, 1 / 60]), rotations, 0.5)
    assert reduced.max_error <= detour + 1e-9
