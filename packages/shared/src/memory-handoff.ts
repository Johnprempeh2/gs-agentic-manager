import { z } from "zod";

/**
 * The live handoff (GRE-2668, John 26 Oct): "where we left off", one record in
 * a person's own memory bank that Claude Code, Codex (ChatGPT) and GSAM agents
 * all read and write. It holds the focus, the live threads (GRE ids, state,
 * next step), what waits on the person, free notes and the last tool that
 * touched it. Every update is a new version, so "what changed since I left"
 * can be answered. Writes are per unit (the focus, one thread, the waiting
 * list, the notes), so two tools never overwrite each other's lines.
 *
 * The Mac sync mirrors it to `NOW.md` in the shared memory folder and sends
 * edits back. This module is pure: the server and the tests use the same
 * render, parse and merge.
 */

export const HANDOFF_SOURCE_KIND = "handoff";
export const HANDOFF_SOURCE_ID = "handoff:live";

export const HANDOFF_TOOLS = ["claude", "chatgpt", "gsam_agent", "gsam", "now_md"] as const;
export type HandoffTool = (typeof HANDOFF_TOOLS)[number];

/** Who wrote a unit: the tool kind and the label shown as "by <label>". */
export interface HandoffAuthor {
  tool: HandoffTool;
  label: string;
  agentId?: string | null;
}

export interface HandoffText {
  text: string;
  by: HandoffAuthor;
  at: string;
}

export interface HandoffThread {
  /** The first GRE id, upper case; a thread with no id is keyed by its title. */
  key: string;
  refs: string[];
  title: string;
  state: string;
  next: string;
  by: HandoffAuthor;
  at: string;
}

export interface HandoffLastTool {
  by: HandoffAuthor;
  at: string;
  doing: string;
}

export interface HandoffState {
  focus: HandoffText | null;
  threads: HandoffThread[];
  waiting: HandoffText | null;
  notes: HandoffText | null;
  lastTool: HandoffLastTool | null;
}

export interface HandoffChange {
  /** `focus`, `waiting`, `notes` or `thread:<key>`. */
  unit: string;
  kind: "added" | "changed" | "removed";
  by: HandoffAuthor;
  at: string;
  /** One line, e.g. `Thread GRE-2668: state "in review"` (by ChatGPT). */
  summary: string;
}

/** Both sides changed the same unit: the newer one was kept, the other is recorded here. */
export interface HandoffConflict {
  unit: string;
  kept: "file" | "gsam";
  keptBy: HandoffAuthor;
  keptAt: string;
  lostValue: string;
  lostBy: HandoffAuthor;
  lostAt: string;
}

/** What a version row keeps in its evidence, besides the source details. */
export interface HandoffVersionEvidence {
  handoff: HandoffState;
  revision: number;
  by: HandoffAuthor;
  doing: string;
  changes: HandoffChange[];
  conflicts: HandoffConflict[];
}

export interface HandoffReadResult {
  bankName: string;
  personName: string;
  /** 0 before the first update. */
  revision: number;
  recordId: string | null;
  updatedAt: string | null;
  handoff: HandoffState;
  /** The handoff as `NOW.md`, the same text the Mac sync writes. */
  markdown: string;
  /** Set when `since` was asked: every change after it, oldest first, and any conflicts. */
  changesSince: {
    since: string | null;
    versions: number;
    changes: HandoffChange[];
    conflicts: HandoffConflict[];
  } | null;
}

export interface HandoffWriteResult extends HandoffReadResult {
  /** False when the update changed nothing (the same text again): no new version. */
  changed: boolean;
  changes: HandoffChange[];
  conflicts: HandoffConflict[];
}

export const HANDOFF_REF_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;
const refSchema = z.string().trim().regex(HANDOFF_REF_PATTERN, "a task id such as GRE-2668");

export const handoffThreadInputSchema = z
  .object({
    /** The thread's main task id (GRE-2668); it keys the thread. */
    ref: refSchema,
    /** Other task ids on the same thread. */
    alsoRefs: z.array(refSchema).max(10).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    state: z.string().trim().max(300).optional(),
    next: z.string().trim().max(500).optional(),
  })
  .strict();

/** Bank name of a person scope (`greatstone-john`); GSAM agents use it, apps default to their own person. */
const personRefSchema = z.string().trim().min(1).max(64);

export const updateHandoffSchema = z
  .object({
    /** What you are doing now, one line. It becomes "Last tool". */
    doing: z.string().trim().min(1).max(300),
    focus: z.string().trim().max(1_000).nullable().optional(),
    /** Each thread named here is added or updated; threads not named are left as they are. */
    threads: z.array(handoffThreadInputSchema).max(20).optional(),
    /** Task ids of threads that are finished or dropped. */
    closeThreads: z.array(refSchema).max(20).optional(),
    /** Replaces the waiting list; `[]` empties it. */
    waiting: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    notes: z.string().trim().max(4_000).nullable().optional(),
    person: personRefSchema.optional(),
  })
  .strict();
export type UpdateHandoff = z.infer<typeof updateHandoffSchema>;

export const HANDOFF_SINCE_MY_LAST_UPDATE = "my_last_update";

export const readHandoffSchema = z
  .object({
    /** An ISO time, or `my_last_update` (changes since this tool last wrote the handoff). */
    since: z.union([z.literal(HANDOFF_SINCE_MY_LAST_UPDATE), z.string().datetime({ offset: true })]).optional(),
    person: personRefSchema.optional(),
  })
  .strict();
export type ReadHandoff = z.infer<typeof readHandoffSchema>;

export const HANDOFF_FILE_MAX_CHARS = 60_000;

/** The Mac sends `NOW.md` back with the revision it last wrote, so the server can tell whose side changed. */
export const reconcileHandoffFileSchema = z
  .object({
    text: z.string().max(HANDOFF_FILE_MAX_CHARS),
    fileChangedAt: z.coerce.date(),
    baseRevision: z.number().int().min(0),
  })
  .strict();
export type ReconcileHandoffFile = z.infer<typeof reconcileHandoffFileSchema>;

export function emptyHandoff(): HandoffState {
  return { focus: null, threads: [], waiting: null, notes: null, lastTool: null };
}

/** The label shown for an app link (`memoryConnection.app`): Codex and ChatGPT both read as "ChatGPT". */
export function handoffAuthorForApp(app: string | null | undefined, name: string): HandoffAuthor {
  if (app === "codex" || app === "chatgpt") return { tool: "chatgpt", label: "ChatGPT" };
  if (app === "claude" || app === "claude_ai" || app === "claude_code") return { tool: "claude", label: "Claude" };
  return { tool: "gsam", label: name.trim().slice(0, 60) || "An app" };
}

/** A "by" line's label back to its tool, for edits made in `NOW.md`. */
export function handoffAuthorFromLabel(label: string): HandoffAuthor {
  const clean = label.trim().slice(0, 60);
  const lower = clean.toLowerCase();
  if (lower.startsWith("chatgpt") || lower.startsWith("codex")) return { tool: "chatgpt", label: "ChatGPT" };
  if (lower.startsWith("claude")) return { tool: "claude", label: "Claude" };
  if (lower.startsWith("gsam agent")) return { tool: "gsam_agent", label: clean };
  if (lower.endsWith("in gsam")) return { tool: "gsam", label: clean };
  return { tool: "now_md", label: clean || NOW_MD_AUTHOR.label };
}

export const NOW_MD_AUTHOR: HandoffAuthor = { tool: "now_md", label: "NOW.md edit" };

export function threadKey(refs: string[], title: string) {
  if (refs.length > 0) return refs[0]!.toUpperCase();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `note:${slug || "untitled"}`;
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** Text as stored and compared: trailing spaces off each line, no blank runs, trimmed. */
export function normalizeHandoffText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function threadLine(thread: Pick<HandoffThread, "refs" | "title" | "state" | "next">) {
  const refs = thread.refs.join(", ");
  const parts = [`${refs}${refs && thread.title ? " " : ""}${oneLine(thread.title)}`];
  if (thread.state) parts.push(`state: ${oneLine(thread.state)}`);
  if (thread.next) parts.push(`next: ${oneLine(thread.next)}`);
  return `- ${parts.join(" | ")}`;
}

function stamp(at: string) {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

/** Each unit's comparable value; a missing unit is absent from the map. */
export function handoffUnits(state: HandoffState): Map<string, { value: string; by: HandoffAuthor; at: string }> {
  const units = new Map<string, { value: string; by: HandoffAuthor; at: string }>();
  for (const name of ["focus", "waiting", "notes"] as const) {
    const unit = state[name];
    if (unit && unit.text) units.set(name, { value: unit.text, by: unit.by, at: unit.at });
  }
  for (const thread of state.threads) units.set(`thread:${thread.key}`, { value: threadLine(thread), by: thread.by, at: thread.at });
  return units;
}

function unitTitle(unit: string) {
  if (unit === "focus") return "Focus";
  if (unit === "waiting") return "Waiting list";
  if (unit === "notes") return "Notes";
  return `Thread ${unit.slice("thread:".length)}`;
}

function changeSummary(unit: string, kind: HandoffChange["kind"], value: string | null) {
  const what = unitTitle(unit);
  if (kind === "removed") return `${what} closed`;
  const text = oneLine((value ?? "").replace(/^- /, "")).slice(0, 160);
  return `${what} ${kind === "added" ? "added" : "changed"}: ${text}`;
}

/** The units that differ between two states, with the author and time of the newer side. */
export function diffHandoff(before: HandoffState, after: HandoffState): HandoffChange[] {
  const a = handoffUnits(before);
  const b = handoffUnits(after);
  const changes: HandoffChange[] = [];
  for (const [unit, next] of b) {
    const prev = a.get(unit);
    if (!prev) changes.push({ unit, kind: "added", by: next.by, at: next.at, summary: changeSummary(unit, "added", next.value) });
    else if (prev.value !== next.value) changes.push({ unit, kind: "changed", by: next.by, at: next.at, summary: changeSummary(unit, "changed", next.value) });
  }
  const closer = after.lastTool;
  for (const [unit, prev] of a) {
    if (b.has(unit)) continue;
    const by = closer?.by ?? prev.by;
    const at = closer?.at ?? prev.at;
    changes.push({ unit, kind: "removed", by, at, summary: changeSummary(unit, "removed", null) });
  }
  return changes;
}

/**
 * One update from a tool. Only what it names changes; everything else keeps
 * its own author and time. Last tool is always set.
 */
export function applyHandoffUpdate(state: HandoffState, input: Omit<UpdateHandoff, "person">, by: HandoffAuthor, now: Date): HandoffState {
  const at = now.toISOString();
  const next: HandoffState = { ...state, threads: [...state.threads] };
  const setText = (name: "focus" | "waiting" | "notes", text: string | null | undefined) => {
    if (text === undefined) return;
    const clean = text === null ? "" : normalizeHandoffText(text);
    if (!clean) next[name] = null;
    else if (state[name]?.text !== clean) next[name] = { text: clean, by, at };
  };
  setText("focus", input.focus);
  setText("notes", input.notes);
  if (input.waiting !== undefined) setText("waiting", input.waiting.map((item) => `- ${oneLine(item)}`).join("\n"));

  const closing = new Set((input.closeThreads ?? []).map((ref) => ref.toUpperCase()));
  next.threads = next.threads.filter((thread) => !closing.has(thread.key));
  for (const item of input.threads ?? []) {
    const key = item.ref.toUpperCase();
    const index = next.threads.findIndex((thread) => thread.key === key);
    const prev = index >= 0 ? next.threads[index] : null;
    const refs = [key, ...(item.alsoRefs ?? prev?.refs.slice(1) ?? []).map((ref) => ref.toUpperCase()).filter((ref) => ref !== key)];
    const merged = {
      key,
      refs: [...new Set(refs)],
      title: oneLine(item.title ?? prev?.title ?? ""),
      state: oneLine(item.state ?? prev?.state ?? ""),
      next: oneLine(item.next ?? prev?.next ?? ""),
    };
    if (prev && threadLine(prev) === threadLine(merged)) continue;
    const thread: HandoffThread = { ...merged, by, at };
    if (index >= 0) next.threads[index] = thread;
    else next.threads.push(thread);
  }
  next.lastTool = { by, at, doing: oneLine(input.doing) };
  return next;
}

const SECTION_HEADINGS = {
  focus: "Focus",
  threads: "Live threads",
  waiting: "Waiting on",
  notes: "Notes",
  lastTool: "Last tool",
} as const;

function byLine(unit: { by: HandoffAuthor; at: string } | null | undefined) {
  return unit ? `<!-- by ${unit.by.label} · ${unit.at} -->` : null;
}

/** The newest author among a list of units. */
function newest<T extends { at: string }>(units: T[]): T | null {
  return units.reduce<T | null>((best, unit) => (best === null || unit.at > best.at ? unit : best), null);
}

/** `NOW.md`: the handoff as the file both tools read when GSAM cannot be reached. */
export function renderHandoffMarkdown(state: HandoffState, meta: { personName: string; bankName: string; revision: number; writtenAt: string }) {
  const section = (heading: string, marker: string | null, body: string) =>
    [`## ${heading}`, ...(marker ? [marker] : []), body || "_(none)_", ""].join("\n");
  const lines = [
    "# NOW: where we left off",
    "",
    `<!-- gsam-handoff revision ${meta.revision} · bank ${meta.bankName} · written ${meta.writtenAt}`,
    `This file mirrors ${meta.personName}'s handoff in GSAM, which is the source of truth when it can be reached.`,
    "Use the handoff_read and handoff_update tools when they work. If they fail, edit a section here and set its",
    "\"by\" line to your tool and the time (for example: by ChatGPT · 2026-10-26T09:30:00Z); the Mac sync",
    "sends the change back and the newer edit wins per section. Keep the ## headings.",
    "One thread per line: - GRE-1, GRE-2 Title | state: ... | next: ... -->",
    "",
    section(SECTION_HEADINGS.focus, byLine(state.focus), state.focus?.text ?? ""),
    section(SECTION_HEADINGS.threads, byLine(newest(state.threads)), state.threads.map(threadLine).join("\n")),
    section(`${SECTION_HEADINGS.waiting} ${meta.personName}`, byLine(state.waiting), state.waiting?.text ?? ""),
    section(SECTION_HEADINGS.notes, byLine(state.notes), state.notes?.text ?? ""),
    section(
      SECTION_HEADINGS.lastTool,
      null,
      state.lastTool ? `${state.lastTool.by.label}, ${stamp(state.lastTool.at)}: ${state.lastTool.doing}` : "",
    ),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Plain text for the memory engine and recall: who wrote what, and when. */
export function renderHandoffText(state: HandoffState, personName: string) {
  const by = (unit: { by: HandoffAuthor; at: string } | null) => (unit ? ` (by ${unit.by.label}, ${stamp(unit.at)})` : "");
  const parts = [
    `${personName}'s live handoff: where we left off across Claude Code, ChatGPT (Codex) and GSAM.`,
    state.lastTool ? `Last tool: ${state.lastTool.by.label} at ${stamp(state.lastTool.at)}, doing: ${state.lastTool.doing}.` : null,
    state.focus ? `Focus${by(state.focus)}: ${state.focus.text}` : null,
    state.threads.length > 0
      ? `Live threads:\n${state.threads.map((thread) => `${threadLine(thread)} (by ${thread.by.label}, ${stamp(thread.at)})`).join("\n")}`
      : null,
    state.waiting ? `Waiting on ${personName}${by(state.waiting)}:\n${state.waiting.text}` : null,
    state.notes ? `Notes${by(state.notes)}:\n${state.notes.text}` : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}

export interface ParsedHandoffFile {
  /** The revision in the file's header, or null for a file GSAM never wrote. */
  revision: number | null;
  sections: {
    focus: ParsedSection | null;
    threads: ParsedSection | null;
    waiting: ParsedSection | null;
    notes: ParsedSection | null;
  };
  threads: Array<Pick<HandoffThread, "key" | "refs" | "title" | "state" | "next">>;
}

interface ParsedSection {
  text: string;
  marker: { label: string; at: string } | null;
}

const MARKER_RE = /^<!--\s*by\s+(.+?)\s+·\s+(\S+)\s*-->$/;
const THREAD_RE = /^[-*]\s+((?:[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?:\s*,\s*[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})*)?\s*(.*)$/;

export function parseThreadLine(line: string): Pick<HandoffThread, "key" | "refs" | "title" | "state" | "next"> | null {
  const match = THREAD_RE.exec(line.trim());
  if (!match) return null;
  const refs = (match[1] ?? "").split(",").map((ref) => ref.trim().toUpperCase()).filter(Boolean);
  const [head = "", ...rest] = (match[2] ?? "").split(/\s*\|\s+/);
  let state = "";
  let next = "";
  const extra: string[] = [];
  for (const part of rest) {
    const field = /^(state|next):\s*(.*)$/i.exec(part.trim());
    if (field?.[1]?.toLowerCase() === "state") state = oneLine(field[2] ?? "");
    else if (field?.[1]?.toLowerCase() === "next") next = oneLine(field[2] ?? "");
    else extra.push(part);
  }
  const title = oneLine([head.replace(/^[:\-–]\s*/, ""), ...extra].join(" | "));
  if (refs.length === 0 && !title) return null;
  return { key: threadKey(refs, title), refs, title, state, next };
}

/**
 * Reads `NOW.md` back. Known `##` headings fill their section; anything else
 * (an old free-form file, a heading a person added) goes to Notes, so nothing
 * written there is lost.
 */
export function parseHandoffMarkdown(text: string): ParsedHandoffFile {
  const clean = text.replace(/\r\n?/g, "\n");
  const header = /<!--\s*gsam-handoff revision (\d+)[\s\S]*?-->/.exec(clean);
  const body = header ? clean.replace(header[0], "") : clean;
  const blocks: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && !line.startsWith("###")) blocks.push({ heading: heading[1]!, lines: [] });
    else blocks.at(-1)!.lines.push(line);
  }
  const sections: ParsedHandoffFile["sections"] = { focus: null, threads: null, waiting: null, notes: null };
  const notes: string[] = [];
  const toSection = (lines: string[]): ParsedSection => {
    const rest = [...lines];
    while (rest.length > 0 && !rest[0]!.trim()) rest.shift();
    const marker = MARKER_RE.exec(rest[0]?.trim() ?? "");
    if (marker) rest.shift();
    const value = normalizeHandoffText(rest.join("\n"));
    return { text: value === "_(none)_" ? "" : value, marker: marker ? { label: marker[1]!, at: marker[2]! } : null };
  };
  for (const block of blocks) {
    const name = block.heading?.toLowerCase() ?? null;
    if (name === null) {
      // Before the first heading: the title line is the file's own; anything else is a note.
      const loose = normalizeHandoffText(block.lines.filter((line) => !/^#\s+NOW\b/i.test(line)).join("\n"));
      if (loose) notes.push(loose);
    } else if (name === "focus") sections.focus = toSection(block.lines);
    else if (name === "live threads" || name === "threads") sections.threads = toSection(block.lines);
    else if (name.startsWith("waiting on")) sections.waiting = toSection(block.lines);
    else if (name === "notes") {
      const section = toSection(block.lines);
      sections.notes = section;
      if (section.text) notes.unshift(section.text);
    } else if (name === "last tool") {
      // Written by the tools and the sync, never read back.
    } else {
      const loose = normalizeHandoffText([`### ${block.heading}`, ...block.lines].join("\n"));
      notes.push(loose);
    }
  }
  if (notes.length > 0) {
    sections.notes = { text: normalizeHandoffText(notes.join("\n\n")), marker: sections.notes?.marker ?? null };
  }
  const threads: ParsedHandoffFile["threads"] = [];
  for (const line of (sections.threads?.text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const thread = parseThreadLine(line);
    if (thread && !threads.some((existing) => existing.key === thread.key)) threads.push(thread);
  }
  return { revision: header ? Number(header[1]) : null, sections, threads };
}

/**
 * Three-way merge of `NOW.md` into the handoff (John: "newest wins per
 * section, and the change is recorded"). `base` is the version the Mac last
 * wrote to the file. A unit only the file changed is taken from the file; one
 * only GSAM changed is kept; one both changed goes to the newer side and the
 * other side is recorded as a conflict.
 */
export function mergeHandoffFile(input: {
  base: HandoffState;
  server: HandoffState;
  file: ParsedHandoffFile;
  fileChangedAt: Date;
  now: Date;
}): { merged: HandoffState; conflicts: HandoffConflict[]; fromFile: string[] } {
  const { base, server, file } = input;
  const ceiling = input.now.getTime() + 60_000;
  const fileTime = Math.min(input.fileChangedAt.getTime(), ceiling);
  const baseMarkers = {
    focus: byLine(base.focus),
    threads: byLine(newest(base.threads)),
    waiting: byLine(base.waiting),
    notes: byLine(base.notes),
  };
  /** Who edited a section in the file: its "by" line if a tool changed it, else "NOW.md edit" at the file's time. */
  const fileAuthor = (name: keyof typeof baseMarkers): { by: HandoffAuthor; at: string } => {
    const section = file.sections[name];
    const marker = section?.marker ?? null;
    const markerLine = marker ? `<!-- by ${marker.label} · ${marker.at} -->` : null;
    const parsed = marker ? Date.parse(marker.at) : Number.NaN;
    if (marker && markerLine !== baseMarkers[name] && Number.isFinite(parsed)) {
      return { by: handoffAuthorFromLabel(marker.label), at: new Date(Math.min(parsed, ceiling)).toISOString() };
    }
    return { by: NOW_MD_AUTHOR, at: new Date(fileTime).toISOString() };
  };

  const fileState: HandoffState = { ...emptyHandoff(), lastTool: null };
  for (const name of ["focus", "waiting", "notes"] as const) {
    const section = file.sections[name];
    if (section?.text) fileState[name] = { text: section.text, ...fileAuthor(name) };
  }
  const threadAuthor = fileAuthor("threads");
  fileState.threads = file.threads.map((thread) => ({ ...thread, ...threadAuthor }));

  const baseUnits = handoffUnits(base);
  const serverUnits = handoffUnits(server);
  const fileUnits = handoffUnits(fileState);
  const keys = new Set([...baseUnits.keys(), ...serverUnits.keys(), ...fileUnits.keys()]);
  const conflicts: HandoffConflict[] = [];
  const fromFile: string[] = [];
  const take = new Map<string, "file" | "gsam">();
  for (const key of keys) {
    const b = baseUnits.get(key)?.value ?? null;
    const s = serverUnits.get(key) ?? null;
    const f = fileUnits.get(key) ?? null;
    const fileChanged = (f?.value ?? null) !== b;
    const serverChanged = (s?.value ?? null) !== b;
    if (!fileChanged) continue;
    if (!serverChanged || (s?.value ?? null) === (f?.value ?? null)) {
      if ((s?.value ?? null) !== (f?.value ?? null)) take.set(key, "file");
      continue;
    }
    // Both sides changed it. A removal counts from the file's time or GSAM's last write.
    const fileAt = f?.at ?? new Date(fileTime).toISOString();
    const serverAt = s?.at ?? server.lastTool?.at ?? new Date(0).toISOString();
    const fileWins = fileAt > serverAt;
    take.set(key, fileWins ? "file" : "gsam");
    conflicts.push({
      unit: key,
      kept: fileWins ? "file" : "gsam",
      keptBy: fileWins ? (f?.by ?? threadAuthor.by) : (s?.by ?? server.lastTool?.by ?? NOW_MD_AUTHOR),
      keptAt: fileWins ? fileAt : serverAt,
      lostValue: (fileWins ? s?.value : f?.value) ?? "(removed)",
      lostBy: fileWins ? (s?.by ?? server.lastTool?.by ?? NOW_MD_AUTHOR) : (f?.by ?? threadAuthor.by),
      lostAt: fileWins ? serverAt : fileAt,
    });
  }

  const merged: HandoffState = { ...server, threads: [...server.threads] };
  for (const [key, side] of take) {
    if (side !== "file") continue;
    fromFile.push(key);
    if (key === "focus" || key === "waiting" || key === "notes") {
      merged[key] = fileState[key];
      continue;
    }
    const threadKeyValue = key.slice("thread:".length);
    const fromFileThread = fileState.threads.find((thread) => thread.key === threadKeyValue) ?? null;
    const index = merged.threads.findIndex((thread) => thread.key === threadKeyValue);
    if (!fromFileThread) {
      if (index >= 0) merged.threads.splice(index, 1);
    } else if (index >= 0) merged.threads[index] = fromFileThread;
    else merged.threads.push(fromFileThread);
  }
  if (fromFile.length > 0) {
    const authors = fromFile.map((key) => {
      if (key === "focus" || key === "waiting" || key === "notes") return fileState[key] ?? { ...fileAuthor(key) };
      return threadAuthor;
    });
    const latest = newest(authors)!;
    if (!merged.lastTool || latest.at >= merged.lastTool.at) {
      merged.lastTool = { by: latest.by, at: latest.at, doing: "edited NOW.md" };
    }
  }
  return { merged, conflicts, fromFile };
}
