"""Minimal PNG reading and writing for skins (no image library needed).

Reads 8-bit, non-interlaced PNGs in every colour type Minecraft skins use (grey, grey +
alpha, RGB, palette with optional transparency, RGBA) into an ``(H, W, 4)`` RGBA array,
and writes RGBA PNGs.
"""

import struct
import zlib
from pathlib import Path

import numpy as np
import numpy.typing as npt

from miku_motion.errors import InputFormatError

type Pixels = npt.NDArray[np.uint8]  # (height, width, 4) RGBA

_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytearray:
    stride = width * bpp
    out = bytearray(height * stride)
    previous = bytearray(stride)
    pos = 0
    for y in range(height):
        kind = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        for x in range(stride):
            left = line[x - bpp] if x >= bpp else 0
            up = previous[x]
            corner = previous[x - bpp] if x >= bpp else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                line[x] = (line[x] + _paeth(left, up, corner)) & 0xFF
            elif kind != 0:
                raise ValueError(f"unknown PNG filter {kind}")
        out[y * stride : (y + 1) * stride] = line
        previous = line
    return out


def decode_png(data: bytes, path: Path | None = None) -> Pixels:
    if not data.startswith(_SIGNATURE):
        raise InputFormatError("not a PNG image", path=path)
    pos = len(_SIGNATURE)
    header: tuple[int, ...] | None = None
    palette = b""
    transparency = b""
    idat = bytearray()
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"PLTE":
            palette = chunk
        elif kind == b"tRNS":
            transparency = chunk
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
    if header is None:
        raise InputFormatError("PNG has no header", path=path)
    width, height, depth, color, _, _, interlace = header
    if depth != 8 or interlace != 0 or color not in _CHANNELS:
        raise InputFormatError(
            "unsupported PNG (needs 8-bit, non-interlaced)",
            path=path,
            hint="re-save the skin as a normal 8-bit RGBA PNG",
        )
    channels = _CHANNELS[color]
    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error as exc:
        raise InputFormatError("corrupt PNG image data", path=path) from exc
    flat = np.frombuffer(_unfilter(raw, width, height, channels), dtype=np.uint8)
    pixels = flat.reshape(height, width, channels)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    if color == 3:
        table = np.frombuffer(palette, dtype=np.uint8).reshape(-1, 3)
        alpha = np.full(len(table), 255, dtype=np.uint8)
        alpha[: len(transparency)] = np.frombuffer(transparency, dtype=np.uint8)[: len(table)]
        index = pixels[:, :, 0]
        rgba[:, :, :3] = table[index]
        rgba[:, :, 3] = alpha[index]
    elif color in (0, 4):
        rgba[:, :, :3] = pixels[:, :, :1]
        rgba[:, :, 3] = pixels[:, :, 1] if color == 4 else 255
    else:
        rgba[:, :, :channels] = pixels
        if color == 2:
            rgba[:, :, 3] = 255
    return rgba


def read_png(path: Path) -> Pixels:
    try:
        return decode_png(path.read_bytes(), path)
    except OSError as exc:
        raise InputFormatError(f"cannot read file: {exc.strerror}", path=path) from exc


def encode_png(pixels: Pixels) -> bytes:
    height, width = pixels.shape[:2]
    rows = b"".join(b"\x00" + pixels[y].astype(np.uint8).tobytes() for y in range(height))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        _SIGNATURE
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
