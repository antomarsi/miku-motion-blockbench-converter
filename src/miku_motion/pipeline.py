"""End-to-end conversion: motion + target model + mapping -> GeckoLib animation."""

import re
from dataclasses import dataclass
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
from miku_motion.geckolib.optimize import Tolerance
from miku_motion.geckolib.writer import WriteStats, render_animation
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


def default_animation_name(model: BlockbenchModel, motion_path: Path) -> str:
    """GeckoLib's convention: ``animation.<model>.<animation>``."""
    return f"animation.{_identifier(model.name)}.{_identifier(motion_path.stem)}"


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


def convert(
    motion_path: Path, target_path: Path, mapping_path: Path, options: ConvertOptions
) -> ConversionResult:
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
        name=options.name or default_animation_name(model, motion_path),
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
    text, stats = render_animation(animation, model.skeleton, options.tolerance)
    if options.tolerance is not None:
        _report_reduction(stats, options.tolerance, diagnostics)
    return ConversionResult(text, animation, model, diagnostics)
