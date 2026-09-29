"""The bone-mapping file: how source (MMD) bones drive target (Blockbench) bones.

Keyed by **target** bone. Each entry lists the chain of source bones, parent to child,
from the bone after the nearest mapped target ancestor's chain down to this bone.
Their local rotations are multiplied in order.

```json
{
  "schema_version": 1,
  "units": {"translation_scale": 1.0},
  "ignore": ["glob*"],
  "bones": {
    "TargetA": "SourceA",
    "TargetB": {"from": ["S1", {"bone": "S2", "weight": -1}, "S3"], "translation": true,
                "rest_correction": {"euler_deg": [0, 0, 37]}}
  }
}
```
"""

import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from miku_motion.errors import MappingError

SCHEMA_VERSION = 1


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ChainLink(_Strict):
    bone: str = Field(min_length=1)
    weight: float = 1.0  # rotation scale; -1 applies the inverse (e.g. a "cancel" bone)


class RestCorrection(_Strict):
    """Rotation taking the target's rest pose to the source's rest pose (ZYX, degrees)."""

    euler_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)


class BoneEntry(_Strict):
    from_: Annotated[list[str | ChainLink], Field(alias="from", min_length=1)]
    translation: bool = False
    rest_correction: RestCorrection | None = None

    @property
    def chain(self) -> tuple[ChainLink, ...]:
        return tuple(ChainLink(bone=x) if isinstance(x, str) else x for x in self.from_)


class Units(_Strict):
    translation_scale: float = Field(default=1.0, gt=0)  # target units per source unit


class MappingFile(_Strict):
    schema_version: Literal[1] = 1
    name: str | None = None
    description: str | None = None
    units: Units = Units()
    unmapped: Literal["warn", "error", "ignore"] = "warn"
    ignore: list[str] = Field(default_factory=list)
    bones: dict[str, str | BoneEntry]

    @field_validator("bones")
    @classmethod
    def _not_empty(cls, bones: dict[str, str | BoneEntry]) -> dict[str, str | BoneEntry]:
        if not bones:
            raise ValueError("must map at least one target bone")
        return bones

    def entries(self) -> dict[str, BoneEntry]:
        """Every target entry in long form (string shorthand expanded)."""
        return {
            target: BoneEntry.model_validate({"from": [value]}) if isinstance(value, str) else value
            for target, value in self.bones.items()
        }


def _describe(error: ValidationError) -> str:
    lines = []
    for item in error.errors():
        where = ".".join(str(p) for p in item["loc"] if p not in ("str", "BoneEntry"))
        lines.append(f"  - {where or '(top level)'}: {item['msg']}")
    return "\n".join(lines)


def load_mapping(path: Path | str) -> MappingFile:
    file_path = Path(path)
    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise MappingError(f"cannot read file: {exc.strerror}", path=file_path) from exc
    except json.JSONDecodeError as exc:
        raise MappingError(
            f"not valid JSON (line {exc.lineno}, column {exc.colno}): {exc.msg}", path=file_path
        ) from exc
    try:
        return MappingFile.model_validate(data)
    except ValidationError as exc:
        raise MappingError(f"invalid mapping file:\n{_describe(exc)}", path=file_path) from exc
