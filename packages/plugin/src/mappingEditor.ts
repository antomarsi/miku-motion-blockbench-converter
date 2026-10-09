/// <reference types="blockbench-types" />

/**
 * The mapping editor: which motion bones drive each bone of the open model, and which
 * chains swing as hair or cloth. It edits the project's own mapping (saved in the
 * .bbmodel); everything it doesn't show (rest corrections, face rules...) is kept as is.
 */

import {
  analyzeModel,
  generateMapping,
  MikuMotionError,
  parseMappingText,
  renderMapping,
  rolesByRole,
  SECONDARY_PRESETS,
  type BlockbenchModel,
} from "@miku-motion/core";

import { showError } from "./importMotion";
import {
  defaultMappingFile,
  rememberCustomMapping,
  rememberedCustomMapping,
  type CustomMappingFile,
} from "./mappingStore";
import { projectModel } from "./project";

type Json = Record<string, unknown>;
type Link = string | { bone: string; weight?: number };

interface BoneRow {
  bone: string;
  depth: number;
  chain: string;
  translation: boolean;
  /** Why an empty row is fine ("swings as long hair"), or what is wrong with the row. */
  note: string;
  missing: boolean;
}

interface ChainRow {
  bones: string;
  preset: string;
  bounciness: string;
  collide: boolean;
  /** Index in the original `secondary_motion`, to keep the fields the editor doesn't show. */
  origin: number;
}

interface EditorState {
  source: string;
  stored: boolean;
  rows: BoneRow[];
  chains: ChainRow[];
  presets: readonly string[];
  error: string;
}

// --- text form of a source chain: "bone, bone*-1" ----------------------------------------

function linkText(link: Link): string {
  if (typeof link === "string") return link;
  return link.weight === undefined || link.weight === 1 ? link.bone : `${link.bone}*${link.weight}`;
}

function parseChain(text: string, bone: string): Link[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part)
    .map((part) => {
      const match = /^(.*?)\s*\*\s*(-?\d+(?:\.\d+)?)$/.exec(part);
      if (!match) return part;
      const weight = Number(match[2]);
      if (!match[1] || !Number.isFinite(weight)) {
        throw new MikuMotionError(`couldn't read "${part}" in the motion bones of ${bone}`, {
          hint: 'write bone names separated by commas; "name*-1" applies a bone inverted',
        });
      }
      return weight === 1 ? match[1] : { bone: match[1], weight };
    });
}

function names(text: string): string[] {
  return text
    .split(/[,>]/)
    .map((part) => part.trim())
    .filter((part) => part);
}

// --- document <-> rows -------------------------------------------------------------------

/** The mapping the editor starts from when the project has none of its own. */
function startingFile(model: BlockbenchModel): CustomMappingFile {
  const builtIn = defaultMappingFile(model);
  const targets = Object.keys((JSON.parse(builtIn.text) as { bones: Json }).bones);
  if (targets.every((bone) => model.skeleton.has(bone))) return builtIn;
  const analysis = analyzeModel(model);
  if (rolesByRole(analysis.roles).size) {
    return {
      name: `${model.name}.mapping.json`,
      text: renderMapping(generateMapping(model.skeleton, analysis.roles, analysis.suggestions, model.name)),
    };
  }
  const empty = { schema_version: 1, name: `MMD standard bones -> ${model.name}`, bones: {} };
  return { name: `${model.name}.mapping.json`, text: `${JSON.stringify(empty, null, 2)}\n` };
}

export function buildState(model: BlockbenchModel, file: CustomMappingFile, stored: boolean): EditorState {
  const document = JSON.parse(file.text) as Json;
  const bones = (document.bones ?? {}) as Record<string, string | { from?: Link[]; translation?: boolean }>;
  const secondary = (document.secondary_motion ?? []) as Json[];
  const morphs = (document.morphs ?? []) as { bone?: string }[];

  const swinging = new Map<string, string>();
  for (const chain of secondary) {
    const preset = String(chain.preset ?? "long_hair").replace(/_/g, " ");
    for (const bone of (chain.bones ?? []) as string[]) swinging.set(bone, `swings as ${preset}`);
  }
  const face = new Set(morphs.map((rule) => rule.bone));

  const row = (bone: string, depth: number, missing: boolean): BoneRow => {
    const entry = bones[bone];
    const chain = entry === undefined ? [] : typeof entry === "string" ? [entry] : (entry.from ?? []);
    return {
      bone,
      depth,
      chain: chain.map(linkText).join(", "),
      translation: typeof entry === "object" && entry.translation === true,
      note: missing
        ? "not in this model"
        : (swinging.get(bone) ?? (face.has(bone) ? "follows facial expressions" : "")),
      missing,
    };
  };
  const rows = model.skeleton.bones.map((bone) => row(bone.name, model.skeleton.ancestors(bone.name).length, false));
  for (const bone of Object.keys(bones)) if (!model.skeleton.has(bone)) rows.push(row(bone, 0, true));

  return {
    source: file.name,
    stored,
    rows,
    chains: secondary.map((chain, origin) => ({
      bones: ((chain.bones ?? []) as string[]).join(", "),
      preset: String(chain.preset ?? "long_hair"),
      bounciness: chain.bounciness === undefined ? "" : String(chain.bounciness),
      collide: chain.collide !== false,
      origin,
    })),
    presets: SECONDARY_PRESETS,
    error: "",
  };
}

/** The edited mapping as text, checked the way an import checks it. */
export function buildText(state: EditorState, original: string): string {
  const document = JSON.parse(original) as Json;
  const before = (document.bones ?? {}) as Record<string, unknown>;
  const bones: Record<string, unknown> = {};
  for (const row of state.rows) {
    const chain = parseChain(row.chain, row.bone);
    if (!chain.length) continue;
    const old = before[row.bone];
    const entry: Json = typeof old === "object" && old !== null ? { ...(old as Json) } : {};
    entry.from = chain;
    if (row.translation) entry.translation = true;
    else delete entry.translation;
    const only = chain[0];
    bones[row.bone] = Object.keys(entry).length === 1 && chain.length === 1 && typeof only === "string" ? only : entry;
  }
  document.bones = bones;

  const oldChains = (document.secondary_motion ?? []) as Json[];
  const chains = state.chains
    .filter((chain) => names(chain.bones).length)
    .map((chain) => {
      const entry: Json = { ...(oldChains[chain.origin] ?? {}) };
      entry.bones = names(chain.bones);
      entry.preset = chain.preset;
      if (chain.bounciness.trim() === "") {
        delete entry.bounciness;
      } else {
        entry.bounciness = Number(chain.bounciness);
        delete entry.damping; // the advanced form of the same setting
      }
      if (!chain.collide) entry.collide = false;
      else if (entry.collide === false) delete entry.collide;
      return entry;
    });
  if (chains.length || "secondary_motion" in document) document.secondary_motion = chains;

  const text = `${JSON.stringify(document, null, 2)}\n`;
  parseMappingText(text, "this mapping");
  return text;
}

// --- the dialog --------------------------------------------------------------------------

const TEMPLATE = `
<div style="max-height: 62vh; overflow-y: auto; padding-right: 6px;">
  <p style="margin: 0 0 6px; color: var(--color-subtle_text);">
    {{ stored ? "This project's mapping" : "Not saved in this project yet; starting from" }}: <b>{{ source }}</b>
    <span style="float: right;">
      <a style="cursor: pointer; text-decoration: underline;" @click="load">Load a file</a> ·
      <a style="cursor: pointer; text-decoration: underline;" @click="save">Save as file</a>
      <span v-if="stored"> · <a style="cursor: pointer; text-decoration: underline;" @click="remove">Remove from project</a></span>
    </span>
  </p>
  <p v-if="error" style="color: var(--color-error); white-space: pre-wrap; user-select: text;">{{ error }}</p>

  <h3 style="margin: 10px 0 4px;">Bones</h3>
  <p style="margin: 0 0 6px; color: var(--color-subtle_text);">
    For each bone of the model: the motion's bones whose rotations it follows, parent to child,
    separated by commas. "name*-1" applies a bone inverted. Bones left empty are not animated.
  </p>
  <div style="display: grid; grid-template-columns: minmax(150px, 1fr) 2fr auto; gap: 3px 8px; align-items: center;">
    <b>Model bone</b><b>Follows (motion bones)</b><b title="Also follow the movement across the floor">Moves</b>
    <template v-for="row in rows">
      <div :style="{ paddingLeft: (row.depth * 12) + 'px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                     color: row.missing ? 'var(--color-error)' : '' }" :title="row.bone">
        {{ row.bone }}
        <span v-if="row.note" style="color: var(--color-subtle_text); font-size: 0.85em;">({{ row.note }})</span>
        <span v-else-if="!row.chain.trim()" style="color: var(--color-warning); font-size: 0.85em;">(not animated)</span>
      </div>
      <input type="text" class="dark_bordered" v-model="row.chain" style="width: 100%;" spellcheck="false">
      <input type="checkbox" v-model="row.translation" title="Also follow the movement across the floor">
    </template>
  </div>

  <h3 style="margin: 16px 0 4px;">Hair and clothes that swing</h3>
  <p style="margin: 0 0 6px; color: var(--color-subtle_text);">
    Chains of the model's bones, parent to child, moved by simulation. Bounciness goes from 0 (settles
    at once) to 1 (keeps bouncing); leave it empty for the kind's own value.
  </p>
  <div style="display: grid; grid-template-columns: 2fr auto 80px auto auto; gap: 3px 8px; align-items: center;">
    <b>Bones</b><b>Kind</b><b>Bounciness</b><b title="Keep the chain out of the head and body">Avoids body</b><span></span>
    <template v-for="(chain, index) in chains">
      <input type="text" class="dark_bordered" v-model="chain.bones" style="width: 100%;" spellcheck="false">
      <select v-model="chain.preset" class="dark_bordered" style="height: 30px;">
        <option v-for="preset in presets" :value="preset">{{ preset.replace(/_/g, " ") }}</option>
      </select>
      <input type="number" class="dark_bordered" v-model="chain.bounciness" min="0" max="1" step="0.1" style="width: 80px;">
      <input type="checkbox" v-model="chain.collide">
      <a style="cursor: pointer;" title="Remove this chain" @click="chains.splice(index, 1)"><i class="material-icons">delete</i></a>
    </template>
  </div>
  <p style="margin: 6px 0 0;">
    <a style="cursor: pointer; text-decoration: underline;" @click="addChain">Add a chain</a>
  </p>
</div>`;

function openEditor(file: CustomMappingFile, stored: boolean): void {
  const model = projectModel();
  const state = buildState(model, file, stored);
  const attempt = (work: (text: string) => void): boolean => {
    try {
      work(buildText(state, file.text));
      state.error = "";
      return true;
    } catch (error) {
      if (!(error instanceof MikuMotionError)) console.error(error);
      state.error = error instanceof MikuMotionError ? error.render() : String(error);
      return false;
    }
  };
  const dialog = new Dialog({
    id: "mmd_motion_importer_mapping_editor",
    title: "Edit Bone Mapping",
    width: 820,
    buttons: ["Save to project", "dialog.cancel"],
    component: {
      data: () => state,
      methods: {
        addChain() {
          state.chains.push({ bones: "", preset: "long_hair", bounciness: "", collide: true, origin: -1 });
        },
        save() {
          attempt((text) =>
            Blockbench.export({
              type: "Bone mapping",
              extensions: ["json"],
              name: file.name.replace(/\.json$/, ""),
              content: text,
            }),
          );
        },
        load() {
          Blockbench.import(
            { extensions: ["json"], type: "Bone mapping", readtype: "text", resource_id: "mmd_mapping" },
            (files: Filesystem.FileResult[]) => {
              const picked = files[0];
              if (!picked) return;
              try {
                const loaded = { name: picked.name.replace(/^.*[\\/]/, ""), text: String(picked.content ?? "") };
                parseMappingText(loaded.text, loaded.name);
                dialog.hide();
                openEditor(loaded, false);
              } catch (error) {
                showError(error);
              }
            },
          );
        },
        remove() {
          rememberCustomMapping(undefined);
          dialog.hide();
          Blockbench.showQuickMessage("Mapping removed from the project. Imports use the built-in one.", 4000);
        },
      },
      template: TEMPLATE,
    },
    onConfirm() {
      const saved = attempt((text) => rememberCustomMapping({ name: file.name, text }));
      if (saved) Blockbench.showQuickMessage("Mapping saved in the project. Imports now use it.", 3000);
      return saved; // on an error the dialog stays open, with the message at the top
    },
  });
  dialog.show();
}

export function editMapping(): void {
  try {
    const stored = rememberedCustomMapping();
    openEditor(stored ?? startingFile(projectModel()), stored !== undefined);
  } catch (error) {
    showError(error);
  }
}
