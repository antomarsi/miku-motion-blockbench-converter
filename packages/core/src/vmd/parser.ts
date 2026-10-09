/**
 * Binary VMD reader.
 *
 * Layout (little-endian), after a 30-byte magic and a model-name field:
 *
 * - bone keys:   u32 count, then 111-byte records
 *   (name[15], u32 frame, f32 pos[3], f32 quat xyzw[4], u8 interpolation[64])
 * - morph keys:  u32 count, then 23-byte records (name[15], u32 frame, f32 weight)
 * - camera keys: u32 count, 61-byte records   (counted only)
 * - light keys:  u32 count, 28-byte records   (counted only)
 * - shadow keys: u32 count, 9-byte records    (counted only)
 * - show/IK keys: u32 count, then (u32 frame, u8 show, u32 n, n x (name[20], u8 enabled))
 *
 * Files written by older tools end early; a section missing entirely at end-of-file
 * counts as empty. A section that starts but is cut short is an error.
 */

import { InputFormatError } from "../errors";
import { BONE_NAME_BYTES, MODEL_NAME_BYTES, decodeName } from "./names";
import { INTERPOLATION_BYTES, emptyVmd, type VmdFile, type VmdIkState } from "./types";

export const MAGIC_V2 = "Vocaloid Motion Data 0002";
export const MAGIC_V1 = "Vocaloid Motion Data file";
export const MAGIC_BYTES = 30;
export const MODEL_NAME_BYTES_V1 = 10;
export const IK_NAME_BYTES = 20;

export const BONE_RECORD_BYTES = BONE_NAME_BYTES + 4 + 12 + 16 + INTERPOLATION_BYTES;
export const MORPH_RECORD_BYTES = BONE_NAME_BYTES + 4 + 4;
const SKIPPED_SECTIONS: readonly (readonly [string, number])[] = [
  ["camera", 61],
  ["light", 28],
  ["self-shadow", 9],
];
const HINT = "the file may be truncated or not a VMD motion; try re-exporting it from MMD";

class Reader {
  offset = 0;
  private readonly view: DataView;

  constructor(
    private readonly data: Uint8Array,
    private readonly path: string | undefined,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get atEnd(): boolean {
    return this.offset >= this.data.length;
  }

  /** Reserve `size` bytes and return where they start. */
  take(size: number, what: string): number {
    if (this.offset + size > this.data.length) {
      throw new InputFormatError(`unexpected end of file while reading ${what}`, {
        path: this.path,
        offset: this.offset,
        hint: HINT,
      });
    }
    const start = this.offset;
    this.offset += size;
    return start;
  }

  bytes(size: number, what: string): Uint8Array {
    const start = this.take(size, what);
    return this.data.subarray(start, start + size);
  }

  u32(what: string): number {
    return this.view.getUint32(this.take(4, what), true);
  }

  u8(what: string): number {
    return this.data[this.take(1, what)]!;
  }

  u32At(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  f32At(offset: number): number {
    return this.view.getFloat32(offset, true);
  }

  slice(start: number, size: number): Uint8Array {
    return this.data.subarray(start, start + size);
  }

  /** Read a section's record count, or undefined if the file ends before the section. */
  sectionCount(name: string): number | undefined {
    return this.atEnd ? undefined : this.u32(`${name} key count`);
  }
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** Parse VMD bytes. `path` is used only for error messages. */
export function parseVmd(data: Uint8Array, path?: string): VmdFile {
  const reader = new Reader(data, path);
  const header = reader.bytes(MAGIC_BYTES, "header");
  const nul = header.indexOf(0);
  const magic = latin1(nul === -1 ? header : header.subarray(0, nul));
  let version: number;
  let nameBytes: number;
  if (magic === MAGIC_V2) {
    version = 2;
    nameBytes = MODEL_NAME_BYTES;
  } else if (magic === MAGIC_V1) {
    version = 1;
    nameBytes = MODEL_NAME_BYTES_V1;
  } else {
    throw new InputFormatError(`not a VMD motion file (header ${JSON.stringify(magic)})`, {
      path,
      offset: 0,
      hint: "expected a MikuMikuDance .vmd file",
    });
  }
  const vmd = emptyVmd(decodeName(reader.bytes(nameBytes, "model name")), version);

  let count = reader.sectionCount("bone") ?? 0;
  let start = reader.take(count * BONE_RECORD_BYTES, `${count} bone keyframes`);
  for (let i = 0; i < count; i++) {
    const o = start + i * BONE_RECORD_BYTES;
    const p = o + BONE_NAME_BYTES + 4;
    vmd.boneKeys.push({
      name: decodeName(reader.slice(o, BONE_NAME_BYTES)),
      frame: reader.u32At(o + BONE_NAME_BYTES),
      position: [reader.f32At(p), reader.f32At(p + 4), reader.f32At(p + 8)],
      rotation: [
        reader.f32At(p + 12),
        reader.f32At(p + 16),
        reader.f32At(p + 20),
        reader.f32At(p + 24),
      ],
      interpolation: reader.slice(p + 28, INTERPOLATION_BYTES).slice(),
    });
  }

  count = reader.sectionCount("morph") ?? 0;
  start = reader.take(count * MORPH_RECORD_BYTES, `${count} morph keyframes`);
  for (let i = 0; i < count; i++) {
    const o = start + i * MORPH_RECORD_BYTES;
    vmd.morphKeys.push({
      name: decodeName(reader.slice(o, BONE_NAME_BYTES)),
      frame: reader.u32At(o + BONE_NAME_BYTES),
      weight: reader.f32At(o + BONE_NAME_BYTES + 4),
    });
  }

  const counts: number[] = [];
  for (const [section, recordSize] of SKIPPED_SECTIONS) {
    const n = reader.sectionCount(section) ?? 0;
    reader.take(n * recordSize, `${n} ${section} keyframes`);
    counts.push(n);
  }
  [vmd.cameraKeyCount, vmd.lightKeyCount, vmd.shadowKeyCount] = counts as [number, number, number];

  count = reader.sectionCount("show/IK") ?? 0;
  for (let i = 0; i < count; i++) {
    const what = `show/IK keyframe ${i + 1} of ${count}`;
    const frame = reader.u32(what);
    const show = reader.u8(what) !== 0;
    const states: VmdIkState[] = [];
    const stateCount = reader.u32(what);
    for (let s = 0; s < stateCount; s++) {
      const name = decodeName(reader.bytes(IK_NAME_BYTES, what));
      states.push({ name, enabled: reader.u8(what) !== 0 });
    }
    vmd.showIkKeys.push({ frame, show, ik: states });
  }
  return vmd;
}
