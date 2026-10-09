/// <reference types="blockbench-types" />

/** The window shown after an import: what was imported and what to know about it. */

import type { Diagnostic } from "@miku-motion/core";

import { friendly, type FriendlyNote } from "./friendly";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]!);
}

/** A listed name; the model's own bones can be clicked to select them. */
function nameHtml(name: string): string {
  if (!Group.all.some((group) => group.name === name)) return escapeHtml(name);
  return `<a data-mmd-bone="${escapeHtml(name)}" title="Select this bone"
    style="cursor: pointer; text-decoration: underline;">${escapeHtml(name)}</a>`;
}

/** Clicks on bone names inside a report select that bone. */
function onReportClick(event: Event): void {
  const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-mmd-bone]") : null;
  const name = target?.dataset.mmdBone;
  const group = name !== undefined ? Group.all.find((candidate) => candidate.name === name) : undefined;
  if (!group) return;
  group.select();
  Blockbench.showQuickMessage(`Selected "${group.name}"`, 1500);
}

function noteHtml(note: FriendlyNote): string {
  const warning = note.severity === "warning";
  const names = note.names.length
    ? `<details style="margin-top: 4px;">
         <summary style="cursor: pointer; color: var(--color-subtle_text);">
           Show the ${note.names.length} ${escapeHtml(note.namesLabel)}
         </summary>
         <div style="user-select: text; padding: 4px 0 0 14px; color: var(--color-subtle_text);">
           ${note.names.map(nameHtml).join(", ")}
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

// --- the panel that keeps the last report at hand ---------------------------------------

const EMPTY_PANEL = `<p style="color: var(--color-subtle_text);">Import an MMD motion to see its report here.</p>`;
const panelState = { html: EMPTY_PANEL };

/** A panel in Animate mode holding the last import's report. Delete the result on unload. */
export function createReportPanel(): Deletable {
  return new Panel("mmd_motion_importer_report", {
    name: "MMD Import Report",
    icon: "music_note",
    condition: { modes: ["animate"] },
    growable: true,
    resizable: true,
    default_side: "right",
    default_position: { slot: "right_bar", float_position: [0, 0], float_size: [320, 420], height: 260, folded: true },
    component: {
      data: () => panelState,
      methods: { click: onReportClick },
      template: `<div style="overflow-y: auto; height: 100%; padding: 6px 8px;" v-html="html" @click="click"></div>`,
    },
  } as unknown as ConstructorParameters<typeof Panel>[1]);
}

function headerHtml(report: Report): string {
  return `<p style="margin: 0; font-size: 1.1em;"><b>${escapeHtml(report.headline)}</b></p>
          <p style="margin: 2px 0 0; color: var(--color-subtle_text); user-select: text;">
            ${escapeHtml(report.details)}
          </p>`;
}

export function showReport(report: Report): void {
  const body = report.parts.map(partHtml).join("");
  panelState.html = headerHtml(report) + (body || `<p>Nothing to report.</p>`);
  if (!body) {
    Blockbench.showQuickMessage(report.headline, 3000);
    return;
  }
  const dialog = new Dialog({
    id: "mmd_motion_importer_report",
    title: "MMD motion imported",
    width: 660,
    lines: [
      `<div style="max-height: 60vh; overflow-y: auto; padding-right: 6px;">
         ${headerHtml(report)}
         ${body}
         <p style="margin: 12px 0 0; color: var(--color-subtle_text);">
           This report stays in the "MMD Import Report" panel of the Animate tab.
         </p>
       </div>`,
    ],
    singleButton: true,
  });
  dialog.show();
  dialog.object?.addEventListener("click", onReportClick);
}
