"""End-to-end conversion: motion + target model + mapping -> GeckoLib animation."""

import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path

import numpy as np

from miku_motion.animation.clip import Animation, LoopMode
from miku_motion.animation.sampling import PoseSamples, sample_times, sample_track
from miku_motion.blockbench.bbmodel import BlockbenchModel, read_bbmodel
from miku_motion.conversion.coordinates import MMD_TO_CANONICAL
from miku_motion.conversion.morphs import apply_morph_rules, resolve_morph_rules
from miku_motion.conversion.retarget import retarget
from miku_motion.conversion.secondary import apply_secondary_motion
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.errors import MikuMotionError
from miku_motion.geckolib.optimize import Tolerance
from miku_motion.geckolib.writer import WriteStats, render_animation
from miku_motion.geometry import quat
from miku_motion.geometry.quat import FloatArray
from miku_motion.mapping.resolve import resolve
from miku_motion.mapping.schema import load_mapping
from miku_motion.mapping.secondary import resolve_secondary, suggest_chains
from miku_motion.rig.ik import ChainResult, solve_ik
from miku_motion.rig.model import SourceRig
from miku_motion.rig.schema import DEFAULT_SKELETON, load_skeleton
from miku_motion.vmd.adapter import to_source_motion
from miku_motion.vmd.parser import read_vmd

DEFAULT_FPS = 20.0
OPTIMIZED_FPS = 60.0  # finer sampling for the optimizer to choose keys from
IK_REACH_TOLERANCE = 0.1  # source units (MMD: ~8 mm)
IK_UNREACHED_SHARE = 0.02  # warn when more samples than this miss their goal


@dataclass(frozen=True, slots=True)
class ConvertOptions:
    fps: float = DEFAULT_FPS
    name: str | None = None
    loop: LoopMode = LoopMode.ONCE
    source_skeleton: str | Path | None = DEFAULT_SKELETON  # None disables IK
    tolerance: Tolerance | None = None  # reduce keyframes within this error


@dataclass(frozen=True, slots=True)
class ConversionResult:
    text: str
    animation: Animation
    model: BlockbenchModel
    diagnostics: Diagnostics


def _identifier(text: str) -> str:
    cleaned = re.sub(r"[^0-9a-z_]+", "_", text.lower()).strip("_")
    return cleaned or "unnamed"


def default_animation_name(model: BlockbenchModel, motion_path: Path | str) -> str:
    """GeckoLib's convention: ``animation.<model>.<animation>`` (a path gives its stem)."""
    label = motion_path.stem if isinstance(motion_path, Path) else motion_path
    return f"animation.{_identifier(model.name)}.{_identifier(label)}"


def _report_ik(rig: SourceRig, results: list[ChainResult], diagnostics: Diagnostics) -> None:
    solved = [r.chain.bone for r in results if r.enabled_fraction > 0]
    if solved:
        diagnostics.info(
            Code.IK_SOLVED,
            f"solved IK with source skeleton {rig.name!r}: {', '.join(solved)}",
            tuple(solved),
        )
    for result in results:
        if result.enabled_fraction == 0:
            continue
        missed = result.residuals > IK_REACH_TOLERANCE
        share = float(np.mean(missed))
        if share > IK_UNREACHED_SHARE:
            diagnostics.warn(
                Code.IK_UNREACHED,
                f"{result.chain.bone} missed its goal in {share:.0%} of samples (by up to "
                f"{float(result.residuals.max()):.2f} units); the source skeleton's "
                "proportions probably differ from the motion's model",
                (result.chain.bone,),
            )


def _report_reduction(stats: WriteStats, tolerance: Tolerance, diagnostics: Diagnostics) -> None:
    saved = 1 - stats.keys / stats.dense_keys if stats.dense_keys else 0.0
    diagnostics.info(
        Code.KEYS_REDUCED,
        f"keyframes reduced from {stats.dense_keys:,} to {stats.keys:,} (-{saved:.0%}); worst "
        f"error {stats.max_rotation_error:.2f} deg / {stats.max_position_error:.3f} px",
    )
    if stats.max_rotation_error > tolerance.rotation_degrees + 1e-6:
        diagnostics.warn(
            Code.REDUCTION_OVER_TOLERANCE,
            f"some rotations still differ by up to {stats.max_rotation_error:.2f} deg between "
            f"keys (tolerance {tolerance.rotation_degrees:g} deg); try a higher --fps",
        )


DEFAULT_GROUP_DURATION_TOLERANCE = 1.0  # seconds


class Formation(StrEnum):
    """What happens to the stage positions the performers' motions carry."""

    KEEP = "keep"  # as authored: every performer stands where its motion puts it
    CENTER = "center"  # the group moves as one so that its middle starts at the origin
    ORIGIN = "origin"  # every performer starts at its own origin (the runtime places them)


@dataclass(frozen=True, slots=True)
class GroupEntry:
    motion_path: Path
    label: str  # names the animation and the output file


@dataclass(frozen=True, slots=True)
class GroupMember:
    motion_path: Path
    result: ConversionResult
    label: str
    start: tuple[float, float, float]  # where the motion puts the performer at t=0 (model px)


@dataclass(frozen=True, slots=True)
class GroupResult:
    members: tuple[GroupMember, ...]
    diagnostics: Diagnostics  # group-level only: see convert_group's docstring


def collect_group(paths: Sequence[Path]) -> tuple[GroupEntry, ...]:
    """Expand folders into their motion files (by name; labelled ``<folder>_<motion>``)."""
    entries: list[GroupEntry] = []
    for path in paths:
        if not path.is_dir():
            entries.append(GroupEntry(path, path.stem))
            continue
        motions = sorted(
            (f for f in path.iterdir() if f.is_file() and f.suffix.lower() == ".vmd"),
            key=lambda f: f.name.lower(),
        )
        if not motions:
            raise MikuMotionError("this folder has no .vmd motions", path=path)
        folder = path.resolve().name
        entries.extend(GroupEntry(f, f"{folder}_{f.stem}") for f in motions)
    seen: dict[str, Path] = {}
    for entry in entries:
        key = _identifier(entry.label)
        if key in seen:
            raise MikuMotionError(
                f"it would get the same animation name as {seen[key]}",
                path=entry.motion_path,
                hint="rename one of the motions, or convert them in separate runs",
            )
        seen[key] = entry.motion_path
    return tuple(entries)


def _movers(draft: "_Draft") -> list[str]:
    """Translated bones with no translated ancestor: they carry the stage position."""
    skeleton = draft.model.skeleton
    moved = {n for n, t in draft.animation.tracks.items() if t.translations is not None}
    return [
        b.name
        for b in skeleton
        if b.name in moved and not any(a.name in moved for a in skeleton.ancestors(b.name))
    ]


def _parent_rest(draft: "_Draft", bone: str) -> FloatArray:
    parent = draft.model.skeleton[bone].parent
    return draft.model.skeleton.rest_world_rotation(parent) if parent else quat.identity()


def _start(draft: "_Draft", bone: str) -> FloatArray:
    """Model-space offset of ``bone`` from its rest position at the first sample."""
    translations = draft.animation.tracks[bone].translations
    assert translations is not None
    start: FloatArray = quat.rotate(_parent_rest(draft, bone), translations[0])
    return start


def _shift(draft: "_Draft", bone: str, offset: FloatArray) -> None:
    """Move ``bone``'s whole track by ``-offset`` (model space), horizontally only."""
    track = draft.animation.tracks[bone]
    assert track.translations is not None
    flat = np.array([offset[0], 0.0, offset[2]])
    local = quat.rotate(quat.inverse(_parent_rest(draft, bone)), flat)
    draft.animation.tracks[bone] = replace(track, translations=track.translations - local)


def _apply_formation(
    drafts: Sequence["_Draft"], starts: Sequence[FloatArray], formation: Formation
) -> None:
    middle = np.mean(np.stack(starts), axis=0)
    for draft in drafts:
        for bone in _movers(draft):
            _shift(draft, bone, _start(draft, bone) if formation is Formation.ORIGIN else middle)


def convert_group(
    motions: Sequence[Path | GroupEntry],
    target_path: Path,
    mapping_path: Path,
    options: ConvertOptions,
    duration_tolerance: float = DEFAULT_GROUP_DURATION_TOLERANCE,
    *,
    formation: Formation = Formation.KEEP,
    sync_length: bool = False,
) -> GroupResult:
    """Convert several motions onto the same target rig, as a group of performers
    sharing one rig and formation - e.g. a dance crew, not a solo.

    By default this is a convenience over calling :func:`convert` once per motion - each
    motion is converted independently and its output is identical - plus one group-level
    diagnostic: performers meant to move together are usually expected to share a
    timeline, so a member whose converted length diverges from the group's average by
    more than ``duration_tolerance`` is flagged.

    Two opt-in adjustments treat the motions as one performance:

    - ``sync_length`` gives every animation the longest member's length (shorter ones
      hold their last pose), so they can be started together and end together.
    - ``formation`` re-centres the group or moves every performer to its own origin
      (see :class:`Formation`). Only horizontal position changes; heights are kept.

    This tool still has no notion of what uses the group (a duet, a trio, a full
    ensemble) or when each member starts within some larger piece - that stays the
    runtime's problem to place and time. ``GroupMember.start`` reports where each motion
    put its performer, for runtimes that place them themselves.
    """
    entries = [m if isinstance(m, GroupEntry) else GroupEntry(m, m.stem) for m in motions]
    drafts = [_draft(e.motion_path, target_path, mapping_path, options, e.label) for e in entries]

    diagnostics = Diagnostics()
    idle = [e.motion_path.name for e, d in zip(entries, drafts, strict=True) if not d.performs]
    if idle and len(idle) < len(drafts):
        # Dance folders often ship the camera motion next to the performers'.
        diagnostics.warn(
            Code.GROUP_MEMBER_SKIPPED,
            f"skipped {', '.join(idle)}: no bone or morph keyframes (a camera or light motion?)",
        )
        entries = [e for e, d in zip(entries, drafts, strict=True) if d.performs]
        drafts = [d for d in drafts if d.performs]
    lengths = [draft.animation.length for draft in drafts]
    if len(drafts) > 1 and not sync_length:
        average = sum(lengths) / len(lengths)
        for entry, length in zip(entries, lengths, strict=True):
            deviation = abs(length - average)
            if deviation > duration_tolerance:
                diagnostics.warn(
                    Code.GROUP_DURATION_MISMATCH,
                    f"{entry.motion_path.name} converts to {length:.2f}s, {deviation:.2f}s away "
                    f"from the group's average ({average:.2f}s over {len(drafts)} members)",
                )

    starts = []
    for draft in drafts:
        movers = _movers(draft)
        starts.append(_start(draft, movers[0]) if movers else np.zeros(3))
    if formation is not Formation.KEEP and drafts:
        _apply_formation(drafts, starts, formation)
        change = (
            "every performer now starts at its own origin"
            if formation is Formation.ORIGIN
            else "the group was moved so that its middle starts at the origin"
        )
        diagnostics.info(
            Code.GROUP_FORMATION,
            f"formation {formation.value!r}: {change}; heights are unchanged",
        )
    if sync_length and drafts:
        longest = max(lengths)
        padded = [
            e.motion_path.name
            for e, length in zip(entries, lengths, strict=True)
            if length < longest
        ]
        for draft in drafts:
            draft.animation.length = longest
        if padded:
            diagnostics.info(
                Code.GROUP_LENGTH_SYNCED,
                f"every animation is now {longest:.2f}s long; these hold their last pose "
                f"until then: {', '.join(padded)}",
            )

    members = tuple(
        GroupMember(
            entry.motion_path,
            _finish(draft, options),
            entry.label,
            (float(start[0]), float(start[1]), float(start[2])),
        )
        for entry, draft, start in zip(entries, drafts, starts, strict=True)
    )
    return GroupResult(members, diagnostics)


@dataclass(slots=True)
class _Draft:
    """A converted animation that can still be adjusted before it is written."""

    animation: Animation
    model: BlockbenchModel
    diagnostics: Diagnostics
    performs: bool  # the motion has bone or morph keys (not just a camera, say)


def _finish(draft: _Draft, options: ConvertOptions) -> ConversionResult:
    text, stats = render_animation(draft.animation, draft.model.skeleton, options.tolerance)
    if options.tolerance is not None:
        _report_reduction(stats, options.tolerance, draft.diagnostics)
    return ConversionResult(text, draft.animation, draft.model, draft.diagnostics)


def convert(
    motion_path: Path, target_path: Path, mapping_path: Path, options: ConvertOptions
) -> ConversionResult:
    draft = _draft(motion_path, target_path, mapping_path, options, motion_path.stem)
    return _finish(draft, options)


def _draft(
    motion_path: Path, target_path: Path, mapping_path: Path, options: ConvertOptions, label: str
) -> _Draft:
    diagnostics = Diagnostics()
    motion = to_source_motion(read_vmd(motion_path), diagnostics)
    model = read_bbmodel(target_path)
    if not model.is_geckolib:
        diagnostics.info(
            Code.TARGET_NOT_GECKOLIB,
            f"the Blockbench project format is {model.model_format!r}; the animation imports "
            "fine, but for GeckoLib convert the project (File > Convert Project > GeckoLib "
            "Animated Model) before exporting the model",
        )
    rig = load_skeleton(options.source_skeleton) if options.source_skeleton else None
    ik_bones = frozenset(motion.canonical_name(c.bone) for c in rig.ik) if rig else frozenset()
    mapping_file = load_mapping(mapping_path)
    chains = resolve_secondary(mapping_file, model.skeleton, mapping_path=mapping_path)
    candidates = suggest_chains(model.skeleton, mapping_file)
    if candidates:
        diagnostics.info(
            Code.SECONDARY_CANDIDATES,
            f"{len(candidates)} bone chains look like hair/cloth but have no secondary motion: "
            + ", ".join(" > ".join(c.bones) for c in candidates)
            + "; `miku-motion inspect-model` prints a snippet to add them",
        )
    mapping = resolve(
        mapping_file,
        model.skeleton,
        motion,
        diagnostics,
        mapping_path=mapping_path,
        solved_ik=ik_bones,
    )

    times = sample_times(motion.duration, options.fps)
    frames = times * motion.frame_rate
    needed = {link.source for b in mapping.bindings for link in b.chain}
    if rig is not None:
        rig = rig.driving(needed, motion.canonical_name)
        needed |= rig.required_bones()
    poses: dict[str, PoseSamples] = {
        name: sample_track(motion.tracks[name], frames)
        for name in sorted(needed & motion.tracks.keys())
    }
    if rig is not None:
        _report_ik(rig, solve_ik(rig, motion, poses, frames), diagnostics)

    animation = retarget(
        poses,
        times,
        mapping,
        model.skeleton,
        MMD_TO_CANONICAL,
        name=options.name or default_animation_name(model, label),
        loop=options.loop,
    )
    morph_rules = resolve_morph_rules(
        mapping_file.morphs, model.skeleton, motion, diagnostics, mapping_path=mapping_path
    )
    apply_morph_rules(animation, model.skeleton, motion, morph_rules)
    if chains:
        apply_secondary_motion(animation, model.skeleton, chains)
        diagnostics.info(
            Code.SECONDARY_MOTION,
            "simulated secondary motion for " + ", ".join(" > ".join(c.bones) for c in chains),
        )
    return _Draft(animation, model, diagnostics, bool(motion.tracks or motion.morphs))
