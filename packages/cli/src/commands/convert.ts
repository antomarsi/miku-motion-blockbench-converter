import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { convert, DEFAULT_FPS, LoopMode } from "@miku-motion/core";

import {
  compact,
  printDiagnostics,
  readInput,
  readMapping,
  readModel,
  stem,
  UsageError,
  writeOutput,
} from "../io";

export const CONVERT_HELP = `Usage: miku-motion convert <motion.vmd> -t <model.bbmodel> -m <mapping.json> [options]

Convert a .vmd motion into a GeckoLib .animation.json for a Blockbench model.

Options:
  -t, --target <file>    Target Blockbench model (required)
  -m, --mapping <file>   Bone mapping JSON (required)
  -o, --output <file>    Default: <motion>.animation.json next to the motion
      --fps <number>     Samples per second, 1 to 240 (default ${DEFAULT_FPS})
      --name <text>      Animation name. Default: animation.<model>.<motion>
      --loop <mode>      GeckoLib loop mode: false, true or hold (default false)
      --strict           Fail when any warning is emitted

Not ported yet: leg IK, simulated hair, facial animation and --optimize.
Use the Python version (branch "python") for those.
`;

const LOOP_MODES = new Set<string>(Object.values(LoopMode));

export function convertCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      target: { type: "string", short: "t" },
      mapping: { type: "string", short: "m" },
      output: { type: "string", short: "o" },
      fps: { type: "string" },
      name: { type: "string" },
      loop: { type: "string" },
      strict: { type: "boolean" },
      help: { type: "boolean" },
    },
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
  const fps = values.fps === undefined ? DEFAULT_FPS : Number(values.fps);
  if (!(fps >= 1 && fps <= 240)) throw new UsageError("error: --fps must be between 1 and 240");
  const loop = values.loop ?? LoopMode.ONCE;
  if (!LOOP_MODES.has(loop)) throw new UsageError("error: --loop must be false, true or hold");

  const result = convert(
    {
      motion: { data: readInput(motion), label: stem(motion), path: motion },
      model: readModel(values.target),
      mapping: readMapping(values.mapping),
      mappingPath: values.mapping,
    },
    { fps, name: values.name, loop: loop as LoopMode },
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
