"""PMX reading: bones, IK and morph names, and using a model as the source skeleton."""

import math
from pathlib import Path

import numpy as np
import pytest

from miku_motion.errors import InputFormatError
from miku_motion.pipeline import ConvertOptions, convert
from miku_motion.pmx.adapter import to_source_rig
from miku_motion.pmx.parser import parse_pmx, read_pmx
from miku_motion.rig.schema import load_skeleton
from miku_motion.vmd.writer import write_vmd
from tests.fixtures.builders import (
    bone_key,
    player_rig,
    pmx_bone,
    pmx_bytes,
    vmd,
    write_json,
)

KNEE_LIMITS = ((-math.pi, 0.0, 0.0), (-0.0087, 0.0, 0.0))


def _legs() -> list[dict[str, object]]:
    """One leg with an IK goal, a waist-cancel bone and an unrelated helper IK."""
    return [
        pmx_bone("root", None, (0, 0, 0)),
        pmx_bone("waist", "root", (0, 12, 0)),
        pmx_bone("cancel", "waist", (1, 11, 0), inherit=("waist", -1.0)),
        pmx_bone("thigh", "cancel", (1, 11, 0)),
        pmx_bone("knee", "thigh", (1, 6, -0.2)),
        pmx_bone("ankle", "knee", (1, 1, 0)),
        pmx_bone(
            "leg_ik",
            "root",
            (1, 1, 0),
            ik=("ankle", 40, 2.0, [("knee", KNEE_LIMITS), ("thigh", None)]),
        ),
        pmx_bone("hair_1", "waist", (0, 14, 1)),
        pmx_bone("hair_2", "hair_1", (0, 13, 1)),
        pmx_bone("hair_ik", "root", (0, 13, 1), ik=("hair_2", 5, 1.0, [("hair_1", None)])),
    ]


@pytest.mark.parametrize(("utf8", "index_size"), [(False, 2), (True, 1), (False, 4)])
def test_reads_bones_ik_and_morphs(utf8: bool, index_size: int) -> None:
    data = pmx_bytes(
        *_legs(), morphs=(("blink", 2), ("a", 3)), name="模型", utf8=utf8, index_size=index_size
    )
    model = parse_pmx(data)

    assert model.name == "模型"
    assert [b.name for b in model.bones][:4] == ["root", "waist", "cancel", "thigh"]
    cancel, thigh = model.bones[2], model.bones[3]
    assert cancel.inherit_rotation == (1, -1.0)
    assert (thigh.parent, thigh.position) == (2, (1.0, 11.0, 0.0))
    ik = model.bones[6].ik
    assert ik is not None
    assert (ik.target, ik.iterations, ik.limit_angle) == (5, 40, 2.0)
    assert [link.bone for link in ik.links] == [4, 3]
    assert ik.links[0].min_angles == pytest.approx(KNEE_LIMITS[0])
    assert ik.links[1].min_angles is None
    assert [(m.name, m.panel) for m in model.morphs] == [("blink", 2), ("a", 3)]


def test_rig_has_parents_first_inheritance_and_solvable_chains() -> None:
    bones = _legs()
    shuffled = [bones[5], *bones[:5], *bones[6:]]  # a child listed before its parent
    rig = to_source_rig(parse_pmx(pmx_bytes(*shuffled)), "legs")

    names = list(rig.bones)
    assert names.index("knee") < names.index("ankle")
    assert rig.bones["ankle"].parent == "knee"
    inherit = rig.bones["cancel"].inherit
    assert inherit is not None
    assert (inherit.bone, inherit.weight) == ("waist", -1.0)
    leg = next(c for c in rig.ik if c.bone == "leg_ik")
    assert (leg.target, [link.bone for link in leg.links]) == ("ankle", ["knee", "thigh"])
    assert leg.links[0].hinge_axis == 0  # knees bend about X only
    np.testing.assert_allclose(rig.offset("knee"), [0, -5, -0.2])


def test_rig_keeps_only_the_chains_that_drive_wanted_bones() -> None:
    rig = to_source_rig(parse_pmx(pmx_bytes(*_legs())), "legs")
    assert {c.bone for c in rig.ik} == {"leg_ik", "hair_ik"}
    assert [c.bone for c in rig.driving({"thigh", "knee"}).ik] == ["leg_ik"]
    assert "hair_1" not in rig.driving({"thigh"}).required_bones()


def test_rig_skips_repeated_names_and_broken_chains() -> None:
    bones = [
        pmx_bone("root", None, (0, 0, 0)),
        pmx_bone("a", "root", (0, 1, 0)),
        pmx_bone("b", "root", (0, 2, 0)),  # not a's child
        pmx_bone("ik", "root", (0, 2, 0), ik=("b", 3, 1.0, [("a", None)])),
    ]
    data = pmx_bytes(*bones)
    rig = to_source_rig(parse_pmx(data), "odd")
    assert rig.ik == ()  # the link isn't the target's parent: can't be solved

    model = parse_pmx(pmx_bytes(*bones[:3]))
    repeated = type(model)(model.name, (*model.bones, model.bones[1]), model.morphs)
    assert list(to_source_rig(repeated, "dup").bones) == ["root", "a", "b"]


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"Pmd\x00rest", "not a PMX file"),
        (pmx_bytes(*_legs())[:60], "file ends inside"),
        (pmx_bytes(*_legs())[:-40], "file ends inside"),
    ],
)
def test_invalid_files_are_explained(tmp_path: Path, data: bytes, message: str) -> None:
    path = tmp_path / "broken.pmx"
    path.write_bytes(data)
    with pytest.raises(InputFormatError, match=message) as error:
        read_pmx(path)
    assert "broken.pmx" in error.value.render()


def test_pmx_as_source_skeleton_matches_the_same_skeleton_as_json(tmp_path: Path) -> None:
    """A .pmx given as --source-skeleton must solve IK exactly like the equivalent JSON."""
    bones = [
        pmx_bone("全ての親", None, (0, 0, 0)),
        pmx_bone("センター", "全ての親", (0, 8, 0)),
        pmx_bone("左足", "センター", (1, 11, 0)),
        pmx_bone("左ひざ", "左足", (1, 6, -0.2)),
        pmx_bone("左足首", "左ひざ", (1, 1, 0)),
        pmx_bone(
            "左足ＩＫ",
            "全ての親",
            (1, 1, 0),
            ik=("左足首", 40, 2.0, [("左ひざ", KNEE_LIMITS), ("左足", None)]),
        ),
    ]
    pmx = tmp_path / "dancer.pmx"
    pmx.write_bytes(pmx_bytes(*bones))
    skeleton = write_json(
        tmp_path / "dancer.json",
        {
            "schema_version": 1,
            "name": "dancer",
            "bones": [
                {"name": b["name"], "parent": b["parent"], "position": list(b["position"])}
                for b in bones
            ],
            "ik": [
                {
                    "bone": "左足ＩＫ",
                    "target": "左足首",
                    "iterations": 40,
                    "limit_angle_deg": math.degrees(2.0),
                    "links": [
                        {
                            "bone": "左ひざ",
                            "min_deg": [math.degrees(v) for v in KNEE_LIMITS[0]],
                            "max_deg": [math.degrees(v) for v in KNEE_LIMITS[1]],
                        },
                        {"bone": "左足"},
                    ],
                }
            ],
        },
    )
    assert load_skeleton(pmx).ik[0].target == "左足首"

    motion = tmp_path / "squat.vmd"
    motion.write_bytes(
        write_vmd(
            vmd(
                bone_key("センター", 0),
                bone_key("センター", 20, position=(0, -3, 0)),
                bone_key("左足ＩＫ", 0),
                bone_key("左足ＩＫ", 20, position=(0, 0, -1)),
            )
        )
    )
    model = write_json(tmp_path / "rig.bbmodel", player_rig())
    mapping = write_json(
        tmp_path / "mapping.json",
        {"schema_version": 1, "bones": {"LeftLeg": {"from": ["左足"]}}},
    )
    with_pmx = convert(motion, model, mapping, ConvertOptions(fps=20, source_skeleton=pmx))
    with_json = convert(motion, model, mapping, ConvertOptions(fps=20, source_skeleton=skeleton))
    plain = convert(motion, model, mapping, ConvertOptions(fps=20, source_skeleton=None))
    assert with_pmx.text == with_json.text
    assert with_pmx.text != plain.text  # the leg really is driven by the solved IK
