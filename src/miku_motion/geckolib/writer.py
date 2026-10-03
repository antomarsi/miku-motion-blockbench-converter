"""Deterministic GeckoLib ``.animation.json`` writer.

Output is byte-identical for identical inputs: bones follow the target skeleton order,
channels are ``rotation`` then ``position``, numbers are rounded to a fixed number of
decimals with ``-0`` normalized, times come from integer sample indices, and every
keyframe sits on its own line (readable diffs without a huge file).

Channels that never change are written as a single keyframe; channels that stay at
the rest pose are omitted. With a tolerance, channels are reduced to the keyframes
GeckoLib needs to stay within it (``optimize.py``).
"""

import json
from dataclasses import dataclass
from typing import Any

import numpy as np

from miku_motion.animation.clip import Animation, LoopMode
from miku_motion.animation.skeleton import Skeleton
from miku_motion.geckolib import encoding
from miku_motion.geckolib.optimize import Tolerance, reduce_position, reduce_rotation
from miku_motion.geometry.quat import FloatArray

FORMAT_VERSION = "1.8.0"
GECKOLIB_FORMAT_VERSION = 2
DECIMALS = 4

_LOOP_VALUES: dict[LoopMode, bool | str] = {
    LoopMode.ONCE: False,
    LoopMode.LOOP: True,
    LoopMode.HOLD: "hold_on_last_frame",
}


class Number(str):
    """A number already formatted for output."""


def format_number(value: float, decimals: int = DECIMALS) -> Number:
    text = f"{value:.{decimals}f}".rstrip("0").rstrip(".")
    return Number("0" if text in ("-0", "") else text)


def format_time(seconds: float) -> str:
    text = format_number(seconds)
    return text if "." in text else f"{text}.0"


@dataclass(slots=True)
class WriteStats:
    dense_keys: int = 0  # keyframes the channels would have without reduction
    keys: int = 0  # keyframes written
    max_rotation_error: float = 0.0  # degrees, from reduction
    max_position_error: float = 0.0  # pixels, from reduction


def _channel(
    times: FloatArray, values: FloatArray, rest: float = 0.0
) -> dict[str, list[Number]] | None:
    rounded = np.round(values, DECIMALS) + 0.0  # + 0.0 turns -0.0 into 0.0
    if np.all(rounded == rest):
        return None
    if np.all(rounded == rounded[0]):
        times, rounded = times[:1], rounded[:1]
    labels = [format_time(t) for t in times]
    if len(set(labels)) != len(labels):
        raise ValueError("keyframe times collide after rounding; lower the fps")
    return {
        label: [format_number(v) for v in row] for label, row in zip(labels, rounded, strict=True)
    }


def build_document(
    animation: Animation, skeleton: Skeleton, tolerance: Tolerance | None = None
) -> tuple[dict[str, Any], WriteStats]:
    """The GeckoLib document; with a ``tolerance``, channels are reduced (see optimize)."""
    times = animation.times
    stats = WriteStats()
    bones: dict[str, Any] = {}
    for bone in skeleton:
        track = animation.tracks.get(bone.name)
        if track is None:
            continue
        channels: dict[str, Any] = {}
        if track.rotations is not None:
            if tolerance is None:
                key_times, values = times, encoding.rotation_channel(bone, track.rotations)
            else:
                reduced = reduce_rotation(bone, times, track.rotations, tolerance.rotation_degrees)
                key_times, values = reduced.times, reduced.values
                stats.max_rotation_error = max(stats.max_rotation_error, reduced.max_error)
            rotation = _channel(key_times, values)
            if rotation:
                channels["rotation"] = rotation
                stats.dense_keys += len(times) if len(rotation) > 1 else 1
                stats.keys += len(rotation)
        if track.translations is not None:
            values = encoding.position_channel(track.translations)
            key_times = times
            if tolerance is not None:
                reduced = reduce_position(times, values, tolerance.position)
                key_times, values = reduced.times, reduced.values
                stats.max_position_error = max(stats.max_position_error, reduced.max_error)
            position = _channel(key_times, values)
            if position:
                channels["position"] = position
                stats.dense_keys += len(times) if len(position) > 1 else 1
                stats.keys += len(position)
        if track.scales is not None:
            values = np.asarray(track.scales, dtype=np.float64)
            key_times = times
            if tolerance is not None:
                reduced = reduce_position(times, values, tolerance.scale)
                key_times, values = reduced.times, reduced.values
            scale = _channel(key_times, values, rest=1.0)
            if scale:
                channels["scale"] = scale
                stats.dense_keys += len(times) if len(scale) > 1 else 1
                stats.keys += len(scale)
        if channels:
            bones[bone.name] = channels

    clip: dict[str, Any] = {
        "loop": _LOOP_VALUES[animation.loop],
        "animation_length": format_number(animation.length),
        "bones": bones,
    }
    return {
        "format_version": FORMAT_VERSION,
        "animations": {animation.name: clip},
        "geckolib_format_version": GECKOLIB_FORMAT_VERSION,
    }, stats


def _emit(value: Any, indent: int, out: list[str], prefix: str, suffix: str) -> None:
    pad = "  " * indent
    if isinstance(value, dict) and value:
        out.append(f"{pad}{prefix}{{")
        items = list(value.items())
        for i, (key, child) in enumerate(items):
            key_text = json.dumps(key, ensure_ascii=False) + ": "
            _emit(child, indent + 1, out, key_text, "," if i < len(items) - 1 else "")
        out.append(f"{pad}}}{suffix}")
    else:
        out.append(f"{pad}{prefix}{_inline(value)}{suffix}")


def _inline(value: Any) -> str:
    if isinstance(value, Number):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_inline(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False)


def render_animation(
    animation: Animation, skeleton: Skeleton, tolerance: Tolerance | None = None
) -> tuple[str, WriteStats]:
    document, stats = build_document(animation, skeleton, tolerance)
    out: list[str] = []
    _emit(document, 0, out, "", "")
    return "\n".join(out) + "\n", stats


def write_animation(animation: Animation, skeleton: Skeleton) -> str:
    return render_animation(animation, skeleton)[0]
