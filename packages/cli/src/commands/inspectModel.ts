import { basename } from "node:path";
import { parseArgs } from "node:util";

import { suggestChains, type MappingFile } from "@miku-motion/core";

import { compact, readMapping, readModel, UsageError } from "../io";

export const INSPECT_MODEL_HELP = `Usage: miku-motion inspect-model <model.bbmodel> [-m mapping.json]

Show a Blockbench model's bones and suggest hair/cloth chains for secondary motion.

Options:
  -m, --mapping <file>   Mark the bones this mapping already uses
`;

function usedBones(mapping: MappingFile | undefined): Set<string> {
  if (!mapping) return new Set();
  return new Set([
    ...Object.keys(mapping.bones),
    ...mapping.secondary_motion.flatMap((chain) => chain.bones),
  ]);
}

export function inspectModel(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { mapping: { type: "string", short: "m" }, help: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(INSPECT_MODEL_HELP);
    return 0;
  }
  const [path, ...rest] = positionals;
  if (path === undefined || rest.length) throw new UsageError(INSPECT_MODEL_HELP);

  const model = readModel(path);
  const mapping = values.mapping ? readMapping(values.mapping) : undefined;
  const used = usedBones(mapping);
  const { skeleton } = model;
  console.log(
    `${basename(path)}  (Blockbench ${model.formatVersion}, ${model.modelFormat}, ` +
      `${skeleton.length} bones)`,
  );
  for (const bone of skeleton) {
    const depth = skeleton.ancestors(bone.name).length;
    const pivot = bone.pivot.map(compact).join(", ");
    const rest = bone.restEulerDegrees.some((v) => v !== 0)
      ? `  rest ${bone.restEulerDegrees.map(compact).join(", ")}`
      : "";
    const tags = (bone.extent ? "" : "  (no cubes)") + (used.has(bone.name) ? "  [mapped]" : "");
    console.log(`  ${"  ".repeat(depth)}${bone.name}  pivot ${pivot}${rest}${tags}`);
  }

  const suggestions = suggestChains(skeleton, mapping);
  if (!suggestions.length) {
    console.log("\nNo unconfigured hair/cloth-like chains found.");
    return 0;
  }
  console.log(
    "\nPossible secondary_motion chains (review, then paste into the mapping; " +
      "presets: long_hair, ponytail, short_hair, cloth, accessory):",
  );
  const lines = suggestions.map(
    (s) => `    { "bones": ${JSON.stringify(s.bones).replace(/,/g, ", ")}, "preset": "${s.preset}" }`,
  );
  console.log(`  "secondary_motion": [\n${lines.join(",\n")}\n  ]`);
  return 0;
}
