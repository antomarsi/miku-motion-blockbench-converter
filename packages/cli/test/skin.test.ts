import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { applySkin, InputFormatError, isSlim, normalizeSkin, type Pixels } from "@miku-motion/core";

import { makeSkinnedModel } from "../src/commands/model";
import { decodePng, encodePng } from "../src/png";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKINS = resolve(ROOT, "reference/skins");

interface SkinCase {
  size: [number, number];
  slim: boolean;
  skin_rgba: string;
  template: string;
  texture_size: [number, number];
  texture_rgba: string;
  texture_name: string;
  model_name: string;
}
const expected = JSON.parse(readFileSync(resolve(SKINS, "expected.json"), "utf8")) as Record<string, SkinCase>;
const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));
const skinFile = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(SKINS, `${name}.png`)));

describe("skins match the Python version", () => {
  it.each(Object.keys(expected))("%s", (name) => {
    const want = expected[name]!;
    const raw = decodePng(skinFile(name));
    expect([raw.width, raw.height]).toEqual(want.size);
    const skin = normalizeSkin(raw);
    expect(Buffer.from(skin.data).equals(Buffer.from(bytes(want.skin_rgba)))).toBe(true);
    expect(isSlim(skin)).toBe(want.slim);

    const result = makeSkinnedModel(skinFile(name), `${name}.png`, resolve(ROOT, "templates"), name);
    expect(result.slim).toBe(want.slim);
    expect([result.pixels.width, result.pixels.height]).toEqual(want.texture_size);
    expect(Buffer.from(result.pixels.data).equals(Buffer.from(bytes(want.texture_rgba)))).toBe(true);
    const document = JSON.parse(result.model) as { name: string; textures: { name: string; source: string }[] };
    expect(document.name).toBe(want.model_name);
    expect(document.textures[0]!.name).toBe(want.texture_name);
    // The embedded texture and the separate PNG are the same picture.
    const embedded = decodePng(bytes(document.textures[0]!.source.split(",")[1]!));
    expect(Buffer.from(embedded.data).equals(Buffer.from(result.pixels.data))).toBe(true);
    expect(Buffer.from(decodePng(result.texture).data).equals(Buffer.from(result.pixels.data))).toBe(true);
  });
});

function png(width: number, height: number, color: number, rows: number[][], extra: [string, number[]][] = []): Uint8Array {
  const chunk = (kind: string, body: number[] | Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(kind, 4, "latin1");
    Buffer.from(body).copy(out, 8);
    return out; // the reader doesn't check the CRC
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, color, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      ...extra.map(([kind, body]) => chunk(kind, body)),
      chunk("IDAT", deflateSync(Buffer.from(rows.flat()))),
      chunk("IEND", []),
    ]),
  );
}

describe("PNG codec", () => {
  it("round-trips RGBA pixels", () => {
    const pixels: Pixels = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) % 256) };
    const decoded = decodePng(encodePng(pixels));
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect(Array.from(decoded.data)).toEqual(Array.from(pixels.data));
  });

  it("reads palette, grey and RGB images, and every row filter", () => {
    const palette = decodePng(png(2, 1, 3, [[0, 1, 0]], [["PLTE", [10, 20, 30, 40, 50, 60]], ["tRNS", [255, 7]]]));
    expect(Array.from(palette.data)).toEqual([40, 50, 60, 7, 10, 20, 30, 255]);
    expect(Array.from(decodePng(png(2, 1, 0, [[0, 5, 9]])).data)).toEqual([5, 5, 5, 255, 9, 9, 9, 255]);
    expect(Array.from(decodePng(png(1, 1, 4, [[0, 5, 9]])).data)).toEqual([5, 5, 5, 9]);
    expect(Array.from(decodePng(png(1, 1, 2, [[0, 1, 2, 3]])).data)).toEqual([1, 2, 3, 255]);
    // Sub, Up, Average and Paeth filters on a 2x? grey image.
    const filtered = decodePng(png(2, 4, 0, [[1, 10, 5], [2, 1, 1], [3, 2, 2], [4, 3, 1]]));
    const grey = Array.from({ length: 8 }, (_, i) => filtered.data[4 * i]);
    expect(grey).toEqual([10, 15, 11, 16, 7, 13, 10, 14]);
  });

  it("explains unusable files", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]), "x.png")).toThrow(/x\.png: not a PNG image/);
    const sixteenBit = png(1, 1, 0, [[0, 0, 0]]);
    sixteenBit[24] = 16;
    expect(() => decodePng(sixteenBit)).toThrow(/unsupported PNG/);
    expect(() => decodePng(png(4, 4, 6, [[0, 1]]))).toThrow(/corrupt PNG image data/);
  });
});

describe("skin handling", () => {
  it("rejects images that are not skins and textures that are too small", () => {
    const tiny: Pixels = { width: 16, height: 16, data: new Uint8Array(4 * 256) };
    expect(() => normalizeSkin(tiny, "tiny.png")).toThrow(InputFormatError);
    expect(() => normalizeSkin(tiny, "tiny.png")).toThrow(/tiny\.png: not a Minecraft skin \(16x16/);
    const skin: Pixels = { width: 64, height: 64, data: new Uint8Array(4 * 64 * 64) };
    expect(() => applySkin(tiny, skin)).toThrow(/smaller than a Minecraft skin/);
  });

  it("lets the arm width be forced", () => {
    const templates = resolve(ROOT, "templates");
    expect(makeSkinnedModel(skinFile("classic"), "c.png", templates, "c", "slim").slim).toBe(true);
    expect(makeSkinnedModel(skinFile("slim"), "s.png", templates, "s", "classic").slim).toBe(false);
  });
});
