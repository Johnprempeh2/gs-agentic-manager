// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => ({ state: "denied" as string }));
const phone = vi.hoisted(() => ({ isPhone: false }));

vi.mock("../../hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({
    state: push.state,
    error: null,
    enable: vi.fn(),
    disable: vi.fn(),
    sendTest: vi.fn(),
  }),
}));
vi.mock("../../hooks/useIsPhone", () => ({ useIsPhone: () => phone.isPhone }));

import { DecisionNotificationsCard } from "./DecisionNotificationsCard";

function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<DecisionNotificationsCard companyId="company-1" />));
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("DecisionNotificationsCard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    push.state = "denied";
  });

  it("gives browser advice on a desktop when notifications are blocked", () => {
    phone.isPhone = false;
    const { container, unmount } = render();
    expect(container.textContent).toContain("browser's site settings");
    expect(container.textContent).not.toContain("phone's Settings");
    unmount();
  });

  it("gives phone advice on a phone", () => {
    phone.isPhone = true;
    const { container, unmount } = render();
    expect(container.textContent).toContain("phone's Settings");
    unmount();
  });

  it("stays hidden on later visits after OK is pressed", () => {
    phone.isPhone = false;
    const first = render();
    const ok = first.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notifications notice"]');
    expect(ok).not.toBeNull();
    act(() => ok!.click());
    expect(first.container.querySelector('[data-testid="decision-notifications-denied"]')).toBeNull();
    first.unmount();

    const later = render();
    expect(later.container.querySelector('[data-testid="decision-notifications-denied"]')).toBeNull();
    later.unmount();
  });

  it("shows the blocked notice on one visit only, even without OK", () => {
    phone.isPhone = false;
    const first = render();
    expect(first.container.querySelector('[data-testid="decision-notifications-denied"]')).not.toBeNull();
    first.unmount();

    const later = render();
    expect(later.container.querySelector('[data-testid="decision-notifications-denied"]')).toBeNull();
    later.unmount();
  });

  it("still offers notifications after the blocked notice was seen, once they are unblocked", () => {
    phone.isPhone = false;
    render().unmount();
    push.state = "off";
    const later = render();
    expect(later.container.querySelector('[data-testid="decision-notifications-offer"]')).not.toBeNull();
    later.unmount();
  });
});
