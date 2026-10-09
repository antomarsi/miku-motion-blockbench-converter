/**
 * Easing curves: cubic Bezier from (0, 0) to (1, 1), as used by MMD and CSS.
 *
 * A curve is `[x1, y1, x2, y2]`: its two inner control points, each coordinate in
 * `[0, 1]`. Evaluating at `x` (normalized time) returns `y` (normalized progress).
 */

export type Curve = readonly [number, number, number, number];

export const LINEAR: Curve = [0.25, 0.25, 0.75, 0.75];

const ITERATIONS = 48; // bisection steps: 2**-48 is far below float32 input precision

/** One coordinate of the curve at parameter `s`. */
function bezier(p1: number, p2: number, s: number): number {
  const inv = 1 - s;
  return 3 * inv * inv * s * p1 + 3 * inv * s * s * p2 + s * s * s;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Progress `y` of the curve `(x1, y1, x2, y2)` at normalized time `x` (clamped to `[0, 1]`). */
export function evaluateCurve(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const target = clamp01(x);
  // Exact endpoints, so keyed values are reproduced bit-for-bit.
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  const cx1 = clamp01(x1); // keeps x(s) monotonic
  const cx2 = clamp01(x2);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < ITERATIONS; i++) {
    const mid = 0.5 * (lo + hi);
    if (bezier(cx1, cx2, mid) < target) lo = mid;
    else hi = mid;
  }
  return bezier(y1, y2, 0.5 * (lo + hi));
}

export function evaluate(curve: Curve, x: number): number {
  return evaluateCurve(curve[0], curve[1], curve[2], curve[3], x);
}

/** True when the curve is the identity easing (control points on the diagonal). */
export function isLinear(curve: Curve, atol = 1e-9): boolean {
  return Math.abs(curve[0] - curve[1]) <= atol && Math.abs(curve[2] - curve[3]) <= atol;
}
