"""Convert a parsed VMD into the format-independent `SourceMotion`.

This is where VMD specifics end: interpolation bytes become normalized easing curves,
keys are grouped per bone, sorted and de-duplicated, and unsupported sections are
reported as diagnostics.
"""

from collections import defaultdict

import numpy as np

from miku_motion.animation.source import MorphTrack, SourceBoneTrack, SourceMotion
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.vmd import interpolation
from miku_motion.vmd.names import canonical_bone_name
from miku_motion.vmd.summary import FRAME_RATE, is_ik_name
from miku_motion.vmd.types import VmdBoneKey, VmdFile

_CURVE_SCALE = 127.0


def _track(name: str, keys: list[VmdBoneKey]) -> SourceBoneTrack:
    curves = []
    for key in keys:
        decoded = interpolation.decode(key.interpolation)
        curves.append([decoded.x, decoded.y, decoded.z, decoded.rotation])
    return SourceBoneTrack(
        name=name,
        frames=np.array([k.frame for k in keys], dtype=np.float64),
        translations=np.array([k.position for k in keys], dtype=np.float64),
        rotations=np.array([k.rotation for k in keys], dtype=np.float64),
        curves=np.array(curves, dtype=np.float64) / _CURVE_SCALE,
    )


def to_source_motion(vmd: VmdFile, diagnostics: Diagnostics) -> SourceMotion:
    by_bone: dict[str, dict[int, VmdBoneKey]] = defaultdict(dict)
    duplicates: dict[str, int] = defaultdict(int)
    for key in vmd.bone_keys:  # file order; a later key for the same frame wins
        name = canonical_bone_name(key.name)
        if key.frame in by_bone[name]:
            duplicates[name] += 1
        by_bone[name][key.frame] = key

    if duplicates:
        names = tuple(sorted(duplicates))
        diagnostics.warn(
            Code.DUPLICATE_KEYS,
            f"{sum(duplicates.values())} duplicate bone keyframes (same bone and frame); "
            f"the last one in the file was used for: {', '.join(names)}",
            names,
        )

    tracks = {
        name: _track(name, [frames[f] for f in sorted(frames)])
        for name, frames in sorted(by_bone.items())
    }
    # The show/IK section lists the model's real IK bones; names containing "IK" (IK
    # parents, IK tips) are only a fallback for files without that section.
    ik_bones = {canonical_bone_name(s.name) for key in vmd.show_ik_keys for s in key.ik}
    ik_states: dict[str, list[tuple[int, bool]]] = defaultdict(list)
    for show_key in sorted(vmd.show_ik_keys, key=lambda k: k.frame):
        for state in show_key.ik:
            ik_states[canonical_bone_name(state.name)].append((show_key.frame, state.enabled))
    if not ik_bones:
        ik_bones.update(name for name in tracks if is_ik_name(name))

    _report_unsupported(vmd, diagnostics)
    return SourceMotion(
        name=vmd.model_name,
        frame_rate=FRAME_RATE,
        end_frame=max((k.frame for k in vmd.bone_keys), default=0),
        tracks=tracks,
        ik_bones=frozenset(ik_bones),
        canonical_name=canonical_bone_name,
        ik_states={name: tuple(states) for name, states in sorted(ik_states.items())},
        morphs=_morph_tracks(vmd),
    )


def _morph_tracks(vmd: VmdFile) -> dict[str, MorphTrack]:
    by_morph: dict[str, dict[int, float]] = defaultdict(dict)
    for key in vmd.morph_keys:  # file order; a later key for the same frame wins
        by_morph[canonical_bone_name(key.name)][key.frame] = key.weight
    return {
        name: MorphTrack(
            name,
            np.array(sorted(keys), dtype=np.float64),
            np.array([keys[f] for f in sorted(keys)], dtype=np.float64),
        )
        for name, keys in sorted(by_morph.items())
    }


def _report_unsupported(vmd: VmdFile, diagnostics: Diagnostics) -> None:
    for count, code, what in (
        (vmd.camera_key_count, Code.UNSUPPORTED_CAMERA, "camera"),
        (vmd.light_key_count, Code.UNSUPPORTED_LIGHT, "light"),
        (vmd.shadow_key_count, Code.UNSUPPORTED_SHADOW, "self-shadow"),
    ):
        if count:
            diagnostics.warn(code, f"{count} {what} keyframes are not converted")
