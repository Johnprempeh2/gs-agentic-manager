import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { healthApi, healthPollInterval, type HealthStatus } from "./health";

describe("healthPollInterval", () => {
  const withDevServer = (restartRequired: boolean) =>
    ({ status: "ok", devServer: { enabled: true, restartRequired } }) as HealthStatus;

  it("polls fast only while a dev-server restart is pending", () => {
    expect(healthPollInterval(withDevServer(true))).toBe(2000);
    expect(healthPollInterval(withDevServer(false))).toBe(30_000);
  });

  it("does not poll a server without the dev watcher", () => {
    expect(healthPollInterval({ status: "ok" })).toBe(false);
    expect(healthPollInterval(undefined)).toBe(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("healthApi", () => {
  it("initiates tenant-session recovery and keeps the bootstrap request pending", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = healthApi.get();
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
