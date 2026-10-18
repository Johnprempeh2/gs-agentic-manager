import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPLY_SNIPPETS,
  MAX_REPLY_SNIPPETS,
  REPLY_SNIPPETS_KEY,
  addReplySnippet,
  loadReplySnippets,
  removeReplySnippet,
  snippetLabel,
} from "./reply-snippets";

describe("reply snippets", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts with the default phrases", () => {
    expect(loadReplySnippets()).toEqual([...DEFAULT_REPLY_SNIPPETS]);
  });

  it("adds to the top without duplicates and keeps them", () => {
    let snippets = loadReplySnippets();
    snippets = addReplySnippet(snippets, "  Ship it.  ");
    snippets = addReplySnippet(snippets, DEFAULT_REPLY_SNIPPETS[1]!);
    expect(snippets[0]).toBe(DEFAULT_REPLY_SNIPPETS[1]);
    expect(snippets[1]).toBe("Ship it.");
    expect(snippets.filter((item) => item === DEFAULT_REPLY_SNIPPETS[1])).toHaveLength(1);
    expect(loadReplySnippets()).toEqual(snippets);
  });

  it("caps the list and ignores blank text", () => {
    let snippets: string[] = [];
    for (let i = 0; i < MAX_REPLY_SNIPPETS + 5; i += 1) snippets = addReplySnippet(snippets, `Note ${i}`);
    expect(snippets).toHaveLength(MAX_REPLY_SNIPPETS);
    expect(addReplySnippet(snippets, "   ")).toBe(snippets);
  });

  it("removes a snippet, and an emptied list stays empty", () => {
    let snippets = loadReplySnippets();
    for (const item of [...snippets]) snippets = removeReplySnippet(snippets, item);
    expect(loadReplySnippets()).toEqual([]);
  });

  it("falls back to the defaults when storage holds junk", () => {
    localStorage.setItem(REPLY_SNIPPETS_KEY, "{not json");
    expect(loadReplySnippets()).toEqual([...DEFAULT_REPLY_SNIPPETS]);
  });

  it("labels a snippet by its first line", () => {
    expect(snippetLabel("First line\nSecond")).toBe("First line");
    expect(snippetLabel("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
