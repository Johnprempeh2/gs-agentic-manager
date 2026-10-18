// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ listSignInHistory: vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: auth }));

const { SignInHistorySection } = await import("./SignInHistorySection");

const now = new Date().toISOString();
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const android = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";

describe("SignInHistorySection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    auth.listSignInHistory.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(waitFor: string) {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}><SignInHistorySection /></QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(container.textContent).toContain(waitFor));
  }

  it("lists each attempt with its device and address, and counts the ones that did not finish", async () => {
    auth.listSignInHistory.mockResolvedValue([
      { id: "e1", outcome: "signed_in", ipAddress: "81.2.69.160", userAgent: mac, at: now },
      { id: "e2", outcome: "wrong_password", ipAddress: "203.0.113.9", userAgent: android, at: now },
      { id: "e3", outcome: "code_needed", ipAddress: "203.0.113.9", userAgent: android, at: now },
    ]);
    await render("Wrong password");
    expect(container.textContent).toContain("Signed in");
    expect(container.textContent).toContain("Safari on Mac · 81.2.69.160");
    expect(container.textContent).toContain("Right password, two-step code not given");
    expect(container.textContent).toContain("2 of these did not finish signing in");
  });

  it("says so when nothing is recorded yet", async () => {
    auth.listSignInHistory.mockResolvedValue([]);
    await render("No sign-ins recorded yet.");
  });
});
