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
    const note = friendly(diagnostic("MM999" as Code, [], "info"));
    expect(note.title).toBe("Technical message");
    expect(note.text).toBe("technical message: with details");
  });

  it("reads numbers out of the technical messages", () => {
    const reduced = friendly({
      code: Code.KEYS_REDUCED,
      severity: "info",
      message: "keyframes reduced from 427,638 to 52,253 (-88%); worst error 1.00 deg / 0.050 px",
      bones: [],
    });
    expect(reduced.title).toBe("Keyframes reduced by 88%");
    expect(reduced.text).toContain("52,253 of 427,638");
    const missed = friendly({
      code: Code.IK_UNREACHED,
      severity: "warning",
      message: "左足ＩＫ missed its goal in 12% of samples (by up to 0.95 units); the source ...",
      bones: ["左足ＩＫ"],
    });
    expect(missed.text).toContain("about 12% of the dance");
  });

  it("formats durations", () => {
    expect([friendlyDuration(12.34), friendlyDuration(161.97), friendlyDuration(60)]).toEqual([
      "12.3 s",
      "2 min 42 s",
      "1 min 0 s",
    ]);
  });
});
