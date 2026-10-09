/**
 * MMD motion (.vmd) to GeckoLib animation conversion.
 *
 * Pure TypeScript: nothing here imports Blockbench, the DOM or Node, so the same code
 * runs in the Blockbench plugin (desktop and web) and in the CLI.
 */

export const CORE_NAME = "miku-motion";

export * from "./diagnostics";
export * from "./errors";

export * as quat from "./geometry/quat";
export * as euler from "./geometry/euler";
export type { Quat, QuatArray, Vec3, Vec3Array } from "./geometry/quat";

export * as curves from "./animation/curves";
export * from "./animation/sampling";
export * from "./animation/source";

export * as vmdInterpolation from "./vmd/interpolation";
export * as vmdNames from "./vmd/names";
export { toSourceMotion } from "./vmd/adapter";
export { parseVmd } from "./vmd/parser";
export * from "./vmd/summary";
export * from "./vmd/types";
export * from "./vmd/synth";
export { writeVmd } from "./vmd/writer";

export * from "./pmx/parser";

export * from "./animation/clip";
export * from "./animation/skeleton";
export * from "./blockbench/bbmodel";
export * from "./conversion/coordinates";
export { retarget } from "./conversion/retarget";
export * as geckolibEncoding from "./geckolib/encoding";
export * from "./geckolib/writer";
export * from "./mapping/resolve";
export * from "./mapping/schema";
export * from "./pipeline";
export * as text from "./text";

export * from "./conversion/morphs";
export * from "./conversion/secondary";
export * from "./geckolib/optimize";
export * from "./mapping/secondary";
export * from "./pmx/adapter";
export * from "./rig/ik";
export * from "./rig/model";
export * from "./rig/schema";

export * from "./mapping/init";
export * from "./model/document";
export * from "./model/editor";
export * from "./model/prepare";
export * from "./model/roles";
export * from "./model/skin";
