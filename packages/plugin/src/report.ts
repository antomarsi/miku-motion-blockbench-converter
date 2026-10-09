/// <reference types="blockbench-types" />

/** The window shown after an import: what was imported and what to know about it. */

import type { ConversionResult } from "@miku-motion/core";

import { friendly, friendlyDuration, type FriendlyNote } from "./friendly";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]!);
}

function noteHtml(note: FriendlyNote): string {
  const warning = note.severity === "warning";
  const names = note.names.length
    ? `<details style="margin-top: 4px;">
         <summary style="cursor: pointer; color: var(--color-subtle_text);">
           Show the ${note.names.length} ${escapeHtml(note.namesLabel)}
         </summary>
         <div style="user-select: text; padding: 4px 0 0 14px; color: var(--color-subtle_text);">
           ${note.names.map(escapeHtml).join(", ")}
         </div>
       </details>`
    : "";
  return `
    <div style="display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--color-border);">
      <i class="material-icons" style="color: var(${warning ? "--color-warning" : "--color-subtle_text"});">
        ${warning ? "warning" : "info"}
      </i>
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; gap: 8px; align-items: baseline;">
          <b style="flex: 1;">${escapeHtml(note.title)}</b>
          <span style="font-size: 0.8em; color: var(--color-subtle_text);" title="Reference code">
            ${escapeHtml(note.code)}
          </span>
        </div>
        <div style="user-select: text;">${escapeHtml(note.text)}</div>
        ${names}
      </div>
    </div>`;
}

function section(title: string, notes: FriendlyNote[]): string {
  if (!notes.length) return "";
  return `<h3 style="margin: 14px 0 4px;">${escapeHtml(title)}</h3>${notes.map(noteHtml).join("")}`;
}

export function showReport(result: ConversionResult, fileName: string, mapping: string, replaced: boolean): void {
  const { animation, diagnostics } = result;
  const headline =
    `${replaced ? "Updated" : "Imported"} "${fileName}": ` +
    `${friendlyDuration(animation.length)}, ${animation.tracks.size} bones animated`;
  if (!diagnostics.items.length) {
    Blockbench.showQuickMessage(headline, 3000);
    return;
  }
  const notes = diagnostics.items.map(friendly);
  new Dialog({
    id: "mmd_motion_importer_report",
    title: "MMD motion imported",
    width: 640,
    lines: [
      `<div style="max-height: 60vh; overflow-y: auto; padding-right: 6px;">
         <p style="margin: 0; font-size: 1.1em;"><b>${escapeHtml(headline)}</b></p>
         <p style="margin: 2px 0 0; color: var(--color-subtle_text); user-select: text;">
           Animation: ${escapeHtml(animation.name)} &middot; Mapping: ${escapeHtml(mapping)}
         </p>
         ${section("Worth a look", notes.filter((n) => n.severity === "warning"))}
         ${section("Good to know", notes.filter((n) => n.severity === "info"))}
       </div>`,
    ],
    singleButton: true,
  }).show();
}
