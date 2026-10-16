// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "@greatstone/shared";
import { NotificationSettings, hourLabel } from "./NotificationSettings";

const server = vi.hoisted(() => ({
  prefs: null as NotificationPreferences | null,
  patches: [] as Array<Record<string, unknown>>,
}));

vi.mock("../api/notificationPreferences", () => ({
  notificationPreferencesApi: {
    get: async () => ({ ...server.prefs! }),
    update: async (_companyId: string, patch: Record<string, unknown>) => {
      server.patches.push(patch);
      server.prefs = { ...server.prefs!, ...patch } as NotificationPreferences;
      return { ...server.prefs };
    },
  },
}));
vi.mock("../hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({ state: "off", error: null, enable: vi.fn(), disable: vi.fn(), sendTest: vi.fn() }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  server.prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  server.patches = [];
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <NotificationSettings />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const toggle = (label: string) => container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;

describe("NotificationSettings", () => {
  it("shows each choice in plain words, all on by default", async () => {
    await render();
    expect(container.textContent).toContain("Notifications are off for this computer.");
    for (const label of ["A decision needs me", "A task is given to me", "Someone messages a team chat I am in"]) {
      expect(toggle(label).getAttribute("aria-checked")).toBe("true");
    }
    expect(toggle("Use quiet hours").getAttribute("aria-checked")).toBe("false");
  });

  it("saves a switch straight away", async () => {
    await render();
    await act(async () => { toggle("Someone messages a team chat I am in").click(); });
    await flush();
    expect(server.patches).toEqual([{ teamChat: false }]);
    expect(toggle("Someone messages a team chat I am in").getAttribute("aria-checked")).toBe("false");
  });

  it("turns quiet hours on from 22:00 to 07:00", async () => {
    await render();
    await act(async () => { toggle("Use quiet hours").click(); });
    await flush();
    expect(server.patches).toEqual([{ quietHoursStart: 22, quietHoursEnd: 7 }]);
    expect(container.textContent).toContain("From 22:00 to 07:00, your time.");
  });

  it("offers the weekly report on Monday mornings, off until chosen", async () => {
    await render();
    const label = "Send me the weekly report on Monday mornings";
    expect(toggle(label).getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle(label).click(); });
    await flush();
    expect(server.patches).toEqual([{ weeklyReport: true }]);
    expect(container.textContent).toContain("Every Monday at 08:00, your time.");
  });

  it("formats hours as a 24 hour clock", () => {
    expect(hourLabel(7)).toBe("07:00");
    expect(hourLabel(22)).toBe("22:00");
  });
});
