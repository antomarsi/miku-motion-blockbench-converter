/// <reference types="blockbench-types" />

/** Two shortcuts: a rig check that moves one direction at a time, and a new dancer project. */

import {
  analyzeModel,
  applySkin,
  calibration,
  convert,
  DEFAULT_FPS,
  isSlim,
  LoopMode,
  mappingEntries,
  MikuMotionError,
  normalizeSkin,
  SEGMENT_FRAMES,
  writeVmd,
  type CalibrationStep,
  type Pixels,
} from "@miku-motion/core";

import classicTemplate from "../../../templates/template.bbmodel";
import slimTemplate from "../../../templates/template_slim.bbmodel";

import { addAnimations, showAnimation } from "./animations";
import { showError } from "./importMotion";
import { customMapping, defaultMapping, rememberedCustomMapping } from "./mappingStore";
import { loadImage, pixelsOf } from "./modelTools";
import { projectModel } from "./project";
import { escapeHtml } from "./report";

// --- Check rig ----------------------------------------------------------------------------

/** What each step should look like, by kind and MMD axis. */
const EXPECTED: Readonly<Record<CalibrationStep["kind"], readonly string[]>> = {
  rotate: [
    "tips backward: what is above the joint goes back, what is below comes forward (a head looks up)",
    "turns toward the model's own right",
    "leans toward the model's own right side",
  ],
  move: [
    "the whole model slides toward its own left",
    "the whole model rises",
    "the whole model moves backward, away from where it faces",
  ],
};

function runCheck(bone: string): void {
  const model = projectModel();
  const stored = rememberedCustomMapping();
  const chosen = stored ? customMapping(stored) : defaultMapping(model);
  const entries = mappingEntries(chosen.mapping);
  // The bone's own motion bone is the last one it follows the normal way round.
  const rotate = [...(entries.get(bone)?.chain ?? [])].reverse().find((link) => link.weight > 0)?.bone;
  if (rotate === undefined) throw new MikuMotionError(`the mapping gives "${bone}" nothing to follow`);
  const mover = [...entries].find(([name, entry]) => entry.translation && model.skeleton.has(name));
  const move = mover?.[1].chain.at(-1)?.bone;

  const { vmd, steps } = calibration(rotate, move);
  const label = `rig_check_${bone.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const result = convert(
    { motion: { data: writeVmd(vmd), label, path: "rig check" }, model, mapping: chosen.mapping, mappingPath: chosen.source },
    { fps: DEFAULT_FPS, loop: LoopMode.ONCE, sourceRig: null, collide: false },
  );
  const loaded = addAnimations([{ document: JSON.parse(result.text), name: result.animation.name }], "Check rig");
  if (loaded.animations[0]) showAnimation(loaded.animations[0]);

  const rows = steps.map((step) => {
    const subject = step.kind === "rotate" ? `<b>${escapeHtml(bone)}</b> ` : "";
    const from = (step.startFrame - SEGMENT_FRAMES) / 30;
    return `<tr><td style="padding: 3px 12px 3px 0; white-space: nowrap; vertical-align: top;">${from} to ${from + 2} s</td>
            <td style="padding: 3px 0;">${subject}${escapeHtml(EXPECTED[step.kind][step.axis]!)}</td></tr>`;
  });
  new Dialog({
    id: "mmd_motion_importer_check_result",
    title: "Check Rig",
    width: 620,
    lines: [
      `<p style="margin: 0 0 8px;">The animation <b>${escapeHtml(result.animation.name)}</b> was added. Play it:
       each move goes out for one second and comes back in the next. You should see:</p>
       <table>${rows.join("")}</table>
       ${move === undefined ? `<p>No bone of the mapping has "Moves" ticked, so the model does not travel.</p>` : ""}
       <p style="margin: 10px 0 0; color: var(--color-subtle_text);">If one of them goes the other way or a
       different part moves, that bone's entry in the mapping is wrong (Edit Bone Mapping). Delete the
       animation when you are done.</p>`,
    ],
    singleButton: true,
  }).show();
}

export function checkRig(): void {
  try {
    const model = projectModel();
    const stored = rememberedCustomMapping();
    const chosen = stored ? customMapping(stored) : defaultMapping(model);
    const bones = [...mappingEntries(chosen.mapping).keys()].filter((bone) => model.skeleton.has(bone));
    if (!bones.length) {
      throw new MikuMotionError("none of the mapping's bones are in this model", {
        hint: "run Generate Bone Mapping first",
      });
    }
    const head = analyzeModel(model).roles.head;
    new Dialog({
      id: "mmd_motion_importer_check",
      title: "Check Rig",
      width: 560,
      lines: [
        `<p style="margin: 0 0 8px;">Adds a short test animation that turns one bone a single direction at
         a time, then moves the whole model, so you can see that the mapping (${escapeHtml(chosen.source)})
         drives the right parts the right way.</p>`,
      ],
      form: {
        bone: {
          type: "select",
          label: "Bone to turn",
          options: Object.fromEntries(bones.map((bone) => [bone, bone])),
          value: head !== undefined && bones.includes(head) ? head : bones[0],
        },
      },
      buttons: ["Add test animation", "dialog.cancel"],
      onConfirm(form: { bone?: string }) {
        try {
          runCheck(form.bone ?? bones[0]!);
        } catch (error) {
          showError(error);
        }
      },
    }).show();
  } catch (error) {
    showError(error);
  }
}

// --- New Minecraft dancer -----------------------------------------------------------------

interface TemplateTexture {
  source?: string;
}

function toDataUrl(pixels: Pixels): string {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const image = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

async function createDancer(name: string, arms: string, skinFile: Filesystem.FileResult | undefined): Promise<void> {
  const skin = skinFile
    ? await loadImage(String(skinFile.content)).then((image) =>
        normalizeSkin(pixelsOf(image, image.naturalWidth, image.naturalHeight), skinFile.name),
      )
    : undefined;
  const slim = arms === "auto" ? (skin ? isSlim(skin) : false) : arms === "slim";
  const model = JSON.parse(JSON.stringify(slim ? slimTemplate : classicTemplate)) as {
    meta?: { model_format?: string };
    textures?: TemplateTexture[];
  };
  const texture = model.textures?.[0];
  if (skin && texture?.source) {
    const image = await loadImage(texture.source);
    texture.source = toDataUrl(applySkin(pixelsOf(image, image.naturalWidth, image.naturalHeight), skin));
  }
  const hasFormat = Boolean(model.meta?.model_format && Formats[model.meta.model_format]);
  Codecs.project!.load(model, { path: "", name: `${name}.bbmodel`, no_file: true } as unknown as Filesystem.FileResult);
  if (Project) {
    Project.name = name;
    Project.saved = false;
  }
  Canvas.updateAll();
  if (hasFormat) {
    Blockbench.showQuickMessage(
      `New dancer with ${slim ? "slim (3 px)" : "classic (4 px)"} arms. Hair and clothes are hidden groups: show the ones you want.`,
      5000,
    );
  } else {
    Blockbench.showMessageBox({
      title: "New Minecraft Dancer",
      message:
        "The dancer was created as a generic model, because the GeckoLib plugin is not installed. " +
        "Dances import fine; to export for a GeckoLib mod, install the GeckoLib Models & Animations " +
        "plugin and use File > Convert Project.",
    });
  }
}

export function newDancer(): void {
  const dialog = new Dialog({
    id: "mmd_motion_importer_new_dancer",
    title: "New Minecraft Dancer",
    width: 620,
    lines: [
      `<p style="margin: 0 0 8px;">Creates a new project from the built-in model: a Minecraft player cut at the
       joints so it can dance, with optional hair, skirt and tie. Dances import on it with no setup.</p>`,
    ],
    form: {
      name: { type: "text", label: "Name", value: "dancer" },
      skin: {
        type: "file",
        label: "Minecraft skin",
        description: "Optional. A Minecraft skin .png (64x64, or the older 64x32). Without one the model keeps its sample skin.",
        extensions: ["png"],
        filetype: "Minecraft skin",
        readtype: "image",
        resource_id: "minecraft_skin",
        return_as: "file",
      },
      arms: {
        type: "select",
        label: "Arms",
        value: "auto",
        options: { auto: "Match the skin (classic without a skin)", classic: "Classic (4 px)", slim: "Slim (3 px)" },
      },
    },
    buttons: ["Create", "dialog.cancel"],
    onConfirm(form: { name?: string; skin?: unknown; arms?: string }) {
      const skin = form.skin;
      if (skin !== undefined && skin !== null && skin !== "" && !(typeof skin === "object" && "content" in skin)) {
        // Older Blockbench hands back a path or the content, not the file.
        const content = String(skin);
        createDancer(form.name?.trim() || "dancer", form.arms ?? "auto", { name: "skin.png", path: "", content }).catch(showError);
        return;
      }
      createDancer(
        form.name?.trim() || "dancer",
        form.arms ?? "auto",
        skin ? (skin as Filesystem.FileResult) : undefined,
      ).catch(showError);
    },
  });
  dialog.show();
  const input = dialog.object?.querySelector<HTMLInputElement>('input[id="skin"]');
  if (input) input.placeholder = "Optional: a Minecraft skin .png";
}
