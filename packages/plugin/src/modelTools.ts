/// <reference types="blockbench-types" />

/**
 * Actions that get a model ready to dance: Prepare model, Generate mapping and Apply
 * Minecraft skin. The logic is the core's; this file is dialogs and Blockbench objects.
 */

import {
  analyzeModel,
  applySkin,
  BbmodelDocument,
  generateMapping,
  isSlim,
  MikuMotionError,
  normalizeSkin,
  parseMappingText,
  prepare,
  renderMapping,
  rolesByRole,
  type Analysis,
  type Finding,
  type Pixels,
  type PrepareOptions,
  unanimatedFaceParts,
} from "@miku-motion/core";

import { showError } from "./importMotion";
import { editAspects, LiveEditor } from "./liveEditor";
import { rememberCustomMapping } from "./mappingStore";
import { projectModel } from "./project";
import { escapeHtml } from "./report";

const TITLE = "MMD Motion Importer";

/** What the user chose last, offered again next time. */
const last = { splitLimbs: true, hairIk: true, limbIk: true };

/** Run an action's work, showing a dialog instead of throwing. */
function guarded(work: () => void): void {
  try {
    work();
  } catch (error) {
    showError(error);
  }
}

/** Plain names for the body parts the tools recognise. */
const PART_NAMES: Readonly<Record<string, string>> = {
  root: "whole body",
  hips: "hips",
  torso: "torso",
  chest: "chest",
  head: "head",
  upper_arm: "upper arm",
  forearm: "forearm",
  hand: "hand",
  thigh: "thigh",
  shin: "shin",
  foot: "foot",
};

function partName(role: string): string {
  const side = /_(left|right)$/.exec(role)?.[1];
  const base = side ? role.slice(0, -side.length - 1) : role;
  const name = PART_NAMES[base] ?? base.replace(/_/g, " ");
  return side ? `${side} ${name}` : name;
}

/** "What the tool recognised", as an HTML list. */
function partsHtml(analysis: Analysis): string {
  const roles = [...rolesByRole(analysis.roles)];
  const rows = roles.map(
    ([role, bone]) => `<li>${escapeHtml(partName(role))}: <b>${escapeHtml(bone)}</b></li>`,
  );
  const chains = analysis.suggestions.map(
    (chain) => `<li>${escapeHtml(chain.preset.replace(/_/g, " "))}: <b>${escapeHtml(chain.bones.join(" > "))}</b></li>`,
  );
  return (
    `<h3 style="margin: 14px 0 4px;">Body parts found</h3>` +
    (rows.length ? `<ul style="margin: 0; columns: 2;">${rows.join("")}</ul>` : "<p>None.</p>") +
    (chains.length
      ? `<h3 style="margin: 14px 0 4px;">Hair and clothes that will swing</h3><ul style="margin: 0;">${chains.join("")}</ul>`
      : "")
  );
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function findingsHtml(title: string, findings: readonly Finding[]): string {
  if (!findings.length) return "";
  const rows = findings.map((finding) => `<li>${escapeHtml(sentence(finding.message))}</li>`);
  return `<h3 style="margin: 14px 0 4px;">${escapeHtml(title)}</h3><ul style="margin: 0;">${rows.join("")}</ul>`;
}

function scrolling(html: string): string {
  return `<div style="max-height: 60vh; overflow-y: auto; padding-right: 6px; user-select: text;">${html}</div>`;
}

// --- Prepare model ----------------------------------------------------------------------

/** What preparing would change, worked out on a copy of the project. */
function rehearse(options: PrepareOptions): ReturnType<typeof prepare> {
  const saved: unknown = JSON.parse(JSON.stringify(Codecs.project!.compile({ raw: true })));
  return prepare(new BbmodelDocument(saved, Project ? Project.name : "model"), options);
}

function applyPreparation(options: PrepareOptions): void {
  Undo.initEdit(editAspects());
  try {
    prepare(new LiveEditor(), options);
  } catch (error) {
    Undo.cancelEdit(true);
    throw error;
  }
  Undo.finishEdit("Prepare model for dancing", editAspects());
  Canvas.updateAll();
  Blockbench.showQuickMessage("Model prepared. Undo (Ctrl+Z) restores the original.", 4000);
}

export function prepareModel(): void {
  guarded(() => {
    projectModel(); // fails early, with a clear message, when there is nothing to prepare
    new Dialog({
      id: "mmd_motion_importer_prepare",
      title: "Prepare Model for Dancing",
      width: 560,
      lines: [
        `<p style="margin: 0 0 8px;">Checks that the model can follow a dance and fixes what it can:
         a root bone, head and arms attached to the torso, legs outside it, joints at the
         right places. You see the list of changes before anything is applied.</p>`,
      ],
      form: {
        splitLimbs: {
          type: "checkbox",
          label: "Split one-piece arms and legs",
          description: "Cut limbs made of a single cube at the elbow or knee so they can bend. The texture stays the same.",
          value: last.splitLimbs,
        },
        limbIk: {
          type: "checkbox",
          label: "Add posing helpers to limbs",
          description: "Blockbench IK handles on arms and legs, for posing by hand. Dances don't need them.",
          value: last.limbIk,
        },
        hairIk: {
          type: "checkbox",
          label: "Add posing helpers to hair",
          description: "Blockbench IK handles on hair and cloth chains, for posing by hand. Dances don't need them.",
          value: last.hairIk,
        },
      },
      buttons: ["Check model", "dialog.cancel"],
      onConfirm(form: Partial<typeof last>) {
        last.splitLimbs = form.splitLimbs ?? true;
        last.limbIk = form.limbIk ?? true;
        last.hairIk = form.hairIk ?? true;
        const options = { ...last };
        guarded(() => reviewPreparation(options));
      },
    }).show();
  });
}

function reviewPreparation(options: PrepareOptions): void {
  const { findings, analysis } = rehearse(options);
  const changes = findings.filter((finding) => finding.fixed);
  const manual = findings.filter((finding) => !finding.fixed);
  const summary = changes.length
    ? `${changes.length} ${changes.length === 1 ? "change" : "changes"} will be made. One undo restores the original.`
    : "The model is ready: nothing to change.";
  new Dialog({
    id: "mmd_motion_importer_prepare_review",
    title: "Prepare Model for Dancing",
    width: 660,
    lines: [
      scrolling(
        `<p style="margin: 0; font-size: 1.1em;"><b>${escapeHtml(summary)}</b></p>` +
          findingsHtml("Changes", changes) +
          findingsHtml("For you to do", manual) +
          partsHtml(analysis),
      ),
    ],
    ...(changes.length ? { buttons: ["Apply changes", "dialog.cancel"] } : { singleButton: true }),
    onConfirm() {
      if (changes.length) guarded(() => applyPreparation(options));
    },
  }).show();
}

// --- Generate mapping -------------------------------------------------------------------

export function generateMappingAction(): void {
  guarded(() => {
    const model = projectModel();
    const analysis = analyzeModel(model);
    if (!rolesByRole(analysis.roles).size) {
      throw new MikuMotionError("couldn't recognise any body parts in this model", {
        hint: "run Prepare Model for Dancing first, or write the mapping by hand",
      });
    }
    const text = renderMapping(generateMapping(model.skeleton, analysis.roles, analysis.suggestions, model.name));
    parseMappingText(text, "generated mapping"); // never hand out a mapping the importer rejects
    const fileName = `${model.name}.mapping.json`;
    const missing = ["torso", "head"].filter((role) => !rolesByRole(analysis.roles).has(role));
    const note = missing.length
      ? `<p style="color: var(--color-warning);">The ${escapeHtml(missing.join(" and "))} could not be found, so
         the dance will not move it. Prepare Model for Dancing may fix that.</p>`
      : "";
    const still = unanimatedFaceParts(model.skeleton, analysis.roles);
    const faceNote = still.length
      ? `<p>The face will stay still: <b>${escapeHtml(still.join(", "))}</b> ${still.length === 1 ? "pivots" : "pivot"}
         away from ${still.length === 1 ? "its" : "their"} own cubes, so a blink or a mouth shape would slide
         ${still.length === 1 ? "it" : "them"} across the face. To animate ${still.length === 1 ? "it" : "them"}, move each pivot to the
         middle of the part and generate the mapping again.</p>`
      : "";
    new Dialog({
      id: "mmd_motion_importer_mapping",
      title: "Generate Bone Mapping",
      width: 660,
      lines: [
        scrolling(
          `<p style="margin: 0;">A mapping tells the importer which of the model's bones follow which
           part of the dance. This one was worked out from the model's shape.</p>${note}${faceNote}${partsHtml(analysis)}`,
        ),
      ],
      buttons: ["Use for imports", "Save as file", "dialog.cancel"],
      cancelIndex: 2,
      onButton(index: number) {
        if (index === 0) {
          rememberCustomMapping({ name: fileName, text });
          Blockbench.showQuickMessage("Imports of this model now use the generated mapping.", 4000);
        } else if (index === 1) {
          Blockbench.export({
            type: "Bone mapping",
            extensions: ["json"],
            name: fileName.replace(/\.json$/, ""),
            content: text,
          });
        }
      },
    }).show();
  });
}

// --- Apply Minecraft skin ---------------------------------------------------------------

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new MikuMotionError("could not read the image"));
    image.src = source;
  });
}

export function pixelsOf(source: CanvasImageSource, width: number, height: number): Pixels {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.drawImage(source, 0, 0);
  return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer) };
}

/** Whether the open model's arms are 3 px wide; undefined when it has no recognisable arms. */
function modelIsSlim(): boolean | undefined {
  const analysis = analyzeModel(projectModel());
  const arm = analysis.roles.arms.get("left")?.[0] ?? analysis.roles.arms.get("right")?.[0];
  const extent = arm !== undefined ? analysis.model.skeleton.get(arm).extent : undefined;
  return extent ? extent[1][0] - extent[0][0] <= 3.25 : undefined;
}

async function wearSkin(file: { name: string; content?: unknown }): Promise<void> {
  const texture = Texture.getDefault() as Texture | undefined;
  if (!texture) {
    throw new MikuMotionError("the model has no texture to put the skin on", {
      hint: "open the template model (templates/template.bbmodel) first",
    });
  }
  const image = await loadImage(String(file.content));
  const skin = normalizeSkin(pixelsOf(image, image.naturalWidth, image.naturalHeight), file.name);
  const current = pixelsOf(texture.canvas, texture.canvas.width, texture.canvas.height);
  const result = applySkin(current, skin);
  texture.edit(
    (canvas: HTMLCanvasElement) => {
      const pixels = new ImageData(new Uint8ClampedArray(result.data), result.width, result.height);
      canvas.getContext("2d")!.putImageData(pixels, 0, 0);
    },
    { edit_name: "Apply Minecraft skin" },
  );
  const slimSkin = isSlim(skin);
  const slimModel = modelIsSlim();
  const arms = (slim: boolean): string => (slim ? "slim (3 px)" : "classic (4 px)");
  if (slimModel !== undefined && slimModel !== slimSkin) {
    Blockbench.showMessageBox({
      title: TITLE,
      message:
        `The skin is applied, but it is made for ${arms(slimSkin)} arms and this model has ` +
        `${arms(slimModel)} arms, so the arms will look shifted. Use the ` +
        `${slimSkin ? "slim" : "classic"} template model for this skin.`,
    });
  } else {
    Blockbench.showQuickMessage(`Skin applied (${arms(slimSkin)} arms).`, 3000);
  }
}

export function applyMinecraftSkin(): void {
  guarded(() => {
    projectModel();
    Blockbench.import(
      { extensions: ["png"], type: "Minecraft skin", readtype: "image", resource_id: "minecraft_skin" },
      (files: Filesystem.FileResult[]) => {
        const file = files[0];
        if (file) wearSkin(file).catch(showError);
      },
    );
  });
}
