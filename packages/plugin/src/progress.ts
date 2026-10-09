/// <reference types="blockbench-types" />

/**
 * Runs a stepwise conversion while showing how far it is.
 *
 * The conversion works in the window's own thread, so between steps it pauses for a
 * moment to let the progress window repaint and the Cancel button respond.
 */

import type { ConvertStep } from "@miku-motion/core";

/** Thrown when the user cancels; callers end quietly on it. */
export class Cancelled extends Error {}

const STAGES: Readonly<Record<ConvertStep["stage"], string>> = {
  read: "Reading the motion",
  sample: "Sampling the keyframes",
  ik: "Solving leg IK",
  retarget: "Moving the model's bones",
  secondary: "Simulating hair and clothes",
  write: "Writing the keyframes",
};

const REPAINT_EVERY = 80; // milliseconds between pauses

interface ProgressWindow {
  update(step: ConvertStep): void;
  cancelled(): boolean;
  close(): void;
}

function openWindow(title: string): ProgressWindow {
  const shade = document.createElement("div");
  shade.style.cssText =
    "position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; " +
    "justify-content: center; background: rgba(0, 0, 0, 0.35);";
  const box = document.createElement("div");
  box.style.cssText =
    "width: 420px; max-width: 90vw; padding: 16px 18px; background: var(--color-ui); " +
    "color: var(--color-text); border: 1px solid var(--color-border); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);";
  const heading = document.createElement("div");
  heading.style.cssText = "font-size: 1.15em; margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
  heading.textContent = title;
  const track = document.createElement("div");
  track.style.cssText = "height: 10px; background: var(--color-back); border: 1px solid var(--color-border);";
  const bar = document.createElement("div");
  bar.style.cssText = "height: 100%; width: 0%; background: var(--color-accent);";
  track.append(bar);
  const row = document.createElement("div");
  row.style.cssText = "display: flex; align-items: center; gap: 12px; margin-top: 10px;";
  const label = document.createElement("div");
  label.style.cssText = "flex: 1; min-width: 0; color: var(--color-subtle_text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  let stop = false;
  cancel.addEventListener("click", () => {
    stop = true;
    cancel.disabled = true;
    label.textContent = "Cancelling...";
  });
  row.append(label, cancel);
  box.append(heading, track, row);
  shade.append(box);
  document.body.append(shade);

  return {
    update(step) {
      const percent = Math.round(Math.min(Math.max(step.fraction, 0), 1) * 100);
      bar.style.width = `${percent}%`;
      if (!stop) label.textContent = `${step.member ? `${step.member}: ` : ""}${STAGES[step.stage]}... ${percent}%`;
      Blockbench.setProgress(step.fraction);
    },
    cancelled: () => stop,
    close() {
      shade.remove();
      Blockbench.setProgress(0);
    },
  };
}

/** Let the browser paint a frame and handle clicks. */
function pause(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100); // no frames are drawn while the window is minimised
  });
}

/** Run `steps` to the end behind a progress window; rejects with `Cancelled` on Cancel. */
export async function withProgress<T>(title: string, steps: Generator<ConvertStep, T>): Promise<T> {
  const progress = openWindow(title);
  try {
    let shown = -Infinity;
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      progress.update(next.value);
      if (performance.now() - shown < REPAINT_EVERY) continue;
      await pause();
      shown = performance.now();
      if (progress.cancelled()) throw new Cancelled("cancelled");
    }
  } finally {
    progress.close();
  }
}
