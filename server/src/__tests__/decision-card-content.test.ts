import { describe, expect, it } from "vitest";
import {
  commentExcerpt,
  listTasks,
  namedAskSentence,
  recommendationFromComment,
  recommendedActionId,
  viewerNames,
} from "../services/decision-card-content.js";

describe("decision card content", () => {
  const john = viewerNames("John Prempeh");

  it("finds the sentence that asks the viewer to act, and ignores a mention", () => {
    expect(namedAskSentence("I sent a test email. Waiting for John to reply \"Received\" before I continue.", john))
      .toBe("Waiting for John to reply \"Received\" before I continue.");
    expect(namedAskSentence("John set this up last week. The key is rejected.", john)).toBeNull();
    expect(namedAskSentence("Johnny needs to reply.", john)).toBeNull();
    expect(namedAskSentence("This needs the board to approve the spend.", viewerNames(null))).toBe("This needs the board to approve the spend.");
    expect(namedAskSentence(null, john)).toBeNull();
  });

  it("reads a recommendation line in its common shapes", () => {
    expect(recommendationFromComment("Stuck.\n\nRecommendation: reassign it to Lintel.")).toBe("reassign it to Lintel.");
    expect(recommendationFromComment("**Recommendation:** cancel it, the route is gone.")).toBe("cancel it, the route is gone.");
    expect(recommendationFromComment("- I recommend retrying after the key rotates.")).toBe("retrying after the key rotates.");
    expect(recommendationFromComment("No advice here.")).toBeNull();
  });

  it("points a recommendation at the option it names", () => {
    expect(recommendedActionId("Reassign it to Lintel")).toBe("reassign");
    expect(recommendedActionId("Cancel it")).toBe("cancel_task");
    expect(recommendedActionId("Approve: it matches the brief")).toBe("approve");
    expect(recommendedActionId("November")).toBeNull();
  });

  it("shortens comments to one plain line and lists tasks in plain English", () => {
    expect(commentExcerpt("**Done.** See [the PR](https://x).\n\n```\nlog\n```")).toBe("Done. See the PR.");
    expect(commentExcerpt("word ".repeat(100), 40).endsWith("…")).toBe(true);
    expect(listTasks(["A", "B"])).toBe("A and B");
    expect(listTasks(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });
});
