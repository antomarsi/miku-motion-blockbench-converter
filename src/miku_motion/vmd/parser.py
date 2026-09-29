"""Binary VMD reader.

Layout (little-endian), after a 30-byte magic and a model-name field:

- bone keys:   u32 count, then 111-byte records
  (name[15], u32 frame, f32 pos[3], f32 quat xyzw[4], u8 interpolation[64])
- morph keys:  u32 count, then 23-byte records (name[15], u32 frame, f32 weight)
- camera keys: u32 count, 61-byte records   (counted only)
- light keys:  u32 count, 28-byte records   (counted only)
- shadow keys: u32 count, 9-byte records    (counted only)
- show/IK keys: u32 count, then (u32 frame, u8 show, u32 n, n x (name[20], u8 enabled))

Files written by older tools end early; a section missing entirely at end-of-file
counts as empty. A section that starts but is cut short is an error.
"""

import struct
from pathlib import Path

from miku_motion.errors import InputFormatError
from miku_motion.vmd.names import BONE_NAME_BYTES, MODEL_NAME_BYTES, decode_name
from miku_motion.vmd.types import (
    VmdBoneKey,
    VmdFile,
    VmdIkState,
    VmdMorphKey,
    VmdShowIkKey,
)

MAGIC_V2 = b"Vocaloid Motion Data 0002"
MAGIC_V1 = b"Vocaloid Motion Data file"
MAGIC_BYTES = 30
MODEL_NAME_BYTES_V1 = 10
IK_NAME_BYTES = 20

_BONE = struct.Struct(f"<{BONE_NAME_BYTES}sI3f4f64s")
_MORPH = struct.Struct(f"<{BONE_NAME_BYTES}sIf")
_U32 = struct.Struct("<I")
_SKIPPED_SECTIONS = (("camera", 61), ("light", 28), ("self-shadow", 9))
_HINT = "the file may be truncated or not a VMD motion; try re-exporting it from MMD"


class _Reader:
    def __init__(self, data: bytes, path: Path | None):
        self.data = data
        self.offset = 0
        self.path = path

    @property
    def at_end(self) -> bool:
        return self.offset >= len(self.data)

    def take(self, size: int, what: str) -> bytes:
        if self.offset + size > len(self.data):
            raise InputFormatError(
                f"unexpected end of file while reading {what}",
                path=self.path,
                offset=self.offset,
                hint=_HINT,
            )
        chunk = self.data[self.offset : self.offset + size]
        self.offset += size
        return chunk

    def u32(self, what: str) -> int:
        value: int = _U32.unpack(self.take(4, what))[0]
        return value

    def section_count(self, name: str) -> int | None:
        """Read a section's record count, or None if the file ends before the section."""
        if self.at_end:
            return None
        return self.u32(f"{name} key count")


def parse_vmd(data: bytes, path: Path | None = None) -> VmdFile:
    """Parse VMD bytes. ``path`` is used only for error messages."""
    reader = _Reader(data, path)
    magic = reader.take(MAGIC_BYTES, "header").split(b"\0", 1)[0]
    if magic == MAGIC_V2:
        version, name_bytes = 2, MODEL_NAME_BYTES
    elif magic == MAGIC_V1:
        version, name_bytes = 1, MODEL_NAME_BYTES_V1
    else:
        raise InputFormatError(
            f"not a VMD motion file (header {magic[:MAGIC_BYTES]!r})",
            path=path,
            offset=0,
            hint="expected a MikuMikuDance .vmd file",
        )
    vmd = VmdFile(model_name=decode_name(reader.take(name_bytes, "model name")), version=version)

    count = reader.section_count("bone") or 0
    block = reader.take(count * _BONE.size, f"{count} bone keyframes")
    for name, frame, px, py, pz, qx, qy, qz, qw, interp in _BONE.iter_unpack(block):
        vmd.bone_keys.append(
            VmdBoneKey(decode_name(name), frame, (px, py, pz), (qx, qy, qz, qw), interp)
        )

    count = reader.section_count("morph") or 0
    block = reader.take(count * _MORPH.size, f"{count} morph keyframes")
    vmd.morph_keys.extend(
        VmdMorphKey(decode_name(name), frame, weight)
        for name, frame, weight in _MORPH.iter_unpack(block)
    )

    counts = []
    for section, record_size in _SKIPPED_SECTIONS:
        n = reader.section_count(section) or 0
        reader.take(n * record_size, f"{n} {section} keyframes")
        counts.append(n)
    vmd.camera_key_count, vmd.light_key_count, vmd.shadow_key_count = counts

    count = reader.section_count("show/IK") or 0
    for i in range(count):
        what = f"show/IK keyframe {i + 1} of {count}"
        frame = reader.u32(what)
        show = reader.take(1, what)[0] != 0
        states = tuple(
            VmdIkState(decode_name(reader.take(IK_NAME_BYTES, what)), reader.take(1, what)[0] != 0)
            for _ in range(reader.u32(what))
        )
        vmd.show_ik_keys.append(VmdShowIkKey(frame, show, states))

    return vmd


def read_vmd(path: Path | str) -> VmdFile:
    """Read and parse a VMD file from disk."""
    file_path = Path(path)
    try:
        data = file_path.read_bytes()
    except OSError as exc:
        raise InputFormatError(f"cannot read file: {exc.strerror}", path=file_path) from exc
    return parse_vmd(data, file_path)
