"""The converter must not hard-code any rig: bone names belong in mapping files only."""

import json
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src" / "miku_motion"
MAPPINGS = Path(__file__).resolve().parents[2] / "mappings"

# CJK ideographs, kana and full-width forms: MMD bone names are written with these.
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]")


def _source_files() -> list[Path]:
    return sorted(p for p in SRC.rglob("*.py"))


def test_no_cjk_in_source() -> None:
    offenders = [
        f"{path.relative_to(SRC)}:{lineno}"
        for path in _source_files()
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if CJK.search(line)
    ]
    assert not offenders, f"MMD bone names must live in mapping files, found in: {offenders}"


def _mapped_target_names() -> set[str]:
    names: set[str] = set()
    for mapping in MAPPINGS.glob("*.json"):
        names.update(json.loads(mapping.read_text(encoding="utf-8")).get("bones", {}))
    return names


def test_no_target_bone_names_in_source() -> None:
    names = _mapped_target_names()
    offenders = [
        f"{path.relative_to(SRC)}: {name!r}"
        for path in _source_files()
        for name in names
        if re.search(rf"[\"']{re.escape(name)}[\"']", path.read_text(encoding="utf-8"))
    ]
    assert not offenders, f"target bone names must live in mapping files, found: {offenders}"
