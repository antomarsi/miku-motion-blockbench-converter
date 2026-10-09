import { basename } from "node:path";
import { parseArgs } from "node:util";

import {
  conditionalNotes,
  durationSeconds,
  parseVmd,
  summarize,
  unsupportedNotes,
  type VmdSummary,
} from "@miku-motion/core";

import { readInput, UsageError } from "../io";
import { renderTable } from "../table";

export const INSPECT_HELP = `Usage: miku-motion inspect <motion.vmd> [--all] [--json]

Show what a .vmd motion contains: frame range, animated bones, unsupported data.

Options:
  --all    Also list bones that only hold a static pose
  --json   Print machine-readable JSON
`;

/** The summary with the field names the Python version printed (kept for scripts). */
export function summaryJson(summary: VmdSummary): Record<string, unknown> {
  return {
    model_name: summary.modelName,
    version: summary.version,
    first_frame: summary.firstFrame,
    last_frame: summary.lastFrame,
    bone_key_count: summary.boneKeyCount,
    morph_key_count: summary.morphKeyCount,
    morph_names: summary.morphNames,
    camera_key_count: summary.cameraKeyCount,
    light_key_count: summary.lightKeyCount,
    shadow_key_count: summary.shadowKeyCount,
    show_ik_key_count: summary.showIkKeyCount,
    bones: summary.bones.map((bone) => ({
      name: bone.name,
      key_count: bone.keyCount,
      first_frame: bone.firstFrame,
      last_frame: bone.lastFrame,
      rotates: bone.rotates,
      translates: bone.translates,
      varies: bone.varies,
      ik: bone.ik,
    })),
    duration_seconds: durationSeconds(summary),
    conditional: conditionalNotes(summary),
    unsupported: unsupportedNotes(summary),
  };
}

function summaryText(fileName: string, summary: VmdSummary, allBones: boolean): string {
  const moving = summary.bones.filter((b) => b.varies);
  const still = summary.bones.filter((b) => !b.varies);
  const lines = [
    `${fileName}  (VMD v${summary.version})`,
    `  model name   ${summary.modelName || "-"}`,
    `  frames       ${summary.firstFrame}-${summary.lastFrame} @ 30 fps` +
      `  (${durationSeconds(summary).toFixed(2)} s)`,
    `  bone keys    ${summary.boneKeyCount} across ${summary.bones.length} bones ` +
      `(${moving.length} moving, ${still.length} static pose only)`,
    `  morph keys   ${summary.morphKeyCount} across ${summary.morphNames.length} morphs`,
    `  camera/light/shadow keys  ${summary.cameraKeyCount}/` +
      `${summary.lightKeyCount}/${summary.shadowKeyCount}`,
    "",
    allBones ? "Bones" : "Moving bones",
    renderTable(
      [
        { title: "bone" },
        { title: "keys", alignRight: true },
        { title: "frames" },
        { title: "rotates" },
        { title: "translates" },
        { title: "note" },
      ],
      (allBones ? summary.bones : moving).map((bone) => [
        bone.name,
        String(bone.keyCount),
        `${bone.firstFrame}-${bone.lastFrame}`,
        bone.rotates ? "yes" : "",
        bone.translates ? "yes" : "",
        (bone.ik ? "IK" : "") + (bone.varies ? "" : " static"),
      ]),
    ),
  ];
  if (still.length && !allBones) {
    lines.push(`  (${still.length} static-pose bones hidden; use --all to list them)`);
  }
  const conditional = conditionalNotes(summary);
  if (conditional.length) {
    lines.push("Converted when the mapping and skeleton cover it:");
    lines.push(...conditional.map((note) => `  - ${note}`));
  }
  const unsupported = unsupportedNotes(summary);
  if (unsupported.length) {
    lines.push("Not converted by this version:");
    lines.push(...unsupported.map((note) => `  - ${note}`));
  }
  return lines.join("\n");
}

export function inspect(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { all: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(INSPECT_HELP);
    return 0;
  }
  const [motion, ...rest] = positionals;
  if (motion === undefined || rest.length) throw new UsageError(INSPECT_HELP);

  const summary = summarize(parseVmd(readInput(motion), motion));
  if (values.json) console.log(JSON.stringify(summaryJson(summary), null, 2));
  else console.log(summaryText(basename(motion), summary, values.all ?? false));
  return 0;
}
