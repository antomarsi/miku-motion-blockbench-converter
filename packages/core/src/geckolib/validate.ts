/**
 * Checks an `.animation.json` document: that it has the shape GeckoLib and Blockbench
 * read, and (given a model) that every animated bone exists in it.
 */

import type { Skeleton } from "../animation/skeleton";

export interface AnimationIssue {
  readonly severity: "error" | "warning";
  /** Where in the document, e.g. `animation.model.dance > head > rotation`. */
  readonly where: string;
  readonly message: string;
}

export interface AnimationCheck {
  readonly issues: readonly AnimationIssue[];
  /** Per animation: name, length in seconds, animated bones and keyframes. */
  readonly animations: readonly { name: string; length: number; bones: number; keyframes: number }[];
}

const CHANNELS = new Set(["rotation", "position", "scale"]);
const TIME_SLACK = 1e-3; // seconds a key may sit past the animation's end (rounding)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVector(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** A keyframe's value: a vector, or Blockbench's `{ post: [...] }` / `{ vector: [...] }` forms. */
function keyValueOk(value: unknown): boolean {
  if (isVector(value)) return true;
  if (!isObject(value)) return false;
  const vectors = [value.post, value.pre, value.vector].filter((v) => v !== undefined);
  return vectors.length > 0 && vectors.every(isVector);
}

export function validateAnimation(document: unknown, skeleton?: Skeleton): AnimationCheck {
  const issues: AnimationIssue[] = [];
  const animations: AnimationCheck["animations"][number][] = [];
  const add = (severity: AnimationIssue["severity"], where: string, message: string): void => {
    issues.push({ severity, where, message });
  };
  if (!isObject(document)) {
    add("error", "file", "not a JSON object");
    return { issues, animations };
  }
  if (typeof document.format_version !== "string") add("error", "file", 'no "format_version"');
  if (!isObject(document.animations)) {
    add("error", "file", 'no "animations" object');
    return { issues, animations };
  }
  if (!Object.keys(document.animations).length) add("error", "file", "contains no animation");

  for (const [name, animation] of Object.entries(document.animations)) {
    if (!isObject(animation)) {
      add("error", name, "not an object");
      continue;
    }
    const length = animation.animation_length;
    const hasLength = typeof length === "number" && Number.isFinite(length) && length >= 0;
    if (!hasLength) add("error", name, '"animation_length" must be a number of seconds');
    const end = hasLength ? length : Infinity;
    if (!["boolean", "string", "undefined"].includes(typeof animation.loop)) {
      add("error", name, '"loop" must be true, false or "hold_on_last_frame"');
    } else if (typeof animation.loop === "string" && animation.loop !== "hold_on_last_frame") {
      add("error", name, `unknown "loop" value "${animation.loop}"`);
    }
    const bones = isObject(animation.bones) ? animation.bones : {};
    if (animation.bones !== undefined && !isObject(animation.bones)) add("error", name, '"bones" must be an object');
    if (!Object.keys(bones).length) add("warning", name, "animates no bones");

    let keyframes = 0;
    const unknown: string[] = [];
    for (const [bone, channels] of Object.entries(bones)) {
      if (skeleton && !skeleton.has(bone)) unknown.push(bone);
      if (!isObject(channels)) {
        add("error", `${name} > ${bone}`, "not an object");
        continue;
      }
      for (const [channel, keys] of Object.entries(channels)) {
        const where = `${name} > ${bone} > ${channel}`;
        if (!CHANNELS.has(channel)) {
          add("warning", where, "not a rotation, position or scale channel");
          continue;
        }
        if (isVector(keys)) {
          keyframes += 1; // a constant channel
          continue;
        }
        if (!isObject(keys)) {
          add("error", where, "must be a vector or an object of keyframes");
          continue;
        }
        let previous = -Infinity;
        let reported = false;
        for (const [time, value] of Object.entries(keys)) {
          keyframes += 1;
          if (reported) continue; // one message per channel is enough
          const seconds = Number(time);
          if (time.trim() === "" || !Number.isFinite(seconds) || seconds < 0) {
            add("error", where, `keyframe time "${time}" is not a number of seconds`);
          } else if (seconds > end + TIME_SLACK) {
            add("warning", where, `keyframe at ${time} s is after the end of the animation (${end} s)`);
          } else if (seconds <= previous) {
            add("warning", where, `keyframe at ${time} s is out of order`);
          } else if (!keyValueOk(value)) {
            add("error", where, `keyframe at ${time} s is not a vector of three numbers`);
          } else {
            previous = seconds;
            continue;
          }
          reported = true;
        }
      }
    }
    if (unknown.length) {
      const shown = unknown.slice(0, 12).join(", ") + (unknown.length > 12 ? ` (+${unknown.length - 12} more)` : "");
      add("error", name, `${unknown.length} animated bones are not in the model: ${shown}`);
    }
    animations.push({ name, length: hasLength ? length : 0, bones: Object.keys(bones).length, keyframes });
  }
  return { issues, animations };
}
