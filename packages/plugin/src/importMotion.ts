/// <reference types="blockbench-types" />

/** The "Import MMD Motion" dialog: files and options, conversion, result. */

import {
  convert,
  DEFAULT_FPS,
  LoopMode,
  MikuMotionError,
} from "@miku-motion/core";

import { addAnimation, showAnimation } from "./animations";
import {
  customMapping,
  defaultMapping,
  rememberCustomMapping,
  rememberedCustomMapping,
  type ChosenMapping,
} from "./mappingStore";
import { projectModel } from "./project";
import { escapeHtml, showReport } from "./report";

const TITLE = "MMD Motion Importer";

interface ImportSettings {
  fps: number;
  loop: LoopMode;
}

let lastSettings: ImportSettings = { fps: DEFAULT_FPS, loop: LoopMode.ONCE };

export function showError(error: unknown): void {
  if (!(error instanceof MikuMotionError)) console.error(error);
  const message = error instanceof MikuMotionError ? error.render() : String(error);
  new Dialog({
    id: "mmd_motion_importer_error",
    title: `${TITLE}: could not import`,
    lines: [`<p style="white-space: pre-wrap; user-select: text;">${escapeHtml(message)}</p>`],
    singleButton: true,
  }).show();
}

function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

function stem(fileName: string): string {
  return baseName(fileName).replace(/\.[^.]+$/, "");
}

/**
 * The file behind a dialog file field.
 *
 * Current Blockbench returns the file itself. Older versions return the path (desktop)
 * or only the content (web), so those are read or wrapped here.
 */
function fieldFile(
  value: unknown,
  readtype: "buffer" | "text",
  fallbackName: string,
  onFile: (file: Filesystem.FileResult | undefined) => void,
): void {
  if (value === undefined || value === null || value === "") {
    onFile(undefined);
  } else if (typeof value === "object" && "content" in value) {
    onFile(value as Filesystem.FileResult);
  } else if (typeof value === "string" && isApp) {
    Blockbench.read([value], { readtype }, (files: Filesystem.FileResult[]) => onFile(files[0]));
  } else {
    onFile({ name: fallbackName, path: "", content: value as string | ArrayBuffer });
  }
}

function convertAndLoad(
  motion: Filesystem.FileResult,
  mappingFile: Filesystem.FileResult | undefined,
  settings: ImportSettings,
): void {
  try {
    if (!(motion.content instanceof ArrayBuffer)) {
      throw new MikuMotionError("the motion file could not be read", { path: motion.name });
    }
    const model = projectModel();
    let chosen: ChosenMapping;
    if (mappingFile) {
      const custom = { name: baseName(mappingFile.name), text: String(mappingFile.content ?? "") };
      chosen = customMapping(custom);
      rememberCustomMapping(custom);
    } else {
      chosen = defaultMapping(model);
      rememberCustomMapping(undefined);
    }
    const fileName = baseName(motion.name);
    const result = convert(
      {
        motion: { data: new Uint8Array(motion.content), label: stem(fileName), path: fileName },
        model,
        mapping: chosen.mapping,
        mappingPath: chosen.source,
      },
      settings,
    );
    const loaded = addAnimation(JSON.parse(result.text), result.animation.name, "Import MMD motion");
    if (loaded.animation) showAnimation(loaded.animation);
    showReport(result, fileName, chosen.source, loaded.replaced);
  } catch (error) {
    showError(error);
  }
}

/**
 * Finishing touches Blockbench's form options don't offer: placeholder text in the file
 * fields, and a label column wide enough to keep every label on one line.
 */
function tidyForm(dialog: Dialog, placeholders: Record<string, string>): void {
  const root = dialog.object;
  if (!root) return;
  for (const label of root.querySelectorAll<HTMLElement>("label.name_space_left")) {
    label.style.whiteSpace = "nowrap";
    label.style.width = "auto";
    label.style.minWidth = "160px";
  }
  for (const [field, text] of Object.entries(placeholders)) {
    const input = root.querySelector<HTMLInputElement>(`input[id="${field}"]`);
    if (input) input.placeholder = text;
  }
}

interface ImportForm {
  motion?: unknown;
  mapping?: unknown;
  fps?: number;
  loop?: LoopMode;
}

/** Ask for the motion, an optional custom mapping and the options, then import. */
export function importMotion(): void {
  try {
    projectModel(); // fail early when there is nothing to animate
  } catch (error) {
    showError(error);
    return;
  }
  const remembered = rememberedCustomMapping();
  const dialog = new Dialog({
    id: "mmd_motion_importer_import",
    title: "Import MMD Motion",
    width: 720,
    buttons: ["Import VMD", "dialog.cancel"],
    form: {
      motion: {
        type: "file",
        label: "VMD file",
        description: "The MikuMikuDance motion to import (required)",
        extensions: ["vmd"],
        filetype: "MMD motion",
        readtype: "buffer",
        resource_id: "mmd_motion",
        return_as: "file",
      },
      mapping: {
        type: "file",
        label: "Custom mapping",
        description:
          "Optional. A mapping .json for your own rig. Leave empty to use the built-in " +
          "mapping of the template model.",
        extensions: ["json"],
        filetype: "Bone mapping",
        readtype: "text",
        resource_id: "mmd_mapping",
        return_as: "file",
      },
      fps: {
        type: "number",
        label: "Samples per second",
        value: lastSettings.fps,
        min: 1,
        max: 240,
        step: 1,
      },
      loop: {
        type: "select",
        label: "Loop",
        value: lastSettings.loop,
        options: {
          [LoopMode.ONCE]: "Play once",
          [LoopMode.LOOP]: "Loop",
          [LoopMode.HOLD]: "Hold on last frame",
        },
      },
    },
    onConfirm(form: ImportForm) {
      if (form.motion === undefined || form.motion === null || form.motion === "") {
        Blockbench.showQuickMessage("Choose a .vmd file to import", 2500);
        return false; // keep the dialog open
      }
      const settings: ImportSettings = {
        fps: Math.min(Math.max(Number(form.fps) || DEFAULT_FPS, 1), 240),
        loop: form.loop ?? LoopMode.ONCE,
      };
      lastSettings = settings;
      fieldFile(form.motion, "buffer", "motion.vmd", (motion) => {
        if (!motion) return;
        fieldFile(form.mapping, "text", "mapping.json", (mapping) =>
          convertAndLoad(motion, mapping, settings),
        );
      });
      return true;
    },
  });
  dialog.show();
  tidyForm(dialog, {
    motion: "Choose a .vmd file (required)",
    mapping: "Optional: leave empty to use the built-in template mapping",
  });
  if (remembered) {
    // Offer the custom mapping this project used last; the field's X clears it.
    try {
      dialog.setFormValues({
        mapping: { name: remembered.name, path: remembered.name, content: remembered.text },
      });
    } catch {
      // Older Blockbench can't preset a file field: the user picks the file again.
    }
  }
}
