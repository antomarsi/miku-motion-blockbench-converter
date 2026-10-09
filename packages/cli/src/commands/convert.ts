import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  builtinSkeleton,
  checkGroupLabels,
  convert,
  convertGroup,
  DEFAULT_FPS,
  DEFAULT_GROUP_DURATION_TOLERANCE,
  DEFAULT_POSITION_TOLERANCE,
  DEFAULT_ROTATION_TOLERANCE,
  DEFAULT_SCALE_TOLERANCE,
  DEFAULT_SKELETON,
  Formation,
  LoopMode,
  MikuMotionError,
  OPTIMIZED_FPS,
  parseSkeletonText,
  pmxRig,
  type ConvertOptions,
  type MotionInput,
  type SourceRig,
} from "@miku-motion/core";

import {
  compact,
  printDiagnostics,
  readInput,
  readMapping,
  readModel,
  readText,
  stem,
  UsageError,
  writeOutput,
} from "../io";
import { renderTable } from "../table";

const SHARED_OPTIONS = `  -t, --target <file>    Target Blockbench model (required)
  -m, --mapping <file>   Bone mapping JSON (required)
      --fps <number>     Samples per second, 1 to 240 (default ${DEFAULT_FPS}, or ${OPTIMIZED_FPS} with --optimize)
      --optimize         Keep only the keyframes needed to stay within the tolerances:
                         much smaller files, and no interpolation detours between keys
      --rotation-tolerance <deg>  Max rotation error with --optimize (default ${DEFAULT_ROTATION_TOLERANCE})
      --position-tolerance <px>   Max position error with --optimize (default ${DEFAULT_POSITION_TOLERANCE})
      --loop <mode>      GeckoLib loop mode: false, true or hold (default false)
      --source-skeleton <name|file>
                         Skeleton of the motion's MMD model, used to solve IK: a built-in
                         name, a skeleton .json, or best the .pmx the motion was made for
                         (default ${DEFAULT_SKELETON})
      --no-ik            Don't solve IK (legs, toes)
      --strict           Fail when any warning is emitted`;

export const CONVERT_HELP = `Usage: miku-motion convert <motion.vmd> -t <model.bbmodel> -m <mapping.json> [options]

Convert a .vmd motion into a GeckoLib .animation.json for a Blockbench model.

Options:
  -o, --output <file>    Default: <motion>.animation.json next to the motion
      --name <text>      Animation name. Default: animation.<model>.<motion>
${SHARED_OPTIONS}
`;

export const CONVERT_GROUP_HELP = `Usage: miku-motion convert-group <motions-or-folder>... -t <model.bbmodel> -m <mapping.json> [options]

Convert several motions sharing one target rig, e.g. a dance crew performing together.
A folder stands for every .vmd in it, named <folder>_<motion>.

By default each motion converts independently, with a warning when lengths differ.
--sync-length and --formation adjust them as one performance.

Options:
  -o, --output-dir <dir>  Default: next to each motion file
      --sync-length       Give every animation the longest one's length; shorter ones
                          hold their last pose
      --formation <mode>  Stage positions stored in the motions: keep them (default),
                          center the group on the origin, or start every performer at
                          its own origin (the table lists where each one stood)
      --duration-tolerance <s>
                          Flag a member whose length differs from the group's average
                          by more than this (default ${DEFAULT_GROUP_DURATION_TOLERANCE})
${SHARED_OPTIONS}
`;

const SHARED_ARGS = {
  target: { type: "string", short: "t" },
  mapping: { type: "string", short: "m" },
  fps: { type: "string" },
  optimize: { type: "boolean" },
  "rotation-tolerance": { type: "string" },
  "position-tolerance": { type: "string" },
  loop: { type: "string" },
  "source-skeleton": { type: "string" },
  "no-ik": { type: "boolean" },
  strict: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type SharedValues = {
  [K in keyof typeof SHARED_ARGS]?: (typeof SHARED_ARGS)[K]["type"] extends "boolean" ? boolean : string;
};

const LOOP_MODES = new Set<string>(Object.values(LoopMode));
const FORMATIONS = new Set<string>(Object.values(Formation));

function numberOption(value: string | undefined, name: string, fallback: number, min: number, max = Infinity): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!(number >= min && number <= max)) {
    throw new UsageError(
      `error: --${name} must be ${Number.isFinite(max) ? `between ${min} and ${max}` : `at least ${min}`}`,
    );
  }
  return number;
}

/** A built-in skeleton name, a skeleton .json file, or the motion's own .pmx model. */
function sourceRig(value: string): SourceRig {
  if (value.toLowerCase().endsWith(".pmx")) return pmxRig(readInput(value), stem(value), value);
  if (value.toLowerCase().endsWith(".json") || existsSync(value)) {
    return parseSkeletonText(readText(value), value);
  }
  return builtinSkeleton(value);
}

function conversionOptions(values: SharedValues): { options: ConvertOptions; fps: number } {
  const optimize = values.optimize ?? false;
  const fps = numberOption(values.fps, "fps", optimize ? OPTIMIZED_FPS : DEFAULT_FPS, 1, 240);
  const loop = values.loop ?? LoopMode.ONCE;
  if (!LOOP_MODES.has(loop)) throw new UsageError("error: --loop must be false, true or hold");
  const options: ConvertOptions = {
    fps,
    loop: loop as LoopMode,
    sourceRig: values["no-ik"] ? null : sourceRig(values["source-skeleton"] ?? DEFAULT_SKELETON),
    tolerance: optimize
      ? {
          rotationDegrees: numberOption(values["rotation-tolerance"], "rotation-tolerance", DEFAULT_ROTATION_TOLERANCE, 0.01),
          position: numberOption(values["position-tolerance"], "position-tolerance", DEFAULT_POSITION_TOLERANCE, 0.001),
          scale: DEFAULT_SCALE_TOLERANCE,
        }
      : undefined,
  };
  return { options, fps };
}

export function convertCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { ...SHARED_ARGS, output: { type: "string", short: "o" }, name: { type: "string" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(CONVERT_HELP);
    return 0;
  }
  const [motion, ...rest] = positionals;
  if (motion === undefined || rest.length || !values.target || !values.mapping) {
    throw new UsageError(CONVERT_HELP);
  }
  const { options, fps } = conversionOptions(values);

  const result = convert(
    {
      motion: { data: readInput(motion), label: stem(motion), path: motion },
      model: readModel(values.target),
      mapping: readMapping(values.mapping),
      mappingPath: values.mapping,
    },
    { ...options, name: values.name },
  );
  printDiagnostics(result.diagnostics);
  if (values.strict && result.diagnostics.warnings.length) {
    console.error("error: warnings present and --strict was given");
    return 1;
  }

  const destination = values.output ?? join(dirname(motion), `${stem(motion)}.animation.json`);
  writeOutput(destination, result.text);
  const { animation } = result;
  console.log(
    `wrote ${destination}  (${animation.tracks.size} bones, ` +
      `${animation.times.length} samples @ ${compact(fps)} fps, ${animation.length.toFixed(2)} s)`,
  );
  return 0;
}

/** Expand folders into their motion files (by name; labelled `<folder>_<motion>`). */
function collectGroup(paths: readonly string[]): MotionInput[] {
  const motions: MotionInput[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new MikuMotionError("no such file or folder", { path });
    if (!statSync(path).isDirectory()) {
      motions.push({ data: readInput(path), label: stem(path), path });
      continue;
    }
    const files = readdirSync(path)
      .filter((name) => name.toLowerCase().endsWith(".vmd") && statSync(join(path, name)).isFile())
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    if (!files.length) throw new MikuMotionError("this folder has no .vmd motions", { path });
    const folder = basename(resolve(path));
    for (const name of files) {
      const file = join(path, name);
      motions.push({ data: readInput(file), label: `${folder}_${stem(name)}`, path: file });
    }
  }
  checkGroupLabels(motions);
  return motions;
}

export function convertGroupCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...SHARED_ARGS,
      "output-dir": { type: "string", short: "o" },
      "sync-length": { type: "boolean" },
      formation: { type: "string" },
      "duration-tolerance": { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(CONVERT_GROUP_HELP);
    return 0;
  }
  if (!positionals.length || !values.target || !values.mapping) throw new UsageError(CONVERT_GROUP_HELP);
  const formation = values.formation ?? Formation.KEEP;
  if (!FORMATIONS.has(formation)) throw new UsageError("error: --formation must be keep, center or origin");
  const { options } = conversionOptions(values);

  const group = convertGroup(
    collectGroup(positionals),
    { model: readModel(values.target), mapping: readMapping(values.mapping), mappingPath: values.mapping },
    options,
    {
      formation: formation as Formation,
      syncLength: values["sync-length"] ?? false,
      durationTolerance: numberOption(values["duration-tolerance"], "duration-tolerance", DEFAULT_GROUP_DURATION_TOLERANCE, 0),
    },
  );

  let anyWarnings = group.diagnostics.warnings.length > 0;
  const rows: string[][] = [];
  for (const member of group.members) {
    printDiagnostics(member.result.diagnostics);
    anyWarnings ||= member.result.diagnostics.warnings.length > 0;
    const path = member.motion.path ?? member.label;
    const folder = values["output-dir"] ?? dirname(path);
    writeOutput(join(folder, `${member.label}.animation.json`), member.result.text);
    const { animation } = member.result;
    rows.push([
      basename(path),
      animation.name,
      String(animation.tracks.size),
      animation.length.toFixed(2),
      `${member.start[0].toFixed(1)}, ${member.start[2].toFixed(1)}`,
      String(member.result.diagnostics.warnings.length),
    ]);
  }
  console.log("Group members");
  console.log(
    renderTable(
      [
        { title: "motion" },
        { title: "animation" },
        { title: "bones", alignRight: true },
        { title: "length (s)", alignRight: true },
        { title: "stood at x, z (px)" },
        { title: "warnings", alignRight: true },
      ],
      rows,
    ),
  );
  printDiagnostics(group.diagnostics);

  if (values.strict && anyWarnings) {
    console.error("error: warnings present and --strict was given");
    return 1;
  }
  return 0;
}
