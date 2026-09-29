"""Raw VMD records, close to the file layout. Nothing outside ``vmd/`` uses these."""

from dataclasses import dataclass, field

type Vec3 = tuple[float, float, float]
type Quat = tuple[float, float, float, float]  # xyzw, as stored in the file

INTERPOLATION_BYTES = 64


@dataclass(frozen=True, slots=True)
class VmdBoneKey:
    name: str
    frame: int
    position: Vec3
    rotation: Quat
    interpolation: bytes  # raw 64 bytes; decoded by `vmd.adapter`


@dataclass(frozen=True, slots=True)
class VmdMorphKey:
    name: str
    frame: int
    weight: float


@dataclass(frozen=True, slots=True)
class VmdIkState:
    name: str
    enabled: bool


@dataclass(frozen=True, slots=True)
class VmdShowIkKey:
    frame: int
    show: bool
    ik: tuple[VmdIkState, ...]


@dataclass(slots=True)
class VmdFile:
    """A parsed VMD. Camera/light/shadow keys are counted, not decoded (unsupported)."""

    model_name: str
    version: int = 2
    bone_keys: list[VmdBoneKey] = field(default_factory=list)
    morph_keys: list[VmdMorphKey] = field(default_factory=list)
    camera_key_count: int = 0
    light_key_count: int = 0
    shadow_key_count: int = 0
    show_ik_keys: list[VmdShowIkKey] = field(default_factory=list)
