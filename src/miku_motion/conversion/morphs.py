"""Facial animation: drive target bones from source morph weights.

GeckoLib animations only move bones, so each morph rule turns a morph's weight into a
bone effect: a scale blend (eyelids closing, a mouth opening), a position or rotation
offset, or a swap that shows/hides a bone (a scale of 0 hides it). Rules on the same
bone combine: scales multiply, offsets add, and a bone with "show" rules is visible only
while one of them is active.
"""

import difflib
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import numpy.typing as npt

from miku_motion.animation.clip import Animation, BoneTrack
from miku_motion.animation.sampling import sample_morph
from miku_motion.animation.skeleton import Skeleton
from miku_motion.animation.source import SourceMotion
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.errors import MappingError
from miku_motion.geckolib import encoding
from miku_motion.geometry import quat
from miku_motion.geometry.quat import FloatArray
from miku_motion.mapping.schema import MorphRule

_LIST_LIMIT = 12

type BoolArray = npt.NDArray[np.bool_]


@dataclass(frozen=True, slots=True)
class ResolvedMorphRule:
    rule: MorphRule
    morphs: tuple[str, ...]  # canonical source morph names


def _names(names: list[str]) -> str:
    shown = ", ".join(names[:_LIST_LIMIT])
    extra = len(names) - _LIST_LIMIT
    return shown + (f" (+{extra} more)" if extra > 0 else "")


def resolve_morph_rules(
    rules: list[MorphRule],
    skeleton: Skeleton,
    motion: SourceMotion,
    diagnostics: Diagnostics,
    *,
    mapping_path: Path | None = None,
) -> list[ResolvedMorphRule]:
    unknown = sorted({r.bone for r in rules if r.bone not in skeleton})
    if unknown:
        lines = []
        for name in unknown:
            close = difflib.get_close_matches(name, skeleton.names, n=1)
            lines.append(f"  - {name!r}" + (f" (did you mean {close[0]!r}?)" if close else ""))
        raise MappingError(
            "morph rules use bones not found in the model:\n" + "\n".join(lines),
            path=mapping_path,
        )
    resolved = [
        ResolvedMorphRule(r, tuple(motion.canonical_name(m) for m in r.morphs)) for r in rules
    ]
    used = {m for r in resolved for m in r.morphs}
    animated = sorted(name for name, track in motion.morphs.items() if track.is_animated)
    unmapped = [m for m in animated if m not in used]
    if unmapped and not rules:
        diagnostics.warn(
            Code.UNSUPPORTED_MORPHS,
            f"facial animation is not converted: {len(unmapped)} animated morphs "
            f"({_names(unmapped)}) but the mapping has no morph rules; `miku-motion "
            "init-mapping` generates them for face bones",
            tuple(unmapped),
        )
    elif unmapped:
        diagnostics.warn(
            Code.UNSUPPORTED_MORPHS,
            f"{len(unmapped)} animated morphs have no morph rule and are dropped: "
            f"{_names(unmapped)}",
            tuple(unmapped),
        )
    driven = sorted({r.rule.bone for r in resolved if set(r.morphs) & set(animated)})
    if driven:
        diagnostics.info(
            Code.FACIAL_ANIMATION,
            f"facial animation drives {_names(driven)} from {len(used & set(animated))} morphs",
            tuple(driven),
        )
    return resolved


def apply_morph_rules(
    animation: Animation,
    skeleton: Skeleton,
    motion: SourceMotion,
    rules: list[ResolvedMorphRule],
) -> None:
    """Add the morph-driven channels to ``animation`` (in place)."""
    frames = animation.times * motion.frame_rate
    count = len(frames)
    cache: dict[str, FloatArray] = {}

    def weight(names: tuple[str, ...]) -> FloatArray:
        out = np.zeros(count)
        for name in names:
            if name not in cache:
                track = motion.morphs.get(name)
                cache[name] = sample_morph(track, frames) if track else np.zeros(count)
            out = np.maximum(out, cache[name])
        result: FloatArray = np.clip(out, 0.0, 1.0)
        return result

    by_bone: dict[str, list[ResolvedMorphRule]] = {}
    for resolved in rules:
        by_bone.setdefault(resolved.rule.bone, []).append(resolved)

    for bone_name, bone_rules in by_bone.items():
        bone = skeleton[bone_name]
        scale = np.ones((count, 3))
        offset = np.zeros((count, 3))
        turn = np.zeros((count, 3))
        shows: list[BoolArray] = []
        hides: list[BoolArray] = []
        for resolved in bone_rules:
            rule, w = resolved.rule, weight(resolved.morphs)[:, None]
            if rule.scale is not None:
                start = np.array(rule.scale_from)
                scale *= start + w * (np.array(rule.scale) - start)
            elif rule.position is not None:
                offset += w * np.array(rule.position)
            elif rule.rotation is not None:
                turn += w * np.array(rule.rotation)
            elif rule.show_above is not None:
                shows.append(w[:, 0] >= rule.show_above)
            elif rule.hide_above is not None:
                hides.append(w[:, 0] >= rule.hide_above)
        visible = np.any(shows, axis=0) if shows else np.ones(count, dtype=bool)
        if hides:
            visible &= ~np.any(hides, axis=0)
        scale *= visible[:, None]

        track = animation.tracks.get(bone_name, BoneTrack())
        changes: dict[str, FloatArray | None] = {}
        if np.any(scale != 1.0):
            changes["scales"] = scale if track.scales is None else track.scales * scale
        if np.any(offset):
            moved = encoding.position_from_channel(offset)
            changes["translations"] = (
                moved if track.translations is None else track.translations + moved
            )
        if np.any(turn):
            base = (
                track.rotations
                if track.rotations is not None
                else np.tile(bone.rest_rotation, (count, 1))
            )
            changes["rotations"] = quat.make_continuous(
                quat.mul(base, encoding.rotation_delta_from_channel(turn))
            )
        if changes:
            animation.tracks[bone_name] = replace(track, **changes)
