/// <reference types="blockbench-types" />

/** The window shown after an import: what was imported and what to know about it. */

import type { Diagnostic } from "@miku-motion/core";

import { friendly, type FriendlyNote } from "./friendly";

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

function section(title: string, notes: readonly FriendlyNote[]): string {
  if (!notes.length) return "";
  return `<h3 style="margin: 14px 0 4px;">${escapeHtml(title)}</h3>${notes.map(noteHtml).join("")}`;
}

/** One part of the report: e.g. one performer, or what applies to all of them. */
export interface ReportPart {
  /** Shown above the part's notes; omitted for a single import. */
  readonly heading?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Report {
  /** What was imported, in one line. */
  readonly headline: string;
  /** Details under the headline (animation name, mapping...). */
  readonly details: string;
  readonly parts: readonly ReportPart[];
}

function partHtml(part: ReportPart): string {
  const notes = part.diagnostics.map(friendly);
  const warnings = notes.filter((n) => n.severity === "warning");
  const infos = notes.filter((n) => n.severity === "info");
  if (!notes.length) return "";
  const heading = part.heading
    ? `<h2 style="margin: 18px 0 0; font-size: 1.15em;">${escapeHtml(part.heading)}</h2>`
    : "";
  return heading + section("Worth a look", warnings) + section("Good to know", infos);
}

/** Notes that every part has (same code and text) are shown once, under `heading`. */
export function withSharedPart(parts: readonly ReportPart[], heading: string): ReportPart[] {
  if (parts.length < 2) return [...parts];
  const key = (d: Diagnostic): string => `${d.code}\n${d.message}`;
  const everywhere = parts[0]!.diagnostics.filter((d) =>
    parts.every((part) => part.diagnostics.some((other) => key(other) === key(d))),
  );
  if (!everywhere.length) return [...parts];
  const shared = new Set(everywhere.map(key));
  return [
    { heading, diagnostics: everywhere },
    ...parts.map((part) => ({ ...part, diagnostics: part.diagnostics.filter((d) => !shared.has(key(d))) })),
  ];
}

export function showReport(report: Report): void {
  const body = report.parts.map(partHtml).join("");
  if (!body) {
    Blockbench.showQuickMessage(report.headline, 3000);
    return;
  }
  new Dialog({
    id: "mmd_motion_importer_report",
    title: "MMD motion imported",
    width: 660,
    lines: [
      `<div style="max-height: 60vh; overflow-y: auto; padding-right: 6px;">
         <p style="margin: 0; font-size: 1.1em;"><b>${escapeHtml(report.headline)}</b></p>
         <p style="margin: 2px 0 0; color: var(--color-subtle_text); user-select: text;">
           ${escapeHtml(report.details)}
         </p>
         ${body}
       </div>`,
    ],
    singleButton: true,
  }).show();
}
