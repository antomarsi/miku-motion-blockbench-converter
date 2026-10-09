/// <reference types="blockbench-types" />

/**
 * Blockbench plugin entry point. Everything Blockbench-specific stays in this package;
 * the conversion itself lives in @miku-motion/core.
 */

import { checkRig, newDancer } from "./extras";
import { importGroup, importMotion } from "./importMotion";
import { editMapping } from "./mappingEditor";
import { registerMappingProperty } from "./mappingStore";
import { applyMinecraftSkin, generateMappingAction, prepareModel } from "./modelTools";
import { createReportPanel } from "./report";

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
  "dance needs, Generate Bone Mapping writes the mapping for you, Edit Bone Mapping lets",
  "you adjust it, and Check Rig shows that each bone turns the right way. The mapping is",
  "saved inside the project file.",
  "",
  "New Minecraft Dancer starts a project from the built-in player model wearing your",
  "skin; Apply Minecraft Skin changes the skin later.",
  "",
  "Legs follow the dance's IK targets, hair and clothes swing by simulation, and blinks",
  "and mouth shapes drive the face parts of the mapping.",
].join("\n");

let actions: Action[] = [];
let extras: Deletable[] = [];

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
    const editAction = new Action(`${PLUGIN_ID}_edit_mapping`, {
      name: "Edit Bone Mapping",
      description: "See and change which motion bones drive each bone, and what swings as hair",
      icon: "tune",
      click: editMapping,
    });
    const checkAction = new Action(`${PLUGIN_ID}_check`, {
      name: "Check Rig",
      description: "Add a test animation that moves one direction at a time",
      icon: "fact_check",
      click: checkRig,
    });
    const dancerAction = new Action(`${PLUGIN_ID}_new_dancer`, {
      name: "New Minecraft Dancer",
      description: "Start a project from the built-in dancing player model, wearing your skin",
      icon: "person_add",
      click: newDancer,
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
      children: [dancerAction, skinAction, "_", prepareAction, mappingAction, editAction, checkAction],
      click() {},
    });
    MenuBar.addAction(toolsMenu, "tools");
    MenuBar.addAction(about, "help");
    extras = [registerMappingProperty(), createReportPanel()];
    // File > New lists formats and model loaders, not actions; a loader also shows on the
    // start screen. Blockbench versions without loaders keep the entry under Tools.
    if (typeof ModelLoader !== "undefined") {
      extras.push(
        new ModelLoader(`${PLUGIN_ID}_new_dancer`, {
          name: "Minecraft Dancer",
          description:
            "A Minecraft player cut at the joints so it can dance, wearing your skin. " +
            "MMD motions (.vmd) import on it with no setup.",
          icon: "person_add",
          show_on_start_screen: true,
          onStart: newDancer,
        }),
      );
    }
    // The row of buttons at the top of the Animations panel, after its own import button.
    const animations = Toolbars.animations as Toolbar | undefined;
    if (animations && !animations.children.includes(importAction)) animations.add(importAction, 3);
    actions = [
      importAction,
      groupAction,
      toolsMenu,
      prepareAction,
      mappingAction,
      editAction,
      checkAction,
      dancerAction,
      skinAction,
      about,
    ];
  },
  onunload() {
    for (const action of actions) action.delete();
    actions = [];
    for (const extra of extras) extra.delete();
    extras = [];
  },
});
