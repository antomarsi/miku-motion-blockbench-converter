"""Check whether a model is ready for dancing, and fix what can be fixed automatically.

Everything is generic: body parts come from ``roles.detect_roles`` (geometry), hair and
cloth from ``suggest_chains``. Fixes are applied to a copy of the project document:

- no root group around the body -> add one
- head or arms not under the torso (flat rigs) -> attach them to it
- legs parented to the torso (torso bends would swing them) -> move them under the root
- torso pivoting above its middle (e.g. at the neck) -> pivot at the waist
- single-segment arms/legs -> split at the elbow/knee (cubes and UVs split exactly)
- a limb segment sharing its parent's pivot -> pivot at its own joint
- hair/limb chains without Blockbench IK -> tip locator, IK null and pole null
"""

from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

import numpy as np

from miku_motion.animation.skeleton import Skeleton
from miku_motion.blockbench.bbmodel import BlockbenchModel, parse_bbmodel
from miku_motion.mapping.schema import MappingFile
from miku_motion.mapping.secondary import Suggestion, geometry_tip, suggest_chains
from miku_motion.model.document import BbmodelDocument
from miku_motion.model.roles import Roles, detect_roles

NEW_ROOT = "root"  # name of the group added around a body that has none
POLE_DISTANCE = 8.0  # px from the joint
HAIR_POLE_OUTWARD = 4.0  # px sideways, away from the head


@dataclass(frozen=True, slots=True)
class Finding:
    message: str
    fixed: bool  # False: needs a manual step (the message says which)


@dataclass(slots=True)
class PrepareOptions:
    split_limbs: bool = True
    hair_ik: bool = True
    limb_ik: bool = True


@dataclass(slots=True)
class Analysis:
    model: BlockbenchModel
    roles: Roles
    suggestions: list[Suggestion] = field(default_factory=list)

    @property
    def skeleton(self) -> Skeleton:
        return self.model.skeleton


def analyze(document: BbmodelDocument, path: Path) -> Analysis:
    model = parse_bbmodel(document.data, path)
    suggestions = suggest_chains(model.skeleton, MappingFile(bones={"": ""}))
    roles = detect_roles(model.skeleton, {b for s in suggestions for b in s.bones})
    return Analysis(model, roles, suggestions)


def _fix_structure(doc: BbmodelDocument, a: Analysis, out: list[Finding]) -> None:
    roles, skeleton = a.roles, a.skeleton
    if roles.root is None and roles.torso and roles.legs:
        tops = [n for n in doc.data["outliner"] if isinstance(n, dict)]
        first = doc.group(tops[0])["name"]
        doc.add_group(doc.unique_name(NEW_ROOT), None, [0, 0, 0], like=first)
        root_name = doc.group(doc.data["outliner"][-1])["name"]
        for node in tops:
            doc.move(doc.group(node)["name"], root_name)
        out.append(
            Finding(
                f"added a {root_name!r} group around the body (it carries the dance's "
                "movement across the floor)",
                True,
            )
        )
        roles.root = root_name
    if roles.torso:
        attach = [("head", roles.head)] + [(f"{side} arm", s[0]) for side, s in roles.arms.items()]
        for what, bone in attach:
            if bone and roles.torso not in {a.name for a in skeleton.ancestors(bone)}:
                doc.move(bone, roles.torso)
                out.append(
                    Finding(
                        f"attached the {what} {bone!r} to the torso {roles.torso!r} "
                        "so it follows the upper body",
                        True,
                    )
                )
        new_parent = roles.root or skeleton[roles.torso].parent
        for side, segments in roles.legs.items():
            leg = segments[0]
            if any(a.name == roles.torso for a in skeleton.ancestors(leg)):
                parent = new_parent
                doc.move(leg, parent)
                out.append(
                    Finding(
                        f"moved the {side} leg {leg!r} out of the torso "
                        f"{roles.torso!r} (torso bends no longer swing it)",
                        True,
                    )
                )
        torso = skeleton[roles.torso]
        if torso.extent is not None:
            middle = 0.5 * (torso.extent[0][1] + torso.extent[1][1])
            if torso.pivot[1] > middle + 0.5:
                waist = [float(torso.pivot[0]), float(torso.extent[0][1]), float(torso.pivot[2])]
                doc.set_pivot(roles.torso, waist)
                out.append(
                    Finding(
                        f"moved the torso {roles.torso!r} pivot from y={torso.pivot[1]:g} "
                        f"to the waist (y={waist[1]:g}) so it bends at the hips",
                        True,
                    )
                )


def _split_limbs(doc: BbmodelDocument, a: Analysis, out: list[Finding]) -> None:
    skeleton = a.skeleton
    for kind, limbs, joint in (("arm", a.roles.arms, "elbow"), ("leg", a.roles.legs, "knee")):
        for side, segments in limbs.items():
            if len(segments) != 1:
                continue
            bone = skeleton[segments[0]]
            if bone.extent is None:
                continue
            y = float(round(0.5 * (bone.extent[0][1] + bone.extent[1][1])))
            lower = doc.unique_name(f"{bone.name} Lower")
            doc.add_group(
                lower, bone.name, [float(bone.pivot[0]), y, float(bone.pivot[2])], like=bone.name
            )
            for cube in doc.cubes(bone.name):
                bottom, top = cube["from"][1], cube["to"][1]
                if bottom >= y:
                    continue
                if top <= y:
                    doc.move_element(cube["uuid"], lower)
                else:
                    doc.split_cube(cube["uuid"], y, lower)
            for child in skeleton.children(bone.name):
                height = (
                    0.5 * (child.extent[0][1] + child.extent[1][1])
                    if child.extent is not None
                    else child.pivot[1]
                )
                if height < y:
                    doc.move(child.name, lower)
            out.append(
                Finding(
                    f"split the {side} {kind} {bone.name!r} at the {joint} (y={y:g}) "
                    f"into {bone.name!r} and {lower!r}, keeping the texture",
                    True,
                )
            )


def _fix_joints(doc: BbmodelDocument, a: Analysis, out: list[Finding]) -> None:
    skeleton = a.skeleton
    for limbs in (a.roles.arms, a.roles.legs):
        for segments in limbs.values():
            for parent, child in pairwise(segments):
                bone = skeleton[child]
                if bone.extent is not None and np.allclose(bone.pivot, skeleton[parent].pivot):
                    pivot = [float(bone.pivot[0]), float(bone.extent[1][1]), float(bone.pivot[2])]
                    doc.set_pivot(child, pivot)
                    out.append(
                        Finding(
                            f"moved {child!r} pivot to its joint (y={pivot[1]:g}); it "
                            f"shared {parent!r}'s pivot",
                            True,
                        )
                    )


def _has_ik(doc: BbmodelDocument, chain_root: str) -> bool:
    root_uuid = doc.group_uuid(chain_root)
    return any(n.get("ik_source") == root_uuid for n in doc.null_objects())


def _add_ik(
    doc: BbmodelDocument,
    skeleton: Skeleton,
    chain: list[str],
    parent: str,
    pole_offset: list[float],
    what: str,
    out: list[Finding],
) -> None:
    tip = geometry_tip(skeleton[chain[-1]], skeleton[chain[0]].pivot)
    if tip is None or _has_ik(doc, chain[0]):
        return
    middle = np.mean([skeleton[b].pivot for b in chain[1:]], axis=0)
    locator = doc.add_locator(doc.unique_name(f"{chain[-1]} tip"), list(tip), chain[-1])
    pole = doc.add_null(
        doc.unique_name(f"{chain[0]} IK pole"), list(middle + np.array(pole_offset)), parent
    )
    doc.add_null(
        doc.unique_name(f"{chain[0]} IK"),
        list(tip),
        parent,
        target=locator,
        source=doc.group_uuid(chain[0]),
        pole=pole,
    )
    out.append(
        Finding(
            f"added Blockbench IK for {what} {' > '.join(chain)} (tip locator, IK null, pole null)",
            True,
        )
    )


def _add_iks(
    doc: BbmodelDocument, a: Analysis, options: PrepareOptions, out: list[Finding]
) -> None:
    skeleton = a.skeleton
    if options.hair_ik:
        for suggestion in a.suggestions:
            chain = list(suggestion.bones)
            parent = skeleton[chain[0]].parent
            if len(chain) < 2 or parent is None:
                continue
            outward = HAIR_POLE_OUTWARD * float(np.sign(skeleton[chain[0]].pivot[0]))
            _add_ik(
                doc, skeleton, chain, parent, [outward, 0.0, POLE_DISTANCE], suggestion.preset, out
            )
    if options.limb_ik:
        anchor = a.roles.root or a.roles.torso
        for side, segments in a.roles.arms.items():
            if len(segments) >= 2 and a.roles.torso:
                _add_ik(
                    doc,
                    skeleton,
                    segments,
                    a.roles.torso,
                    [0.0, 0.0, POLE_DISTANCE],
                    f"the {side} arm",
                    out,
                )  # elbows point back
        for side, segments in a.roles.legs.items():
            if len(segments) >= 2 and anchor:
                _add_ik(
                    doc,
                    skeleton,
                    segments,
                    anchor,
                    [0.0, 0.0, -POLE_DISTANCE],
                    f"the {side} leg",
                    out,
                )  # knees point forward


def prepare(
    document: BbmodelDocument, path: Path, options: PrepareOptions | None = None
) -> tuple[list[Finding], Analysis]:
    """Apply every automatic fix to ``document``; returns findings and the final analysis."""
    options = options or PrepareOptions()
    findings: list[Finding] = []
    a = analyze(document, path)
    missing = [
        part
        for part, found in (
            ("torso", a.roles.torso),
            ("head", a.roles.head),
            ("legs", a.roles.legs),
            ("arms", a.roles.arms),
        )
        if not found
    ]
    if missing:
        findings.append(
            Finding(
                f"couldn't find the model's {', '.join(missing)}; map those bones by hand", False
            )
        )
    _fix_structure(document, a, findings)
    if options.split_limbs:
        _split_limbs(document, analyze(document, path), findings)
    _fix_joints(document, analyze(document, path), findings)
    _add_iks(document, analyze(document, path), options, findings)
    final = analyze(document, path)
    if not final.model.is_geckolib:
        findings.append(
            Finding(
                f"the project format is {final.model.model_format!r}: in Blockbench use "
                "File > Convert Project > GeckoLib Animated Model before exporting "
                "for the mod",
                False,
            )
        )
    return findings, final
