"""Deterministic GeckoLib ``.animation.json`` writer.

Output is byte-identical for identical inputs: bones follow the target skeleton order,
channels are ``rotation`` then ``position``, numbers are rounded to a fixed number of
decimals with ``-0`` normalized, times come from integer sample indices, and every
keyframe sits on its own line (readable diffs without a huge file).

Channels that never change are written as a single keyframe; channels that stay at
the rest pose are omitted.
"""

import json
from typing import Any

import numpy as np

from miku_motion.animation.clip import Animation, LoopMode
from miku_motion.animation.skeleton import Skeleton
from miku_motion.geckolib import encoding
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


def _channel(times: list[str], values: FloatArray) -> dict[str, list[Number]] | None:
    rounded = np.round(values, DECIMALS) + 0.0  # + 0.0 turns -0.0 into 0.0
    if not np.any(rounded):
        return None
    rows = rounded[:1] if np.all(rounded == rounded[0]) else rounded
    return {times[i]: [format_number(v) for v in row] for i, row in enumerate(rows)}


def build_document(animation: Animation, skeleton: Skeleton) -> dict[str, Any]:
    times = [format_time(t) for t in animation.times]
    if len(set(times)) != len(times):
        raise ValueError("sample times collide after rounding; lower the fps")

    bones: dict[str, Any] = {}
    for bone in skeleton:
        track = animation.tracks.get(bone.name)
        if track is None:
            continue
        channels: dict[str, Any] = {}
        if track.rotations is not None:
            rotation = _channel(times, encoding.rotation_channel(bone, track.rotations))
            if rotation:
                channels["rotation"] = rotation
        if track.translations is not None:
            position = _channel(times, encoding.position_channel(track.translations))
            if position:
                channels["position"] = position
        if channels:
            bones[bone.name] = channels

    clip: dict[str, Any] = {
        "loop": _LOOP_VALUES[animation.loop],
        "animation_length": format_number(animation.length),
        "bones": bones,
    }
    if animation.sounds:
        cues = {format_time(cue.time): {"effect": cue.effect} for cue in animation.sounds}
        if len(cues) != len(animation.sounds):
            raise ValueError("two sound cues share the same time")
        clip["sound_effects"] = dict(sorted(cues.items(), key=lambda item: float(item[0])))
    return {
        "format_version": FORMAT_VERSION,
        "animations": {animation.name: clip},
        "geckolib_format_version": GECKOLIB_FORMAT_VERSION,
    }


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


def write_animation(animation: Animation, skeleton: Skeleton) -> str:
    out: list[str] = []
    _emit(build_document(animation, skeleton), 0, out, "", "")
    return "\n".join(out) + "\n"
