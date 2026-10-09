/// <reference types="blockbench-types" />

/**
 * Blockbench plugin entry point. Everything Blockbench-specific stays in this package;
 * the conversion itself lives in @miku-motion/core.
 */

import { CORE_NAME } from "@miku-motion/core";

declare const __VERSION__: string;

const PLUGIN_ID = "mmd_motion_importer";
const TITLE = "MMD Motion Importer";
const REPOSITORY = "https://github.com/antomarsi/miku-motion-blockbench-converter";

const ABOUT = [
  "Imports MikuMikuDance motion (.vmd) as GeckoLib animations, retargeted onto your",
  "model through a bone mapping.",
  "",
  "This version only contains the plugin shell: the converter is being ported from",
  "its Python command-line version.",
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
    const about = new Action(`${PLUGIN_ID}_about`, {
      name: `About ${TITLE}`,
      description: "Version and project page",
      icon: "info",
      click() {
        Blockbench.showMessageBox({
          title: TITLE,
          message: `${TITLE} ${__VERSION__} (${CORE_NAME})\n\n${ABOUT}\n\n${REPOSITORY}`,
        });
      },
    });
    MenuBar.addAction(about, "help");
    actions = [about];
  },
  onunload() {
    for (const action of actions) action.delete();
    actions = [];
  },
});
