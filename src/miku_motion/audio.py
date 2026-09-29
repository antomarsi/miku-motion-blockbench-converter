"""Minimal Ogg (Vorbis / Opus) reader: just enough to know an audio file's length.

The converter never decodes or copies audio; it only checks that music attached as a
sound keyframe lasts as long as the motion.

An Ogg stream is a sequence of pages (``"OggS"``, version, flags, u64 granule position,
serial, sequence, CRC, segment count, segment table, payload). The first page carries the
codec's identification header; the last page's granule position is the stream's total
sample count (for Opus always at 48 kHz, including a leading pre-skip).
"""

import struct
from dataclasses import dataclass
from pathlib import Path

from miku_motion.errors import InputFormatError

_PAGE = struct.Struct("<4sBBqIIIB")
_OPUS_GRANULE_RATE = 48_000
_HINT = "attach an Ogg Vorbis or Ogg Opus file (the format Minecraft plays)"


@dataclass(frozen=True, slots=True)
class AudioInfo:
    codec: str
    channels: int
    sample_rate: int
    duration: float  # seconds


def _first_packet(data: bytes, path: Path | None) -> tuple[bytes, int]:
    if len(data) < _PAGE.size or data[:4] != b"OggS":
        raise InputFormatError("not an Ogg audio file", path=path, offset=0, hint=_HINT)
    *_, serial, _seq, _crc, segments = _PAGE.unpack_from(data)
    body = _PAGE.size + segments
    size = sum(data[_PAGE.size : body])
    if len(data) < body + size:
        raise InputFormatError("Ogg file is truncated", path=path, offset=body, hint=_HINT)
    return data[body : body + size], serial


def _last_granule(data: bytes, serial: int) -> int | None:
    position = len(data)
    while (position := data.rfind(b"OggS", 0, position)) != -1:
        if position + _PAGE.size <= len(data):
            _magic, version, _flags, granule, page_serial, *_ = _PAGE.unpack_from(data, position)
            if version == 0 and page_serial == serial and granule >= 0:
                return int(granule)
    return None


def parse_ogg(data: bytes, path: Path | None = None) -> AudioInfo:
    packet, serial = _first_packet(data, path)
    if packet.startswith(b"\x01vorbis") and len(packet) >= 16:
        channels = packet[11]
        rate = int.from_bytes(packet[12:16], "little")
        codec, granule_rate, skip = "vorbis", rate, 0
    elif packet.startswith(b"OpusHead") and len(packet) >= 16:
        channels = packet[9]
        skip = int.from_bytes(packet[10:12], "little")
        rate = int.from_bytes(packet[12:16], "little")
        codec, granule_rate = "opus", _OPUS_GRANULE_RATE
    else:
        raise InputFormatError(
            "unsupported Ogg codec (expected Vorbis or Opus)", path=path, hint=_HINT
        )
    if granule_rate <= 0:
        raise InputFormatError("invalid sample rate in the audio header", path=path, hint=_HINT)
    granule = _last_granule(data, serial)
    if granule is None:
        raise InputFormatError("cannot find the end of the Ogg stream", path=path, hint=_HINT)
    return AudioInfo(codec, channels, rate, max(granule - skip, 0) / granule_rate)


def read_audio(path: Path | str) -> AudioInfo:
    file_path = Path(path)
    try:
        data = file_path.read_bytes()
    except OSError as exc:
        raise InputFormatError(f"cannot read file: {exc.strerror}", path=file_path) from exc
    return parse_ogg(data, file_path)
