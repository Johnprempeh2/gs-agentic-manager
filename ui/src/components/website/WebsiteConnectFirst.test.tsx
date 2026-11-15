// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Database } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteConnectFirst } from "./WebsiteConnectFirst";

let root: Root;
let container: HTMLDivElement;
let search = "";

function Where() {
  search = useLocation().search;
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WebsiteConnectFirst", () => {
  it("says what the tab needs and opens Releases, where the site is connected", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/website?tab=collections"]}>
          <WebsiteConnectFirst icon={Database} message="Entries are edited here once the site is connected." />
          <Where />
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("Connect the site first");
    const open = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Open Releases"));
    expect(open).toBeTruthy();
    await act(async () => open!.click());
    expect(new URLSearchParams(search).get("tab")).toBe("releases");
  });
});
