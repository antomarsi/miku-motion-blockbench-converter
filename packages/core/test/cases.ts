/** Runs the reference conversion cases through the TypeScript pipeline. */

import { basename } from "node:path";

import { parseBbmodelText, type BlockbenchModel } from "../src/blockbench/bbmodel";
import { DEFAULT_TOLERANCE } from "../src/geckolib/optimize";
import { parseMappingText } from "../src/mapping/schema";
import { convert, type ConversionResult, type ConvertOptions } from "../src/pipeline";
import { pmxRig } from "../src/pmx/adapter";
import type { SourceRig } from "../src/rig/model";
import { builtinSkeleton, parseSkeletonText } from "../src/rig/schema";
import { caseFile, readCase, readCaseText, readReferenceBytes, type CaseSpec } from "./reference";

export function loadModel(name: string, reference: string): BlockbenchModel {
  const stem = basename(caseFile(name, reference)).replace(/\.[^.]+$/, "");
  return parseBbmodelText(readCaseText(name, reference), stem, reference);
}

/** The source skeleton a case asks for: none, a built-in one, or a file in its folder. */
export function caseRig(name: string, spec: CaseSpec): SourceRig | null {
  const skeleton = spec.source_skeleton;
  if (skeleton === null) return null;
  if (skeleton.endsWith(".pmx")) return pmxRig(readReferenceBytes("cases", name, skeleton), "skeleton");
  if (skeleton.endsWith(".json")) return parseSkeletonText(readCaseText(name, skeleton), skeleton);
  return builtinSkeleton(skeleton);
}

export function caseOptions(name: string, spec: CaseSpec): ConvertOptions {
  return {
    fps: spec.fps,
    sourceRig: caseRig(name, spec),
    tolerance: spec.optimize
      ? { ...DEFAULT_TOLERANCE, rotationDegrees: spec.optimize.rotation, position: spec.optimize.position }
      : undefined,
  };
}

export function runCase(name: string): ConversionResult {
  const { spec, motion } = readCase(name);
  return convert(
    {
      motion: { data: motion, label: "motion" },
      model: loadModel(name, spec.model),
      mapping: parseMappingText(readCaseText(name, spec.mapping)),
    },
    caseOptions(name, spec),
  );
}
