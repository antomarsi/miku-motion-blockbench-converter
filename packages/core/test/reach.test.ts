import { describe, expect, it } from "vitest";

import { IDENTITY } from "../src/geometry/quat";
import type { ResolvedMapping } from "../src/mapping/resolve";
import { SourceRig, type RigBone } from "../src/rig/model";
import { followSourceTree, reach } from "../src/rig/reach";

function rig(bones: [name: string, parent?: string, inherit?: [string, number]][]): SourceRig {
  const map = new Map<string, RigBone>();
  for (const [name, parent, inherit] of bones) {
    map.set(name, {
      name,
      parent,
      position: [0, 0, 0],
      inherit: inherit ? { bone: inherit[0], weight: inherit[1] } : undefined,
    });
  }
  return new SourceRig("test", map);
}

/** An arm whose elbow hangs off a helper that follows the twist at 75%. */
const PARTIAL = rig([
  ["arm"],
  ["twist", "arm"],
  ["twist1", "arm", ["twist", 0.75]],
  ["elbow", "twist1"],
  ["wrist_twist", "elbow"],
  ["cancel", "arm", ["arm", -1]],
  ["leg", "cancel"],
]);
/** The standard layout: the elbow hangs off the twist bone itself. */
const STANDARD = rig([["arm"], ["twist", "arm"], ["elbow", "twist"], ["wrist_twist", "elbow"]]);

const mapping = (chain: [string, number][]): ResolvedMapping => ({
  translationScale: 1,
  bindings: [
    {
      target: "forearm",
      chain: chain.map(([source, weight]) => ({ source, weight })),
      translation: false,
      restCorrection: IDENTITY,
      anchor: undefined,
    },
  ],
});
const weights = (result: ResolvedMapping): number[] => result.bindings[0]!.chain.map((link) => link.weight);

describe("reach of a source bone", () => {
  it("is 1 through a plain parent chain and the inherit weight through a helper", () => {
    expect(reach(STANDARD, "twist", "elbow")).toBe(1);
    expect(reach(PARTIAL, "twist", "elbow")).toBe(0.75);
    expect(reach(PARTIAL, "arm", "elbow")).toBe(1);
    expect(reach(PARTIAL, "elbow", "twist")).toBe(0); // not under it
    expect(reach(PARTIAL, "arm", "leg")).toBe(0); // cancelled on the way down
  });
});

describe("followSourceTree", () => {
  const chain: [string, number][] = [
    ["twist", 1],
    ["elbow", 1],
    ["wrist_twist", 1],
  ];

  it("weights a link by how much of it reaches the next one", () => {
    const { mapping: followed, changes } = followSourceTree(mapping(chain), PARTIAL);
    expect(weights(followed)).toEqual([0.75, 1, 1]);
    expect(changes).toEqual([{ target: "forearm", source: "twist", towards: "elbow", from: 1, to: 0.75 }]);
  });

  it("returns the same mapping when the tree is the standard one", () => {
    const original = mapping(chain);
    const { mapping: followed, changes } = followSourceTree(original, STANDARD);
    expect(followed).toBe(original);
    expect(changes).toEqual([]);
  });

  it("leaves cancels, unrelated pairs and bones the rig lacks as written", () => {
    const written: [string, number][] = [
      ["arm", 1],
      ["arm", -1],
      ["leg", 1],
      ["missing", 1],
    ];
    expect(weights(followSourceTree(mapping(written), PARTIAL).mapping)).toEqual([1, -1, 1, 1]);
  });

  it("matches rig bones to mapping names through the given key", () => {
    const upper = (name: string): string => name.toUpperCase();
    const named = mapping(chain.map(([source, weight]) => [source.toUpperCase(), weight]));
    expect(weights(followSourceTree(named, PARTIAL, upper).mapping)).toEqual([0.75, 1, 1]);
  });
});
