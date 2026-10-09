/// <reference types="blockbench-types" />

/**
 * Adds generated animations to the open project.
 *
 * An animation goes through Blockbench's own Bedrock/GeckoLib animation loader, so
 * Blockbench applies its file conventions itself. It is given no file path: the
 * animation is not linked to a file on disk, and re-importing replaces it in place.
 */

// `Animator.animations` is the project's animation list in every supported version; the
// class itself is only reachable as `Animation`, which clashes with the DOM type.
interface AnimationLoader {
  loadFile?: (file: unknown, filter?: string[]) => unknown;
}

function loader(): AnimationLoader {
  // The generated file is in the Bedrock animation format, whatever the project's own
  // format is. Blockbench 5 keeps that loader in a codec; older versions on Animator.
  const registry = (globalThis as { AnimationCodec?: { codecs?: Record<string, AnimationLoader> } })
    .AnimationCodec;
  const bedrock = registry?.codecs?.bedrock;
  if (bedrock?.loadFile) return bedrock;
  return Animator as AnimationLoader;
}

export interface NewAnimation {
  /** A parsed `.animation.json` document. */
  readonly document: unknown;
  /** The animation's name inside the document. */
  readonly name: string;
}

export interface LoadedAnimations {
  /** The animations now in the project, in the order given. */
  readonly animations: BBAnimation[];
  /** How many replaced an animation of the same name. */
  readonly replaced: number;
}

/** Load `items` as one undoable step, replacing animations that have the same names. */
export function addAnimations(items: readonly NewAnimation[], undoLabel: string): LoadedAnimations {
  const names = new Set(items.map((item) => item.name));
  const existing = Animator.animations.filter((animation) => names.has(animation.name));
  Undo.initEdit({ animations: existing });
  for (const animation of existing) animation.remove(false);

  const source = loader();
  if (!source.loadFile) throw new Error("this Blockbench version has no animation loader");
  const created: BBAnimation[] = [];
  for (const item of items) {
    const before = new Set(Animator.animations);
    const file = { name: `${item.name}.animation.json`, path: "", json: item.document, no_file: true };
    source.loadFile(file, [item.name]);
    for (const animation of Animator.animations) {
      if (before.has(animation)) continue;
      // Not from a file: nothing on disk to overwrite or to reload from.
      animation.path = "";
      animation.saved = false;
      created.push(animation);
    }
  }
  Undo.finishEdit(undoLabel, { animations: created });
  return { animations: created, replaced: existing.length };
}

/** Switch to the Animate tab and show `animation`. */
export function showAnimation(animation: BBAnimation): void {
  const animate = Modes.options.animate;
  if (animate && !animate.selected) animate.select();
  animation.select();
}
