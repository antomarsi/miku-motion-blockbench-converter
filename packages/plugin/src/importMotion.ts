/// <reference types="blockbench-types" />

/** The import dialog: one motion and its options. */

import {
  convertSteps,
  DEFAULT_FPS,
  DEFAULT_TOLERANCE,
  LoopMode,
  MikuMotionError,
  OPTIMIZED_FPS,
  pmxRig,
  type ConvertOptions,
  type MotionInput,
} from "@miku-motion/core";

import { addAnimations, showAnimation } from "./animations";
import { friendlyDuration } from "./friendly";
import {
  customMapping,
  defaultMapping,
  rememberCustomMapping,
  rememberedCustomMapping,
  type ChosenMapping,
} from "./mappingStore";
import { Cancelled, withProgress } from "./progress";
import { projectModel } from "./project";
import { escapeHtml, panelActions, showReport } from "./report";

const TITLE = "MMD Motion Importer";

/** What the user chose last, offered again next time. */
const last = {
  optimize: true,
  fps: OPTIMIZED_FPS,
  ik: true,
  collide: true,
  loop: LoopMode.ONCE as LoopMode,
};

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

type FileResult = Filesystem.FileResult;

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
  onFile: (file: FileResult | undefined) => void,
): void {
  if (value === undefined || value === null || value === "") {
    onFile(undefined);
  } else if (typeof value === "object" && "content" in value) {
    onFile(value as FileResult);
  } else if (typeof value === "string" && isApp) {
    Blockbench.read([value], { readtype }, (files: FileResult[]) => onFile(files[0]));
  } else {
    onFile({ name: fallbackName, path: "", content: value as string | ArrayBuffer });
  }
}

function bytes(file: FileResult): Uint8Array {
  if (!(file.content instanceof ArrayBuffer)) {
    throw new MikuMotionError("the file could not be read", { path: baseName(file.name) });
  }
  return new Uint8Array(file.content);
}

function motionInput(file: FileResult): MotionInput {
  const name = baseName(file.name);
  return { data: bytes(file), label: stem(name), path: name };
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
    label.style.minWidth = "170px";
  }
  for (const [field, text] of Object.entries(placeholders)) {
    const input = root.querySelector<HTMLInputElement>(`input[id="${field}"]`);
    if (input) input.placeholder = text;
  }
}

interface SharedForm {
  mapping?: unknown;
  model?: unknown;
  optimize?: boolean;
  fps?: number;
  ik?: boolean;
  collide?: boolean;
  loop?: LoopMode;
}

const SHARED_PLACEHOLDERS = {
  mapping: "Optional: leave empty to use the built-in template mapping",
  model: "Optional: the .pmx model the dance was made for",
};

/** The option fields, after the motion's file field. */
function sharedFields(): Record<string, object> {
  return {
    mapping: {
      type: "file",
      label: "Custom mapping",
      description:
        "Optional. A mapping .json for your own rig; it is then saved with the project. Leave " +
        "empty to use the built-in mapping of the template model.",
      extensions: ["json"],
      filetype: "Bone mapping",
      readtype: "text",
      resource_id: "mmd_mapping",
      return_as: "file",
    },
    model: {
      type: "file",
      label: "Source model",
      description:
        "Optional. The MMD model (.pmx) the dance was made for. Its leg proportions make " +
        "the feet land exactly. Only use the dance's own model: another one makes it worse.",
      extensions: ["pmx"],
      filetype: "MMD model",
      readtype: "buffer",
      resource_id: "mmd_model",
      return_as: "file",
    },
    optimize: {
      type: "checkbox",
      label: "Reduce keyframes",
      description:
        "Keep only the keyframes needed to follow the dance: a much smaller animation, " +
        "and more accurate motion between keys. Recommended.",
      value: last.optimize,
    },
    fps: {
      type: "number",
      label: "Samples per second",
      description: `${OPTIMIZED_FPS} suits reduced keyframes; ${DEFAULT_FPS} keeps unreduced animations small.`,
      value: last.fps,
      min: 1,
      max: 240,
      step: 1,
    },
    ik: {
      type: "checkbox",
      label: "Solve leg IK",
      description: "Work out knee bends from where the dance places the feet, as MMD does.",
      value: last.ik,
    },
    collide: {
      type: "checkbox",
      label: "Hair avoids the body",
      description: "Keep simulated hair and cloth from passing through the head and body.",
      value: last.collide,
    },
    loop: {
      type: "select",
      label: "Loop",
      value: last.loop,
      options: {
        [LoopMode.ONCE]: "Play once",
        [LoopMode.LOOP]: "Loop",
        [LoopMode.HOLD]: "Hold on last frame",
      },
    },
  };
}

/** Switch the sample rate with the "Reduce keyframes" box while it's at a default. */
function followOptimize(dialog: Dialog, form: SharedForm, state: { optimize: boolean }): void {
  const optimize = form.optimize ?? true;
  if (optimize === state.optimize) return;
  state.optimize = optimize;
  const from = optimize ? DEFAULT_FPS : OPTIMIZED_FPS;
  if (Number(form.fps) === from) {
    dialog.setFormValues({ fps: optimize ? OPTIMIZED_FPS : DEFAULT_FPS }, false);
  }
}

interface Prepared {
  readonly options: ConvertOptions;
  readonly chosen: ChosenMapping;
  readonly modelName: string | undefined;
}

/** What the last import of a project used, so it can be repeated without the dialogs. */
interface LastImport {
  readonly file: FileResult;
  /** The project's own mapping was used (not the built-in one). */
  readonly projectMapping: boolean;
  readonly modelFile: FileResult | undefined;
}

const lastImports = new Map<string, LastImport>();

function projectKey(): string {
  return Project ? Project.uuid : "";
}

/** Everything a conversion needs, from the remembered settings and the given files. */
function prepared(chosen: ChosenMapping, modelFile: FileResult | undefined): Prepared {
  const modelName = modelFile ? baseName(modelFile.name) : undefined;
  // Leaving `sourceRig` out means the built-in skeleton; `null` means no IK at all.
  const rig = !last.ik
    ? { sourceRig: null }
    : modelFile && modelName
      ? { sourceRig: pmxRig(bytes(modelFile), stem(modelName), modelName) }
      : {};
  const options: ConvertOptions = {
    fps: last.fps,
    loop: last.loop,
    tolerance: last.optimize ? DEFAULT_TOLERANCE : undefined,
    collide: last.collide,
    ...rig,
  };
  return { options, chosen, modelName };
}

/** Read the optional files, then hand over everything a conversion needs. */
function prepare(
  form: SharedForm,
  onReady: (ready: Prepared, used: Pick<LastImport, "projectMapping" | "modelFile">) => void,
): void {
  last.optimize = form.optimize ?? true;
  last.fps = Math.min(Math.max(Number(form.fps) || DEFAULT_FPS, 1), 240);
  last.ik = form.ik ?? true;
  last.collide = form.collide ?? true;
  last.loop = form.loop ?? LoopMode.ONCE;
  fieldFile(form.mapping, "text", "mapping.json", (mappingFile) => {
    fieldFile(form.model, "buffer", "model.pmx", (modelFile) => {
      try {
        let chosen: ChosenMapping;
        if (mappingFile) {
          const custom = { name: baseName(mappingFile.name), text: String(mappingFile.content ?? "") };
          chosen = customMapping(custom);
          rememberCustomMapping(custom);
        } else {
          // An emptied field means "the built-in mapping, this time": the project keeps its own.
          chosen = defaultMapping(projectModel());
        }
        onReady(prepared(chosen, modelFile), { projectMapping: mappingFile !== undefined, modelFile });
      } catch (error) {
        showError(error);
      }
    });
  });
}

/** Run a conversion, showing errors in a dialog; a cancelled one ends quietly. */
function run(work: () => Promise<void>): void {
  work().catch((error: unknown) => {
    if (error instanceof Cancelled) Blockbench.showQuickMessage("Import cancelled", 2000);
    else showError(error);
  });
}

async function convertOne(file: FileResult, ready: Prepared): Promise<void> {
  const motion = motionInput(file);
  const result = await withProgress(
    `Importing ${motion.path}`,
    convertSteps(
      { motion, model: projectModel(), mapping: ready.chosen.mapping, mappingPath: ready.chosen.source },
      ready.options,
    ),
  );
  const { animation } = result;
  const loaded = addAnimations([{ document: JSON.parse(result.text), name: animation.name }], "Import MMD motion");
  if (loaded.animations[0]) showAnimation(loaded.animations[0]);
  showReport({
    headline:
      `${loaded.replaced ? "Updated" : "Imported"} "${motion.path}": ` +
      `${friendlyDuration(animation.length)}, ${animation.tracks.size} bones animated`,
    details: `Animation: ${animation.name} · ${details(ready)}`,
    parts: [{ diagnostics: result.diagnostics.items }],
  });
}

/**
 * Convert the project's last motion again with the same settings, picking up changes to
 * the model and to the project's mapping.
 */
export function reimport(): void {
  try {
    const model = projectModel();
    const again = lastImports.get(projectKey());
    if (!again) {
      Blockbench.showQuickMessage("Nothing to re-import yet: import a motion in this project first", 3000);
      return;
    }
    const stored = again.projectMapping ? rememberedCustomMapping() : undefined;
    const ready = prepared(stored ? customMapping(stored) : defaultMapping(model), again.modelFile);
    run(() => convertOne(again.file, ready));
  } catch (error) {
    showError(error);
  }
}

/** Open the import dialog again on the project's last motion, to change its settings. */
export function adjustImport(): void {
  const again = lastImports.get(projectKey());
  importMotion(again?.file);
}

panelActions.reimport = reimport;
panelActions.adjust = adjustImport;

function presetMapping(dialog: Dialog): void {
  const remembered = rememberedCustomMapping();
  if (!remembered) return;
  // Offer the project's own mapping; the field's X uses the built-in one for this import.
  try {
    dialog.setFormValues({
      mapping: { name: remembered.name, path: remembered.name, content: remembered.text },
    });
  } catch {
    // Older Blockbench can't preset a file field: the user picks the file again.
  }
}

function details(ready: Prepared): string {
  const model = ready.modelName ? ` · Source model: ${ready.modelName}` : "";
  return `Mapping: ${ready.chosen.source}${model}`;
}

/** Ask for one motion and its options, then import it. `preset` fills in the motion. */
export function importMotion(preset?: FileResult): void {
  try {
    projectModel(); // fail early when there is nothing to animate
  } catch (error) {
    showError(error);
    return;
  }
  const state = { optimize: last.optimize };
  const dialog = new Dialog({
    id: "mmd_motion_importer_import",
    title: "Import MMD Motion",
    width: 760,
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
      ...sharedFields(),
    },
    onFormChange(form: SharedForm) {
      followOptimize(dialog, form, state);
    },
    onConfirm(form: SharedForm & { motion?: unknown }) {
      if (form.motion === undefined || form.motion === null || form.motion === "") {
        Blockbench.showQuickMessage("Choose a .vmd file to import", 2500);
        return false; // keep the dialog open
      }
      fieldFile(form.motion, "buffer", "motion.vmd", (file) => {
        if (!file) return;
        prepare(form, (ready, used) => {
          lastImports.set(projectKey(), { file, ...used });
          run(() => convertOne(file, ready));
        });
      });
      return true;
    },
  });
  dialog.show();
  tidyForm(dialog, { motion: "Choose a .vmd file (required)", ...SHARED_PLACEHOLDERS });
  presetMapping(dialog);
  if (preset && "content" in preset) {
    try {
      dialog.setFormValues({ motion: preset });
    } catch {
      // Older Blockbench can't preset a file field: the user picks the file again.
    }
  }
}

