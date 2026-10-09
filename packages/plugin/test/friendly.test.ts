import { describe, expect, it } from "vitest";

import { Code, type Diagnostic } from "@miku-motion/core";

import { friendly, friendlyDuration } from "../src/friendly";

const diagnostic = (code: Code, bones: string[] = [], severity: "warning" | "info" = "warning"): Diagnostic => ({
  code,
  severity,
  message: "technical message: with details",
  bones,
});

describe("friendly report text", () => {
  it("explains a dropped bone without jargon and keeps the names and code", () => {
    const note = friendly(diagnostic(Code.UNMAPPED_ANIMATED_BONES, ["a", "b"]));
    expect(note.title).toBe("2 moving parts of the dance had nowhere to go");
    expect(note.text).not.toMatch(/MM\d|source bone|target bone/);
    expect([note.names, note.code, note.severity]).toEqual([["a", "b"], "MM101", "warning"]);
  });

  it("uses the singular for one item", () => {
    expect(friendly(diagnostic(Code.UNMAPPED_TARGET_BONES, ["hair"], "info")).title).toBe(
      "1 bone of your model is not animated",
    );
    expect(friendly(diagnostic(Code.UNMAPPED_TARGET_BONES, ["a", "b"], "info")).title).toBe(
      "2 bones of your model are not animated",
    );
  });

  it("falls back to the technical message for codes without their own text", () => {
    const note = friendly(diagnostic(Code.KEYS_REDUCED, [], "info"));
    expect(note.title).toBe("Technical message");
    expect(note.text).toBe("technical message: with details");
  });

  it("formats durations", () => {
    expect([friendlyDuration(12.34), friendlyDuration(161.97), friendlyDuration(60)]).toEqual([
      "12.3 s",
      "2 min 42 s",
      "1 min 0 s",
    ]);
  });
});
