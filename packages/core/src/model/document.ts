/**
 * Editing a Blockbench project's JSON: bones, pivots, cubes, locators and IK nulls.
 *
 * Supports both outliner layouts (4.x nested groups, 5.x `groups[]` + uuid references).
 * Only structure and geometry are touched; everything else is kept as Blockbench wrote it.
 */

import { parseBbmodel, type BlockbenchModel } from "../blockbench/bbmodel";
import { TargetModelError } from "../errors";
import type { Vec3 } from "../geometry/quat";
import { splitFaceUvs, type EditorCube, type ModelEditor, type NullLinks } from "./editor";

type Node = Record<string, unknown>;

function randomUuid(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Only an identifier inside one file: uniqueness matters, unpredictability doesn't.
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childList(node: Node): unknown[] {
  if (!Array.isArray(node.children)) node.children = [];
  return node.children as unknown[];
}

export class BbmodelDocument implements ModelEditor {
  readonly data: Node;
  private readonly layout5: boolean;
  private readonly groupData = new Map<string, Node>();

  /** `fallbackName` names the model when the project has no name of its own. */
  constructor(
    data: unknown,
    private readonly fallbackName = "model",
    private readonly newUuid: () => string = randomUuid,
  ) {
    if (!isNode(data) || !Array.isArray(data.outliner)) {
      throw new TargetModelError("not a Blockbench project (missing 'outliner')");
    }
    this.data = data;
    this.layout5 = Array.isArray(data.groups);
    for (const group of this.layout5 ? (data.groups as unknown[]) : []) {
      if (isNode(group) && typeof group.uuid === "string") this.groupData.set(group.uuid, group);
    }
    if (!Array.isArray(data.elements)) data.elements = [];
  }

  /** The project as compact JSON, as Blockbench saves it. */
  toJson(): string {
    return JSON.stringify(this.data);
  }

  model(): BlockbenchModel {
    return parseBbmodel(this.data, this.fallbackName);
  }

  // --- lookup -------------------------------------------------------------------------

  private get outliner(): unknown[] {
    return this.data.outliner as unknown[];
  }

  private get elements(): Node[] {
    return this.data.elements as Node[];
  }

  private *walk(nodes: unknown[], parent: Node | undefined): Generator<[Node, Node | undefined]> {
    for (const node of nodes) {
      if (!isNode(node)) continue;
      yield [node, parent];
      yield* this.walk(Array.isArray(node.children) ? node.children : [], node);
    }
  }

  /** The group's data (name, origin, rotation) for an outliner node. */
  private group(node: Node): Node {
    return this.groupData.get(String(node.uuid)) ?? node;
  }

  /** Outliner node of the group `name` and its parent node (undefined at top level). */
  private find(name: string): [Node, Node | undefined] {
    for (const [node, parent] of this.walk(this.outliner, undefined)) {
      if (this.group(node).name === name) return [node, parent];
    }
    throw new RangeError(`no group named '${name}'`);
  }

  private element(id: string): Node {
    const found = this.elements.find((element) => element.uuid === id);
    if (!found) throw new RangeError(`no element with id '${id}'`);
    return found;
  }

  topLevelGroups(): string[] {
    return this.outliner.filter(isNode).map((node) => String(this.group(node).name));
  }

  private names(): Set<string> {
    const names = new Set<string>();
    for (const [node] of this.walk(this.outliner, undefined)) names.add(String(this.group(node).name ?? ""));
    for (const element of this.elements) names.add(String(element.name ?? ""));
    return names;
  }

  uniqueName(base: string): string {
    const taken = this.names();
    if (!taken.has(base)) return base;
    let index = 2;
    while (taken.has(`${base} ${index}`)) index++;
    return `${base} ${index}`;
  }

  cubes(name: string): EditorCube[] {
    const [node] = this.find(name);
    const ids = new Set(childList(node).filter((child) => typeof child === "string"));
    return this.elements
      .filter((element) => ids.has(element.uuid as string) && Array.isArray(element.from))
      .map((element) => ({
        id: String(element.uuid),
        from: element.from as Vec3,
        to: element.to as Vec3,
      }));
  }

  /** The project's Blockbench IK nulls. */
  nullObjects(): Node[] {
    return this.elements.filter((element) => element.type === "null_object");
  }

  hasIk(chainRoot: string): boolean {
    const root = this.groupUuid(chainRoot);
    return this.nullObjects().some((object) => object.ik_source === root);
  }

  private groupUuid(name: string): string {
    return String(this.find(name)[0].uuid);
  }

  // --- structure ------------------------------------------------------------------------

  private childrenOf(parent: Node | undefined): unknown[] {
    return parent ? childList(parent) : this.outliner;
  }

  move(name: string, newParent: string | undefined): void {
    const [node, parent] = this.find(name);
    const siblings = this.childrenOf(parent);
    siblings.splice(siblings.indexOf(node), 1);
    const target = newParent === undefined ? undefined : this.find(newParent)[0];
    this.childrenOf(target).push(node);
  }

  setPivot(name: string, pivot: Vec3): void {
    this.group(this.find(name)[0]).origin = [...pivot];
  }

  addGroup(name: string, parent: string | undefined, pivot: Vec3, like: string): void {
    const template = structuredClone(this.group(this.find(like)[0]));
    Object.assign(template, { name, uuid: this.newUuid(), origin: [...pivot], rotation: [0, 0, 0] });
    delete template.children;
    let node: Node;
    if (this.layout5) {
      (this.data.groups as Node[]).push(template);
      this.groupData.set(String(template.uuid), template);
      node = { uuid: template.uuid, isOpen: true, children: [] };
    } else {
      node = { ...template, children: [] };
    }
    const target = parent === undefined ? undefined : this.find(parent)[0];
    this.childrenOf(target).push(node);
  }

  moveElement(id: string, newParent: string): void {
    for (const [node] of this.walk(this.outliner, undefined)) {
      const children = childList(node);
      const index = children.indexOf(id);
      if (index !== -1) children.splice(index, 1);
    }
    childList(this.find(newParent)[0]).push(id);
  }

  // --- geometry -------------------------------------------------------------------------

  /** Both halves switch to per-face UV so the texture layout no longer depends on size. */
  splitCube(id: string, y: number, lowerParent: string): string {
    const upper = this.element(id);
    const from = upper.from as number[];
    const to = upper.to as number[];
    const fraction = (to[1]! - y) / (to[1]! - from[1]!); // of the side faces, from the top
    const lower = structuredClone(upper);
    lower.uuid = this.newUuid();
    lower.name = upper.name ?? "cube";
    from[1] = y;
    (lower.to as number[])[1] = y;
    upper.box_uv = false;
    lower.box_uv = false;
    if (isNode(upper.faces) && isNode(lower.faces)) {
      splitFaceUvs(
        upper.faces as Record<string, { uv?: number[] }>,
        lower.faces as Record<string, { uv?: number[] }>,
        fraction,
      );
    }
    this.elements.push(lower);
    childList(this.find(lowerParent)[0]).push(lower.uuid);
    return String(lower.uuid);
  }

  addLocator(name: string, position: Vec3, parent: string): string {
    const locator = {
      name,
      position: [...position],
      rotation: [0, 0, 0],
      ignore_inherited_scale: false,
      visibility: true,
      locked: false,
      scope: 0,
      uuid: this.newUuid(),
      type: "locator",
    };
    this.elements.push(locator);
    childList(this.find(parent)[0]).push(locator.uuid);
    return locator.uuid;
  }

  addNull(name: string, position: Vec3, parent: string, links: NullLinks = {}): string {
    const object = {
      name,
      position: [...position],
      ik_target: links.target ?? "",
      ik_source: links.source !== undefined ? this.groupUuid(links.source) : "",
      ik_pole: links.pole ?? "",
      lock_ik_target_rotation: false,
      visibility: true,
      locked: false,
      scope: 0,
      uuid: this.newUuid(),
      type: "null_object",
    };
    this.elements.push(object);
    childList(this.find(parent)[0]).push(object.uuid);
    return object.uuid;
  }
}

/** Parse the text of a `.bbmodel` file for editing. */
export function parseDocument(text: string, fallbackName: string, path?: string): BbmodelDocument {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TargetModelError(`not valid JSON: ${reason}`, { path });
  }
  try {
    return new BbmodelDocument(data, fallbackName);
  } catch (error) {
    if (error instanceof TargetModelError) throw new TargetModelError(error.detail, { path });
    throw error;
  }
}
