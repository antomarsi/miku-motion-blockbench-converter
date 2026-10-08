"""Binary PMX 2.0 / 2.1 reader for bones and morph names.

Layout: header, vertices, faces, textures, materials, bones, morphs, (display frames,
rigid bodies, joints: not read). Everything before the bones is skipped; its records
have variable sizes, so they still have to be walked.

Index sizes (1, 2 or 4 bytes) come from the header. Vertex indices are unsigned when 1
or 2 bytes wide; every other index is signed, with -1 meaning "none".
"""

import struct
from dataclasses import dataclass
from pathlib import Path

from miku_motion.errors import InputFormatError

MAGIC = b"PMX "

# Bone flags.
_TAIL_IS_BONE = 0x0001
_HAS_IK = 0x0020
_INHERIT_ROTATION = 0x0100
_INHERIT_TRANSLATION = 0x0200
_FIXED_AXIS = 0x0400
_LOCAL_AXES = 0x0800
_EXTERNAL_PARENT = 0x2000

# Bytes after the bone/vertex indices of each vertex deform type (BDEF1, BDEF2, BDEF4,
# SDEF, QDEF), and how many bone indices each one starts with.
_DEFORM = {0: (1, 0), 1: (2, 4), 2: (4, 16), 3: (2, 40), 4: (4, 16)}

MORPH_PANELS = {0: "system", 1: "brow", 2: "eye", 3: "mouth", 4: "other"}

type Vec3 = tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class PmxIkLink:
    bone: int
    min_angles: Vec3 | None  # radians; None = unlimited
    max_angles: Vec3 | None


@dataclass(frozen=True, slots=True)
class PmxIk:
    target: int
    iterations: int
    limit_angle: float  # radians per link per iteration
    links: tuple[PmxIkLink, ...]


@dataclass(frozen=True, slots=True)
class PmxBone:
    name: str
    position: Vec3
    parent: int  # -1 = none
    inherit_rotation: tuple[int, float] | None  # (bone index, weight)
    ik: PmxIk | None


@dataclass(frozen=True, slots=True)
class PmxMorph:
    name: str
    panel: int  # see MORPH_PANELS


@dataclass(frozen=True, slots=True)
class PmxModel:
    name: str
    bones: tuple[PmxBone, ...]
    morphs: tuple[PmxMorph, ...]


class _Reader:
    def __init__(self, data: bytes, path: Path | None):
        self.data = data
        self.offset = 0
        self.path = path
        self.encoding = "utf-16-le"

    def fail(self, message: str) -> InputFormatError:
        return InputFormatError(message, path=self.path, offset=self.offset)

    def skip(self, size: int, what: str) -> None:
        if size < 0 or self.offset + size > len(self.data):
            raise self.fail(f"file ends inside {what}")
        self.offset += size

    def unpack(self, fmt: str, what: str) -> tuple[int | float, ...]:
        layout = struct.Struct("<" + fmt)
        if self.offset + layout.size > len(self.data):
            raise self.fail(f"file ends inside {what}")
        values: tuple[int | float, ...] = layout.unpack_from(self.data, self.offset)
        self.offset += layout.size
        return values

    def integer(self, fmt: str, what: str) -> int:
        return int(self.unpack(fmt, what)[0])

    def count(self, what: str) -> int:
        value = self.integer("i", f"the {what} count")
        if value < 0:
            raise self.fail(f"negative {what} count ({value})")
        return value

    def index(self, size: int, what: str) -> int:
        return self.integer({1: "b", 2: "h", 4: "i"}[size], what)

    def floats(self, count: int, what: str) -> tuple[float, ...]:
        return tuple(float(v) for v in self.unpack(f"{count}f", what))

    def text(self, what: str) -> str:
        size = self.count(f"{what} length")
        start = self.offset
        self.skip(size, what)
        return self.data[start : start + size].decode(self.encoding, errors="replace")


def _vec3(values: tuple[float, ...]) -> Vec3:
    return (values[0], values[1], values[2])


def parse_pmx(data: bytes, path: Path | None = None) -> PmxModel:
    r = _Reader(data, path)
    if data[:4] != MAGIC:
        raise InputFormatError(
            "not a PMX file (it doesn't start with 'PMX ')",
            path=path,
            hint="older .pmd models aren't supported; convert them to .pmx with PMXEditor",
        )
    r.skip(4, "the header")
    version = r.floats(1, "the version")[0]
    if not 1.9 < version < 2.2:
        raise r.fail(f"unsupported PMX version {version:g} (2.0 and 2.1 are supported)")
    globals_count = r.integer("B", "the header")
    if globals_count < 8:
        raise r.fail(f"the header lists {globals_count} settings, expected at least 8")
    settings = [int(v) for v in r.unpack(f"{globals_count}B", "the header")]
    r.encoding = "utf-16-le" if settings[0] == 0 else "utf-8"
    extra_uvs, vertex_size, texture_size, material_size, bone_size, morph_size, body_size = (
        settings[1:8]
    )
    for size in (vertex_size, texture_size, material_size, bone_size, morph_size, body_size):
        if size not in (1, 2, 4):
            raise r.fail(f"invalid index size {size} in the header")

    name = r.text("the model name")
    for what in ("the English name", "the comment", "the English comment"):
        r.text(what)

    for _ in range(r.count("vertex")):
        r.skip(4 * (8 + 4 * extra_uvs), "a vertex")
        deform = r.integer("B", "a vertex")
        if deform not in _DEFORM:
            raise r.fail(f"unknown vertex deform type {deform}")
        bones, rest = _DEFORM[deform]
        r.skip(bones * bone_size + rest + 4, "a vertex")
    r.skip(r.count("face index") * vertex_size, "the faces")
    for _ in range(r.count("texture")):
        r.text("a texture path")
    for _ in range(r.count("material")):
        r.text("a material name")
        r.text("a material name")
        r.skip(4 * 11 + 1 + 4 * 5 + 2 * texture_size + 1, "a material")
        shared_toon = r.integer("B", "a material")
        r.skip(1 if shared_toon else texture_size, "a material")
        r.text("a material memo")
        r.skip(4, "a material")

    bones_out = []
    for number in range(r.count("bone")):
        what = f"bone {number}"
        bone_name = r.text(what)
        r.text(what)
        position = _vec3(r.floats(3, what))
        parent = r.index(bone_size, what)
        r.skip(4, what)  # deform layer
        flags = r.integer("H", what)
        r.skip(bone_size if flags & _TAIL_IS_BONE else 12, what)
        inherit = None
        if flags & (_INHERIT_ROTATION | _INHERIT_TRANSLATION):
            source = r.index(bone_size, what)
            weight = r.floats(1, what)[0]
            if flags & _INHERIT_ROTATION:
                inherit = (source, weight)
        if flags & _FIXED_AXIS:
            r.skip(12, what)
        if flags & _LOCAL_AXES:
            r.skip(24, what)
        if flags & _EXTERNAL_PARENT:
            r.skip(4, what)
        ik = None
        if flags & _HAS_IK:
            target = r.index(bone_size, what)
            iterations = r.integer("i", what)
            limit = r.floats(1, what)[0]
            links = []
            for _ in range(r.count(f"{what} IK link")):
                link = r.index(bone_size, what)
                if r.integer("B", what):
                    limits = r.floats(6, what)
                    links.append(PmxIkLink(link, _vec3(limits[:3]), _vec3(limits[3:])))
                else:
                    links.append(PmxIkLink(link, None, None))
            ik = PmxIk(target, iterations, limit, tuple(links))
        bones_out.append(PmxBone(bone_name, position, parent, inherit, ik))

    # Bytes per offset record of each morph type; UV morphs (3..7) share one layout.
    offset_sizes = {
        0: morph_size + 4,
        1: vertex_size + 12,
        2: bone_size + 28,
        8: material_size + 1 + 112,
        9: morph_size + 4,
        10: body_size + 1 + 24,
    }
    morphs_out = []
    for number in range(r.count("morph")):
        what = f"morph {number}"
        morph_name = r.text(what)
        r.text(what)
        panel = r.integer("B", what)
        kind = r.integer("B", what)
        if kind > 10:
            raise r.fail(f"unknown morph type {kind}")
        r.skip(r.count(f"{what} offset") * offset_sizes.get(kind, vertex_size + 16), what)
        morphs_out.append(PmxMorph(morph_name, panel))
    return PmxModel(name, tuple(bones_out), tuple(morphs_out))


def read_pmx(path: Path) -> PmxModel:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise InputFormatError(f"cannot read file: {exc.strerror}", path=path) from exc
    return parse_pmx(data, path)
