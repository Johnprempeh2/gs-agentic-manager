// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridgeMock = vi.hoisted(() => ({ status: vi.fn(), createKey: vi.fn() }));
vi.mock("../../api/website-data-bridge", () => ({ websiteDataBridgeApi: bridgeMock }));

import { WebsiteDataBridgeRow } from "./WebsiteDataBridgeRow";

const site = { id: "site-1", companyId: "co-1", domain: "www.greatstone.example" } as WebsiteSite;
const notSetUp = { state: "not_set_up", keyId: null, url: "https://www.greatstone.example", checkedAt: null, message: null, clockSkewSeconds: null };

async function flush() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("WebsiteDataBridgeRow", () => {
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
    vi.resetAllMocks();
  });

  function render(canManage: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={client}><WebsiteDataBridgeRow companyId="co-1" site={site} canManage={canManage} /></QueryClientProvider>));
  }
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);

  const line = (capability: string) => container.querySelector(`[data-testid=website-data-bridge-key-${capability}]`)!;
  const lineButton = (capability: string, text: string) => [...line(capability).querySelectorAll("button")].find((b) => b.textContent === text);
  const submit = () => act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  it("shows one line per key, with its id and when it was made, or Not set", async () => {
    bridgeMock.status.mockResolvedValue({ ...notSetUp, state: "connected", keyId: "stg-read-2026-10-abc123",
      writeKeyId: "live-write-2026-09-def456", refundKeyId: null });
    render(false);
    await flush();
    expect(line("read").textContent).toContain("stg-read-2026-10-abc123");
    expect(line("read").textContent).toContain("Staging site, made October 2026");
    expect(line("write").textContent).toContain("live-write-2026-09-def456");
    expect(line("write").textContent).toContain("Live site, made September 2026");
    expect(line("refund_request").textContent).toContain("Not set");
  });

  it("says when GSAM cannot read yet, and shows no key button without Publish rights", async () => {
    bridgeMock.status.mockResolvedValue(notSetUp);
    render(false);
    await flush();
    expect(container.textContent).toContain("Not set up.");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("makes a read key and shows only the public entry to add to GSAM_BRIDGE_KEYS", async () => {
    bridgeMock.status.mockResolvedValue(notSetUp);
    const keysEntry = { kid: "stg-read-2026-10-abc123", capability: "read", publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg" };
    bridgeMock.createKey.mockResolvedValue({ keyId: keysEntry.kid, capability: "read", publicKey: keysEntry.publicKey, keysEntry });
    render(true);
    await flush();
    act(() => lineButton("read", "Make key")!.click());
    submit();
    await flush();
    expect(bridgeMock.createKey).toHaveBeenCalledWith("co-1", "site-1", { environment: "stg", capability: "read", url: undefined });
    expect(container.querySelector("[data-testid=website-data-bridge-entry]")!.textContent).toBe(JSON.stringify(keysEntry));
    expect(container.textContent).toContain("GSAM_BRIDGE_KEYS");
  });

  it.each([["write"], ["refund_request"]])("makes a missing %s key with that capability", async (capability) => {
    bridgeMock.status.mockResolvedValue({ ...notSetUp, state: "connected", keyId: "stg-read-2026-10-abc123", writeKeyId: null, refundKeyId: null });
    const keysEntry = { kid: `live-${capability}-2026-10-abc123`, capability, publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg" };
    bridgeMock.createKey.mockResolvedValue({ keyId: keysEntry.kid, capability, publicKey: keysEntry.publicKey, keysEntry });
    render(true);
    await flush();
    expect(lineButton("read", "Make key")).toBeUndefined();
    act(() => lineButton(capability, "Make key")!.click());
    const select = container.querySelector("select")!;
    act(() => { select.value = "live"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    submit();
    await flush();
    expect(bridgeMock.createKey).toHaveBeenCalledWith("co-1", "site-1", { environment: "live", capability, url: undefined });
    expect(container.querySelector("[data-testid=website-data-bridge-entry]")!.textContent).toBe(JSON.stringify(keysEntry));
  });

  it("shows why the site is not reading", async () => {
    bridgeMock.status.mockResolvedValue({ ...notSetUp, state: "failing", keyId: "stg-read-2026-10-abc123",
      message: "The website refused GSAM's read key. Check that the key id shown in GSAM is in the site's GSAM_BRIDGE_KEYS." });
    render(true);
    await flush();
    expect(container.textContent).toContain("Not reading.");
    expect(container.textContent).toContain("refused GSAM's read key");
    expect(lineButton("read", "Make a new key")).toBeDefined();
  });
});
