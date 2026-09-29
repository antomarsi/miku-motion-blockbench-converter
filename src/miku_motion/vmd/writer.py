"""Binary VMD writer, used for synthetic test fixtures and calibration motions.

Camera/light/shadow sections are written empty; their counts in ``VmdFile`` are ignored.
"""

import struct

from miku_motion.vmd.names import BONE_NAME_BYTES, MODEL_NAME_BYTES, encode_name
from miku_motion.vmd.parser import IK_NAME_BYTES, MAGIC_BYTES, MAGIC_V2
from miku_motion.vmd.types import INTERPOLATION_BYTES, VmdFile

_BONE = struct.Struct(f"<{BONE_NAME_BYTES}sI3f4f{INTERPOLATION_BYTES}s")
_MORPH = struct.Struct(f"<{BONE_NAME_BYTES}sIf")
_U32 = struct.Struct("<I")


def write_vmd(vmd: VmdFile) -> bytes:
    """Serialize ``vmd`` as a version-2 VMD file."""
    parts = [MAGIC_V2.ljust(MAGIC_BYTES, b"\0"), encode_name(vmd.model_name, MODEL_NAME_BYTES)]

    parts.append(_U32.pack(len(vmd.bone_keys)))
    for key in vmd.bone_keys:
        if len(key.interpolation) != INTERPOLATION_BYTES:
            raise ValueError(f"bone key {key.name!r} needs {INTERPOLATION_BYTES} interp bytes")
        parts.append(
            _BONE.pack(
                encode_name(key.name, BONE_NAME_BYTES),
                key.frame,
                *key.position,
                *key.rotation,
                key.interpolation,
            )
        )

    parts.append(_U32.pack(len(vmd.morph_keys)))
    parts.extend(
        _MORPH.pack(encode_name(m.name, BONE_NAME_BYTES), m.frame, m.weight) for m in vmd.morph_keys
    )

    parts.append(_U32.pack(0) * 3)  # camera, light, self-shadow

    parts.append(_U32.pack(len(vmd.show_ik_keys)))
    for ik_key in vmd.show_ik_keys:
        parts.append(
            _U32.pack(ik_key.frame) + bytes([int(ik_key.show)]) + _U32.pack(len(ik_key.ik))
        )
        parts.extend(
            encode_name(s.name, IK_NAME_BYTES) + bytes([int(s.enabled)]) for s in ik_key.ik
        )

    return b"".join(parts)
