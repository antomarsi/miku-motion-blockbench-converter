/**
 * Deterministic GeckoLib `.animation.json` writer.
 *
 * Output is identical for identical inputs: bones follow the target skeleton order,
 * channels are `rotation`, `position`, then `scale`, numbers are rounded to a fixed
 * number of decimals with `-0` normalized, times come from integer sample indices, and
 * every keyframe sits on its own line (readable diffs without a huge file).
 *
 * Channels that never change are written as a single keyframe; channels that stay at
 * the rest pose are omitted.
 */

import { LoopMode, type Animation } from "../animation/clip";
import type { Skeleton } from "../animation/skeleton";
import type { Vec3Array } from "../geometry/quat";
import { positionChannel, rotationChannel } from "./encoding";

export const FORMAT_VERSION = "1.8.0";
export const GECKOLIB_FORMAT_VERSION = 2;
export const DECIMALS = 4;
const SCALE = 10 ** DECIMALS;

const LOOP_VALUES: Record<LoopMode, boolean | string> = {
  [LoopMode.ONCE]: false,
  [LoopMode.LOOP]: true,
  [LoopMode.HOLD]: "hold_on_last_frame",
};

/** A number already formatted for output. */
export class NumberText {
  constructor(readonly text: string) {}
}

/** Round to `DECIMALS` places, halves to even (as NumPy does), and never `-0`. */
export function roundValue(value: number): number {
  const scaled = value * SCALE;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
  return rounded / SCALE + 0;
}

export function formatNumber(value: number): string {
  let text = value.toFixed(DECIMALS);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

export function formatTime(seconds: number): string {
  const text = formatNumber(seconds);
  return text.includes(".") ? text : `${text}.0`;
}

export interface WriteStats {
  /** Keyframes the channels would have without reduction. */
  denseKeys: number;
  /** Keyframes written. */
  keys: number;
  /** Degrees, from reduction. */
  maxRotationError: number;
  /** Pixels, from reduction. */
  maxPositionError: number;
}

type Channel = Record<string, NumberText[]>;
/** A JSON-like tree whose leaves may be pre-formatted numbers. */
export type DocumentNode =
  | NumberText
  | string
  | number
  | boolean
  | DocumentNode[]
  | { [key: string]: DocumentNode };

/** One channel's keyframes, or undefined when it never leaves `rest`. */
export function channel(times: Float64Array, values: Vec3Array, rest = 0): Channel | undefined {
  const rounded = Float64Array.from(values, roundValue);
  if (rounded.every((v) => v === rest)) return undefined;
  let count = times.length;
  let constant = true;
  for (let i = 3; i < rounded.length && constant; i++) constant = rounded[i] === rounded[i % 3];
  if (constant) count = 1;
  const out: Channel = {};
  for (let k = 0; k < count; k++) {
    const label = formatTime(times[k]!);
    if (label in out) throw new RangeError("keyframe times collide after rounding; lower the fps");
    out[label] = [0, 1, 2].map((axis) => new NumberText(formatNumber(rounded[3 * k + axis]!)));
  }
  return out;
}

/** The GeckoLib document for `animation` on `skeleton`. */
export function buildDocument(
  animation: Animation,
  skeleton: Skeleton,
): { document: { [key: string]: DocumentNode }; stats: WriteStats } {
  const { times } = animation;
  const stats: WriteStats = { denseKeys: 0, keys: 0, maxRotationError: 0, maxPositionError: 0 };
  const bones: { [key: string]: DocumentNode } = {};
  const count = (keys: Channel): void => {
    const written = Object.keys(keys).length;
    stats.denseKeys += written > 1 ? times.length : 1;
    stats.keys += written;
  };
  for (const bone of skeleton) {
    const track = animation.tracks.get(bone.name);
    if (!track) continue;
    const channels: { [key: string]: DocumentNode } = {};
    if (track.rotations) {
      const rotation = channel(times, rotationChannel(bone, track.rotations));
      if (rotation) {
        channels.rotation = rotation;
        count(rotation);
      }
    }
    if (track.translations) {
      const position = channel(times, positionChannel(track.translations));
      if (position) {
        channels.position = position;
        count(position);
      }
    }
    if (track.scales) {
      const scale = channel(times, track.scales, 1);
      if (scale) {
        channels.scale = scale;
        count(scale);
      }
    }
    if (Object.keys(channels).length) bones[bone.name] = channels;
  }

  const clip: { [key: string]: DocumentNode } = {
    loop: LOOP_VALUES[animation.loop],
    animation_length: new NumberText(formatNumber(animation.length)),
    bones,
  };
  return {
    document: {
      format_version: FORMAT_VERSION,
      animations: { [animation.name]: clip },
      geckolib_format_version: GECKOLIB_FORMAT_VERSION,
    },
    stats,
  };
}

function inline(value: DocumentNode): string {
  if (value instanceof NumberText) return value.text;
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  return JSON.stringify(value);
}

function emit(value: DocumentNode, indent: number, out: string[], prefix: string, suffix: string): void {
  const pad = "  ".repeat(indent);
  const isObject = typeof value === "object" && !(value instanceof NumberText) && !Array.isArray(value);
  const entries = isObject ? Object.entries(value) : [];
  if (entries.length) {
    out.push(`${pad}${prefix}{`);
    entries.forEach(([key, child], i) => {
      emit(child, indent + 1, out, `${JSON.stringify(key)}: `, i < entries.length - 1 ? "," : "");
    });
    out.push(`${pad}}${suffix}`);
  } else {
    out.push(`${pad}${prefix}${inline(value)}${suffix}`);
  }
}

/** Serialize a document with one keyframe per line. */
export function renderDocument(document: DocumentNode): string {
  const out: string[] = [];
  emit(document, 0, out, "", "");
  return `${out.join("\n")}\n`;
}

export function renderAnimation(
  animation: Animation,
  skeleton: Skeleton,
): { text: string; stats: WriteStats } {
  const { document, stats } = buildDocument(animation, skeleton);
  return { text: renderDocument(document), stats };
}

/** The document as plain JSON data (numbers as numbers), e.g. to hand to Blockbench. */
export function toPlainJson(text: string): unknown {
  return JSON.parse(text);
}
