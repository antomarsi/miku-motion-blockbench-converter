import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

/** Repository root and the reference dumps written by the Python version. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const REFERENCE_DIR = resolve(REPO_ROOT, "reference");

export function readReferenceJson<T>(...path: string[]): T {
  return JSON.parse(readFileSync(resolve(REFERENCE_DIR, ...path), "utf8")) as T;
}

export function readReferenceBytes(...path: string[]): Uint8Array {
  return new Uint8Array(readFileSync(resolve(REFERENCE_DIR, ...path)));
}

/** Options of one conversion case (`reference/cases/<name>/case.json`). */
export interface CaseSpec {
  motion: string;
  model: string;
  mapping: string;
  fps: number;
  source_skeleton: string | null;
  optimize?: { rotation: number; position: number };
}

export interface PoseStage {
  translations: number[][];
  rotations: number[][];
}

/** Intermediate values of one conversion case (`stages.json`). */
export interface Stages {
  vmd: {
    model_name: string;
    version: number;
    bone_keys: {
      name: string;
      frame: number;
      position: number[];
      rotation: number[];
      curves: number[][];
    }[];
    morph_keys: { name: string; frame: number; weight: number }[];
    show_ik_keys: { frame: number; show: boolean; ik: [string, boolean][] }[];
    counts: [number, number, number];
  };
  motion: {
    end_frame: number;
    tracks: string[];
    ik_bones: string[];
    ik_states: Record<string, [number, boolean][]>;
    flags: Record<string, [boolean, boolean, boolean]>;
  };
  times: number[];
  frames: number[];
  sampled: Record<string, PoseStage>;
  morphs: Record<string, number[]>;
}

/** Names of the single-motion conversion cases (group cases are listed separately). */
export function caseNames(): string[] {
  return readdirSync(resolve(REFERENCE_DIR, "cases"))
    .filter((name) => existsSync(resolve(REFERENCE_DIR, "cases", name, "motion.vmd")))
    .sort();
}

export function readCase(name: string): { spec: CaseSpec; stages: Stages; motion: Uint8Array } {
  return {
    spec: readReferenceJson<CaseSpec>("cases", name, "case.json"),
    stages: readReferenceJson<Stages>("cases", name, "stages.json"),
    motion: readReferenceBytes("cases", name, "motion.vmd"),
  };
}

/** Element-wise comparison of numbers and nested number arrays within `tolerance`. */
export function expectClose(
  actual: unknown,
  expected: unknown,
  tolerance = 1e-9,
  label = "",
): void {
  const flat = (value: unknown): number[] =>
    typeof value === "number"
      ? [value]
      : Array.from(value as ArrayLike<unknown>).flatMap((v) => flat(v));
  const a = flat(actual);
  const e = flat(expected);
  expect(a.length, `${label} length`).toBe(e.length);
  let worst = 0;
  let worstIndex = -1;
  for (let i = 0; i < a.length; i++) {
    const difference = Math.abs(a[i]! - e[i]!);
    if (!(difference <= worst)) {
      worst = difference;
      worstIndex = i;
    }
  }
  expect(
    worst,
    `${label} differs by ${worst} at index ${worstIndex}: ${a[worstIndex]} vs ${e[worstIndex]}`,
  ).toBeLessThanOrEqual(tolerance);
}
