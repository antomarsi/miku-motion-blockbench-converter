import base64
import json
import zlib
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from miku_motion.cli import app
from miku_motion.errors import InputFormatError
from miku_motion.model.png import _paeth, decode_png, encode_png
from miku_motion.model.skin import (
    apply_skin,
    is_slim,
    make_skinned_model,
    normalize_skin,
    template_pixels,
)

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "templates"


def _image(height: int, width: int, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    pixels = rng.integers(0, 256, (height, width, 4), dtype=np.uint8)
    pixels[..., 3] = 255
    return pixels


# --- PNG ------------------------------------------------------------------------------------


def _filtered_png(pixels: np.ndarray, kind: int) -> bytes:
    """A PNG whose rows all use filter ``kind`` (to exercise the decoder)."""
    height, width = pixels.shape[:2]
    bpp, stride = 4, width * 4
    raw = bytearray()
    previous = bytes(stride)
    for y in range(height):
        line = pixels[y].tobytes()
        out = bytearray([kind])
        for x in range(stride):
            left = line[x - bpp] if x >= bpp else 0
            up, corner = previous[x], (previous[x - bpp] if x >= bpp else 0)
            predict = {0: 0, 1: left, 2: up, 3: (left + up) // 2, 4: _paeth(left, up, corner)}
            out.append((line[x] - predict[kind]) & 0xFF)
        raw += out
        previous = line
    png = encode_png(pixels)
    start = png.index(b"IDAT") - 4
    end = png.index(b"IEND") - 4
    body = zlib.compress(bytes(raw))
    crc = zlib.crc32(b"IDAT" + body).to_bytes(4, "big")
    return png[:start] + len(body).to_bytes(4, "big") + b"IDAT" + body + crc + png[end:]


@pytest.mark.parametrize("kind", [0, 1, 2, 3, 4])
def test_png_filters_decode(kind: int) -> None:
    pixels = _image(5, 7)
    np.testing.assert_array_equal(decode_png(_filtered_png(pixels, kind)), pixels)


def test_png_round_trip_and_errors() -> None:
    pixels = _image(4, 3)
    np.testing.assert_array_equal(decode_png(encode_png(pixels)), pixels)
    with pytest.raises(InputFormatError, match="not a PNG"):
        decode_png(b"GIF89a")


# --- skins ------------------------------------------------------------------------------------


def test_legacy_skin_is_upgraded_with_mirrored_left_limbs() -> None:
    legacy = np.zeros((32, 64, 4), dtype=np.uint8)
    legacy[20:32, 4:8] = (255, 0, 0, 255)  # right leg front ...
    legacy[20:32, 4:5] = (0, 255, 0, 255)  # ... with its left column marked
    skin = normalize_skin(legacy)
    assert skin.shape == (64, 64, 4)
    # The left leg front (x 20..24, y 52..64) is its mirror image: the mark moves right.
    assert tuple(skin[52, 23]) == (0, 255, 0, 255)
    assert tuple(skin[52, 20]) == (255, 0, 0, 255)


def test_wrong_size_is_rejected() -> None:
    with pytest.raises(InputFormatError, match="not a Minecraft skin"):
        normalize_skin(np.zeros((16, 16, 4), dtype=np.uint8))


def test_slim_detection() -> None:
    classic = _image(64, 64)
    slim = classic.copy()
    slim[20:32, 54:56, 3] = 0
    assert not is_slim(classic)
    assert is_slim(slim)


def test_apply_skin_replaces_only_the_minecraft_area() -> None:
    document = json.loads((TEMPLATES / "template.bbmodel").read_text(encoding="utf-8"))
    before = template_pixels(document)
    skin = _image(64, 64)
    texture = apply_skin(document, skin, "mine")
    np.testing.assert_array_equal(texture[:64], skin)
    np.testing.assert_array_equal(texture[64:], before[64:])  # the extras are kept
    assert document["textures"][0]["name"] == "mine.png"
    np.testing.assert_array_equal(template_pixels(document), texture)


@pytest.mark.parametrize(("slim", "template"), [(False, "template"), (True, "template_slim")])
def test_make_skinned_model_picks_the_arm_width(tmp_path: Path, slim: bool, template: str) -> None:
    skin = _image(64, 64)
    if slim:
        skin[20:32, 54:56, 3] = 0
    skin_path = tmp_path / "me.png"
    skin_path.write_bytes(encode_png(skin))
    model, texture, detected = make_skinned_model(skin_path, TEMPLATES, tmp_path / "me.bbmodel")
    assert detected is slim
    document = json.loads(model.read_text(encoding="utf-8"))
    reference = json.loads((TEMPLATES / f"{template}.bbmodel").read_text(encoding="utf-8"))
    assert {g["name"] for g in document["groups"]} == {g["name"] for g in reference["groups"]}
    arm = next(e for e in document["elements"] if e["name"] == "arm_right")
    assert arm["to"][0] - arm["from"][0] == (3 if slim else 4)
    np.testing.assert_array_equal(decode_png(texture.read_bytes())[:64], skin)
    source = document["textures"][0]["source"].split(",", 1)[1]
    assert decode_png(base64.b64decode(source)).shape == (128, 64, 4)


def test_cli_apply_skin(tmp_path: Path) -> None:
    skin_path = tmp_path / "steve_like.png"
    skin_path.write_bytes(encode_png(_image(64, 64)))
    result = CliRunner().invoke(app, ["apply-skin", str(skin_path), "--templates", str(TEMPLATES)])
    assert result.exit_code == 0, result.output
    assert "classic (4 px) arms" in result.output
    assert (tmp_path / "steve_like.bbmodel").exists()
    bad = CliRunner().invoke(app, ["apply-skin", str(skin_path), "--arms", "huge"])
    assert bad.exit_code == 1


@pytest.mark.real_assets
def test_real_skins(assets_dir: Path, tmp_path: Path) -> None:
    applied = 0
    for path in sorted((assets_dir / "models").glob("*.png")):
        try:
            make_skinned_model(path, TEMPLATES, tmp_path / f"{path.stem}.bbmodel")
        except InputFormatError:
            continue  # a model texture, not a Minecraft skin
        applied += 1
    assert applied >= 1
