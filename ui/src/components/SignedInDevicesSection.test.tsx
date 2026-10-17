// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({
  listSessions: vi.fn(),
  signOutDevice: vi.fn(),
  signOutOtherDevices: vi.fn(),
}));
vi.mock("@/api/auth", () => ({ authApi: auth }));

const { SignedInDevicesSection, describeDevice } = await import("./SignedInDevicesSection");

const now = new Date().toISOString();
const here = {
  id: "s-here",
  createdAt: now,
  lastActiveAt: now,
  expiresAt: now,
  ipAddress: "81.2.69.160",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  current: true,
};
const phone = {
  ...here,
  id: "s-phone",
  ipAddress: "203.0.113.9",
  userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36",
  current: false,
};

describe("describeDevice", () => {
  it("names the browser and system in plain words", () => {
    expect(describeDevice(here.userAgent)).toBe("Safari on Mac");
    expect(describeDevice(phone.userAgent)).toBe("Chrome on Android");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36 Edg/129.0")).toBe("Edge on Windows");
    expect(describeDevice("curl/8.5.0")).toBe("A script");
    expect(describeDevice(null)).toBe("Unknown device");
  });
});

describe("SignedInDevicesSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    auth.listSessions.mockReset().mockResolvedValue([here, phone]);
    auth.signOutDevice.mockReset().mockResolvedValue(undefined);
    auth.signOutOtherDevices.mockReset().mockResolvedValue(1);
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
      <QueryClientProvider client={new QueryClient()}><SignedInDevicesSection /></QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(container.textContent).toContain("Chrome on Android"));
  }

  const button = (label: string) =>
    [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);

  it("lists each device, marks this one, and offers sign-out only for the others", async () => {
    await render();
    expect(container.textContent).toContain("Safari on Mac");
    expect(container.textContent).toContain("This device");
    expect(container.textContent).toContain("203.0.113.9");
    expect(button("Sign out")).toHaveLength(1);
  });

  it("signs out one device, then everywhere else", async () => {
    await render();
    await act(async () => button("Sign out")[0]!.click());
    expect(auth.signOutDevice).toHaveBeenCalledWith("s-phone");

    await act(async () => button("Sign out everywhere else")[0]!.click());
    expect(auth.signOutOtherDevices).toHaveBeenCalled();
    await vi.waitFor(() => expect(auth.listSessions.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("hides the sign-out-everywhere button when this is the only device", async () => {
    auth.listSessions.mockResolvedValue([here]);
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}><SignedInDevicesSection /></QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(container.textContent).toContain("This device"));
    expect(button("Sign out everywhere else")).toHaveLength(0);
  });
});
