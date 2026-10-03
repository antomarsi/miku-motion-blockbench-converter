"""Structured warnings and notes collected while converting.

Nothing is dropped silently: every stage that ignores or approximates data records a
diagnostic here. Codes are stable so reports can be diffed and filtered.
"""

from dataclasses import dataclass, field
from enum import StrEnum


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"


class Code(StrEnum):
    UNSUPPORTED_MORPHS = "MM001"
    UNSUPPORTED_CAMERA = "MM002"
    UNSUPPORTED_LIGHT = "MM003"
    UNSUPPORTED_SHADOW = "MM004"
    DUPLICATE_KEYS = "MM010"
    UNMAPPED_ANIMATED_BONES = "MM101"
    IK_DRIVEN_BONES = "MM102"
    TRANSLATION_DROPPED = "MM103"
    MAPPED_SOURCE_MISSING = "MM104"
    SOURCE_APPLIED_TWICE = "MM105"
    IK_UNREACHED = "MM106"
    IK_SOLVED = "MM107"
    UNMAPPED_TARGET_BONES = "MM201"
    PIVOT_SHARED_WITH_PARENT = "MM202"
    TARGET_NOT_GECKOLIB = "MM203"
    SECONDARY_MOTION = "MM302"
    SECONDARY_CANDIDATES = "MM303"
    KEYS_REDUCED = "MM401"
    REDUCTION_OVER_TOLERANCE = "MM402"


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: Code
    severity: Severity
    message: str
    bones: tuple[str, ...] = ()

    def render(self) -> str:
        return f"[{self.code}] {self.message}"


@dataclass(slots=True)
class Diagnostics:
    items: list[Diagnostic] = field(default_factory=list)

    def add(
        self, code: Code, severity: Severity, message: str, bones: tuple[str, ...] = ()
    ) -> None:
        self.items.append(Diagnostic(code, severity, message, bones))

    def warn(self, code: Code, message: str, bones: tuple[str, ...] = ()) -> None:
        self.add(code, Severity.WARNING, message, bones)

    def info(self, code: Code, message: str, bones: tuple[str, ...] = ()) -> None:
        self.add(code, Severity.INFO, message, bones)

    @property
    def warnings(self) -> list[Diagnostic]:
        return [d for d in self.items if d.severity is Severity.WARNING]

    def codes(self) -> set[Code]:
        return {d.code for d in self.items}
