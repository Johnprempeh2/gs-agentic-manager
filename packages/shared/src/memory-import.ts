import { z } from "zod";

/**
 * Bringing what Claude and ChatGPT know into organization memory. Parsing is
 * pure and runs in the browser, so a large export never leaves the person's
 * machine whole: only the entries they pick are sent. No model is called.
 */

export const MEMORY_IMPORT_APPS = ["claude", "chatgpt"] as const;
export type MemoryImportApp = (typeof MEMORY_IMPORT_APPS)[number];

export const MEMORY_IMPORT_APP_LABEL: Record<MemoryImportApp, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/** `sourceKind` on records brought in from each app. */
export const MEMORY_IMPORT_SOURCE_KIND: Record<MemoryImportApp, "claude_import" | "chatgpt_import"> = {
  claude: "claude_import",
  chatgpt: "chatgpt_import",
};

/** Most entries one import call takes. Each one is a contribution the engine retains. */
export const MEMORY_IMPORT_MAX_ENTRIES = 50;
/** Longest text kept from one conversation; the rest is trimmed with a note. */
export const MEMORY_IMPORT_CONVERSATION_MAX_CHARS = 6_000;

/** What to paste into Claude or ChatGPT so it lists what it remembers. */
export const MEMORY_IMPORT_PROMPT =
  "List everything you remember about me and my work: facts, preferences, people, clients, projects and decisions. " +
  "Write one item per line, as a plain sentence, with no headings and no numbering. Do not include passwords, keys or bank details.";

export interface MemoryImportCandidate {
  /** Stable for the same text or conversation, so a second import skips it. */
  sourceId: string;
  title: string;
  content: string;
  /** ISO date the item came from, when the export says. */
  occurredAt: string | null;
  /** Messages in the conversation; null for a pasted line. */
  messageCount: number | null;
  trimmed: boolean;
}

export type MemoryImportParseResult =
  | { ok: true; app: MemoryImportApp; kind: "conversations" | "memories"; candidates: MemoryImportCandidate[] }
  | { ok: false; error: string };

/** Small, stable, non-cryptographic hash (FNV-1a) for ids of pasted text. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function titleFrom(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

const BULLET_RE = /^\s*(?:[-*•●▪–—]+|\d{1,3}[.)]|\(\d{1,3}\))\s*/;

/**
 * One entry per line of pasted memory. Bullets and numbering are dropped,
 * short headings ("Work:") are skipped, and repeats count once.
 */
export function parsePastedMemories(text: string): MemoryImportCandidate[] {
  const seen = new Set<string>();
  const candidates: MemoryImportCandidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(BULLET_RE, "").replace(/\s+/g, " ").trim();
    if (line.length < 4) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (line.endsWith(":") && line.length <= 60) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const content = line.slice(0, 2_000);
    candidates.push({
      sourceId: `paste:${hashText(key)}`,
      title: titleFrom(content),
      content,
      occurredAt: null,
      messageCount: null,
      trimmed: content.length < line.length,
    });
  }
  return candidates;
}

type Turn = { role: "me" | "assistant"; text: string };

function toIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // ChatGPT exports seconds since the epoch.
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function chatGptPartsText(content: Record<string, unknown> | null): string {
  if (!content) return "";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const texts = parts.filter((part): part is string => typeof part === "string");
  if (texts.length === 0 && typeof content.text === "string") texts.push(content.text);
  return texts.join("\n").trim();
}

/** Follows ChatGPT's message tree from the current node back to the root, then reads it forwards. */
function chatGptTurns(conversation: Record<string, unknown>): Turn[] {
  const mapping = asRecord(conversation.mapping);
  if (!mapping) return [];
  const chain: Record<string, unknown>[] = [];
  let nodeId = typeof conversation.current_node === "string" ? conversation.current_node : null;
  const visited = new Set<string>();
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = asRecord(mapping[nodeId]);
    if (!node) break;
    chain.push(node);
    nodeId = typeof node.parent === "string" ? node.parent : null;
  }
  if (chain.length === 0) chain.push(...Object.values(mapping).map(asRecord).filter((node): node is Record<string, unknown> => !!node));
  else chain.reverse();
  const turns: Turn[] = [];
  for (const node of chain) {
    const message = asRecord(node.message);
    if (!message) continue;
    const role = asRecord(message.author)?.role;
    if (role !== "user" && role !== "assistant") continue;
    // Custom instructions and other context ChatGPT injects but never shows.
    if (asRecord(message.metadata)?.is_visually_hidden_from_conversation === true) continue;
    const contentType = asRecord(message.content)?.content_type;
    if (contentType && !["text", "multimodal_text", "code"].includes(String(contentType))) continue;
    const text = chatGptPartsText(asRecord(message.content));
    if (text) turns.push({ role: role === "user" ? "me" : "assistant", text });
  }
  return turns;
}

function claudeTurns(conversation: Record<string, unknown>): Turn[] {
  const messages = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [];
  const turns: Turn[] = [];
  for (const entry of messages) {
    const message = asRecord(entry);
    if (!message) continue;
    const sender = message.sender;
    if (sender !== "human" && sender !== "assistant") continue;
    let text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text && Array.isArray(message.content)) {
      text = message.content
        .map((block) => asRecord(block))
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block!.text as string)
        .join("\n")
        .trim();
    }
    if (text) turns.push({ role: sender === "human" ? "me" : "assistant", text });
  }
  return turns;
}

function conversationCandidate(
  app: MemoryImportApp,
  id: string,
  title: string,
  occurredAt: string | null,
  turns: Turn[],
): MemoryImportCandidate | null {
  if (turns.length === 0) return null;
  const assistant = MEMORY_IMPORT_APP_LABEL[app];
  let content = "";
  let trimmed = false;
  for (const turn of turns) {
    const line = `${turn.role === "me" ? "Me" : assistant}: ${turn.text.replace(/\n{3,}/g, "\n\n")}\n\n`;
    if (content.length + line.length > MEMORY_IMPORT_CONVERSATION_MAX_CHARS) {
      const room = MEMORY_IMPORT_CONVERSATION_MAX_CHARS - content.length;
      if (room > 200) content += `${line.slice(0, room)}...`;
      trimmed = true;
      break;
    }
    content += line;
  }
  content = content.trim();
  if (trimmed) content += `\n\n(Trimmed: the full conversation is longer.)`;
  const cleanTitle = title.trim() || titleFrom(turns[0].text);
  return {
    sourceId: `conversation:${id}`.slice(0, 200),
    title: titleFrom(cleanTitle, 160),
    content,
    occurredAt,
    messageCount: turns.length,
    trimmed,
  };
}

function isChatGptConversation(value: Record<string, unknown>) {
  return asRecord(value.mapping) !== null;
}

function isClaudeConversation(value: Record<string, unknown>) {
  return Array.isArray(value.chat_messages);
}

/** Claude's export may carry a memories file: objects with a `conversations_memory` summary. */
function claudeMemoryText(items: Record<string, unknown>[]): string | null {
  const texts: string[] = [];
  for (const item of items) {
    if (typeof item.conversations_memory === "string") texts.push(item.conversations_memory);
    const projects = asRecord(item.project_memories);
    if (projects) for (const value of Object.values(projects)) if (typeof value === "string") texts.push(value);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Reads a `conversations.json` (or Claude `memories.json`) file from a
 * ChatGPT or Claude data export. The app is detected from the file's shape.
 */
export function parseAssistantExport(fileText: string): MemoryImportParseResult {
  let data: unknown;
  try {
    data = JSON.parse(fileText);
  } catch {
    return { ok: false, error: "This file is not a valid export. Choose the conversations.json file from inside the export folder." };
  }
  const items = (Array.isArray(data) ? data : [data]).map(asRecord).filter((item): item is Record<string, unknown> => !!item);
  if (items.length === 0) return { ok: false, error: "This export has no conversations in it." };

  if (items.some(isChatGptConversation)) {
    const candidates = items
      .filter(isChatGptConversation)
      .map((item) => {
        const id = String(item.conversation_id ?? item.id ?? hashText(JSON.stringify(item.title ?? "") + String(item.create_time ?? "")));
        return conversationCandidate("chatgpt", id, typeof item.title === "string" ? item.title : "", toIsoDate(item.create_time), chatGptTurns(item));
      })
      .filter((candidate): candidate is MemoryImportCandidate => !!candidate);
    return { ok: true, app: "chatgpt", kind: "conversations", candidates: newestFirst(candidates) };
  }

  if (items.some(isClaudeConversation)) {
    const candidates = items
      .filter(isClaudeConversation)
      .map((item) => {
        const id = String(item.uuid ?? hashText(JSON.stringify(item.name ?? "") + String(item.created_at ?? "")));
        return conversationCandidate("claude", id, typeof item.name === "string" ? item.name : "", toIsoDate(item.created_at), claudeTurns(item));
      })
      .filter((candidate): candidate is MemoryImportCandidate => !!candidate);
    return { ok: true, app: "claude", kind: "conversations", candidates: newestFirst(candidates) };
  }

  const memoryText = claudeMemoryText(items);
  if (memoryText) return { ok: true, app: "claude", kind: "memories", candidates: parsePastedMemories(memoryText) };

  return {
    ok: false,
    error: "This does not look like a Claude or ChatGPT export. Choose the conversations.json file from inside the export folder.",
  };
}

function newestFirst(candidates: MemoryImportCandidate[]) {
  return [...candidates].sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""));
}

/** Several export files (ChatGPT can split large exports) read as one list, repeats counted once. */
export function mergeImportResults(results: MemoryImportParseResult[]): MemoryImportParseResult {
  const ok = results.filter((result): result is Extract<MemoryImportParseResult, { ok: true }> => result.ok);
  if (ok.length === 0) return results[0] ?? { ok: false, error: "No file chosen." };
  const seen = new Set<string>();
  const candidates: MemoryImportCandidate[] = [];
  for (const result of ok) {
    for (const candidate of result.candidates) {
      if (seen.has(candidate.sourceId)) continue;
      seen.add(candidate.sourceId);
      candidates.push(candidate);
    }
  }
  return { ok: true, app: ok[0].app, kind: ok[0].kind, candidates: newestFirst(candidates) };
}

/** Lower-case words of three letters or more, for comparing two entries. */
export function memoryTextWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/**
 * How alike two texts are, from 0 to 1, by shared words (Jaccard). Cheap and
 * fallible: it flags likely repeats for a person to decide, nothing more.
 */
export function memoryTextSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** At or above this, an entry is shown as probably already in memory. */
export const MEMORY_IMPORT_SIMILAR_THRESHOLD = 0.7;

export const checkMemoryImportSchema = z
  .object({
    scopeId: z.string().guid(),
    app: z.enum(MEMORY_IMPORT_APPS),
    entries: z
      .array(z.object({ sourceId: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20_000) }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export type CheckMemoryImport = z.infer<typeof checkMemoryImportSchema>;

export interface MemoryImportCheckResult {
  entries: Array<{
    sourceId: string;
    /** `already_imported`: this exact line or chat was added before. `similar`: an entry with much the same words exists. */
    match: "already_imported" | "similar" | null;
    existing: { recordId: string; title: string | null; status: string } | null;
  }>;
}

export const importMemoryEntrySchema = z
  .object({
    sourceId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200).optional().nullable(),
    content: z.string().trim().min(1).max(20_000),
    occurredAt: z.coerce.date().optional().nullable(),
  })
  .strict();

export const importMemorySchema = z
  .object({
    scopeId: z.string().guid(),
    app: z.enum(MEMORY_IMPORT_APPS),
    /** How the person brought it in: pasted lines or an export file. */
    via: z.enum(["paste", "export"]),
    entries: z.array(importMemoryEntrySchema).min(1).max(MEMORY_IMPORT_MAX_ENTRIES),
  })
  .strict();
export type ImportMemory = z.infer<typeof importMemorySchema>;

export type MemoryImportEntryOutcome = "added" | "already_imported" | "held_back";

export interface MemoryImportResult {
  added: number;
  alreadyImported: number;
  heldBack: number;
  entries: Array<{ sourceId: string; outcome: MemoryImportEntryOutcome; recordId: string | null; reason: string | null }>;
}

/**
 * A live link from a person's Claude, Codex or other MCP app to organization
 * memory. Each one is a paused agent that holds `memory_only` keys, so the app
 * is recorded as its own contributor and can reach memory and nothing else.
 */
export const MEMORY_CONNECTION_APPS = ["claude", "claude_ai", "claude_code", "codex", "chatgpt", "other"] as const;
export type MemoryConnectionApp = (typeof MEMORY_CONNECTION_APPS)[number];

export const MEMORY_CONNECTION_APP_LABEL: Record<MemoryConnectionApp, string> = {
  claude: "Claude desktop app",
  claude_ai: "Claude.ai",
  claude_code: "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT",
  other: "Another app",
};

export const createMemoryConnectionSchema = z
  .object({
    app: z.enum(MEMORY_CONNECTION_APPS),
    /** Let the app add entries to organization and project memory, not only its own notes. */
    canContribute: z.boolean().default(true),
  })
  .strict();
export type CreateMemoryConnection = z.infer<typeof createMemoryConnectionSchema>;

export interface MemoryConnection {
  agentId: string;
  app: MemoryConnectionApp;
  name: string;
  createdByUserId: string | null;
  canContribute: boolean;
  keys: Array<{ id: string; createdAt: Date | string; lastUsedAt: Date | string | null }>;
}

export interface CreatedMemoryConnection {
  connection: MemoryConnection;
  /** Shown once. GSAM keeps only its hash. */
  token: string;
}

/** Where ChatGPT and Claude.ai sign in to memory, when this server offers it. */
export interface MemoryAppSignInStatus {
  /** The address to paste into the app. */
  mcpUrl: string;
}

/**
 * The app asking to connect, as the consent screen shows it. `app` comes from
 * where it sends the browser back; `name` is only the app's own claim.
 */
export interface MemoryAppSignInClient {
  name: string;
  app: MemoryConnectionApp;
  redirectHost: string;
}

export interface ApproveMemoryAppSignIn {
  companyId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state?: string;
  canContribute: boolean;
}

/** What a linked app has done, newest first, for the owner's "check it works" view. */
export interface MemoryConnectionActivity {
  lastUsedAt: Date | string | null;
  operations: Array<{ id: string; operation: string; outcome: string; recordId: string | null; createdAt: Date | string }>;
  contributions: Array<{ id: string; title: string | null; status: string; createdAt: Date | string }>;
}
