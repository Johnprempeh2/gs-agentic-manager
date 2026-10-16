// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsNew } from "./WhatsNew";
import { LATEST_WHATS_NEW_ID, WHATS_NEW, useWhatsNewUnseen } from "@/lib/whats-new";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
let unseen: boolean | null = null;

function UnseenProbe() {
  unseen = useWhatsNewUnseen();
  return null;
}

async function render(withPage: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <MemoryRouter>
      <UnseenProbe />
      {withPage ? <WhatsNew /> : null}
    </MemoryRouter>,
  ));
}

describe("What's new", () => {
  beforeEach(() => {
    window.localStorage.clear();
    unseen = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
  });

  it("shows the New badge state until the page is opened", async () => {
    await render(false);
    expect(unseen).toBe(true);
    await act(async () => root!.unmount());
    container.remove();

    await render(true);
    expect(unseen).toBe(false);
    expect(window.localStorage.getItem("gsam.whatsNew.seen")).toBe(LATEST_WHATS_NEW_ID);
  });

  it("lists every area with a plain sentence and a link to try it", async () => {
    await render(true);
    const release = WHATS_NEW[0];
    const section = container.querySelector(`[data-testid="whats-new-${release.id}"]`)!;
    expect(section).not.toBeNull();
    const headings = [...section.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(release.areas.map((area) => area.area));
    const linked = release.areas.flatMap((area) => area.entries).filter((entry) => entry.to);
    expect(section.querySelectorAll("a").length).toBe(linked.length);
    expect(section.querySelector('a[href="/weekly-report"]')).not.toBeNull();
  });

  it("writes every entry as one sentence with no dashes", () => {
    for (const entry of WHATS_NEW.flatMap((release) => release.areas.flatMap((area) => area.entries))) {
      expect(entry.text).toMatch(/\.$/);
      expect(entry.text).not.toMatch(/[–—]/);
    }
  });
});
