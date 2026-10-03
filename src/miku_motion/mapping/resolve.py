"""Check a mapping against a concrete target skeleton and source motion."""

import difflib
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path

import numpy as np

from miku_motion.animation.skeleton import Skeleton
from miku_motion.animation.source import SourceMotion
from miku_motion.diagnostics import Code, Diagnostics
from miku_motion.errors import MappingError
from miku_motion.geometry import euler, quat
from miku_motion.geometry.quat import FloatArray
from miku_motion.mapping.schema import MappingFile

_LIST_LIMIT = 12


@dataclass(frozen=True, slots=True, eq=False)
class Link:
    source: str  # canonical source bone name
    weight: float


@dataclass(frozen=True, slots=True, eq=False)
class Binding:
    target: str
    chain: tuple[Link, ...]
    translation: bool
    rest_correction: FloatArray  # (4,) quaternion, canonical space
    anchor: str | None  # nearest mapped ancestor in the target skeleton


@dataclass(frozen=True, slots=True)
class ResolvedMapping:
    bindings: tuple[Binding, ...]  # in target skeleton order
    translation_scale: float

    def binding(self, target: str) -> Binding:
        return next(b for b in self.bindings if b.target == target)


def _names(names: list[str] | tuple[str, ...]) -> str:
    shown = ", ".join(names[:_LIST_LIMIT])
    return shown + (f" (+{len(names) - _LIST_LIMIT} more)" if len(names) > _LIST_LIMIT else "")


def unknown_targets(unknown: list[str], skeleton: Skeleton) -> str:
    lines = []
    for name in unknown:
        close = difflib.get_close_matches(name, skeleton.names, n=1)
        lines.append(f"  - {name!r}" + (f" (did you mean {close[0]!r}?)" if close else ""))
    return "\n".join(lines)


def resolve(
    mapping: MappingFile,
    skeleton: Skeleton,
    motion: SourceMotion,
    diagnostics: Diagnostics,
    *,
    mapping_path: Path | None = None,
    solved_ik: frozenset[str] = frozenset(),
) -> ResolvedMapping:
    entries = mapping.entries()
    unknown = [target for target in entries if target not in skeleton]
    if unknown:
        raise MappingError(
            f"mapped target bones not found in the model:\n{unknown_targets(unknown, skeleton)}",
            path=mapping_path,
            hint="the model may have changed; run `miku-motion inspect-model` to list its bones",
        )

    key = motion.canonical_name
    bindings = []
    for bone in skeleton:
        entry = entries.get(bone.name)
        if entry is None:
            continue
        correction = entry.rest_correction
        rest = (
            euler.to_quat(np.radians(correction.euler_deg))
            if correction is not None
            else quat.identity()
        )
        anchor = next((a.name for a in skeleton.ancestors(bone.name) if a.name in entries), None)
        bindings.append(
            Binding(
                target=bone.name,
                chain=tuple(Link(key(link.bone), link.weight) for link in entry.chain),
                translation=entry.translation,
                rest_correction=rest,
                anchor=anchor,
            )
        )

    resolved = ResolvedMapping(tuple(bindings), mapping.units.translation_scale)
    _report(mapping, resolved, skeleton, motion, diagnostics, mapping_path, solved_ik)
    return resolved


def _report(
    mapping: MappingFile,
    resolved: ResolvedMapping,
    skeleton: Skeleton,
    motion: SourceMotion,
    diagnostics: Diagnostics,
    mapping_path: Path | None,
    solved_ik: frozenset[str],
) -> None:
    used = {link.source for b in resolved.bindings for link in b.chain}
    ignore = [motion.canonical_name(pattern) for pattern in mapping.ignore]

    def ignored(name: str) -> bool:
        return any(fnmatchcase(name, pattern) for pattern in ignore)

    missing = sorted(used - motion.tracks.keys())
    if missing:
        diagnostics.info(
            Code.MAPPED_SOURCE_MISSING,
            f"{len(missing)} mapped source bones have no keyframes in this motion (held at "
            f"rest): {_names(missing)}",
            tuple(missing),
        )

    ik = sorted(
        name
        for name in (motion.ik_bones & motion.tracks.keys()) - solved_ik
        # IK matters even when its goal is static (it pins feet while the body moves).
        if not ignored(name) and any(on for _, on in motion.ik_states.get(name, ((0, True),)))
    )
    if ik:
        diagnostics.warn(
            Code.IK_DRIVEN_BONES,
            f"motion uses IK bones the source skeleton doesn't define ({_names(ik)}); bones "
            "they drive only follow their own keyframes",
            tuple(ik),
        )

    unmapped = sorted(
        name
        for name, track in motion.tracks.items()
        if track.is_animated and name not in used and name not in motion.ik_bones
        if not ignored(name)
    )
    if unmapped and mapping.unmapped != "ignore":
        message = (
            f"{len(unmapped)} animated source bones are not mapped and their motion is "
            f"dropped: {_names(unmapped)}"
        )
        if mapping.unmapped == "error":
            raise MappingError(
                message,
                path=mapping_path,
                hint='map them, add them to \'ignore\', or set "unmapped": "warn"',
            )
        diagnostics.warn(Code.UNMAPPED_ANIMATED_BONES, message, tuple(unmapped))

    dropped = sorted(
        {
            link.source
            for b in resolved.bindings
            if not b.translation
            for link in b.chain
            if link.source in motion.tracks and motion.tracks[link.source].translates
        }
    )
    if dropped:
        diagnostics.warn(
            Code.TRANSLATION_DROPPED,
            f"translation of {_names(dropped)} is dropped because their target entry has no "
            '"translation": true',
            tuple(dropped),
        )

    unbound = [b for b in skeleton.names if b not in {x.target for x in resolved.bindings}]
    if unbound:
        diagnostics.info(
            Code.UNMAPPED_TARGET_BONES,
            f"{len(unbound)} target bones are not mapped and stay at rest: {_names(unbound)}",
            tuple(unbound),
        )

    _lint_rig(resolved, skeleton, diagnostics)


def _lint_rig(resolved: ResolvedMapping, skeleton: Skeleton, diagnostics: Diagnostics) -> None:
    """Mapping-vs-rig mistakes that convert fine but look wrong."""
    by_target = {b.target: b for b in resolved.bindings}

    doubled = []
    for binding in resolved.bindings:
        weights: dict[str, float] = {}
        node: Binding | None = binding
        while node is not None:  # this chain plus every mapped ancestor's chain
            for link in node.chain:
                weights[link.source] = weights.get(link.source, 0.0) + link.weight
            node = by_target[node.anchor] if node.anchor else None
        doubled += [
            f"{s} ({binding.target} via {binding.anchor})"
            for s, w in weights.items()
            if w > 1.0 + 1e-9 and any(link.source == s for link in binding.chain)
        ]
    if doubled:
        diagnostics.warn(
            Code.SOURCE_APPLIED_TWICE,
            "source bones are applied twice because they're also in a mapped ancestor's "
            f'chain: {_names(doubled)}; remove them from the child\'s "from"',
            tuple(doubled),
        )

    shared = [
        f"{b.target} (pivot of {parent})"
        for b in resolved.bindings
        if (parent := skeleton[b.target].parent) in by_target
        and np.allclose(skeleton[b.target].pivot, skeleton[parent].pivot)
    ]
    if shared:
        diagnostics.warn(
            Code.PIVOT_SHARED_WITH_PARENT,
            f"these bones rotate around their parent's pivot: {_names(shared)}; if they're "
            "separate joints (elbow, knee, chest...), move their pivot to the joint in Blockbench",
            tuple(shared),
        )
