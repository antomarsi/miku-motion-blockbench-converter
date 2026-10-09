/**
 * Put a Minecraft skin on the template model.
 *
 * The template's texture is 64x128: the top 64x64 is exactly the Minecraft skin layout and
 * the bottom half holds the template's extras (hair styles, skirt, tie, cuffs). Applying a
 * skin replaces the top half and keeps the extras.
 *
 * - legacy 64x32 skins are upgraded the way Minecraft does: the left arm and leg become
 *   mirrored copies of the right ones, and the missing overlay layers stay empty
 * - slim ("Alex", 3 px arms) skins are detected and get the slim template
 *
 * Works on raw RGBA pixels; decoding and encoding PNG files is the caller's job (a
 * canvas in the plugin, a small codec in the CLI).
 */

import { InputFormatError, MikuMotionError } from "../errors";

export const SKIN_SIZE = 64;

/** RGBA pixels, row by row from the top-left. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** `4 * width * height` bytes. */
  readonly data: Uint8Array;
}

type Box = readonly [x0: number, y0: number, x1: number, y1: number];

const RIGHT_LEG: readonly [number, number] = [0, 16];
const LEFT_LEG: readonly [number, number] = [16, 48];
const RIGHT_ARM: readonly [number, number] = [40, 16];
const LEFT_ARM: readonly [number, number] = [32, 48];

/** Pixel rectangles of a box's faces in the Minecraft layout. */
function faceBoxes(u: number, v: number, w: number, h: number, d: number): Record<string, Box> {
  return {
    up: [u + d, v, u + d + w, v + d],
    down: [u + d + w, v, u + d + 2 * w, v + d],
    east: [u, v + d, u + d, v + d + h],
    north: [u + d, v + d, u + d + w, v + d + h],
    west: [u + d + w, v + d, u + 2 * d + w, v + d + h],
    south: [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
  };
}

/** Copy a 4x12x4 limb as its mirror image (what Minecraft does for legacy skins). */
function mirrorBox(pixels: Pixels, source: readonly [number, number], target: readonly [number, number]): void {
  const src = faceBoxes(source[0], source[1], 4, 12, 4);
  const dst = faceBoxes(target[0], target[1], 4, 12, 4);
  const swap: Record<string, string> = { east: "west", west: "east" };
  const { data, width } = pixels;
  for (const [face, [x0, y0, x1, y1]] of Object.entries(dst)) {
    const [, sy0, sx1] = src[swap[face] ?? face]!;
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < x1 - x0; x++) {
        const from = 4 * ((sy0 + y) * width + (sx1 - 1 - x)); // flipped left to right
        const to = 4 * ((y0 + y) * width + (x0 + x));
        data.copyWithin(to, from, from + 4);
      }
    }
  }
}

/** A 64x64 RGBA skin; 64x32 legacy skins are upgraded. `path` is for error messages. */
export function normalizeSkin(pixels: Pixels, path?: string): Pixels {
  const { width, height } = pixels;
  if (width !== SKIN_SIZE || (height !== 32 && height !== SKIN_SIZE)) {
    throw new InputFormatError(
      `not a Minecraft skin (${width}x${height}; expected 64x64 or 64x32)`,
      { path },
    );
  }
  if (height === SKIN_SIZE) return { width, height, data: pixels.data.slice() };
  const skin: Pixels = {
    width: SKIN_SIZE,
    height: SKIN_SIZE,
    data: new Uint8Array(4 * SKIN_SIZE * SKIN_SIZE),
  };
  skin.data.set(pixels.data);
  mirrorBox(skin, RIGHT_LEG, LEFT_LEG);
  mirrorBox(skin, RIGHT_ARM, LEFT_ARM);
  return skin;
}

/** Slim skins leave the outer 2 columns of the right arm's area transparent. */
export function isSlim(skin: Pixels): boolean {
  for (let y = 20; y < 32; y++) {
    for (let x = 54; x < 56; x++) {
      if (skin.data[4 * (y * skin.width + x) + 3] !== 0) return false;
    }
  }
  return true;
}

/**
 * The template's texture with its Minecraft area replaced by `skin` (a normalised 64x64
 * skin). The extras below it are kept.
 */
export function applySkin(texture: Pixels, skin: Pixels): Pixels {
  if (texture.width < SKIN_SIZE || texture.height < SKIN_SIZE) {
    throw new MikuMotionError("the template's texture is smaller than a Minecraft skin");
  }
  const data = texture.data.slice();
  for (let y = 0; y < SKIN_SIZE; y++) {
    const row = skin.data.subarray(4 * y * SKIN_SIZE, 4 * (y + 1) * SKIN_SIZE);
    data.set(row, 4 * y * texture.width);
  }
  return { width: texture.width, height: texture.height, data };
}
