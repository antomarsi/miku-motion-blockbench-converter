import { CORE_NAME, MikuMotionError } from "@miku-motion/core";

import { inspect } from "./commands/inspect";
import { UsageError } from "./io";

const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const USAGE = `miku-motion ${VERSION}
Convert MikuMikuDance motion (.vmd) into Blockbench / GeckoLib animation JSON.

Usage: miku-motion <command> [options]

Commands:
  inspect <motion.vmd>   Show what a motion contains

More commands are being ported from the Python version (branch "python").

Options:
  --version   Show the version
  --help      Show this help (also after a command)
`;

const COMMANDS: Record<string, (argv: string[]) => number> = { inspect };

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "--version") {
    console.log(`${CORE_NAME} ${VERSION}`);
    return 0;
  }
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    console.error(`error: unknown command '${command}'\n\n${USAGE}`);
    return 2;
  }
  try {
    return run(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof MikuMotionError) {
      // Errors that explain themselves: no stack trace.
      console.error(`error: ${error.render()}`);
      return 1;
    }
    if (error instanceof TypeError && "code" in error) {
      // node:util parseArgs: unknown option, missing value...
      console.error(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
