import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { authApi } from "./auth";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authApi.getSession", () => {
  it("returns null for an ordinary local 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getSession()).resolves.toBeNull();
  });

  it("initiates recovery and stays pending for a Cloud tenant-session 401", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = authApi.getSession();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe("authApi.signUpEmail", () => {
  function okFetch() {
    return vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "session", user: { id: "user-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("sends the invite token in its own header, never in the body", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await authApi.signUpEmail(
      { name: "Ben", email: "ben@example.com", password: "long-enough-password" },
      { inviteToken: " pcp_invite_abc " },
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-up/email", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-gsam-invite-token": "pcp_invite_abc",
      },
      body: JSON.stringify({ name: "Ben", email: "ben@example.com", password: "long-enough-password" }),
    });
  });

  it("sends no invite header for an ordinary sign-up", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await authApi.signUpEmail({ name: "Ann", email: "ann@example.com", password: "long-enough-password" });
    await authApi.signUpEmail(
      { name: "Ann", email: "ann@example.com", password: "long-enough-password" },
      { inviteToken: "   " },
    );

    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers).toEqual({ "Content-Type": "application/json" });
    }
  });
});

describe("authApi.signOut", () => {
  it("returns the managed deployment redirect from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, redirectTo: "/cloud/logout" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.signOut()).resolves.toEqual({
      success: true,
      redirectTo: "/cloud/logout",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});
