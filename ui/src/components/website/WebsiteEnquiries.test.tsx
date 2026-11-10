// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WebsiteEnquiriesView } from "./WebsiteEnquiries";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WebsiteEnquiriesView", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("says what to do next when there are no enquiries, and names the button it points to", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<WebsiteEnquiriesView leads={[]} onCheck={() => {}} />));
    const button = container.querySelector("button")!.textContent!;
    expect(container.querySelector("h2")!.textContent).toBe("Enquiries");
    expect(button).toBe("Check for new enquiries");
    expect(container.textContent).toContain(`No enquiries yet. Press ${button}`);
    act(() => root.unmount());
  });
});
