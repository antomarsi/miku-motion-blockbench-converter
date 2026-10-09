/// <reference types="blockbench-types" />

/**
 * Which bone mapping an import uses.
 *
 * Without a custom mapping, the mapping of the bundled template model is used (classic
 * or slim arms, chosen from the open model). A project's own mapping is saved inside its
 * .bbmodel, so the import dialog offers it again on any machine.
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

/** The built-in template mapping that fits `model`, as an editable file. */
export function defaultMappingFile(model: BlockbenchModel): CustomMappingFile {
  const slim = defaultMapping(model).source.includes("slim");
  return {
    name: slim ? "template_slim.json" : "template.json",
    text: `${JSON.stringify(slim ? templateSlimMapping : templateMapping, null, 2)}
`,
  };
}

// The project's mapping is saved inside the .bbmodel, through a project property.
const PROPERTY = "mmd_motion_mapping";
type MappedProject = ModelProject & { [PROPERTY]?: string };

/** Make Blockbench save the mapping with the project. Delete the result on unload. */
export function registerMappingProperty(): Deletable {
  return new Property(ModelProject, "string", PROPERTY, { default: "", exposed: false });
}

const STORAGE_PREFIX = "mmd_motion_importer.mapping.";

function storageKey(): string {
  return STORAGE_PREFIX + ((Project && Project.name) || "unnamed");
}

function readFile(saved: string | null | undefined): CustomMappingFile | undefined {
  if (!saved) return undefined;
  try {
    const file = JSON.parse(saved) as Partial<CustomMappingFile>;
    return typeof file.name === "string" && typeof file.text === "string"
      ? { name: file.name, text: file.text }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The open project's own mapping, if it has one. */
export function rememberedCustomMapping(): CustomMappingFile | undefined {
  const stored = Project ? readFile((Project as MappedProject)[PROPERTY]) : undefined;
  if (stored) return stored;
  // Before mappings were saved in the project, they were kept in the browser by project name.
  try {
    return readFile(localStorage.getItem(storageKey()));
  } catch {
    return undefined;
  }
}

/** Store (or, with `undefined`, remove) the open project's mapping. */
export function rememberCustomMapping(file: CustomMappingFile | undefined): void {
  if (!Project) return;
  const project = Project as MappedProject;
  const text = file ? JSON.stringify(file) : "";
  if ((project[PROPERTY] ?? "") !== text) {
    project[PROPERTY] = text;
    project.saved = false; // the mapping is part of the .bbmodel
  }
  try {
    localStorage.removeItem(storageKey());
  } catch {
    // Storage unavailable: nothing to clean up.
  }
}
