// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Field, InlineField, ToggleField } from "./agent-config-primitives";

vi.mock("../adapters/adapter-display-registry", () => ({ getAdapterLabels: () => ({}) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("agent-config primitives accessible names (GRE-900)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  function render(node: React.ReactNode) {
    const root = createRoot(container);
    flushSync(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
    return root;
  }

  function ariaLabels(selector: string) {
    return Array.from(container.querySelectorAll(selector)).map((el) => el.getAttribute("aria-label"));
  }

  it("names the help icon after its field label", () => {
    const root = render(
      <>
        <Field label="Organization name" hint="The display name.">
          <input />
        </Field>
        <InlineField label="Hourly wage" hint="Rate per hour.">
          <input />
        </InlineField>
      </>,
    );
    expect(ariaLabels("button")).toEqual(["About Organization name", "About Hourly wage"]);
    flushSync(() => root.unmount());
  });

  it("names the toggle switch and its help icon after the toggle label", () => {
    const root = render(
      <ToggleField
        label="Require board approval for new hires"
        hint="New hires stay pending."
        checked={false}
        onChange={() => {}}
      />,
    );
    expect(ariaLabels('[role="switch"]')).toEqual(["Require board approval for new hires"]);
    expect(ariaLabels("button:not([role])")).toEqual(["About Require board approval for new hires"]);
    flushSync(() => root.unmount());
  });
});
