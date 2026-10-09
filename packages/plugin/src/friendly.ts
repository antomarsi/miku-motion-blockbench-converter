/**
 * Plain-language versions of the converter's diagnostics, for the import report.
 *
 * The core's messages are precise and stable (they are compared against the reference
 * implementation and suit logs). People importing a dance want to know what they will
 * see and whether they need to do anything; that wording lives here. No Blockbench
 * code in this file, so it can be tested on its own.
 */

import { Code, type Diagnostic } from "@miku-motion/core";

export interface FriendlyNote {
  /** What happened, in a few words. */
  readonly title: string;
  /** What it means for the result, and what to do about it if anything. */
  readonly text: string;
  /** Names worth listing (bones, expressions), shown folded away. */
  readonly names: readonly string[];
  /** What the names are, e.g. "bones". */
  readonly namesLabel: string;
  readonly severity: "warning" | "info";
  /** The stable code, for looking things up or reporting a problem. */
  readonly code: string;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Writer = (d: Diagnostic) => { title: string; text: string; namesLabel?: string };

const WRITERS: Partial<Record<Code, Writer>> = {
  [Code.UNSUPPORTED_MORPHS]: (d) => ({
    title: "Facial expressions are not imported yet",
    text:
      `This motion has ${count(d.bones.length, "facial expression", "facial expressions")} ` +
      "(blinks, mouth shapes). This version can't convert them yet, so the face stays still.",
    namesLabel: "expressions",
  }),
  [Code.UNSUPPORTED_CAMERA]: () => ({
    title: "Camera movement is not imported",
    text: "The file also contains camera keyframes. Only the character's motion is converted.",
  }),
  [Code.UNSUPPORTED_LIGHT]: () => ({
    title: "Lighting is not imported",
    text: "The file also contains light keyframes. Only the character's motion is converted.",
  }),
  [Code.UNSUPPORTED_SHADOW]: () => ({
    title: "Shadow settings are not imported",
    text: "The file also contains shadow keyframes. Only the character's motion is converted.",
  }),
  [Code.DUPLICATE_KEYS]: (d) => ({
    title: "The motion file has repeated keyframes",
    text:
      `${count(d.bones.length, "bone has", "bones have")} two keyframes on the same frame. ` +
      "The later one in the file was used.",
  }),
  [Code.UNMAPPED_ANIMATED_BONES]: (d) => ({
    title: `${count(d.bones.length, "moving part", "moving parts")} of the dance had nowhere to go`,
    text:
      "The motion animates these bones, but the mapping doesn't connect them to any bone " +
      "of your model, so their movement is left out. Small parts like toes are fine to " +
      "skip; for anything bigger, add it to a custom mapping.",
  }),
  [Code.IK_DRIVEN_BONES]: () => ({
    title: "Legs are not fully imported yet",
    text:
      "This dance places the feet with IK targets. This version can't solve them yet, so " +
      "the knees may stay straight and the feet may slide.",
    namesLabel: "IK targets",
  }),
  [Code.TRANSLATION_DROPPED]: (d) => ({
    title: `Position changes of ${count(d.bones.length, "bone", "bones")} are left out`,
    text:
      "The motion moves these bones, but the mapping only passes on their rotation. Add " +
      '"translation": true to their entry in a custom mapping if they should move.',
  }),
  [Code.MAPPED_SOURCE_MISSING]: (d) => ({
    title: `${count(d.bones.length, "bone the mapping expects is", "bones the mapping expects are")} not in this dance`,
    text: "They simply stay in their rest pose. This is normal: dances use different sets of bones.",
  }),
  [Code.SOURCE_APPLIED_TWICE]: () => ({
    title: "Some rotations are applied twice",
    text:
      "A bone of the dance is listed both for a bone of your model and for one of its " +
      "parents, so it rotates double. Remove it from the child's entry in the mapping.",
    namesLabel: "entries",
  }),
  [Code.UNMAPPED_TARGET_BONES]: (d) => ({
    title: `${count(d.bones.length, "bone of your model is", "bones of your model are")} not animated`,
    text:
      "The mapping doesn't use them, so they stay in their rest pose. That's expected for " +
      "parts the dance doesn't control.",
  }),
  [Code.PIVOT_SHARED_WITH_PARENT]: () => ({
    title: "Some joints rotate around the wrong point",
    text:
      "These bones have the same pivot as their parent. If they are separate joints (an " +
      "elbow, a knee), move their pivot to the joint in Blockbench.",
  }),
  [Code.TARGET_NOT_GECKOLIB]: () => ({
    title: "This project is not a GeckoLib model",
    text:
      "The animation imports fine. To use it with GeckoLib, convert the project first: " +
      "File > Convert Project > GeckoLib Animated Model.",
  }),
  [Code.SECONDARY_MOTION]: () => ({
    title: "Hair and clothes don't move yet",
    text:
      "Swinging hair, skirts and ties are simulated by the converter, and this version " +
      "can't do that yet. These parts stay still.",
    namesLabel: "bones",
  }),
};

/** The first sentence of a technical message, as a fallback title. */
function firstSentence(message: string): string {
  const cut = message.search(/[:;]|\. /);
  const text = cut > 0 ? message.slice(0, cut) : message;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function friendly(diagnostic: Diagnostic): FriendlyNote {
  const written = WRITERS[diagnostic.code]?.(diagnostic);
  return {
    title: written?.title ?? firstSentence(diagnostic.message),
    text: written?.text ?? diagnostic.message,
    names: diagnostic.bones,
    namesLabel: written?.namesLabel ?? "bones",
    severity: diagnostic.severity,
    code: diagnostic.code,
  };
}

/** `162.4` -> `2 min 42 s`. */
export function friendlyDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${Number(seconds.toFixed(1))} s`;
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}
