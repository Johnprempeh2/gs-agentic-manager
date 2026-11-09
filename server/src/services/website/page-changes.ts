// What a page's approved revision changes against the one live now (Puck data:
// `{ root: { props }, content: [{ type, props: { id, ... } }] }`), in words for a
// Publish card: "Added Hero "Welcome"", "Edited CardGrid: title, items".
type Block = { type?: unknown; props?: Record<string, unknown> };
type PuckData = { root?: { props?: Record<string, unknown> }; content?: Block[] };

function parse(body: string | null | undefined): PuckData | null {
  if (!body) return null;
  try {
    const data = JSON.parse(body) as PuckData;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function nameOf(block: Block) {
  const props = block.props ?? {};
  const heading = [props.title, props.heading, props.headline, props.eyebrow].find((v) => typeof v === "string" && v.trim());
  const type = typeof block.type === "string" ? block.type : "Section";
  return heading ? `${type} "${String(heading).trim().slice(0, 60)}"` : type;
}

function changedKeys(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => key !== "id" && JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

export interface PageChangeSummary {
  lines: string[];
  /** The id of the first added or edited block, for a link that scrolls to it. */
  firstChangedBlockId: string | null;
}

/** Compare the live body with the approved one. A page never published reads as new. */
export function describePageChanges(liveBody: string | null | undefined, nextBody: string | null | undefined): PageChangeSummary {
  const before = parse(liveBody);
  const after = parse(nextBody);
  if (!after) return { lines: [], firstChangedBlockId: null };
  if (!before) return { lines: ["New page: not on the live site yet"], firstChangedBlockId: null };
  const lines: string[] = [];
  let first: string | null = null;
  const idOf = (block: Block) => (typeof block.props?.id === "string" ? block.props.id : null);
  const oldById = new Map((before.content ?? []).flatMap((b) => (idOf(b) ? [[idOf(b)!, b] as const] : [])));
  const newIds = new Set((after.content ?? []).map(idOf).filter(Boolean));
  const rootKeys = changedKeys(before.root?.props, after.root?.props);
  if (rootKeys.length) lines.push(`Page settings: ${rootKeys.join(", ")}`);
  for (const block of after.content ?? []) {
    const id = idOf(block);
    const old = id ? oldById.get(id) : undefined;
    if (!old) {
      lines.push(`Added ${nameOf(block)}`);
      first ??= id;
      continue;
    }
    const keys = changedKeys(old.props, block.props);
    if (keys.length) {
      lines.push(`Edited ${nameOf(block)}: ${keys.join(", ")}`);
      first ??= id;
    }
  }
  for (const block of before.content ?? []) {
    const id = idOf(block);
    if (!id || !newIds.has(id)) lines.push(`Removed ${nameOf(block)}`);
  }
  const order = (data: PuckData) => (data.content ?? []).map(idOf).filter((id) => id && oldById.has(id) && newIds.has(id)).join("|");
  if (order(before) !== order(after)) lines.push("Sections reordered");
  return { lines, firstChangedBlockId: first };
}
