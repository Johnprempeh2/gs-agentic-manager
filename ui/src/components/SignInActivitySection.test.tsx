// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getSignInActivity: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: api }));

const { SignInActivitySection } = await import("./SignInActivitySection");

const now = new Date().toISOString();
const android = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";

describe("SignInActivitySection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    api.getSignInActivity.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}><SignInActivitySection /></QueryClientProvider>,
    ));
  }

  it("shows the day's counts and each unfinished attempt with whose account it was", async () => {
    api.getSignInActivity.mockResolvedValue({
      since: now,
      counts: { signedIn: 4, wrongPassword: 3, codeNeeded: 1 },
      events: [
        { id: "e1", outcome: "code_needed", ipAddress: "203.0.113.9", userAgent: android, at: now, user: { id: "u1", email: "ben@example.com", name: "Ben" } },
        { id: "e2", outcome: "wrong_password", ipAddress: null, userAgent: null, at: now, user: { id: "u2", email: "amy@example.com", name: null } },
      ],
    });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Sign-in activity"));
    expect(container.textContent).toContain("4 sign-ins, 3 wrong passwords, 1 stopped at the two-step code");
    expect(container.textContent).toContain("Ben · Right password, two-step code not given");
    expect(container.textContent).toContain("Chrome on Android · 203.0.113.9");
    expect(container.textContent).toContain("amy@example.com · Wrong password");
  });

  it("shows nothing to someone who is not an instance admin", async () => {
    api.getSignInActivity.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    await render();
    await vi.waitFor(() => expect(api.getSignInActivity).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});
