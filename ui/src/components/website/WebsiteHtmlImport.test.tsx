// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteSite } from "@greatstone/shared";
import { ApiError } from "../../api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleMock = vi.hoisted(() => ({ importHtml: vi.fn() }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleMock };
});

import { WebsiteHtmlImport, importErrorMessage } from "./WebsiteHtmlImport";

const site = { id: "site-2", companyId: "co-1", name: "Greatstone staging" } as WebsiteSite;

const release = {
  schema: 2,
  stylesheet: "",
  chrome: {},
  pages: [
    { slug: "/", title: "Home", html: "<h1>Home</h1>" },
    { slug: "/about", title: "About", html: "<h1>About</h1>" },
  ],
};

describe("WebsiteHtmlImport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <WebsiteHtmlImport companyId="co-1" site={site} />
        </QueryClientProvider>,
      );
    });
  }

  async function chooseAndImport(contents: string) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([contents], "html-export-release.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    const submit = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Import HTML")!;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
  }

  it("sends the chosen release file to this site and shows how many pages became drafts", async () => {
    moduleMock.importHtml.mockResolvedValue({ redirects: [], created: ["/about"], updated: ["/"], unchanged: [], chrome: ["header"] });
    await render();
    const submit = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Import HTML")!;
    expect(submit.disabled).toBe(true);
    await chooseAndImport(JSON.stringify(release));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="website-html-import-result"]')).not.toBeNull());
    expect(moduleMock.importHtml).toHaveBeenCalledWith("co-1", "site-2", release);
    const result = container.querySelector('[data-testid="website-html-import-result"]')!.textContent!;
    expect(result).toContain("2 pages became drafts.");
    expect(result).toContain("1 new, 1 changed, 0 unchanged.");
    expect(result).toContain("Nothing is live yet.");
  });

  it("refuses a file that is not JSON or not schema 2 without calling the server", async () => {
    await render();
    await chooseAndImport("<html>not json</html>");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("This file is not JSON."));
    await chooseAndImport(JSON.stringify({ ...release, schema: 1 }));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("not a release file of schema 2"));
    expect(moduleMock.importHtml).not.toHaveBeenCalled();
  });

  it("puts a server refusal in plain words", async () => {
    moduleMock.importHtml.mockRejectedValue(
      new ApiError("Validation error", 400, { error: "Validation error", details: [{ path: ["pages", 0, "slug"], message: "Invalid" }] }),
    );
    await render();
    await chooseAndImport(JSON.stringify(release));
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "The file does not match the release format (pages.0.slug: Invalid). Export the site again and choose the new file.",
      ),
    );
    expect(importErrorMessage(new ApiError("Board access required", 403, null))).toBe("Only a person with Publish rights can import HTML.");
  });
});
