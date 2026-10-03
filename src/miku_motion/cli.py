"""Command-line interface (`miku-motion`)."""

import dataclasses
import json
import sys
from pathlib import Path
from typing import Annotated

import numpy as np
import typer
from rich.console import Console
from rich.table import Table

from miku_motion import __version__
from miku_motion.animation.clip import LoopMode
from miku_motion.blockbench.bbmodel import read_bbmodel
from miku_motion.diagnostics import Diagnostics, Severity
from miku_motion.errors import MikuMotionError
from miku_motion.geckolib.optimize import (
    DEFAULT_POSITION_TOLERANCE,
    DEFAULT_ROTATION_TOLERANCE,
    Tolerance,
)
from miku_motion.mapping.schema import MappingFile, load_mapping
from miku_motion.mapping.secondary import suggest_chains
from miku_motion.pipeline import DEFAULT_FPS, OPTIMIZED_FPS, ConvertOptions, convert
from miku_motion.rig.schema import DEFAULT_SKELETON
from miku_motion.vmd import synth
from miku_motion.vmd.parser import read_vmd
from miku_motion.vmd.summary import VmdSummary, summarize
from miku_motion.vmd.writer import write_vmd

app = typer.Typer(
    name="miku-motion",
    help="Convert MikuMikuDance motion (.vmd) into Blockbench / GeckoLib animation JSON.",
    no_args_is_help=True,
    add_completion=False,
)

for _stream in (sys.stdout, sys.stderr):
    # MMD names are Japanese; legacy Windows consoles default to a code page that can't
    # print them.
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

console = Console(highlight=False)
err_console = Console(stderr=True, highlight=False)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"miku-motion {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: Annotated[
        bool,
        typer.Option("--version", callback=_version_callback, is_eager=True, help="Show version."),
    ] = False,
) -> None:
    """Convert MikuMikuDance motion (.vmd) into Blockbench / GeckoLib animation JSON."""


def _fail(error: MikuMotionError) -> typer.Exit:
    err_console.print(f"[bold red]error:[/] {error.render()}", markup=True, soft_wrap=True)
    return typer.Exit(code=1)


ExistingFile = Annotated[
    Path, typer.Argument(exists=True, dir_okay=False, readable=True, show_default=False)
]


@app.command()
def inspect(
    motion: ExistingFile,
    all_bones: Annotated[
        bool, typer.Option("--all", help="Also list bones that only hold a static pose.")
    ] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Print machine-readable JSON.")] = False,
) -> None:
    """Show what a .vmd motion contains: frame range, animated bones, unsupported data."""
    try:
        summary = summarize(read_vmd(motion))
    except MikuMotionError as error:
        raise _fail(error) from error

    if as_json:
        data = dataclasses.asdict(summary)
        data["duration_seconds"] = summary.duration_seconds
        data["unsupported"] = list(summary.unsupported)
        typer.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return
    _print_summary(motion, summary, all_bones)


@app.command(name="convert")
def convert_command(
    motion: ExistingFile,
    target: Annotated[
        Path,
        typer.Option(
            "--target", "-t", exists=True, dir_okay=False, help="Target Blockbench model."
        ),
    ],
    mapping: Annotated[
        Path,
        typer.Option("--mapping", "-m", exists=True, dir_okay=False, help="Bone mapping JSON."),
    ],
    output: Annotated[
        Path | None,
        typer.Option("--output", "-o", dir_okay=False, help="Default: <motion>.animation.json"),
    ] = None,
    fps: Annotated[
        float | None,
        typer.Option(
            min=1.0,
            max=240.0,
            help=f"Samples per second (default {DEFAULT_FPS:g}, or {OPTIMIZED_FPS:g} with "
            "--optimize).",
            show_default=False,
        ),
    ] = None,
    optimize: Annotated[
        bool,
        typer.Option(
            help="Keep only the keyframes needed to stay within the tolerances: much smaller "
            "files, and no interpolation detours between keys."
        ),
    ] = False,
    rotation_tolerance: Annotated[
        float, typer.Option(min=0.01, help="Max rotation error with --optimize (degrees).")
    ] = DEFAULT_ROTATION_TOLERANCE,
    position_tolerance: Annotated[
        float, typer.Option(min=0.001, help="Max position error with --optimize (pixels).")
    ] = DEFAULT_POSITION_TOLERANCE,
    name: Annotated[
        str | None, typer.Option(help="Animation name. Default: animation.<model>.<motion>")
    ] = None,
    loop: Annotated[LoopMode, typer.Option(help="GeckoLib loop mode.")] = LoopMode.ONCE,
    audio: Annotated[
        Path | None,
        typer.Option(
            exists=True,
            dir_okay=False,
            help="Music (.ogg) to start on the first frame via a sound keyframe; its length "
            "is checked against the motion.",
        ),
    ] = None,
    sound: Annotated[
        str | None,
        typer.Option(
            help="Sound effect id for that keyframe. Default: <model mod id>:<audio name>. "
            "Can be used without --audio."
        ),
    ] = None,
    source_skeleton: Annotated[
        str,
        typer.Option(
            help="Skeleton of the motion's MMD model, used to solve IK: a built-in name or "
            "a skeleton .json file."
        ),
    ] = DEFAULT_SKELETON,
    ik: Annotated[bool, typer.Option(help="Solve IK (legs, toes) like MMD does.")] = True,
    strict: Annotated[bool, typer.Option(help="Fail when any warning is emitted.")] = False,
) -> None:
    """Convert a .vmd motion into a GeckoLib .animation.json for a Blockbench model."""
    sample_rate = fps if fps is not None else (OPTIMIZED_FPS if optimize else DEFAULT_FPS)
    options = ConvertOptions(
        fps=sample_rate,
        tolerance=Tolerance(rotation_tolerance, position_tolerance) if optimize else None,
        name=name,
        loop=loop,
        audio=audio,
        sound=sound,
        source_skeleton=source_skeleton if ik else None,
    )
    try:
        result = convert(motion, target, mapping, options)
    except MikuMotionError as error:
        raise _fail(error) from error

    _print_diagnostics(result.diagnostics)
    if strict and result.diagnostics.warnings:
        err_console.print("[bold red]error:[/] warnings present and --strict was given")
        raise typer.Exit(code=1)

    destination = output or motion.with_name(f"{motion.stem}.animation.json")
    destination.write_text(result.text, encoding="utf-8", newline="\n")
    animation = result.animation
    console.print(
        f"[green]wrote[/] {destination}  ({len(animation.tracks)} bones, "
        f"{len(animation.times)} samples @ {sample_rate:g} fps, {animation.length:.2f} s)",
        soft_wrap=True,
    )
    for cue in animation.sounds:
        console.print(f"  sound keyframe at {cue.time:g} s: {cue.effect}")


@app.command(name="inspect-model")
def inspect_model(
    model: ExistingFile,
    mapping: Annotated[
        Path | None,
        typer.Option(
            "--mapping", "-m", exists=True, dir_okay=False, help="Skip bones it already uses."
        ),
    ] = None,
) -> None:
    """Show a Blockbench model's bones and suggest hair/cloth chains for secondary motion."""
    try:
        target = read_bbmodel(model)
        config = load_mapping(mapping) if mapping else MappingFile(bones={"": ""})
    except MikuMotionError as error:
        raise _fail(error) from error

    skeleton = target.skeleton
    console.print(
        f"[bold]{model.name}[/]  (Blockbench {target.format_version}, {target.model_format}, "
        f"{len(skeleton)} bones)"
    )
    used = set(config.bones) | {b for chain in config.secondary_motion for b in chain.bones}
    for bone in skeleton:
        depth = len(list(skeleton.ancestors(bone.name)))
        pivot = ", ".join(f"{v:g}" for v in bone.pivot)
        rest = (
            "  rest " + ", ".join(f"{v:g}" for v in bone.rest_euler_degrees)
            if np.any(bone.rest_euler_degrees)
            else ""
        )
        tags = ("" if bone.extent is not None else "  (no cubes)") + (
            "  [mapped]" if bone.name in used else ""
        )
        console.print(f"  {'  ' * depth}{bone.name}  [dim]pivot {pivot}{rest}{tags}[/]")

    suggestions = suggest_chains(skeleton, config)
    if not suggestions:
        console.print("\nNo unconfigured hair/cloth-like chains found.")
        return
    console.print(
        "\n[bold]Possible secondary_motion chains[/] (review, then paste into the mapping; "
        "presets: long_hair, ponytail, short_hair, cloth, accessory):"
    )
    lines = []
    for suggestion in suggestions:
        bones = json.dumps(list(suggestion.bones), ensure_ascii=False)
        lines.append(f'    {{ "bones": {bones}, "preset": "{suggestion.preset}" }}')
    typer.echo('  "secondary_motion": [\n' + ",\n".join(lines) + "\n  ]")


def _print_diagnostics(diagnostics: Diagnostics) -> None:
    for item in diagnostics.items:
        style = "yellow" if item.severity is Severity.WARNING else "dim"
        err_console.print(f"[{style}]{item.severity}:[/] {item.render()}", soft_wrap=True)


dev_app = typer.Typer(help="Developer tools for verifying conventions.", no_args_is_help=True)
app.add_typer(dev_app, name="dev", hidden=True)


@dev_app.command("synth-calibration")
def synth_calibration(
    output: Annotated[Path, typer.Option("--output", "-o", dir_okay=False)],
    rotate_bone: Annotated[str, typer.Option("--rotate", help="Source bone to rotate.")],
    move_bone: Annotated[
        str | None, typer.Option("--move", help="Source bone to translate.")
    ] = None,
    degrees: float = 45.0,
    distance: float = 2.0,
) -> None:
    """Write a VMD that rotates one bone about X, Y, Z and moves another along X, Y, Z."""
    vmd, steps = synth.calibration(rotate_bone, move_bone, degrees, distance)
    output.write_bytes(write_vmd(vmd))
    console.print(f"[green]wrote[/] {output}")
    for step in steps:
        console.print(f"  {step.start_frame / 30:5.1f} s  {step.label}")


def _print_summary(path: Path, summary: VmdSummary, all_bones: bool) -> None:
    moving = [b for b in summary.bones if b.varies]
    static = [b for b in summary.bones if not b.varies]
    console.print(f"[bold]{path.name}[/]  (VMD v{summary.version})")
    console.print(f"  model name   {summary.model_name or '-'}")
    console.print(
        f"  frames       {summary.first_frame}-{summary.last_frame} @ 30 fps"
        f"  ({summary.duration_seconds:.2f} s)"
    )
    console.print(
        f"  bone keys    {summary.bone_key_count} across {len(summary.bones)} bones "
        f"({len(moving)} moving, {len(static)} static pose only)"
    )
    console.print(
        f"  morph keys   {summary.morph_key_count} across {len(summary.morph_names)} morphs"
    )
    console.print(
        f"  camera/light/shadow keys  {summary.camera_key_count}/"
        f"{summary.light_key_count}/{summary.shadow_key_count}"
    )

    table = Table(title="Bones" if all_bones else "Moving bones", title_justify="left")
    for column in ("bone", "keys", "frames", "rotates", "translates", "note"):
        table.add_column(column, justify="right" if column == "keys" else "left")
    for bone in summary.bones if all_bones else moving:
        table.add_row(
            bone.name,
            str(bone.key_count),
            f"{bone.first_frame}-{bone.last_frame}",
            "yes" if bone.rotates else "",
            "yes" if bone.translates else "",
            ("IK" if bone.ik else "") + ("" if bone.varies else " static"),
        )
    console.print(table)
    if static and not all_bones:
        console.print(f"  ({len(static)} static-pose bones hidden; use --all to list them)")

    if summary.unsupported:
        console.print("[bold yellow]Not converted by this version:[/]")
        for note in summary.unsupported:
            console.print(f"  - {note}")
