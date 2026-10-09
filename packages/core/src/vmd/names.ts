/**
 * Shift-JIS (cp932) handling for fixed-width VMD name fields.
 *
 * VMD stores names in fixed byte fields (15 bytes for bones and morphs). Long names are
 * cut at the byte level, which can split a two-byte character. Matching user-supplied
 * names therefore goes through the same encode → truncate → decode round-trip.
 *
 * Decoding uses the platform's `shift_jis` decoder (the WHATWG one, which is cp932).
 * There is no platform encoder, so the reverse table is built once by decoding every
 * one- and two-byte sequence.
 */

export const BONE_NAME_BYTES = 15;
export const MODEL_NAME_BYTES = 20;

let strictDecoder: TextDecoder | undefined;
let looseDecoder: TextDecoder | undefined;
let encodeTable: Map<string, number> | undefined;

function strict(): TextDecoder {
  return (strictDecoder ??= new TextDecoder("shift_jis", { fatal: true }));
}

/** Decode a NUL-terminated cp932 field, dropping a dangling half character. */
export function decodeName(raw: Uint8Array): string {
  const nul = raw.indexOf(0);
  const data = nul === -1 ? raw : raw.subarray(0, nul);
  for (let end = data.length; end > Math.max(data.length - 2, -1); end--) {
    try {
      return strict().decode(data.subarray(0, end));
    } catch {
      continue;
    }
  }
  return (looseDecoder ??= new TextDecoder("shift_jis")).decode(data);
}

function isLeadByte(byte: number): boolean {
  return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
}

function buildEncodeTable(): Map<string, number> {
  const table = new Map<string, number>();
  const decoder = strict();
  const add = (bytes: number[], code: number): void => {
    let text: string;
    try {
      text = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    // One character only, and the first byte sequence found for it wins.
    if ([...text].length === 1 && !table.has(text)) table.set(text, code);
  };
  for (let byte = 0; byte < 0x80; byte++) add([byte], byte);
  for (let byte = 0xa1; byte <= 0xdf; byte++) add([byte], byte); // half-width katakana
  // cp932 holds some characters twice. Like Windows, prefer the JIS rows, then the IBM
  // extension rows (0xFA-0xFC), and only then NEC's copies (0x87, 0xED-0xEE).
  const leads: number[] = [];
  for (let lead = 0x81; lead <= 0xfc; lead++) if (isLeadByte(lead)) leads.push(lead);
  const late = new Set([0x87, 0xed, 0xee]);
  const ordered = [...leads.filter((l) => !late.has(l)), ...leads.filter((l) => late.has(l))];
  for (const lead of ordered) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail !== 0x7f) add([lead, trail], (lead << 8) | trail);
    }
  }
  return table;
}

/** `name` as cp932 bytes; throws when a character has no Shift-JIS form. */
export function encodeText(name: string): Uint8Array {
  const table = (encodeTable ??= buildEncodeTable());
  const bytes: number[] = [];
  for (const character of name) {
    const code = table.get(character);
    if (code === undefined) {
      throw new RangeError(`name '${name}' cannot be represented in Shift-JIS (cp932)`);
    }
    if (code > 0xff) bytes.push(code >> 8, code & 0xff);
    else bytes.push(code);
  }
  return Uint8Array.from(bytes);
}

/** Encode `name` into a NUL-padded `width`-byte field (truncating like MMD does). */
export function encodeName(name: string, width: number): Uint8Array {
  const field = new Uint8Array(width);
  field.set(encodeText(name).subarray(0, width));
  return field;
}

/** The name as it would read back from a VMD bone field (for matching). */
export function canonicalBoneName(name: string): string {
  try {
    return decodeName(encodeName(name, BONE_NAME_BYTES));
  } catch {
    return name;
  }
}
