/** validate: check an .animation.json, optionally against the model it is for. */

import { basename } from "node:path";
import { parseArgs } from "node:util";

import { InputFormatError, validateAnimation } from "@miku-motion/core";

import { readModel, readText, UsageError } from "../io";

export const VALIDATE_HELP = `Usage: miku-motion validate <file.animation.json> [-t model.bbmodel]

Check that an animation file has the shape GeckoLib and Blockbench read.

Options:
  -t, --target <file>   Also check that every animated bone exists in this model
`;

export function validateCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { target: { type: "string", short: "t" }, help: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(VALIDATE_HELP);
    return 0;
  }
  const [path, ...rest] = positionals;
  if (path === undefined || rest.length) throw new UsageError(VALIDATE_HELP);

  const text = readText(path);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InputFormatError(`not valid JSON: ${reason}`, { path });
  }
  const model = values.target !== undefined ? readModel(values.target) : undefined;
  const check = validateAnimation(document, model?.skeleton);

  console.log(basename(path));
  for (const animation of check.animations) {
    console.log(
      `  ${animation.name}  ${animation.length} s, ${animation.bones} bones, ${animation.keyframes} keyframes`,
    );
  }
  for (const issue of check.issues) console.error(`${issue.severity}: ${issue.where}: ${issue.message}`);
  const errors = check.issues.filter((issue) => issue.severity === "error").length;
  const warnings = check.issues.length - errors;
  if (!check.issues.length) {
    console.log(values.target !== undefined ? `ok: valid, and every bone is in ${basename(values.target)}` : "ok: valid");
  } else {
    console.log(`${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  }
  return errors ? 1 : 0;
}
