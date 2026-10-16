import { describe, expect, it } from "vitest";
import {
  importMemorySchema,
  memoryTextSimilarity,
  memoryTextWords,
  mergeImportResults,
  parseAssistantExport,
  parsePastedMemories,
} from "./memory-import.js";

describe("parsePastedMemories", () => {
  it("drops bullets, headings and repeats and keeps stable ids", () => {
    const text = "Work:\n- Runs Greatstone International\n2. Prefers British English\n\n* runs greatstone international\n## Notes\nok";
    const first = parsePastedMemories(text);
    expect(first.map((c) => c.content)).toEqual(["Runs Greatstone International", "Prefers British English"]);
    expect(parsePastedMemories(text).map((c) => c.sourceId)).toEqual(first.map((c) => c.sourceId));
    expect(first[0].sourceId).toMatch(/^paste:[0-9a-f]{8}$/);
  });
});

describe("parseAssistantExport", () => {
  it("reads a ChatGPT export along the current branch, newest first", () => {
    const chatgpt = [
      {
        id: "c-old",
        title: "Old chat",
        create_time: 1_700_000_000,
        current_node: "b",
        mapping: {
          root: { parent: null, message: null },
          a: { parent: "root", message: { author: { role: "user" }, content: { parts: ["Price the Indago workshop"] } } },
          x: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["Abandoned branch"] } } },
          b: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["Two days at the standard rate"] } } },
        },
      },
      {
        conversation_id: "c-new",
        title: "New chat",
        create_time: 1_760_000_000,
        current_node: "q",
        mapping: { q: { parent: null, message: { author: { role: "user" }, content: { parts: ["Hello there"] } } } },
      },
    ];
    const result = parseAssistantExport(JSON.stringify(chatgpt));
    expect(result.ok && result.app).toBe("chatgpt");
    if (!result.ok) return;
    expect(result.candidates.map((c) => c.sourceId)).toEqual(["conversation:c-new", "conversation:c-old"]);
    const old = result.candidates[1];
    expect(old.content).toBe("Me: Price the Indago workshop\n\nChatGPT: Two days at the standard rate");
    expect(old.messageCount).toBe(2);
    expect(old.occurredAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("reads a Claude export and trims long conversations", () => {
    const claude = [
      {
        uuid: "u1",
        name: "",
        created_at: "2026-10-01T09:00:00Z",
        chat_messages: [
          { sender: "human", text: "Plan the Strategy Board cycle" },
          { sender: "assistant", text: "", content: [{ type: "text", text: "x".repeat(7_000) }] },
        ],
      },
    ];
    const result = parseAssistantExport(JSON.stringify(claude));
    expect(result.ok && result.app).toBe("claude");
    if (!result.ok) return;
    const [only] = result.candidates;
    expect(only.title).toBe("Plan the Strategy Board cycle");
    expect(only.trimmed).toBe(true);
    expect(only.content.length).toBeLessThan(6_200);
    expect(only.content).toMatch(/Trimmed/);
  });

  it("reads a Claude memories file and refuses anything else", () => {
    const memories = parseAssistantExport(JSON.stringify([{ conversations_memory: "- Lives in London\n- Runs Greatstone" }]));
    expect(memories.ok && memories.kind).toBe("memories");
    expect(parseAssistantExport("not json").ok).toBe(false);
    expect(parseAssistantExport(JSON.stringify([{ foo: 1 }])).ok).toBe(false);
  });

  it("validates the import body", () => {
    const scopeId = "00000000-0000-4000-8000-000000000000";
    expect(importMemorySchema.safeParse({ scopeId, app: "claude", via: "paste", entries: [{ sourceId: "p:1", content: "x" }] }).success).toBe(true);
    expect(importMemorySchema.safeParse({ scopeId, app: "gemini", via: "paste", entries: [{ sourceId: "p:1", content: "x" }] }).success).toBe(false);
  });
});

describe("real export details", () => {
  it("skips hidden context and tool output in ChatGPT exports", () => {
    const chatgpt = [
      {
        id: "c1",
        title: "With hidden bits",
        current_node: "c",
        mapping: {
          a: { parent: null, message: { author: { role: "user" }, metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: "user_editable_context", parts: ["About me"] } } },
          b: { parent: "a", message: { author: { role: "user" }, content: { content_type: "multimodal_text", parts: [{ asset_pointer: "file-1" }, "What is in this photo?"] } } },
          c: { parent: "b", message: { author: { role: "assistant" }, content: { content_type: "thoughts", parts: ["thinking"] } } },
        },
      },
    ];
    const result = parseAssistantExport(JSON.stringify(chatgpt));
    expect(result.ok && result.candidates[0].content).toBe("Me: What is in this photo?");
  });

  it("merges several export files, counting repeats once", () => {
    const one = parseAssistantExport(JSON.stringify([{ uuid: "u1", name: "A", created_at: "2026-10-01T00:00:00Z", chat_messages: [{ sender: "human", text: "hi there" }] }]));
    const two = parseAssistantExport(JSON.stringify([
      { uuid: "u1", name: "A", created_at: "2026-10-01T00:00:00Z", chat_messages: [{ sender: "human", text: "hi there" }] },
      { uuid: "u2", name: "B", created_at: "2026-10-02T00:00:00Z", chat_messages: [{ sender: "human", text: "second" }] },
    ]));
    const merged = mergeImportResults([one, two]);
    expect(merged.ok && merged.candidates.map((c) => c.sourceId)).toEqual(["conversation:u2", "conversation:u1"]);
  });

  it("scores near repeats high and different text low", () => {
    const a = memoryTextWords("Greatstone prices discovery workshops per day");
    expect(memoryTextSimilarity(a, memoryTextWords("Greatstone prices discovery workshops per day."))).toBe(1);
    expect(memoryTextSimilarity(a, memoryTextWords("Ben likes short updates"))).toBe(0);
  });
});
