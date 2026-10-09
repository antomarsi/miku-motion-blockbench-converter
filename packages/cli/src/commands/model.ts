/** Commands that work on the model: prepare-model, init-mapping and apply-skin. */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  analyzeModel,
  applySkin,
  generateMapping,
  unanimatedFaceParts,
  isSlim,
  MikuMotionError,
  normalizeSkin,
  parseDocument,
  prepare,
  renderMapping,
  rolesByRole,
  type Pixels,
} from "@miku-motion/core";

import { readInput, readModel, readText, stem, UsageError, writeOutput } from "../io";
import { decodePng, encodePng } from "../png";

export const PREPARE_MODEL_HELP = `Usage: miku-motion prepare-model <model.bbmodel> [options]

Make a model ready for dancing: fix its rig and add Blockbench IK (writes a copy).

Options:
  -o, --output <file>   Default: <model>.prepared.bbmodel
      --check           Only report; write nothing
      --no-split-limbs  Don't split one-piece arms/legs at the joint
      --no-hair-ik      Don't add Blockbench IK to hair/cloth chains
      --no-limb-ik      Don't add Blockbench IK to arms and legs
`;

export function prepareModelCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      check: { type: "boolean" },
      "no-split-limbs": { type: "boolean" },
      "no-hair-ik": { type: "boolean" },
      "no-limb-ik": { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(PREPARE_MODEL_HELP);
    return 0;
  }
  const [model, ...rest] = positionals;
  if (model === undefined || rest.length) throw new UsageError(PREPARE_MODEL_HELP);
  const destination = values.output ?? join(dirname(model), `${stem(model)}.prepared.bbmodel`);
  if (resolve(destination) === resolve(model)) {
    throw new MikuMotionError("refusing to overwrite the input model", { path: model });
  }
  const document = parseDocument(readText(model), stem(model), model);
  const { findings, analysis } = prepare(document, {
    splitLimbs: !values["no-split-limbs"],
    hairIk: !values["no-hair-ik"],
    limbIk: !values["no-limb-ik"],
  });

  if (!findings.length) console.log("The model is ready: nothing to change.");
  for (const finding of findings) {
    console.log(`  ${finding.fixed ? "fixed" : "to do"}  ${finding.message}`);
  }
  const roles = [...rolesByRole(analysis.roles)].map(([role, bone]) => `${role}=${bone}`).join(", ");
  console.log(`\nBody parts: ${roles}`);
  if (values.check || !findings.some((finding) => finding.fixed)) return 0;
  writeOutput(destination, document.toJson());
  console.log(`wrote ${destination} (the original is unchanged)`);
  return 0;
}

export const INIT_MAPPING_HELP = `Usage: miku-motion init-mapping <model.bbmodel> [-o mapping.json] [--force]

Generate a starter mapping from the model's detected body parts and hair.

Options:
  -o, --output <file>   Default: print it
      --force           Overwrite an existing output file
`;

export function initMappingCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(INIT_MAPPING_HELP);
    return 0;
  }
  const [model, ...rest] = positionals;
  if (model === undefined || rest.length) throw new UsageError(INIT_MAPPING_HELP);
  const target = readModel(model);
  const analysis = analyzeModel(target);
  if (!rolesByRole(analysis.roles).size) {
    throw new MikuMotionError("couldn't recognise any body parts", { path: model });
  }
  const text = renderMapping(
    generateMapping(target.skeleton, analysis.roles, analysis.suggestions, target.name),
  );
  if (values.output === undefined) {
    process.stdout.write(text);
    return 0;
  }
  if (existsSync(values.output) && !values.force) {
    throw new MikuMotionError("already exists; pass --force to overwrite", { path: values.output });
  }
  writeOutput(values.output, text);
  console.log(`wrote ${values.output}`);
  const still = unanimatedFaceParts(target.skeleton, analysis.roles);
  if (still.length) {
    console.log(
      `note: no face rules for ${still.join(", ")}: their pivots are away from their cubes, so ` +
        "blinks and mouth shapes would move them. Put each pivot at the part's centre and run this again.",
    );
  }
  return 0;
}

export const APPLY_SKIN_HELP = `Usage: miku-motion apply-skin <skin.png> [options]

Make a ready-to-dance model wearing a Minecraft skin (64x64, or legacy 64x32).

Options:
  -o, --output <file>     Default: <skin>.bbmodel
      --templates <dir>   Folder with template(_slim).bbmodel (default templates)
      --arms <kind>       auto (detect from the skin), classic (4 px) or slim (3 px)
`;

interface TemplateDocument {
  name?: string;
  textures?: { source?: string; name?: string; relative_path?: string }[];
}

/** The template's embedded texture and the document entry that holds it. */
function templateTexture(document: TemplateDocument): { entry: NonNullable<TemplateDocument["textures"]>[number]; pixels: Pixels } {
  const entry = document.textures?.[0];
  const source = entry?.source;
  if (!entry || typeof source !== "string" || !source.includes(",")) {
    throw new MikuMotionError("the template has no embedded texture");
  }
  const pixels = decodePng(new Uint8Array(Buffer.from(source.slice(source.indexOf(",") + 1), "base64")));
  return { entry, pixels };
}

export interface SkinnedModel {
  /** The `.bbmodel` text. */
  readonly model: string;
  /** The model's texture as a PNG. */
  readonly texture: Uint8Array;
  readonly pixels: Pixels;
  readonly slim: boolean;
}

/** The template (classic or slim) wearing `skin`, named `name`. */
export function makeSkinnedModel(
  skinPng: Uint8Array,
  skinPath: string,
  templateDir: string,
  name: string,
  arms: "auto" | "classic" | "slim" = "auto",
): SkinnedModel {
  const skin = normalizeSkin(decodePng(skinPng, skinPath), skinPath);
  const slim = arms === "auto" ? isSlim(skin) : arms === "slim";
  const templatePath = join(templateDir, slim ? "template_slim.bbmodel" : "template.bbmodel");
  if (!existsSync(templatePath)) {
    throw new MikuMotionError("cannot read the template: no such file", { path: templatePath });
  }
  const document = JSON.parse(readText(templatePath)) as TemplateDocument;
  const { entry, pixels: template } = templateTexture(document);
  const pixels = applySkin(template, skin);
  const texture = encodePng(pixels);
  entry.source = `data:image/png;base64,${Buffer.from(texture).toString("base64")}`;
  entry.name = entry.relative_path = `${name}.png`;
  document.name = name;
  return { model: `${JSON.stringify(document, null, 1)}\n`, texture, pixels, slim };
}

export function applySkinCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      templates: { type: "string" },
      arms: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(APPLY_SKIN_HELP);
    return 0;
  }
  const [skin, ...rest] = positionals;
  if (skin === undefined || rest.length) throw new UsageError(APPLY_SKIN_HELP);
  const arms = values.arms ?? "auto";
  if (arms !== "auto" && arms !== "classic" && arms !== "slim") {
    throw new UsageError("error: --arms must be auto, classic or slim");
  }
  const destination = values.output ?? join(dirname(skin), `${stem(skin)}.bbmodel`);
  const name = stem(destination);
  const result = makeSkinnedModel(readInput(skin), skin, values.templates ?? "templates", name, arms);
  const texturePath = join(dirname(destination), `${name}.png`);
  writeOutput(destination, result.model);
  writeOutput(texturePath, result.texture);
  console.log(
    `wrote ${destination} and ${texturePath} (${result.slim ? "slim (3 px)" : "classic (4 px)"} arms)`,
  );
  const mapping = result.slim ? "mappings/template_slim.json" : "mappings/template.json";
  console.log(`  use it with: miku-motion convert dance.vmd -t ${destination} -m ${mapping}`);
  return 0;
}
