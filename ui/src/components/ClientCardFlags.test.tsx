// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientCardFlags } from "./ClientCardFlags";

const now = new Date("2026-10-09T12:00:00Z");

describe("ClientCardFlags", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(caseItem: Parameters<typeof ClientCardFlags>[0]["caseItem"]) {
    flushSync(() => root.render(<ClientCardFlags caseItem={caseItem} now={now} />));
    return container.textContent ?? "";
  }

  it("shows the no-contact flag for an old last-contact date", () => {
    expect(render({ fields: { lastContact: "2026-09-01" }, stageEnteredAt: "2026-10-01T00:00:00Z" })).toBe(
      "No contact 38 days",
    );
  });

  it("shows nothing for a fresh last-contact date and a recent stage move", () => {
    expect(render({ fields: { lastContact: "2026-10-07" }, stageEnteredAt: "2026-10-01T00:00:00Z" })).toBe("");
  });

  it("shows the stuck-stage flag when the stage has not moved for 30 days", () => {
    expect(render({ fields: { lastContact: "2026-10-07" }, stageEnteredAt: "2026-08-30T00:00:00Z" })).toBe(
      "Same stage 40 days",
    );
  });
});
