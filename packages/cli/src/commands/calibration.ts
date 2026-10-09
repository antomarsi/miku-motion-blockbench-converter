/** synth-calibration: write a motion that moves one axis at a time. */

import { parseArgs } from "node:util";

import { calibration, writeVmd } from "@miku-motion/core";

import { UsageError, writeOutput } from "../io";

export const SYNTH_CALIBRATION_HELP = `Usage: miku-motion synth-calibration -o <out.vmd> --rotate <bone> [options]

Write a VMD that rotates one source bone about X, Y, Z and moves another along X, Y, Z,
for checking a rig and its mapping one direction at a time.

Options:
  -o, --output <file>   The .vmd to write (required)
      --rotate <bone>   Source (MMD) bone to rotate (required)
      --move <bone>     Source (MMD) bone to translate
      --degrees <n>     Default: 45
      --distance <n>    In MMD units. Default: 2
`;

export function synthCalibrationCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      rotate: { type: "string" },
      move: { type: "string" },
      degrees: { type: "string" },
      distance: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(SYNTH_CALIBRATION_HELP);
    return 0;
  }
  const degrees = Number(values.degrees ?? 45);
  const distance = Number(values.distance ?? 2);
  if (
    positionals.length ||
    values.output === undefined ||
    values.rotate === undefined ||
    !Number.isFinite(degrees) ||
    !Number.isFinite(distance)
  ) {
    throw new UsageError(SYNTH_CALIBRATION_HELP);
  }
  const { vmd, steps } = calibration(values.rotate, values.move, degrees, distance);
  writeOutput(values.output, writeVmd(vmd));
  console.log(`wrote ${values.output}`);
  for (const step of steps) {
    console.log(`  ${(step.startFrame / 30).toFixed(1).padStart(5)} s  ${step.label}`);
  }
  return 0;
}
