from pathlib import Path

import pytest

from miku_motion.audio import parse_ogg, read_audio
from miku_motion.errors import InputFormatError
from tests.fixtures.builders import _ogg_page, ogg_opus, ogg_vorbis


def test_vorbis_duration() -> None:
    info = parse_ogg(ogg_vorbis(12.5, rate=48_000, channels=1))
    assert (info.codec, info.channels, info.sample_rate) == ("vorbis", 1, 48_000)
    assert info.duration == pytest.approx(12.5)


def test_opus_duration_excludes_pre_skip() -> None:
    info = parse_ogg(ogg_opus(3.0))
    assert info.codec == "opus"
    assert info.duration == pytest.approx(3.0)


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"RIFF....WAVE", "not an Ogg audio file"),
        (ogg_vorbis(1.0)[:30], "truncated"),
        (_ogg_page(b"\x7fFLAC" + bytes(20), 0), "unsupported Ogg codec"),
    ],
)
def test_bad_audio_is_explained(data: bytes, message: str) -> None:
    with pytest.raises(InputFormatError, match=message):
        parse_ogg(data, Path("music.ogg"))


def test_stream_without_end_page() -> None:
    data = ogg_vorbis(1.0)
    first_page_end = data.index(b"OggS", 4)
    corrupted = data[:first_page_end] + b"XggS" + data[first_page_end + 4 :]
    # Only the header page remains, whose granule (0) still counts as a valid end.
    assert parse_ogg(corrupted).duration == 0.0


def test_read_audio(tmp_path: Path) -> None:
    path = tmp_path / "song.ogg"
    path.write_bytes(ogg_vorbis(2.0))
    assert read_audio(path).duration == pytest.approx(2.0)
    with pytest.raises(InputFormatError, match="cannot read file"):
        read_audio(tmp_path / "missing.ogg")


@pytest.mark.real_assets
def test_real_audio(assets_dir: Path) -> None:
    files = sorted(assets_dir.rglob("*.ogg"))
    if not files:
        pytest.skip("no .ogg in assets/")
    assert read_audio(files[0]).duration > 1
