"""Command-line interface (`miku-motion`)."""

import dataclasses
import json
import sys
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from miku_motion import __version__
from miku_motion.animation.clip import LoopMode
from miku_motion.diagnostics import Diagnostics, Severity
from miku_motion.errors import MikuMotionError
from miku_motion.pipeline import DEFAULT_FPS, ConvertOptions, convert
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
        float, typer.Option(min=1.0, max=240.0, help="Samples per second of output.")
    ] = DEFAULT_FPS,
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
    strict: Annotated[bool, typer.Option(help="Fail when any warning is emitted.")] = False,
) -> None:
    """Convert a .vmd motion into a GeckoLib .animation.json for a Blockbench model."""
    options = ConvertOptions(fps=fps, name=name, loop=loop, audio=audio, sound=sound)
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
        f"{len(animation.times)} samples @ {fps:g} fps, {animation.length:.2f} s)",
        soft_wrap=True,
    )
    for cue in animation.sounds:
        console.print(f"  sound keyframe at {cue.time:g} s: {cue.effect}")


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
