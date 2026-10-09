/** Small text helpers shared by diagnostics and error messages. */

/** Code-unit order, so lists read the same on every machine (no locale). */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const LIST_LIMIT = 12;

/** A comma-separated list, cut after a dozen names. */
export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LIST_LIMIT).join(", ");
  return shown + (names.length > LIST_LIMIT ? ` (+${names.length - LIST_LIMIT} more)` : "");
}

/** Shell-style pattern match (`*`, `?`, `[abc]`, `[!abc]`), case-sensitive. */
export function globMatch(name: string, pattern: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      source += ".*";
    } else if (c === "?") {
      source += ".";
    } else if (c === "[") {
      const end = pattern.indexOf("]", pattern[i + 1] === "!" ? i + 3 : i + 2);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      else if (body.startsWith("^")) body = `\\${body}`;
      source += `[${body}]`;
      i = end;
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^(?:${source})$`, "su").test(name);
}

/** Total length of the matching blocks of `a` and `b` (Ratcliff/Obershelp). */
function matchingLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let bestA = 0;
  let bestB = 0;
  let bestSize = 0;
  // Longest common substring, by dynamic programming over one row.
  let previous = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const size = previous[j - 1]! + 1;
        row[j] = size;
        if (size > bestSize) {
          bestSize = size;
          bestA = i - size;
          bestB = j - size;
        }
      }
    }
    previous = row;
  }
  if (!bestSize) return 0;
  return (
    bestSize +
    matchingLength(a.slice(0, bestA), b.slice(0, bestB)) +
    matchingLength(a.slice(bestA + bestSize), b.slice(bestB + bestSize))
  );
}

/** Similarity in `[0, 1]`: twice the matching characters over the total length. */
export function similarity(a: string, b: string): number {
  const total = a.length + b.length;
  return total ? (2 * matchingLength(a, b)) / total : 1;
}

/** The candidate most similar to `name`, if any is similar enough to be a likely typo. */
export function closestMatch(
  name: string,
  candidates: readonly string[],
  cutoff = 0.6,
): string | undefined {
  let best: string | undefined;
  let bestScore = cutoff;
  for (const candidate of candidates) {
    const score = similarity(name, candidate);
    if (score >= bestScore && (best === undefined || score > bestScore)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
