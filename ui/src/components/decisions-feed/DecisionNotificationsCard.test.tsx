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
});
