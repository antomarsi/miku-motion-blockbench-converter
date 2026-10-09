/** Plain-text tables that line up with full-width (CJK) characters in a terminal. */

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK, kana, radicals
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compatibility forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // full-width forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Columns `text` takes in a terminal. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += isWide(character.codePointAt(0)!) ? 2 : 1;
  return width;
}

function pad(text: string, width: number, right: boolean): string {
  const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
  return right ? fill + text : text + fill;
}

export interface Column {
  readonly title: string;
  readonly alignRight?: boolean;
}

export function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const widths = columns.map((column, i) =>
    Math.max(displayWidth(column.title), ...rows.map((row) => displayWidth(row[i] ?? ""))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => pad(cell, widths[i]!, columns[i]!.alignRight ?? false))
      .join("  ")
      .trimEnd();
  return [
    line(columns.map((c) => c.title)),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}
