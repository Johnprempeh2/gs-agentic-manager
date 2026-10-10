/**
 * Merge a user's saved section order with today's default order. Saved ids the
 * sidebar no longer has are dropped; sections added since the user last saved
 * land in their default slot (straight after the section that precedes them by
 * default), so a new release never hides a new section.
 */
export function mergeSectionOrder(defaults: readonly string[], stored: readonly string[]): string[] {
  const known = new Set(defaults);
  const order = [...new Set(stored)].filter((id) => known.has(id));
  defaults.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = index === 0 ? -1 : order.indexOf(defaults[index - 1]!);
    order.splice(before + 1, 0, id);
  });
  return order;
}

/** Move one id up (-1) or down (+1); a move past either end is a no-op. */
export function moveSection(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
