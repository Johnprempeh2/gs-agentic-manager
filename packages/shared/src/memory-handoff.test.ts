import { describe, expect, it } from "vitest";
import {
  applyHandoffUpdate,
  diffHandoff,
  emptyHandoff,
  handoffUnits,
  mergeHandoffFile,
  parseHandoffMarkdown,
  parseThreadLine,
  renderHandoffMarkdown,
  type HandoffAuthor,
} from "./memory-handoff.js";

const claude: HandoffAuthor = { tool: "claude", label: "Claude" };
const chatgpt: HandoffAuthor = { tool: "chatgpt", label: "ChatGPT" };
const meta = { personName: "John", bankName: "greatstone-john", revision: 3, writtenAt: "2026-10-26T01:00:00.000Z" };

function sample() {
  let state = applyHandoffUpdate(
    emptyHandoff(),
    {
      doing: "starting the shared memory work",
      focus: "Ship shared memory (GRE-2668) before Indago.",
      threads: [
        { ref: "GRE-2668", alsoRefs: ["GRE-2694"], title: "Hindsight shared memory", state: "in review", next: "Flint's security check" },
        { ref: "gre-571", title: "Airport taxi prototype scope", state: "waiting on discovery", next: "John and Ben sign off" },
      ],
      waiting: ["Approve the release card (GRE-2695)"],
    },
    claude,
    new Date("2026-10-26T00:50:00.000Z"),
  );
  state = applyHandoffUpdate(state, { doing: "reviewing", notes: "Indago call moved to 9 Nov." }, chatgpt, new Date("2026-10-26T00:55:00.000Z"));
  return state;
}

const values = (state: ReturnType<typeof sample>) => Object.fromEntries([...handoffUnits(state)].map(([key, unit]) => [key, unit.value]));

describe("handoff record (GRE-2668)", () => {
  it("changes only what an update names and keeps each unit's own author", () => {
    const before = sample();
    const after = applyHandoffUpdate(
      before,
      { doing: "after review", threads: [{ ref: "GRE-2668", state: "changes requested" }] },
      chatgpt,
      new Date("2026-10-26T01:10:00.000Z"),
    );
    const thread = after.threads.find((item) => item.key === "GRE-2668")!;
    expect(thread).toMatchObject({ refs: ["GRE-2668", "GRE-2694"], title: "Hindsight shared memory", state: "changes requested", next: "Flint's security check", by: chatgpt });
    // Claude's lines are still Claude's.
    expect(after.focus?.by).toEqual(claude);
    expect(after.threads.find((item) => item.key === "GRE-571")?.by).toEqual(claude);
    expect(after.lastTool).toEqual({ by: chatgpt, at: "2026-10-26T01:10:00.000Z", doing: "after review" });
    expect(diffHandoff(before, after).map((change) => [change.unit, change.kind, change.by.label])).toEqual([["thread:GRE-2668", "changed", "ChatGPT"]]);

    const closed = applyHandoffUpdate(after, { doing: "closing", closeThreads: ["GRE-571"] }, claude, new Date("2026-10-26T01:20:00.000Z"));
    expect(diffHandoff(after, closed)).toEqual([expect.objectContaining({ unit: "thread:GRE-571", kind: "removed", by: claude })]);
  });

  it("writes NOW.md and reads the same handoff back", () => {
    const state = sample();
    const markdown = renderHandoffMarkdown(state, meta);
    expect(markdown).toContain("## Focus\n<!-- by Claude · 2026-10-26T00:50:00.000Z -->\nShip shared memory");
    expect(markdown).toContain("- GRE-2668, GRE-2694 Hindsight shared memory | state: in review | next: Flint's security check");
    expect(markdown).toContain("## Waiting on John");
    expect(markdown).toContain("## Notes\n<!-- by ChatGPT · 2026-10-26T00:55:00.000Z -->");
    expect(markdown).toContain("ChatGPT, 2026-10-26 00:55 UTC: reviewing");
    const parsed = parseHandoffMarkdown(markdown);
    expect(parsed.revision).toBe(3);
    // Nothing changed in the file: merging it changes nothing.
    const merged = mergeHandoffFile({ base: state, server: state, file: parsed, fileChangedAt: new Date("2026-10-26T02:00:00Z"), now: new Date("2026-10-26T02:00:00Z") });
    expect(merged.fromFile).toEqual([]);
    expect(values(merged.merged)).toEqual(values(state));
  });

  it("keeps an old free-form NOW.md as notes", () => {
    const parsed = parseHandoffMarkdown("# NOW\n\nWorking on Indago.\n\n## Next session\n- call Ben\n");
    expect(parsed.revision).toBeNull();
    expect(parsed.sections.notes?.text).toBe("Working on Indago.\n\n### Next session\n- call Ben");
    expect(parseThreadLine("- GRE-1 | state: open")).toMatchObject({ key: "GRE-1", title: "", state: "open" });
  });

  it("takes an offline edit from the file, and on a clash keeps the newer side and records it", () => {
    const base = sample();
    const file = renderHandoffMarkdown(base, meta)
      // Codex, offline, edits the GRE-571 line and the focus, and sets the focus "by" line.
      .replace("state: waiting on discovery", "state: discovery booked")
      .replace("<!-- by Claude · 2026-10-26T00:50:00.000Z -->\nShip shared memory (GRE-2668) before Indago.", "<!-- by ChatGPT · 2026-10-26T03:00:00.000Z -->\nIndago first, then shared memory");
    // Meanwhile Claude, through GSAM, changed the focus earlier and a different thread.
    const server = applyHandoffUpdate(
      base,
      { doing: "online", focus: "Release prep.", threads: [{ ref: "GRE-2668", state: "approved" }] },
      claude,
      new Date("2026-10-26T02:30:00.000Z"),
    );
    const { merged, conflicts, fromFile } = mergeHandoffFile({
      base,
      server,
      file: parseHandoffMarkdown(file),
      fileChangedAt: new Date("2026-10-26T03:05:00.000Z"),
      now: new Date("2026-10-26T03:10:00.000Z"),
    });
    expect(fromFile.sort()).toEqual(["focus", "thread:GRE-571"]);
    expect(merged.focus).toMatchObject({ text: "Indago first, then shared memory", by: chatgpt, at: "2026-10-26T03:00:00.000Z" });
    // The thread line had no new "by" line: it reads as a NOW.md edit at the file's time.
    expect(merged.threads.find((thread) => thread.key === "GRE-571")).toMatchObject({ state: "discovery booked", by: { tool: "now_md" }, at: "2026-10-26T03:05:00.000Z" });
    // GSAM's own change to the other thread survives.
    expect(merged.threads.find((thread) => thread.key === "GRE-2668")?.state).toBe("approved");
    expect(conflicts).toEqual([
      expect.objectContaining({ unit: "focus", kept: "file", keptBy: chatgpt, lostValue: "Release prep.", lostBy: claude }),
    ]);

    // The other way round: GSAM's change is newer, so it stays and the file's is recorded.
    const later = applyHandoffUpdate(base, { doing: "online", focus: "Release now." }, claude, new Date("2026-10-26T04:00:00.000Z"));
    const second = mergeHandoffFile({ base, server: later, file: parseHandoffMarkdown(file), fileChangedAt: new Date("2026-10-26T03:05:00.000Z"), now: new Date("2026-10-26T04:10:00.000Z") });
    expect(second.merged.focus?.text).toBe("Release now.");
    expect(second.conflicts).toEqual([expect.objectContaining({ unit: "focus", kept: "gsam", lostValue: "Indago first, then shared memory", lostBy: chatgpt })]);
  });
});
