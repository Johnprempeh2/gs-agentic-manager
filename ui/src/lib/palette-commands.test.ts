import { describe, expect, it } from "vitest";
import { parseCommand, parseWhen } from "./palette-commands";

// Friday 16 October 2026
const now = new Date(2026, 9, 16, 1, 0, 0);
const agents = [
  { id: "mason", name: "Mason" },
  { id: "ridge", name: "Ridge" },
];

describe("parseWhen", () => {
  it("reads days and dates", () => {
    expect(parseWhen("tomorrow", now)?.label).toBe("Saturday 17 October");
    expect(parseWhen("Friday", now)?.label).toBe("Friday 23 October");
    expect(parseWhen("Monday", now)?.label).toBe("Monday 19 October");
    expect(parseWhen("next Friday", now)?.label).toBe("Friday 23 October");
    expect(parseWhen("Thursday", now)?.label).toBe("Thursday 22 October");
    expect(parseWhen("in 3 days", now)?.label).toBe("Monday 19 October");
    expect(parseWhen("3 Nov", now)?.label).toBe("Tuesday 3 November");
    expect(parseWhen("next week", now)?.label).toBe("Monday 19 October");
    expect(parseWhen("someday", now)).toBeNull();
  });
});

describe("parseCommand", () => {
  it("creates a task for an agent with a deadline", () => {
    expect(parseCommand("create a task for Mason to draft the Indago pack by Friday", agents, now)).toMatchObject({
      kind: "create",
      title: "Draft the Indago pack",
      agent: { id: "mason" },
      due: { label: "Friday 23 October" },
    });
  });

  it("understands ask X to Y", () => {
    expect(parseCommand("ask Ridge to chase the data room login", agents, now)).toMatchObject({
      kind: "create",
      title: "Chase the data room login",
      agent: { id: "ridge" },
      due: null,
    });
    expect(parseCommand("ask Everest to look at this", agents, now)).toBeNull();
  });

  it("keeps 'for' in the title when it is not an agent", () => {
    expect(parseCommand("add task for the Indago kick-off", agents, now)).toMatchObject({
      kind: "create",
      title: "For the Indago kick-off",
      agent: null,
    });
  });

  it("assigns a task", () => {
    expect(parseCommand("assign GRE-12 to Ridge", agents, now)).toMatchObject({ kind: "assign", taskRef: "GRE-12", agent: { id: "ridge" } });
    expect(parseCommand("assign this to me", agents, now)).toMatchObject({ kind: "assign", taskRef: "this", toMe: true });
    expect(parseCommand("assign GRE-12 to Nobody", agents, now)).toBeNull();
  });

  it("sets reminders either way round", () => {
    expect(parseCommand("remind me on Monday to call Ben", agents, now)).toMatchObject({
      kind: "remind",
      title: "Call Ben",
      when: { label: "Monday 19 October" },
    });
    expect(parseCommand("remind me to send the invoice tomorrow", agents, now)).toMatchObject({
      kind: "remind",
      title: "Send the invoice",
      when: { label: "Saturday 17 October" },
    });
    expect(parseCommand("remind me about stuff", agents, now)).toBeNull();
  });

  it("ignores ordinary searches", () => {
    expect(parseCommand("indago", agents, now)).toBeNull();
    expect(parseCommand("what is stuck on indago", agents, now)).toBeNull();
  });
});
