// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mailboxes } from "./Mailboxes";

const listMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/mailboxes", () => ({
  mailboxesApi: {
    list: listMock,
    connect: connectMock,
    setAgents: vi.fn(),
    test: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [
      { id: "11111111-1111-4111-8111-111111111111", name: "Mail Reader", status: "idle" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Gone", status: "terminated" },
    ]),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Radix checkboxes measure themselves; jsdom has no ResizeObserver.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  for (let index = 0; index < 6; index += 1)
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
}

function button(text: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const mailbox = {
  id: "mb-1",
  label: "Work",
  address: "john@greatstone.example",
  host: "imap.greatstone.example",
  port: 993,
  secure: true,
  username: "john@greatstone.example",
  provider: "imap",
  healthStatus: "ok",
  healthMessage: "Connected",
  healthCheckedAt: null,
  allAgents: false,
  agentIds: ["11111111-1111-4111-8111-111111111111"],
  createdAt: "2026-10-11T00:00:00.000Z",
};

describe("Mailboxes page", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    listMock.mockResolvedValue([mailbox]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Mailboxes />
        </QueryClientProvider>,
      ),
    );
    await flush();
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("lists connected mailboxes with their assigned agents", () => {
    expect(container.textContent).toContain("Work · john@greatstone.example");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Mail Reader");
  });

  it("fills Gmail settings, submits the mailbox, and clears the password", async () => {
    connectMock.mockResolvedValue({ ...mailbox, id: "mb-2", address: "john@gmail.com" });
    await act(() => button("Add mailbox")!.click());
    await type("mailbox-address", "john@gmail.com");
    expect((document.getElementById("mailbox-host") as HTMLInputElement).value).toBe("imap.gmail.com");
    expect(container.textContent).toContain("app password");
    await type("mailbox-password", "abcd efgh ijkl mnop");
    // Terminated agents are not offered.
    expect(container.textContent).not.toContain("Gone");
    await act(() => button("Connect")!.click());
    await flush();
    expect(connectMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        address: "john@gmail.com",
        label: "john@gmail.com",
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        username: "john@gmail.com",
        password: "abcd efgh ijkl mnop",
        allAgents: false,
        agentIds: [],
      }),
    );
    expect(document.getElementById("mailbox-password")).toBeNull();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "john@gmail.com is connected" }));
  });

  it("keeps the form open and shows why when sign-in fails", async () => {
    connectMock.mockRejectedValue(new Error("Mailbox sign-in failed. Check the username and app password."));
    await act(() => button("Add mailbox")!.click());
    await type("mailbox-address", "john@example.com");
    await type("mailbox-host", "imap.example.com");
    await type("mailbox-password", "wrong");
    await act(() => button("Connect")!.click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("sign-in failed");
    expect(document.getElementById("mailbox-password")).not.toBeNull();
  });
});
