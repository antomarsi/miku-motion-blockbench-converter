/// <reference types="blockbench-types" />

/** The import dialogs: one motion, or several performers' motions as a group. */

import {
  checkGroupLabels,
  convert,
  convertGroup,
  DEFAULT_FPS,
  DEFAULT_TOLERANCE,
  Formation,
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
import { projectModel } from "./project";
import { escapeHtml, showReport, withSharedPart, type ReportPart } from "./report";

const TITLE = "MMD Motion Importer";

/** What the user chose last, offered again next time. */
const last = {
  optimize: true,
  fps: OPTIMIZED_FPS,
  ik: true,
  loop: LoopMode.ONCE as LoopMode,
  formation: Formation.KEEP as Formation,
  syncLength: true,
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
  loop?: LoopMode;
}

const SHARED_PLACEHOLDERS = {
  mapping: "Optional: leave empty to use the built-in template mapping",
  model: "Optional: the .pmx model the dance was made for",
};

/** The form fields both dialogs share, after their own file field. */
function sharedFields(): Record<string, object> {
  return {
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

/** Read the optional files, then hand over everything a conversion needs. */
function prepare(form: SharedForm, onReady: (prepared: Prepared) => void): void {
  last.optimize = form.optimize ?? true;
  last.fps = Math.min(Math.max(Number(form.fps) || DEFAULT_FPS, 1), 240);
  last.ik = form.ik ?? true;
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
          chosen = defaultMapping(projectModel());
          rememberCustomMapping(undefined);
        }
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
          ...rig,
        };
        onReady({ options, chosen, modelName });
      } catch (error) {
        showError(error);
      }
    });
  });
}

/** Let the "working" message paint before a long conversion blocks the window. */
function runSoon(work: () => void): void {
  Blockbench.showQuickMessage("Converting the motion...", 1500);
  setTimeout(() => {
    try {
      work();
    } catch (error) {
      showError(error);
    }
  }, 30);
}

function presetMapping(dialog: Dialog): void {
  const remembered = rememberedCustomMapping();
  if (!remembered) return;
  // Offer the custom mapping this project used last; the field's X clears it.
  try {
    dialog.setFormValues({
      mapping: { name: remembered.name, path: remembered.name, content: remembered.text },
    });
  } catch {
    // Older Blockbench can't preset a file field: the user picks the file again.
  }
}

function details(prepared: Prepared): string {
  const model = prepared.modelName ? ` · Source model: ${prepared.modelName}` : "";
  return `Mapping: ${prepared.chosen.source}${model}`;
}

/** Ask for one motion and its options, then import it. */
export function importMotion(): void {
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
        prepare(form, (prepared) =>
          runSoon(() => {
            const motion = motionInput(file);
            const result = convert(
              {
                motion,
                model: projectModel(),
                mapping: prepared.chosen.mapping,
                mappingPath: prepared.chosen.source,
              },
              prepared.options,
            );
            const { animation } = result;
            const loaded = addAnimations(
              [{ document: JSON.parse(result.text), name: animation.name }],
              "Import MMD motion",
            );
            if (loaded.animations[0]) showAnimation(loaded.animations[0]);
            showReport({
              headline:
                `${loaded.replaced ? "Updated" : "Imported"} "${motion.path}": ` +
                `${friendlyDuration(animation.length)}, ${animation.tracks.size} bones animated`,
              details: `Animation: ${animation.name} · ${details(prepared)}`,
              parts: [{ diagnostics: result.diagnostics.items }],
            });
          }),
        );
      });
      return true;
    },
  });
  dialog.show();
  tidyForm(dialog, { motion: "Choose a .vmd file (required)", ...SHARED_PLACEHOLDERS });
  presetMapping(dialog);
}

interface GroupForm extends SharedForm {
  formation?: Formation;
  sync?: boolean;
}

function importGroupFiles(files: FileResult[]): void {
  let motions: MotionInput[];
  try {
    projectModel();
    motions = files.map(motionInput);
    checkGroupLabels(motions);
  } catch (error) {
    showError(error);
    return;
  }
  const state = { optimize: last.optimize };
  const dialog = new Dialog({
    id: "mmd_motion_importer_group",
    title: "Import MMD Performer Group",
    width: 760,
    buttons: [`Import ${motions.length} VMD files`, "dialog.cancel"],
    form: {
      files: {
        type: "info",
        label: "Motions",
        text: motions.map((motion) => motion.path).join(", "),
      },
      sync: {
        type: "checkbox",
        label: "Same length for all",
        description:
          "Give every animation the longest one's length, so the performers start and " +
          "end together. Shorter motions hold their last pose.",
        value: last.syncLength,
      },
      formation: {
        type: "select",
        label: "Stage positions",
        description: "The motions store where each performer stands on the stage.",
        value: last.formation,
        options: {
          [Formation.KEEP]: "Keep them as in the dance",
          [Formation.CENTER]: "Centre the whole group on the origin",
          [Formation.ORIGIN]: "Start every performer at the origin (you place them)",
        },
      },
      ...sharedFields(),
    },
    onFormChange(form: GroupForm) {
      followOptimize(dialog, form, state);
    },
    onConfirm(form: GroupForm) {
      last.formation = form.formation ?? Formation.KEEP;
      last.syncLength = form.sync ?? true;
      prepare(form, (prepared) =>
        runSoon(() => {
          const group = convertGroup(
            motions,
            {
              model: projectModel(),
              mapping: prepared.chosen.mapping,
              mappingPath: prepared.chosen.source,
            },
            prepared.options,
            { formation: last.formation, syncLength: last.syncLength },
          );
          const loaded = addAnimations(
            group.members.map((member) => ({
              document: JSON.parse(member.result.text),
              name: member.result.animation.name,
            })),
            "Import MMD performer group",
          );
          if (loaded.animations[0]) showAnimation(loaded.animations[0]);

          const perMember: ReportPart[] = group.members.map((member) => ({
            heading:
              `${member.motion.path} (${friendlyDuration(member.result.animation.length)}, ` +
              `stood at x ${member.start[0].toFixed(1)}, z ${member.start[2].toFixed(1)} px)`,
            diagnostics: member.result.diagnostics.items,
          }));
          showReport({
            headline: `Imported ${group.members.length} performers as ${loaded.animations.length} animations`,
            details: details(prepared),
            parts: [
              { heading: "The group", diagnostics: group.diagnostics.items },
              ...withSharedPart(perMember, "Every performer"),
            ],
          });
        }),
      );
      return true;
    },
  });
  dialog.show();
  tidyForm(dialog, SHARED_PLACEHOLDERS);
  presetMapping(dialog);
}

/** Pick several motions (one per performer), then ask for the group's options. */
export function importGroup(): void {
  Blockbench.import(
    {
      extensions: ["vmd"],
      type: "MMD motions (one per performer)",
      readtype: "buffer",
      multiple: true,
      resource_id: "mmd_motion",
    },
    (files: FileResult[]) => {
      if (files.length) importGroupFiles(files);
    },
  );
}
