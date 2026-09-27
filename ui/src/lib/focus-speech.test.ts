import { describe, expect, it } from "vitest";
import { buildSpokenSummary, parseOptionCommand, plainTextFromMarkdown, splitSentences } from "./focus-speech";

describe("buildSpokenSummary", () => {
  const base = {
    agentName: "Ridge",
    taskIdentifier: "GRE-44",
    taskTitle: "Stalled runs recovery",
    question: "Should I restart a stuck run on its own?",
    background: "Two runs stopped last night. A restart is safe for **most** tasks.",
    options: [
      { label: "Restart on its own", description: "Fastest" },
      { label: "Always ask me first" },
    ],
  };

  it("reads who asks, the task, the question, the background, then the options", () => {
    expect(buildSpokenSummary(base)).toEqual([
      { kind: "intro", text: "Ridge asks, on GRE-44, Stalled runs recovery." },
      { kind: "question", text: "Should I restart a stuck run on its own?" },
      { kind: "background", text: "Two runs stopped last night.", sentenceIndex: 0 },
      { kind: "background", text: "A restart is safe for most tasks.", sentenceIndex: 1 },
      { kind: "option", text: "Option 1: Restart on its own. Fastest.", optionIndex: 0 },
      { kind: "option", text: "Option 2: Always ask me first.", optionIndex: 1 },
    ]);
  });

  it("reads the question and options only when there is no background note", () => {
    const parts = buildSpokenSummary({ ...base, background: null, agentName: null, taskIdentifier: null, taskTitle: null });
    expect(parts.map((part) => part.kind)).toEqual(["intro", "question", "option", "option"]);
    expect(parts[0]!.text).toBe("An agent asks.");
  });

  it("uses the given noun for non-question options", () => {
    const parts = buildSpokenSummary({ ...base, options: [{ label: "Write the tests" }], optionNoun: "Task" });
    expect(parts.at(-1)!.text).toBe("Task 1: Write the tests.");
  });
});

describe("speech text helpers", () => {
  it("strips markdown to speakable text", () => {
    expect(plainTextFromMarkdown("## Plan\n- See [the doc](/x) and `pnpm test`")).toBe("Plan See the doc and pnpm test");
  });

  it("keeps abbreviations inside a sentence", () => {
    expect(splitSentences("Use v1.2 today. Then e.g. retry! Done")).toEqual([
      "Use v1.2 today.",
      "Then e.g. retry!",
      "Done",
    ]);
  });
});

describe("parseOptionCommand", () => {
  it.each([
    ["Option two. And send me a message", 2],
    ["option 3 please", 3],
    ["I pick option number one", 1],
    ["option to", 2],
    ["let's go with the second option", 2],
    ["OPTION FOUR", 4],
  ])("%s → %s", (transcript, expected) => {
    expect(parseOptionCommand(transcript, 4)).toBe(expected);
  });

  it("ignores notes without a command and options that do not exist", () => {
    expect(parseOptionCommand("restart it but tell me", 3)).toBeNull();
    expect(parseOptionCommand("option nine", 3)).toBeNull();
    expect(parseOptionCommand("the optional step", 3)).toBeNull();
  });
});
