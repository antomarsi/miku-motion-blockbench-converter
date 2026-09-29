"""Metadata about a VMD file, for `miku-motion inspect`."""

import math
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field

from miku_motion.vmd.types import VmdBoneKey, VmdFile

FRAME_RATE = 30.0
_ROTATION_EPS = 1e-4  # radians
_TRANSLATION_EPS = 1e-4  # MMD units


@dataclass(frozen=True, slots=True)
class BoneSummary:
    name: str
    key_count: int
    first_frame: int
    last_frame: int
    rotates: bool  # some key rotates away from the rest pose
    translates: bool  # some key moves away from the rest position
    varies: bool  # keys differ from each other (actual motion, not a static pose)
    ik: bool  # an IK target/effector bone: it drives other bones through the model's IK


@dataclass(frozen=True, slots=True)
class VmdSummary:
    model_name: str
    version: int
    first_frame: int
    last_frame: int
    bone_key_count: int
    morph_key_count: int
    morph_names: tuple[str, ...]
    camera_key_count: int
    light_key_count: int
    shadow_key_count: int
    show_ik_key_count: int
    bones: tuple[BoneSummary, ...] = field(default=())

    @property
    def duration_seconds(self) -> float:
        return self.last_frame / FRAME_RATE

    @property
    def unsupported(self) -> tuple[str, ...]:
        notes = []
        if self.morph_key_count:
            notes.append(f"{self.morph_key_count} morph keyframes (facial animation)")
        if self.camera_key_count:
            notes.append(f"{self.camera_key_count} camera keyframes")
        if self.light_key_count:
            notes.append(f"{self.light_key_count} light keyframes")
        if self.shadow_key_count:
            notes.append(f"{self.shadow_key_count} self-shadow keyframes")
        ik_bones = [b.name for b in self.bones if b.ik and (b.varies or b.translates)]
        if ik_bones:
            notes.append(f"IK-driven motion (not solved yet): {', '.join(ik_bones)}")
        return tuple(notes)


def is_ik_name(name: str) -> bool:
    """MMD names IK bones with 'IK' (often full-width); normalize before checking."""
    return "IK" in unicodedata.normalize("NFKC", name).upper()


def _rotation_angle(q: tuple[float, float, float, float]) -> float:
    vec = math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2)
    return 2.0 * math.atan2(vec, abs(q[3]))


def _bone_summary(name: str, keys: list[VmdBoneKey], ik_names: set[str]) -> BoneSummary:
    first = keys[0]
    return BoneSummary(
        name=name,
        key_count=len(keys),
        first_frame=min(k.frame for k in keys),
        last_frame=max(k.frame for k in keys),
        rotates=any(_rotation_angle(k.rotation) > _ROTATION_EPS for k in keys),
        translates=any(max(map(abs, k.position)) > _TRANSLATION_EPS for k in keys),
        varies=any(
            max(abs(a - b) for a, b in zip(k.position, first.position, strict=True))
            > _TRANSLATION_EPS
            or max(abs(a - b) for a, b in zip(k.rotation, first.rotation, strict=True))
            > _ROTATION_EPS
            for k in keys
        ),
        ik=name in ik_names or is_ik_name(name),
    )


def summarize(vmd: VmdFile) -> VmdSummary:
    by_bone: dict[str, list[VmdBoneKey]] = defaultdict(list)
    for key in vmd.bone_keys:
        by_bone[key.name].append(key)
    ik_names = {state.name for key in vmd.show_ik_keys for state in key.ik}
    frames = [k.frame for k in vmd.bone_keys] + [k.frame for k in vmd.morph_keys]
    bones = sorted(
        (_bone_summary(name, keys, ik_names) for name, keys in by_bone.items()),
        key=lambda b: (-b.key_count, b.name),
    )
    return VmdSummary(
        model_name=vmd.model_name,
        version=vmd.version,
        first_frame=min(frames, default=0),
        last_frame=max(frames, default=0),
        bone_key_count=len(vmd.bone_keys),
        morph_key_count=len(vmd.morph_keys),
        morph_names=tuple(sorted({k.name for k in vmd.morph_keys})),
        camera_key_count=vmd.camera_key_count,
        light_key_count=vmd.light_key_count,
        shadow_key_count=vmd.shadow_key_count,
        show_ik_key_count=len(vmd.show_ik_keys),
        bones=tuple(bones),
    )
