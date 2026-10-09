/**
 * Minimal PNG reading and writing for skins (no image library needed).
 *
 * Reads 8-bit, non-interlaced PNGs in every colour type Minecraft skins use (grey, grey +
 * alpha, RGB, palette with optional transparency, RGBA) into RGBA pixels, and writes
 * RGBA PNGs.
 */

import { crc32, deflateSync, inflateSync } from "node:zlib";

import { InputFormatError, type Pixels } from "@miku-motion/core";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new RangeError("image data is too short");
  const out = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const kind = raw[pos]!;
    if (kind > 4) throw new RangeError(`unknown PNG filter ${kind}`);
    const line = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[line + x - bpp]! : 0;
      const up = y > 0 ? out[line - stride + x]! : 0;
      const corner = y > 0 && x >= bpp ? out[line - stride + x - bpp]! : 0;
      const value = raw[pos + 1 + x]!;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][kind]!;
      out[line + x] = (value + predicted) & 0xff;
    }
    pos += 1 + stride;
  }
  return out;
}

/** Decode PNG bytes into RGBA pixels. `path` is for error messages. */
export function decodePng(data: Uint8Array, path?: string): Pixels {
  if (data.length < SIGNATURE.length || SIGNATURE.some((byte, i) => data[i] !== byte)) {
    throw new InputFormatError("not a PNG image", { path });
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = SIGNATURE.length;
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | undefined;
  let palette: Uint8Array = new Uint8Array(0);
  let transparency: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  while (pos + 8 <= data.length) {
    const length = view.getUint32(pos);
    const kind = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
    const chunk = data.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (kind === "IHDR" && chunk.length >= 13) {
      header = {
        width: view.getUint32(chunk.byteOffset - data.byteOffset),
        height: view.getUint32(chunk.byteOffset - data.byteOffset + 4),
        depth: chunk[8]!,
        color: chunk[9]!,
        interlace: chunk[12]!,
      };
    } else if (kind === "PLTE") palette = chunk;
    else if (kind === "tRNS") transparency = chunk;
    else if (kind === "IDAT") idat.push(chunk);
    else if (kind === "IEND") break;
  }
  if (!header) throw new InputFormatError("PNG has no header", { path });
  const { width, height, depth, color, interlace } = header;
  const channels = CHANNELS[color];
  if (depth !== 8 || interlace !== 0 || channels === undefined) {
    throw new InputFormatError("unsupported PNG (needs 8-bit, non-interlaced)", {
      path,
      hint: "re-save the skin as a normal 8-bit RGBA PNG",
    });
  }
  let flat: Uint8Array;
  try {
    flat = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  } catch {
    throw new InputFormatError("corrupt PNG image data", { path });
  }
  const rgba = new Uint8Array(4 * width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const o = 4 * i;
    if (color === 3) {
      const index = flat[p]!;
      rgba[o] = palette[3 * index] ?? 0;
      rgba[o + 1] = palette[3 * index + 1] ?? 0;
      rgba[o + 2] = palette[3 * index + 2] ?? 0;
      rgba[o + 3] = transparency[index] ?? 255;
    } else if (color === 0 || color === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = flat[p]!;
      rgba[o + 3] = color === 4 ? flat[p + 1]! : 255;
    } else {
      rgba[o] = flat[p]!;
      rgba[o + 1] = flat[p + 1]!;
      rgba[o + 2] = flat[p + 2]!;
      rgba[o + 3] = color === 6 ? flat[p + 3]! : 255;
    }
  }
  return { width, height, data: rgba };
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = kind.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encode RGBA pixels as a PNG. */
export function encodePng(pixels: Pixels): Uint8Array {
  const { width, height, data } = pixels;
  const stride = 4 * width;
  const rows = new Uint8Array(height * (stride + 1)); // each row starts with filter 0
  for (let y = 0; y < height; y++) {
    rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const parts = [
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
