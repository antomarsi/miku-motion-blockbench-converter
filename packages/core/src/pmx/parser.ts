/**
 * Binary PMX 2.0 / 2.1 reader: only what a motion needs from its model.
 *
 * A motion file assumes its model's skeleton but doesn't contain it. From a `.pmx` this
 * reads the bones (tree, rest positions, inherited rotations, IK chains) and the morph
 * names. Geometry, materials and physics are skipped and never loaded.
 *
 * Layout: header, vertices, faces, textures, materials, bones, morphs, (display frames,
 * rigid bodies, joints: not read). Everything before the bones is skipped; its records
 * have variable sizes, so they still have to be walked.
 *
 * Index sizes (1, 2 or 4 bytes) come from the header. Vertex indices are unsigned when 1
 * or 2 bytes wide; every other index is signed, with -1 meaning "none".
 */

import { InputFormatError } from "../errors";
import type { Vec3 } from "../geometry/quat";

// Bone flags.
const TAIL_IS_BONE = 0x0001;
const HAS_IK = 0x0020;
const INHERIT_ROTATION = 0x0100;
const INHERIT_TRANSLATION = 0x0200;
const FIXED_AXIS = 0x0400;
const LOCAL_AXES = 0x0800;
const EXTERNAL_PARENT = 0x2000;

// Vertex deform types (BDEF1, BDEF2, BDEF4, SDEF, QDEF): how many bone indices each one
// starts with, and the bytes after them.
const DEFORM: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 4],
  [4, 16],
  [2, 40],
  [4, 16],
];

export const MORPH_PANELS: Readonly<Record<number, string>> = {
  0: "system",
  1: "brow",
  2: "eye",
  3: "mouth",
  4: "other",
};

export interface PmxIkLink {
  readonly bone: number;
  /** Radians; undefined = unlimited. */
  readonly minAngles: Vec3 | undefined;
  readonly maxAngles: Vec3 | undefined;
}

export interface PmxIk {
  readonly target: number;
  readonly iterations: number;
  /** Radians per link per iteration. */
  readonly limitAngle: number;
  readonly links: readonly PmxIkLink[];
}

export interface PmxBone {
  readonly name: string;
  readonly position: Vec3;
  /** -1 = none. */
  readonly parent: number;
  /** `[bone index, weight]`. */
  readonly inheritRotation: readonly [number, number] | undefined;
  readonly ik: PmxIk | undefined;
}

export interface PmxMorph {
  readonly name: string;
  /** See `MORPH_PANELS`. */
  readonly panel: number;
}

export interface PmxModel {
  readonly name: string;
  readonly bones: readonly PmxBone[];
  readonly morphs: readonly PmxMorph[];
}

class Reader {
  offset = 0;
  private readonly view: DataView;
  private decoder = new TextDecoder("utf-16le");

  constructor(
    private readonly data: Uint8Array,
    private readonly path: string | undefined,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  useUtf8(): void {
    this.decoder = new TextDecoder("utf-8");
  }

  fail(message: string): InputFormatError {
    return new InputFormatError(message, { path: this.path, offset: this.offset });
  }

  /** Reserve `size` bytes and return where they start. */
  take(size: number, what: string): number {
    if (size < 0 || this.offset + size > this.data.length) {
      throw this.fail(`file ends inside ${what}`);
    }
    const start = this.offset;
    this.offset += size;
    return start;
  }

  u8(what: string): number {
    return this.view.getUint8(this.take(1, what));
  }

  u16(what: string): number {
    return this.view.getUint16(this.take(2, what), true);
  }

  i32(what: string): number {
    return this.view.getInt32(this.take(4, what), true);
  }

  f32(what: string): number {
    return this.view.getFloat32(this.take(4, what), true);
  }

  vec3(what: string): Vec3 {
    return [this.f32(what), this.f32(what), this.f32(what)];
  }

  count(what: string): number {
    const value = this.i32(`the ${what} count`);
    if (value < 0) throw this.fail(`negative ${what} count (${value})`);
    return value;
  }

  /** A signed index of `size` bytes. */
  index(size: number, what: string): number {
    const start = this.take(size, what);
    if (size === 1) return this.view.getInt8(start);
    if (size === 2) return this.view.getInt16(start, true);
    return this.view.getInt32(start, true);
  }

  text(what: string): string {
    const size = this.count(`${what} length`);
    const start = this.take(size, what);
    return this.decoder.decode(this.data.subarray(start, start + size));
  }
}

export function parsePmx(data: Uint8Array, path?: string): PmxModel {
  const r = new Reader(data, path);
  if (data.length < 4 || String.fromCharCode(...data.subarray(0, 4)) !== "PMX ") {
    throw new InputFormatError("not a PMX file (it doesn't start with 'PMX ')", {
      path,
      hint: "older .pmd models aren't supported; convert them to .pmx with PMXEditor",
    });
  }
  r.take(4, "the header");
  const version = r.f32("the version");
  if (!(version > 1.9 && version < 2.2)) {
    throw r.fail(
      `unsupported PMX version ${Number(version.toFixed(3))} (2.0 and 2.1 are supported)`,
    );
  }
  const globalsCount = r.u8("the header");
  if (globalsCount < 8) {
    throw r.fail(`the header lists ${globalsCount} settings, expected at least 8`);
  }
  const settings: number[] = [];
  for (let i = 0; i < globalsCount; i++) settings.push(r.u8("the header"));
  if (settings[0] !== 0) r.useUtf8();
  const [extraUvs, vertexSize, textureSize, materialSize, boneSize, morphSize, bodySize] =
    settings.slice(1, 8) as [number, number, number, number, number, number, number];
  for (const size of [vertexSize, textureSize, materialSize, boneSize, morphSize, bodySize]) {
    if (size !== 1 && size !== 2 && size !== 4) {
      throw r.fail(`invalid index size ${size} in the header`);
    }
  }

  const name = r.text("the model name");
  for (const what of ["the English name", "the comment", "the English comment"]) r.text(what);

  for (let n = r.count("vertex"); n > 0; n--) {
    r.take(4 * (8 + 4 * extraUvs), "a vertex");
    const deform = DEFORM[r.u8("a vertex")];
    if (!deform) throw r.fail("unknown vertex deform type");
    r.take(deform[0] * boneSize + deform[1] + 4, "a vertex");
  }
  r.take(r.count("face index") * vertexSize, "the faces");
  for (let n = r.count("texture"); n > 0; n--) r.text("a texture path");
  for (let n = r.count("material"); n > 0; n--) {
    r.text("a material name");
    r.text("a material name");
    r.take(4 * 11 + 1 + 4 * 5 + 2 * textureSize + 1, "a material");
    const sharedToon = r.u8("a material");
    r.take(sharedToon ? 1 : textureSize, "a material");
    r.text("a material memo");
    r.take(4, "a material");
  }

  const bones: PmxBone[] = [];
  const boneCount = r.count("bone");
  for (let number = 0; number < boneCount; number++) {
    const what = `bone ${number}`;
    const boneName = r.text(what);
    r.text(what);
    const position = r.vec3(what);
    const parent = r.index(boneSize, what);
    r.take(4, what); // deform layer
    const flags = r.u16(what);
    r.take(flags & TAIL_IS_BONE ? boneSize : 12, what);
    let inheritRotation: [number, number] | undefined;
    if (flags & (INHERIT_ROTATION | INHERIT_TRANSLATION)) {
      const source = r.index(boneSize, what);
      const weight = r.f32(what);
      if (flags & INHERIT_ROTATION) inheritRotation = [source, weight];
    }
    if (flags & FIXED_AXIS) r.take(12, what);
    if (flags & LOCAL_AXES) r.take(24, what);
    if (flags & EXTERNAL_PARENT) r.take(4, what);
    let ik: PmxIk | undefined;
    if (flags & HAS_IK) {
      const target = r.index(boneSize, what);
      const iterations = r.i32(what);
      const limitAngle = r.f32(what);
      const links: PmxIkLink[] = [];
      for (let n = r.count(`${what} IK link`); n > 0; n--) {
        const bone = r.index(boneSize, what);
        if (r.u8(what)) {
          const minAngles = r.vec3(what);
          links.push({ bone, minAngles, maxAngles: r.vec3(what) });
        } else {
          links.push({ bone, minAngles: undefined, maxAngles: undefined });
        }
      }
      ik = { target, iterations, limitAngle, links };
    }
    bones.push({ name: boneName, position, parent, inheritRotation, ik });
  }

  // Bytes per offset record of each morph type; UV morphs (3..7) share one layout.
  const offsetSizes: Record<number, number> = {
    0: morphSize + 4,
    1: vertexSize + 12,
    2: boneSize + 28,
    8: materialSize + 1 + 112,
    9: morphSize + 4,
    10: bodySize + 1 + 24,
  };
  const morphs: PmxMorph[] = [];
  const morphCount = r.count("morph");
  for (let number = 0; number < morphCount; number++) {
    const what = `morph ${number}`;
    const morphName = r.text(what);
    r.text(what);
    const panel = r.u8(what);
    const kind = r.u8(what);
    if (kind > 10) throw r.fail(`unknown morph type ${kind}`);
    r.take(r.count(`${what} offset`) * (offsetSizes[kind] ?? vertexSize + 16), what);
    morphs.push({ name: morphName, panel });
  }
  return { name, bones, morphs };
}
