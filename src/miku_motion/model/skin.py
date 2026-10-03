"""Put a Minecraft skin on the template model.

The template's texture is 64x128: the top 64x64 is exactly the Minecraft skin layout and
the bottom half holds the template's extras (hair styles, skirt, tie, cuffs). Applying a
skin replaces the top half and keeps the extras.

- legacy 64x32 skins are upgraded the way Minecraft does: the left arm and leg become
  mirrored copies of the right ones, and the missing overlay layers stay empty
- slim ("Alex", 3 px arms) skins are detected and get the slim template
"""

import base64
import json
from pathlib import Path
from typing import Any

import numpy as np

from miku_motion.errors import InputFormatError, MikuMotionError
from miku_motion.model.png import Pixels, decode_png, encode_png, read_png

SKIN = 64
_RIGHT_LEG, _LEFT_LEG = (0, 16), (16, 48)
_RIGHT_ARM, _LEFT_ARM = (40, 16), (32, 48)


def _face_boxes(u: int, v: int, w: int, h: int, d: int) -> dict[str, tuple[int, int, int, int]]:
    """Pixel rectangles (x0, y0, x1, y1) of a box's faces in the Minecraft layout."""
    return {
        "up": (u + d, v, u + d + w, v + d),
        "down": (u + d + w, v, u + d + 2 * w, v + d),
        "east": (u, v + d, u + d, v + d + h),
        "north": (u + d, v + d, u + d + w, v + d + h),
        "west": (u + d + w, v + d, u + 2 * d + w, v + d + h),
        "south": (u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h),
    }


def _mirror_box(pixels: Pixels, source: tuple[int, int], target: tuple[int, int]) -> None:
    """Copy a 4x12x4 limb as its mirror image (what Minecraft does for legacy skins)."""
    src, dst = _face_boxes(*source, 4, 12, 4), _face_boxes(*target, 4, 12, 4)
    swap = {"east": "west", "west": "east"}
    for face, (x0, y0, x1, y1) in dst.items():
        sx0, sy0, sx1, sy1 = src[swap.get(face, face)]
        pixels[y0:y1, x0:x1] = pixels[sy0:sy1, sx0:sx1][:, ::-1]


def normalize_skin(pixels: Pixels, path: Path | None = None) -> Pixels:
    """A 64x64 RGBA skin; 64x32 legacy skins are upgraded."""
    height, width = pixels.shape[:2]
    if width != SKIN or height not in (32, SKIN):
        raise InputFormatError(
            f"not a Minecraft skin ({width}x{height}; expected 64x64 or 64x32)", path=path
        )
    if height == SKIN:
        return pixels.copy()
    skin = np.zeros((SKIN, SKIN, 4), dtype=np.uint8)
    skin[:32] = pixels
    _mirror_box(skin, _RIGHT_LEG, _LEFT_LEG)
    _mirror_box(skin, _RIGHT_ARM, _LEFT_ARM)
    return skin


def is_slim(skin: Pixels) -> bool:
    """Slim skins leave the outer 2 columns of the right arm's area transparent."""
    return not bool(np.any(skin[20:32, 54:56, 3]))


def load_skin(path: Path) -> Pixels:
    return normalize_skin(read_png(path), path)


def _texture(document: dict[str, Any]) -> dict[str, Any]:
    textures = document.get("textures") or []
    if not textures or "source" not in textures[0]:
        raise MikuMotionError("the template has no embedded texture")
    texture: dict[str, Any] = textures[0]
    return texture


def template_pixels(document: dict[str, Any]) -> Pixels:
    source = _texture(document)["source"]
    return decode_png(base64.b64decode(source.split(",", 1)[1]))


def apply_skin(document: dict[str, Any], skin: Pixels, name: str) -> Pixels:
    """Replace the template's Minecraft area with ``skin``; returns the full texture."""
    texture = template_pixels(document)
    if texture.shape[0] < SKIN or texture.shape[1] < SKIN:
        raise MikuMotionError("the template's texture is smaller than a Minecraft skin")
    texture[:SKIN, :SKIN] = skin
    png = encode_png(texture)
    entry = _texture(document)
    entry["source"] = "data:image/png;base64," + base64.b64encode(png).decode()
    entry["name"] = entry["relative_path"] = f"{name}.png"
    document["name"] = name
    return texture


def make_skinned_model(
    skin_path: Path, template_dir: Path, output: Path, arms: str = "auto"
) -> tuple[Path, Path, bool]:
    """Write ``output`` (.bbmodel) and its texture next to it; returns paths and slimness."""
    skin = load_skin(skin_path)
    slim = is_slim(skin) if arms == "auto" else arms == "slim"
    template = template_dir / ("template_slim.bbmodel" if slim else "template.bbmodel")
    try:
        document = json.loads(template.read_text(encoding="utf-8"))
    except OSError as exc:
        raise MikuMotionError(f"cannot read the template: {exc.strerror}", path=template) from exc
    name = output.stem
    texture = apply_skin(document, skin, name)
    text = json.dumps(document, ensure_ascii=False, indent=1) + "\n"
    output.write_text(text, encoding="utf-8", newline="\n")  # LF on every OS
    texture_path = output.with_name(f"{name}.png")
    texture_path.write_bytes(encode_png(texture))
    return output, texture_path, slim
