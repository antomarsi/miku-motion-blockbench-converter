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

/** The first capture of `pattern` in a technical message, or a fallback. */
function found(message: string, pattern: RegExp, fallback = "?"): string {
  return pattern.exec(message)?.[1] ?? fallback;
}

type Writer = (d: Diagnostic) => { title: string; text: string; namesLabel?: string };

const WRITERS: Partial<Record<Code, Writer>> = {
  [Code.UNSUPPORTED_MORPHS]: (d) =>
    d.message.includes("no morph rules")
      ? {
          title: "Facial expressions were left out",
          text:
            `This motion has ${count(d.bones.length, "facial expression", "facial expressions")} ` +
            "(blinks, mouth shapes), but the mapping has no rules for the face, so it stays " +
            "still. The template's built-in mapping has them; a custom mapping needs a " +
            '"morphs" section.',
          namesLabel: "expressions",
        }
      : {
          title: `${count(d.bones.length, "facial expression", "facial expressions")} had nowhere to go`,
          text:
            "The face is animated, but the mapping has no rule for these expressions (often " +
            "eyebrows or special faces your model has no parts for), so they are left out.",
          namesLabel: "expressions",
        },
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
    title: "Some foot or hand targets could not be followed",
    text:
      "The dance moves these parts with IK targets that the source skeleton doesn't know " +
      "(or IK solving is switched off), so the limbs only follow their own keyframes: " +
      "knees may stay straight and feet may slide.",
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
  [Code.IK_UNREACHED]: (d) => ({
    title: "A foot doesn't always reach where the dance puts it",
    text:
      `In about ${found(d.message, /in (\d+%) of samples/)} of the dance, this leg can't ` +
      "reach its target, so the foot may float or slide a little. The dance was made for a " +
      "model with different leg proportions; choosing that model's .pmx as the source " +
      "model fixes it.",
    namesLabel: "IK target",
  }),
  [Code.IK_SOLVED]: () => ({
    title: "Legs follow the dance's foot targets",
    text: "Knee bends were worked out from where the dance places the feet, as MMD does.",
    namesLabel: "IK targets",
  }),
  [Code.FACIAL_ANIMATION]: () => ({
    title: "The face is animated",
    text: "Blinks and mouth shapes from the dance drive these parts of your model.",
    namesLabel: "face parts",
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
    title: "Hair and clothes swing with the dance",
    text:
      "MMD moves these with physics, which a motion file doesn't store, so their swing " +
      "was simulated from the body's movement.",
  }),
  [Code.SECONDARY_CANDIDATES]: (d) => ({
    title: "Some hair or cloth parts could swing but are not set up",
    text:
      `${found(d.message, /^(\d+) bone chains/)} parts of your model look like hair or cloth ` +
      "but the mapping doesn't list them, so they stay stiff. Add them to the " +
      '"secondary_motion" section of a custom mapping to make them swing.',
  }),
  [Code.KEYS_REDUCED]: (d) => ({
    title: `Keyframes reduced by ${found(d.message, /\(-(\d+%)\)/)}`,
    text:
      `Only the keyframes needed to follow the dance were kept: ` +
      `${found(d.message, /to ([\d,]+) \(/)} of ${found(d.message, /from ([\d,]+) to/)}. ` +
      "The file is smaller and the motion between keys is more accurate.",
  }),
  [Code.REDUCTION_OVER_TOLERANCE]: (d) => ({
    title: "A few very fast moves are slightly off",
    text:
      `In some quick spins the result differs from the dance by up to ` +
      `${found(d.message, /up to ([\d.]+) deg/)} degrees for a moment. If you notice a ` +
      "glitch, import again with more samples per second.",
  }),
  [Code.GROUP_DURATION_MISMATCH]: (d) => ({
    title: "This performer's motion has a different length",
    text:
      `${found(d.message, /^(.+?) converts to/)} is ` +
      `${found(d.message, /, ([\d.]+)s away/)} s away from the group's average length. ` +
      'Tick "Same length for all" so everyone ends together.',
  }),
  [Code.GROUP_FORMATION]: (d) => ({
    title: d.message.includes("own origin")
      ? "Every performer starts at the model's origin"
      : "The group was centred on the origin",
    text:
      "The stage positions stored in the motions were adjusted as you chose. Heights are " +
      "unchanged.",
  }),
  [Code.GROUP_LENGTH_SYNCED]: (d) => ({
    title: "All animations have the same length",
    text:
      `Every animation now lasts ${found(d.message, /is now ([\d.]+)s long/)} s, so the ` +
      "performers can start and end together. Shorter motions hold their last pose.",
  }),
  [Code.GROUP_MEMBER_SKIPPED]: (d) => ({
    title: "A file without a performer was skipped",
    text:
      `${found(d.message, /^skipped (.+?):/)} has no body or face motion (it is probably ` +
      "the camera), so no animation was made for it.",
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
