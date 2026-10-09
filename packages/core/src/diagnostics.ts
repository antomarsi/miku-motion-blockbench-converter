/**
 * Structured warnings and notes collected while converting.
 *
 * Nothing is dropped silently: every stage that ignores or approximates data records a
 * diagnostic here. Codes are stable so reports can be diffed and filtered.
 */

export type Severity = "info" | "warning";

export const Code = {
  UNSUPPORTED_MORPHS: "MM001",
  UNSUPPORTED_CAMERA: "MM002",
  UNSUPPORTED_LIGHT: "MM003",
  UNSUPPORTED_SHADOW: "MM004",
  DUPLICATE_KEYS: "MM010",
  UNMAPPED_ANIMATED_BONES: "MM101",
  IK_DRIVEN_BONES: "MM102",
  TRANSLATION_DROPPED: "MM103",
  MAPPED_SOURCE_MISSING: "MM104",
  SOURCE_APPLIED_TWICE: "MM105",
  IK_UNREACHED: "MM106",
  IK_SOLVED: "MM107",
  FACIAL_ANIMATION: "MM108",
  END_BONES_UNMAPPED: "MM109",
  SOURCE_TREE_FOLLOWED: "MM110",
  UNMAPPED_TARGET_BONES: "MM201",
  PIVOT_SHARED_WITH_PARENT: "MM202",
  TARGET_NOT_GECKOLIB: "MM203",
  SECONDARY_MOTION: "MM302",
  SECONDARY_CANDIDATES: "MM303",
  KEYS_REDUCED: "MM401",
  REDUCTION_OVER_TOLERANCE: "MM402",
  GROUP_DURATION_MISMATCH: "MM501",
  GROUP_FORMATION: "MM502",
  GROUP_LENGTH_SYNCED: "MM503",
  GROUP_MEMBER_SKIPPED: "MM504",
} as const;

export type Code = (typeof Code)[keyof typeof Code];

export interface Diagnostic {
  readonly code: Code;
  readonly severity: Severity;
  readonly message: string;
  readonly bones: readonly string[];
}

export function renderDiagnostic(diagnostic: Diagnostic): string {
  return `[${diagnostic.code}] ${diagnostic.message}`;
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];

  add(code: Code, severity: Severity, message: string, bones: readonly string[] = []): void {
    this.items.push({ code, severity, message, bones });
  }

  warn(code: Code, message: string, bones: readonly string[] = []): void {
    this.add(code, "warning", message, bones);
  }

  info(code: Code, message: string, bones: readonly string[] = []): void {
    this.add(code, "info", message, bones);
  }

  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === "warning");
  }

  codes(): Set<Code> {
    return new Set(this.items.map((d) => d.code));
  }
}
