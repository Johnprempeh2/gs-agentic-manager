import { describe, expect, it } from "vitest";
import {
  GUIDE_LENGTH_THRESHOLD,
  interactionGuideSummary,
  needsInteractionGuide,
  splitInteractionGuide,
} from "./interaction-guide";
import { stepGuideMarkdown } from "../fixtures/issueThreadInteractionFixtures";

describe("needsInteractionGuide", () => {
  it("keeps short plain help text inline", () => {
    expect(needsInteractionGuide("Pick the option that **fits** best.")).toBe(false);
    expect(needsInteractionGuide("")).toBe(false);
    expect(needsInteractionGuide(null)).toBe(false);
  });

  it("opens the guide for long text", () => {
    expect(needsInteractionGuide("word ".repeat(GUIDE_LENGTH_THRESHOLD / 4))).toBe(true);
  });

  it("opens the guide for a code block even when short", () => {
    expect(needsInteractionGuide("Run:\n```\npnpm i\n```")).toBe(true);
  });

  it("opens the guide for a numbered list or Step lines", () => {
    expect(needsInteractionGuide("1. Open it\n2. Close it")).toBe(true);
    expect(needsInteractionGuide("**Step 1** Open\n**Step 2** Close")).toBe(true);
    expect(needsInteractionGuide("1. Only one item")).toBe(false);
  });
});

describe("interactionGuideSummary", () => {
  it("uses the first paragraph without markdown markers", () => {
    expect(interactionGuideSummary(stepGuideMarkdown)).toBe(
      "Run the setup script on your computer, then tell me when it is done.",
    );
  });

  it("cuts a long first paragraph to its first sentence", () => {
    const long = `Do the **first** thing now. ${"Then more detail follows here. ".repeat(10)}`;
    expect(interactionGuideSummary(long)).toBe("Do the first thing now.");
  });

  it("falls back to a step count when the text starts with the steps", () => {
    expect(interactionGuideSummary("1. Open it\n2. Run it\n3. Close it")).toBe(
      "Follow the 3 steps in the guide.",
    );
  });
});

describe("splitInteractionGuide", () => {
  it("splits on Step lines and keeps code blocks whole", () => {
    const { intro, steps } = splitInteractionGuide(stepGuideMarkdown);
    expect(intro).toBe("Run the setup script on your computer, then tell me when it is done.");
    expect(steps.map((step) => step.title)).toEqual([
      "Step 1 of 3",
      "Step 2 of 3",
      "Step 3 of 3",
    ]);
    expect(steps[0].body).toBe("Open a terminal in the project folder.");
    expect(steps[1].body).toContain("```sh\npnpm gsam setup --company demo\n```");
  });

  it("splits on headings", () => {
    const { steps } = splitInteractionGuide("## Install\nRun it.\n## Check\nLook at it.");
    expect(steps).toEqual([
      { title: "Install", body: "Run it." },
      { title: "Check", body: "Look at it." },
    ]);
  });

  it("splits a numbered list, dedents nested code and keeps closing text apart", () => {
    const markdown = [
      "Before you start:",
      "",
      "1. Open a terminal.",
      "2. Run:",
      "   ```",
      "   1. not a step",
      "   ```",
      "",
      "Tell me when done.",
    ].join("\n");
    const { intro, steps, outro } = splitInteractionGuide(markdown);
    expect(intro).toBe("Before you start:");
    expect(steps).toHaveLength(2);
    expect(steps[1].body).toBe("Run:\n```\n1. not a step\n```");
    expect(outro).toBe("Tell me when done.");
  });

  it("returns one untitled step when there are no boundaries", () => {
    const { steps } = splitInteractionGuide("Just one long paragraph.");
    expect(steps).toEqual([{ title: null, body: "Just one long paragraph." }]);
  });
});
