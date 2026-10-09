/// <reference types="blockbench-types" />

/**
 * Which bone mapping an import uses.
 *
 * Without a custom mapping, the mapping of the bundled template model is used (classic
 * or slim arms, chosen from the open model). A custom mapping file is remembered per
 * project, so the import dialog can offer it again.
 */

import {
  mappingEntries,
  parseMapping,
  parseMappingText,
  type BlockbenchModel,
  type MappingFile,
} from "@miku-motion/core";

import templateMapping from "../../../mappings/template.json";
import templateSlimMapping from "../../../mappings/template_slim.json";

export interface ChosenMapping {
  readonly mapping: MappingFile;
  /** Where it came from, for messages. */
  readonly source: string;
}

export interface CustomMappingFile {
  readonly name: string;
  readonly text: string;
}

const SLIM_ARM_WIDTH = 3; // pixels; classic arms are 4 wide

/** The bundled template mapping that fits `model`: slim when its arms are 3 px wide. */
export function defaultMapping(model: BlockbenchModel): ChosenMapping {
  const classic = parseMapping(templateMapping, "built-in template mapping");
  // The arms are the bones the mapping corrects for their rest direction.
  const arm = [...mappingEntries(classic)].find(([, entry]) => entry.restCorrectionDegrees)?.[0];
  const extent = arm !== undefined && model.skeleton.has(arm) ? model.skeleton.get(arm).extent : undefined;
  const slim = extent !== undefined && extent[1][0] - extent[0][0] <= SLIM_ARM_WIDTH + 0.25;
  return slim
    ? {
        mapping: parseMapping(templateSlimMapping, "built-in slim template mapping"),
        source: "built-in template mapping (slim arms)",
      }
    : { mapping: classic, source: "built-in template mapping" };
}

export function customMapping(file: CustomMappingFile): ChosenMapping {
  return { mapping: parseMappingText(file.text, file.name), source: file.name };
}

const STORAGE_PREFIX = "mmd_motion_importer.mapping.";

function storageKey(): string {
  return STORAGE_PREFIX + ((Project && Project.name) || "unnamed");
}

/** The custom mapping last used with the open project, if any. */
export function rememberedCustomMapping(): CustomMappingFile | undefined {
  try {
    const saved = localStorage.getItem(storageKey());
    if (!saved) return undefined;
    const file = JSON.parse(saved) as Partial<CustomMappingFile>;
    return typeof file.name === "string" && typeof file.text === "string"
      ? { name: file.name, text: file.text }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remember (or, with `undefined`, forget) the open project's custom mapping. */
export function rememberCustomMapping(file: CustomMappingFile | undefined): void {
  try {
    if (file) localStorage.setItem(storageKey(), JSON.stringify(file));
    else localStorage.removeItem(storageKey());
  } catch {
    // Storage full or unavailable: only this import is affected.
  }
}
