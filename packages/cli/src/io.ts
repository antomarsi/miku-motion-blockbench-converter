/** File access and terminal output for the CLI. The core never touches the file system. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import {
  InputFormatError,
  parseBbmodelText,
  parseMappingText,
  renderDiagnostic,
  type BlockbenchModel,
  type Diagnostics,
  type MappingFile,
} from "@miku-motion/core";

/** Wrong command-line usage: the message is the help text to show. */
export class UsageError extends Error {}

function reason(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : String(error);
}

export function readInput(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    throw new InputFormatError(`cannot read file: ${reason(error)}`, { path });
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new InputFormatError(`cannot read file: ${reason(error)}`, { path });
  }
}

/** File name without its directory and extension. */
export function stem(path: string): string {
  return basename(path, extname(path));
}

export function readModel(path: string): BlockbenchModel {
  return parseBbmodelText(readText(path), stem(path), path);
}

export function readMapping(path: string): MappingFile {
  return parseMappingText(readText(path), path);
}

/** Write a file (text as UTF-8 with the line endings it has), creating the folder if needed. */
export function writeOutput(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Warnings and notes go to stderr so stdout stays clean for piping. */
export function printDiagnostics(diagnostics: Diagnostics): void {
  for (const item of diagnostics.items) {
    console.error(`${item.severity}: ${renderDiagnostic(item)}`);
  }
}

/** A `%g`-like number: up to 6 significant digits, no trailing zeros. */
export function compact(value: number): string {
  return String(Number(value.toPrecision(6)));
}
