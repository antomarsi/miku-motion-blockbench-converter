"""End-to-end conversion: motion + target model + mapping -> GeckoLib animation."""

import re
from dataclasses import dataclass
from pathlib import Path

from miku_motion.animation.clip import Animation, LoopMode, SoundCue
from miku_motion.audio import read_audio
from miku_motion.blockbench.bbmodel import BlockbenchModel, read_bbmodel
from miku_motion.conversion.coordinates import MMD_TO_CANONICAL
from miku_motion.conversion.retarget import retarget
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.errors import MikuMotionError
from miku_motion.geckolib.writer import write_animation
from miku_motion.mapping.resolve import resolve
from miku_motion.mapping.schema import load_mapping
from miku_motion.vmd.adapter import to_source_motion
from miku_motion.vmd.parser import read_vmd

DEFAULT_FPS = 20.0
AUDIO_LENGTH_TOLERANCE = 2.0  # seconds; motions often hold a final pose past the music


@dataclass(frozen=True, slots=True)
class ConvertOptions:
    fps: float = DEFAULT_FPS
    name: str | None = None
    loop: LoopMode = LoopMode.ONCE
    audio: Path | None = None  # music started by a sound keyframe on the first frame
    sound: str | None = None  # sound identifier for that keyframe


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


def default_sound_id(model: BlockbenchModel, audio_path: Path) -> str:
    """``<namespace>:<audio name>``, using the model's GeckoLib mod id as namespace."""
    if model.namespace is None:
        raise MikuMotionError(
            "cannot name the sound effect: the model has no GeckoLib mod id",
            hint="pass --sound NAMESPACE:NAME, or set the mod id in Blockbench's GeckoLib settings",
        )
    return f"{_identifier(model.namespace)}:{_identifier(audio_path.stem)}"


def _sound_cue(
    options: ConvertOptions, model: BlockbenchModel, duration: float, diagnostics: Diagnostics
) -> SoundCue | None:
    if options.audio is None:
        return SoundCue(0.0, options.sound) if options.sound else None
    audio = read_audio(options.audio)
    difference = audio.duration - duration
    message = (
        f"audio {options.audio.name} lasts {audio.duration:.2f} s and the motion "
        f"{duration:.2f} s ({difference:+.2f} s)"
    )
    if abs(difference) > AUDIO_LENGTH_TOLERANCE:
        diagnostics.warn(Code.AUDIO_LENGTH, message + "; is it the right track?")
    else:
        diagnostics.info(Code.AUDIO_LENGTH, message)
    return SoundCue(0.0, options.sound or default_sound_id(model, options.audio))


def convert(
    motion_path: Path, target_path: Path, mapping_path: Path, options: ConvertOptions
) -> ConversionResult:
    diagnostics = Diagnostics()
    motion = to_source_motion(read_vmd(motion_path), diagnostics)
    model = read_bbmodel(target_path)
    mapping = resolve(
        load_mapping(mapping_path),
        model.skeleton,
        motion,
        diagnostics,
        mapping_path=mapping_path,
    )
    animation = retarget(
        motion,
        mapping,
        model.skeleton,
        MMD_TO_CANONICAL,
        fps=options.fps,
        name=options.name or default_animation_name(model, motion_path),
        loop=options.loop,
    )
    cue = _sound_cue(options, model, animation.length, diagnostics)
    if cue is not None:
        animation.sounds = (cue,)
    text = write_animation(animation, model.skeleton)
    return ConversionResult(text, animation, model, diagnostics)
