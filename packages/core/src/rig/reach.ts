/**
 * Fits a mapping's source chains to the source model's actual bone tree.
 *
 * A mapping chain lists source bones parent to child and assumes each one fully carries
 * the next. Model families differ in small ways: on some, the elbow hangs off a helper
 * that follows the arm twist only in part, so the twist reaches the forearm at 75%, not
 * 100%. Given the motion's own skeleton, each link is weighted by how much of its
 * rotation really arrives at the next link.
 */

import type { Binding, Link, ResolvedMapping } from "../mapping/resolve";
import type { SourceRig } from "./model";

export interface ReachChange {
  readonly target: string;
  /** The link whose weight changed, and the next link it was measured against. */
  readonly source: string;
  readonly towards: string;
  readonly from: number;
  readonly to: number;
}

const EPSILON = 1e-6;

/**
 * How much of `bone`'s local rotation arrives at `below`: 1 for each ancestor of `below`
 * that is `bone` itself, plus the weight of each ancestor that inherits from it.
 * Zero means `below` doesn't hang under `bone` at all.
 */
export function reach(rig: SourceRig, bone: string, below: string): number {
  let total = 0;
  for (const name of rig.ancestors(below)) {
    if (name === bone) total += 1;
    const inherit = rig.bone(name).inherit;
    if (inherit && inherit.bone === bone) total += inherit.weight;
  }
  return total;
}

/**
 * `mapping` with each chain link scaled by its reach to the next link the rig knows.
 * Links the rig doesn't define, inverted links (cancels) and pairs that aren't under one
 * another are left as written. `key` maps rig bone names to the mapping's source names.
 */
export function followSourceTree(
  mapping: ResolvedMapping,
  rig: SourceRig,
  key: (name: string) => string = (name) => name,
): { mapping: ResolvedMapping; changes: ReachChange[] } {
  const rigName = new Map<string, string>();
  for (const name of rig.bones.keys()) if (!rigName.has(key(name))) rigName.set(key(name), name);

  const changes: ReachChange[] = [];
  const bindings: Binding[] = mapping.bindings.map((binding) => {
    let changed = false;
    const chain: Link[] = binding.chain.map((link, index) => {
      const own = rigName.get(link.source);
      const next = binding.chain.slice(index + 1).find((later) => later.weight > 0 && rigName.has(later.source));
      if (link.weight <= 0 || own === undefined || !next || next.source === link.source) return link;
      const share = reach(rig, own, rigName.get(next.source)!);
      if (share <= EPSILON || Math.abs(share - 1) <= EPSILON) return link;
      changed = true;
      const weight = link.weight * share;
      changes.push({ target: binding.target, source: link.source, towards: next.source, from: link.weight, to: weight });
      return { ...link, weight };
    });
    return changed ? { ...binding, chain } : binding;
  });
  return { mapping: changes.length ? { ...mapping, bindings } : mapping, changes };
}
