/// <reference types="blockbench-types" />

/**
 * Adds a generated animation to the open project.
 *
 * The animation goes through Blockbench's own Bedrock/GeckoLib animation loader, so
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

export interface LoadedAnimation {
  readonly animation: BBAnimation | undefined;
  /** An animation of the same name was replaced. */
  readonly replaced: boolean;
}

/** Load `document` (a parsed `.animation.json`) and return its animation `name`. */
export function addAnimation(document: unknown, name: string, undoLabel: string): LoadedAnimation {
  const existing = Animator.animations.filter((animation) => animation.name === name);
  Undo.initEdit({ animations: existing });
  for (const animation of existing) animation.remove(false);

  const before = new Set(Animator.animations);
  const source = loader();
  if (!source.loadFile) throw new Error("this Blockbench version has no animation loader");
  const file = { name: `${name}.animation.json`, path: "", json: document, no_file: true };
  source.loadFile(file, [name]);
  const created = Animator.animations.filter((animation) => !before.has(animation));
  for (const animation of created) {
    // Not from a file: nothing on disk to overwrite or to reload from.
    animation.path = "";
    animation.saved = false;
  }
  Undo.finishEdit(undoLabel, { animations: created });

  const animation = created.find((item) => item.name === name) ?? created[0];
  return { animation, replaced: existing.length > 0 };
}

/** Switch to the Animate tab and show `animation`. */
export function showAnimation(animation: BBAnimation): void {
  const animate = Modes.options.animate;
  if (animate && !animate.selected) animate.select();
  animation.select();
}
