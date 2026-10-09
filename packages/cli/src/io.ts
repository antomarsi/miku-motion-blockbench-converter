/** File access for the CLI. The core never touches the file system. */

import { readFileSync } from "node:fs";

import { InputFormatError } from "@miku-motion/core";

/** Wrong command-line usage: the message is the help text to show. */
export class UsageError extends Error {}

export function readInput(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
    throw new InputFormatError(`cannot read file: ${reason}`, { path });
  }
}
