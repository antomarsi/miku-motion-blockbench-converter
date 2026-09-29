"""User-facing errors. The CLI prints these without a traceback."""

from pathlib import Path


class MikuMotionError(Exception):
    """Base class for errors that explain themselves to the user."""

    def __init__(self, message: str, *, path: Path | str | None = None, hint: str | None = None):
        self.message = message
        self.path = Path(path) if path is not None else None
        self.hint = hint
        super().__init__(self.render())

    def render(self) -> str:
        text = f"{self.path}: {self.message}" if self.path else self.message
        return f"{text}\n  hint: {self.hint}" if self.hint else text


class InputFormatError(MikuMotionError):
    """An input file is malformed or not the format it claims to be."""

    def __init__(
        self,
        message: str,
        *,
        path: Path | str | None = None,
        offset: int | None = None,
        hint: str | None = None,
    ):
        self.offset = offset
        where = f" (at byte offset {offset})" if offset is not None else ""
        super().__init__(f"{message}{where}", path=path, hint=hint)


class MappingError(MikuMotionError):
    """The bone-mapping file is invalid or inconsistent with the inputs."""


class TargetModelError(MikuMotionError):
    """The target model (e.g. .bbmodel) can't be used as a skeleton."""
