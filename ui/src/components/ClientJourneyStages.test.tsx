// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientNda } from "@greatstone/shared";
import { NdaRow } from "./ClientJourneyStages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({ Link: () => null }));

const required: ClientNda = { status: "required", acceptedAt: null, suspendedReason: null, changedBy: null, changedAt: null };

describe("NdaRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const radios = () => [...container.querySelectorAll<HTMLButtonElement>("[role='radio']")];
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label)!;

  it("is a three-way control, and suspending asks for the reason first", () => {
    const onChange = vi.fn();
    act(() => root.render(<NdaRow nda={required} busy={false} onChange={onChange} />));

    expect(radios().map((radio) => radio.textContent)).toEqual(["Required", "Accepted", "Suspended"]);
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("governing law England and Wales");

    act(() => button("Suspended").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(button("Suspend NDA").disabled).toBe(true);

    const reason = container.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(reason, "Engagement already under way");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Suspend NDA").click());
    expect(onChange).toHaveBeenCalledWith({ status: "suspended", reason: "Engagement already under way" });

    act(() => button("Accepted").click());
    expect(onChange).toHaveBeenLastCalledWith({ status: "accepted" });
  });

  it("shows the reason, who and when while suspended", () => {
    act(() => root.render(
      <NdaRow
        nda={{ ...required, status: "suspended", suspendedReason: "Omni was already under way", changedBy: "John", changedAt: "2026-10-13T10:00:00.000Z" }}
        busy={false}
        onChange={vi.fn()}
      />,
    ));
    expect(radios().find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent).toBe("Suspended");
    expect(container.querySelector("[data-testid='journey-nda-reason']")?.textContent).toContain("Omni was already under way");
    expect(container.textContent).toContain("by John, not waived");
  });
});
