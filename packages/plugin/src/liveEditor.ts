/// <reference types="blockbench-types" />

/**
 * Model preparation applied to the open Blockbench project.
 *
 * The same `prepare` logic that edits a `.bbmodel` file in the CLI runs here against
 * live groups and cubes. The caller wraps the edits in one undo step (`editAspects`).
 */

import {
  splitFaceUvs,
  type BlockbenchModel,
  type EditorCube,
  type ModelEditor,
  type NullLinks,
  type Vec3,
} from "@miku-motion/core";

import { projectModel } from "./project";

const FACES = ["north", "east", "south", "west", "up", "down"] as const;

interface FaceCopy {
  uv?: number[];
  texture?: string | false | null;
  rotation?: number;
}

/** Blockbench's IK links on a null object, which the typings only partly list. */
type IkNull = NullObject & { ik_source?: string; ik_pole?: string };

function vec3(value: ArrayLike<number>): Vec3 {
  return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
}

/** What an undo step must save before and after preparing the model. */
export function editAspects(): UndoAspects {
  return { outliner: true, elements: Outliner.elements.slice() };
}

export class LiveEditor implements ModelEditor {
  model(): BlockbenchModel {
    return projectModel();
  }

  private group(name: string): Group {
    const found = Group.all.find((group) => group.name === name);
    if (!found) throw new RangeError(`no group named '${name}'`);
    return found;
  }

  private element(id: string): OutlinerElement {
    const found = Outliner.elements.find((element) => element.uuid === id);
    if (!found) throw new RangeError(`no element with id '${id}'`);
    return found;
  }

  topLevelGroups(): string[] {
    return Outliner.root.filter((node): node is Group => node instanceof Group).map((group) => group.name);
  }

  uniqueName(base: string): string {
    const taken = new Set([
      ...Group.all.map((group) => group.name),
      ...Outliner.elements.map((element) => element.name),
    ]);
    if (!taken.has(base)) return base;
    let index = 2;
    while (taken.has(`${base} ${index}`)) index++;
    return `${base} ${index}`;
  }

  addGroup(name: string, parent: string | undefined, pivot: Vec3, like: string): void {
    const template = this.group(like);
    const group = new Group({
      name,
      origin: [...pivot],
      rotation: [0, 0, 0],
      color: template.color,
      visibility: template.visibility,
      shade: template.shade,
      autouv: template.autouv,
      mirror_uv: template.mirror_uv,
    });
    group.addTo(parent === undefined ? "root" : this.group(parent)).init();
    group.isOpen = true;
  }

  move(name: string, newParent: string | undefined): void {
    // Cube positions are absolute, so nothing moves on screen.
    this.group(name).addTo(newParent === undefined ? "root" : this.group(newParent));
  }

  setPivot(name: string, pivot: Vec3): void {
    this.group(name).origin = [...pivot];
  }

  cubes(name: string): EditorCube[] {
    return this.group(name)
      .children.filter((child): child is Cube => child instanceof Cube)
      .map((cube) => ({ id: cube.uuid, from: vec3(cube.from), to: vec3(cube.to) }));
  }

  moveElement(id: string, newParent: string): void {
    this.element(id).addTo(this.group(newParent));
  }

  /** Both halves switch to per-face UV so the texture layout no longer depends on size. */
  splitCube(id: string, y: number, lowerParent: string): string {
    const upper = this.element(id);
    if (!(upper instanceof Cube)) throw new RangeError(`element '${id}' is not a cube`);
    const fraction = (upper.to[1] - y) / (upper.to[1] - upper.from[1]); // of the side faces, from the top
    upper.setUVMode(false);
    const lower = new Cube(upper as unknown as ICubeOptions);
    upper.from = [upper.from[0], y, upper.from[2]];
    lower.to = [lower.to[0], y, lower.to[2]];

    const copy = (cube: Cube): Record<string, FaceCopy> =>
      Object.fromEntries(
        FACES.filter((face) => cube.faces[face]).map((face) => {
          const { uv, texture, rotation } = cube.faces[face]!;
          return [face, { uv: [...uv], texture, rotation } as FaceCopy];
        }),
      );
    const upperFaces = copy(upper);
    const lowerFaces = copy(lower);
    splitFaceUvs(upperFaces, lowerFaces, fraction);
    for (const [cube, faces] of [[upper, upperFaces], [lower, lowerFaces]] as const) {
      for (const [face, data] of Object.entries(faces)) cube.faces[face]?.extend(data as CubeFaceOptions);
    }
    lower.addTo(this.group(lowerParent)).init();
    return lower.uuid;
  }

  hasIk(chainRoot: string): boolean {
    const root = this.group(chainRoot).uuid;
    return (NullObject.all as IkNull[]).some((object) => object.ik_source === root);
  }

  addLocator(name: string, position: Vec3, parent: string): string {
    const locator = new Locator({ name, position: [...position] } as Partial<LocatorOptions>);
    locator.addTo(this.group(parent)).init();
    return locator.uuid;
  }

  addNull(name: string, position: Vec3, parent: string, links: NullLinks = {}): string {
    const object = new NullObject({
      name,
      position: [...position],
      ik_target: links.target ?? "",
      ik_source: links.source !== undefined ? this.group(links.source).uuid : "",
      ik_pole: links.pole ?? "",
    } as Partial<NullObjectOptions>);
    object.addTo(this.group(parent)).init();
    return object.uuid;
  }
}
