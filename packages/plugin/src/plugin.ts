/// <reference types="blockbench-types" />

/**
 * Blockbench plugin entry point. Everything Blockbench-specific stays in this package;
 * the conversion itself lives in @miku-motion/core.
 */

import { importGroup, importMotion } from "./importMotion";
import { applyMinecraftSkin, generateMappingAction, prepareModel } from "./modelTools";

declare const __VERSION__: string;

const PLUGIN_ID = "mmd_motion_importer";
const TITLE = "MMD Motion Importer";
const REPOSITORY = "https://github.com/antomarsi/miku-motion-blockbench-converter";

const ABOUT = [
  "Imports MikuMikuDance motion (.vmd) as GeckoLib animations, retargeted onto your",
  "model through a bone mapping. The bundled template model works out of the box; for",
  "your own rig, pick a custom mapping .json in the import dialog.",
  "",
  "Use File > Import > Import MMD Motion (.vmd), or the music-note button in the",
  "Animations panel. For a dance with several performers, use Import MMD Performer",
  "Group and pick one .vmd per performer.",
  "",
  "For your own rig, Tools > MMD Motion Importer > Prepare Model for Dancing checks its bones and fixes what a",
  "dance needs, and Generate Bone Mapping writes the mapping for you. Apply Minecraft",
  "Skin dresses the template model in any Minecraft skin.",
  "",
  "Legs follow the dance's IK targets, hair and clothes swing by simulation, and blinks",
  "and mouth shapes drive the face parts of the mapping.",
].join("\n");

let actions: Action[] = [];

BBPlugin.register(PLUGIN_ID, {
  title: TITLE,
  author: "antomarsi",
  description: "Import MikuMikuDance motion (.vmd) as GeckoLib animations on any model.",
  about: ABOUT,
  icon: "music_note",
  version: __VERSION__,
  variant: "both",
  min_version: "4.8.0",
  tags: ["Animation", "Importer", "GeckoLib"],
  onload() {
    const importAction = new Action(`${PLUGIN_ID}_import`, {
      name: "Import MMD Motion (.vmd)",
      description: "Convert a MikuMikuDance motion into an animation on this model",
      icon: "music_note",
      click: importMotion,
    });
    const groupAction = new Action(`${PLUGIN_ID}_import_group`, {
      name: "Import MMD Performer Group (.vmd)",
      description: "Convert several performers' motions of one dance, one animation each",
      icon: "groups",
      click: importGroup,
    });
    const prepareAction = new Action(`${PLUGIN_ID}_prepare`, {
      name: "Prepare Model for Dancing",
      description: "Check the model's bones and fix what a dance needs (one undo step)",
      icon: "accessibility_new",
      click: prepareModel,
    });
    const mappingAction = new Action(`${PLUGIN_ID}_mapping`, {
      name: "Generate Bone Mapping",
      description: "Work out which of this model's bones follow which part of a dance",
      icon: "account_tree",
      click: generateMappingAction,
    });
    const skinAction = new Action(`${PLUGIN_ID}_skin`, {
      name: "Apply Minecraft Skin",
      description: "Put a Minecraft skin (.png) on the template model",
      icon: "checkroom",
      click: applyMinecraftSkin,
    });
    const about = new Action(`${PLUGIN_ID}_about`, {
      name: `About ${TITLE}`,
      description: "Version and project page",
      icon: "info",
      click() {
        Blockbench.showMessageBox({
          title: TITLE,
          message: `${TITLE} ${__VERSION__}\n\n${ABOUT}\n\n${REPOSITORY}`,
        });
      },
    });
    MenuBar.addAction(importAction, "file.import");
    MenuBar.addAction(groupAction, "file.import");
    MenuBar.addAction(importAction, "animation");
    MenuBar.addAction(groupAction, "animation");
    const toolsMenu = new Action(`${PLUGIN_ID}_tools`, {
      name: TITLE,
      description: "Get a model ready to dance",
      icon: "music_note",
      children: [prepareAction, mappingAction, skinAction],
      click() {},
    });
    MenuBar.addAction(toolsMenu, "tools");
    MenuBar.addAction(about, "help");
    // The row of buttons at the top of the Animations panel, after its own import button.
    const animations = Toolbars.animations as Toolbar | undefined;
    if (animations && !animations.children.includes(importAction)) animations.add(importAction, 3);
    actions = [importAction, groupAction, toolsMenu, prepareAction, mappingAction, skinAction, about];
  },
  onunload() {
    for (const action of actions) action.delete();
    actions = [];
  },
});
