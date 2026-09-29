"""Convert MikuMikuDance motion (.vmd) into Blockbench / GeckoLib animation JSON."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("miku-motion-converter")
except PackageNotFoundError:  # pragma: no cover - running from a source tree without install
    __version__ = "0.0.0+unknown"
