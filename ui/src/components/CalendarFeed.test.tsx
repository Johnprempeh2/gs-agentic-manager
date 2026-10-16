// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarFeedDialog, calendarFeedStatusLine } from "./CalendarFeed";

const mocks = vi.hoisted(() => ({ status: vi.fn(), enable: vi.fn(), disable: vi.fn() }));

vi.mock("@/api/calendar", () => ({
  calendarApi: { feedStatus: mocks.status, enableFeed: mocks.enable, disableFeed: mocks.disable },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CalendarFeedDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

  it("is off until turned on, then shows the private address once", async () => {
    mocks.status.mockResolvedValueOnce({ enabled: false, lastFetchedAt: null }).mockResolvedValue({ enabled: true, lastFetchedAt: null });
    mocks.enable.mockResolvedValue({ path: "/api/calendar-feeds/gsam_cal_abc.ics", token: "gsam_cal_abc" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CalendarFeedDialog companyId="company-1" open onOpenChange={() => {}} />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(document.body.textContent).toContain("Turned off.");
    await act(async () => { button("Turn on").click(); });
    await flush();
    expect(mocks.enable).toHaveBeenCalledWith("company-1");
    expect((document.body.querySelector("#calendar-feed-url") as HTMLInputElement).value).toBe(
      `${window.location.origin}/api/calendar-feeds/gsam_cal_abc.ics`,
    );
    expect(document.body.textContent).toContain("Outlook: Add calendar, then Subscribe from web");
  });

  it("words the card status", () => {
    expect(calendarFeedStatusLine({ enabled: false, lastFetchedAt: null })).toBeNull();
    expect(calendarFeedStatusLine({ enabled: true, lastFetchedAt: null })).toContain("No calendar app has subscribed yet");
    expect(calendarFeedStatusLine({ enabled: true, lastFetchedAt: new Date().toISOString() })).toContain("last checked for changes");
  });
});
