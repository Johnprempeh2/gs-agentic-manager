/** Route prefixes typed one per line; blank lines are dropped. */
export function parseLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Collections typed with commas or spaces. */
export function parseCollections(value: string): string[] {
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}
