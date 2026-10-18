// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryApps } from "./MemoryApps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graphApiMock = vi.hoisted(() => ({
  scopes: vi.fn(),
  importEntries: vi.fn(),
  checkImport: vi.fn(),
  connections: vi.fn(),
  createConnection: vi.fn(),
  revokeConnection: vi.fn(),
  connectionActivity: vi.fn(),
  settings: vi.fn(),
  updateSettings: vi.fn(),
  appSignInStatus: vi.fn(),
}));

const accessApiMock = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));

vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: graphApiMock }));
vi.mock("../api/access", () => ({ accessApi: accessApiMock }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-kestrel" }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useNavigate: actual.useNavigate,
    useSearchParams: actual.useSearchParams,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/memory/apps"]}>
          <Routes>
            <Route path="/memory/apps" element={<MemoryApps />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const body = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

function typeInto(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const scopes = [
  { id: "scope-agent", companyId: "co-kestrel", kind: "agent", name: "Mason notes", projectId: null, agentId: "a1", createdAt: "" },
  { id: "scope-org", companyId: "co-kestrel", kind: "organization", name: "Greatstone", projectId: null, agentId: null, createdAt: "" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  graphApiMock.scopes.mockResolvedValue(scopes);
  graphApiMock.connections.mockResolvedValue([]);
  accessApiMock.listUserDirectory.mockResolvedValue({ users: [] });
  graphApiMock.connectionActivity.mockResolvedValue({ lastUsedAt: null, operations: [], contributions: [] });
  graphApiMock.checkImport.mockImplementation(async (_companyId: string, body: { entries: Array<{ sourceId: string }> }) => ({
    entries: body.entries.map((entry) => ({ sourceId: entry.sourceId, match: null, existing: null })),
  }));
  graphApiMock.importEntries.mockResolvedValue({ added: 2, alreadyImported: 0, heldBack: 0, entries: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("MemoryApps", () => {
  it("turns a pasted answer into entries and adds the ticked ones to the organisation scope", async () => {
    await render();
    expect(body()).toContain("Bring what Claude and ChatGPT know into shared memory");
    // Agent working notes are not offered as a place to import into.
    expect([...document.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Greatstone"]);

    typeInto(document.querySelector("textarea")!, "- Runs Greatstone International\n- Prefers British English\n");
    await flush();
    expect(body()).toContain("2 of 2 ticked");

    await act(async () => button("Add 2 to memory").click());
    await flush();
    expect(graphApiMock.importEntries).toHaveBeenCalledWith(
      "co-kestrel",
      expect.objectContaining({
        scopeId: "scope-org",
        app: "chatgpt",
        via: "paste",
        entries: [
          expect.objectContaining({ content: "Runs Greatstone International" }),
          expect.objectContaining({ content: "Prefers British English" }),
        ],
      }),
    );
    expect(body()).toContain("2 added");
    expect(body()).toContain("Review");
  });

  it("unticks entries memory already has and says why", async () => {
    graphApiMock.checkImport.mockImplementation(async (_companyId: string, body: { entries: Array<{ sourceId: string }> }) => ({
      entries: body.entries.map((entry, index) =>
        index === 0
          ? { sourceId: entry.sourceId, match: "already_imported", existing: { recordId: "r1", title: null, status: "unreviewed" } }
          : index === 1
            ? { sourceId: entry.sourceId, match: "similar", existing: { recordId: "r2", title: "Language", status: "accepted" } }
            : { sourceId: entry.sourceId, match: null, existing: null },
      ),
    }));
    await render();
    typeInto(document.querySelector("textarea")!, "- Runs Greatstone International\n- Prefers British English\n- Based in London\n");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    await flush();
    expect(graphApiMock.checkImport).toHaveBeenCalledWith("co-kestrel", expect.objectContaining({ scopeId: "scope-org", app: "chatgpt" }));
    expect(body()).toContain("1 of 3 ticked");
    expect(body()).toContain("Already in memory, so it is unticked.");
    expect(body()).toContain('Looks like an entry already in memory: "Language"');
    expect(body()).toContain("2 look like things memory already has");
  });

  it("connects Claude and shows the key once inside the setup text", async () => {
    graphApiMock.createConnection.mockResolvedValue({
      token: "tok_once",
      connection: { agentId: "a-link", app: "claude", name: "Claude desktop app memory link", createdByUserId: "u1", canContribute: true, keys: [] },
    });
    await render();
    await act(async () => button("Connect Claude desktop app").click());
    await flush();
    expect(graphApiMock.createConnection).toHaveBeenCalledWith("co-kestrel", { app: "claude", canContribute: true });
    expect(body()).toContain("the key is shown only once");
    expect(document.querySelector("pre")?.textContent).toContain("Bearer tok_once");
    expect(body()).toContain("Waiting for Claude desktop app to use memory");
  });

  it("says it works once the app has searched memory", async () => {
    graphApiMock.createConnection.mockResolvedValue({
      token: "tok_once",
      connection: { agentId: "a-link", app: "claude", name: "Claude desktop app memory link", createdByUserId: "u1", canContribute: true, keys: [] },
    });
    graphApiMock.connectionActivity.mockResolvedValue({
      lastUsedAt: "2026-10-16T00:41:00Z",
      operations: [{ id: "op1", operation: "recall", outcome: "ok", recordId: null, createdAt: "2026-10-16T00:41:00Z" }],
      contributions: [],
    });
    await render();
    await act(async () => button("Connect Claude desktop app").click());
    await flush();
    expect(body()).toContain("It works.");
    expect(body()).toContain("searched memory");
  });

  it("names the owner of each connected app, with a fallback when the owner is not known", async () => {
    const connection = (agentId: string, app: string, createdByUserId: string | null) => ({
      agentId, app, name: `${app} memory link`, createdByUserId, canContribute: true, keys: [],
    });
    graphApiMock.connections.mockResolvedValue([
      connection("a-ada", "claude", "u-ada"),
      connection("a-ben", "codex", "u-ben"),
      connection("a-gone", "claude_code", "u-gone"),
      connection("a-none", "other", null),
    ]);
    accessApiMock.listUserDirectory.mockResolvedValue({
      users: [
        { principalId: "u-ada", status: "active", user: { id: "u-ada", email: "ada@example.com", name: "Ada Lovelace", image: null } },
        { principalId: "u-ben", status: "active", user: { id: "u-ben", email: "ben@example.com", name: null, image: null } },
      ],
    });
    await render();
    for (let i = 0; i < 10 && !body().includes("Connected by"); i += 1) await flush();
    const rows = [...document.querySelectorAll("li")]
      .map((row) => row.textContent ?? "")
      .filter((text) => text.includes("Disconnect"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("Connected by Ada Lovelace");
    expect(rows[1]).toContain("Connected by ben@example.com");
    expect(rows[2]).toContain("Owner unknown");
    expect(rows[3]).toContain("Owner unknown");
    expect(accessApiMock.listUserDirectory).toHaveBeenCalledWith("co-kestrel");
  });

  async function pickApp(name: string) {
    const option = [...document.querySelectorAll('[aria-label="App to connect"] button')].find((el) => el.textContent?.includes(name)) as HTMLButtonElement;
    await act(async () => option.click());
    await flush();
  }

  it("says when this GSAM does not offer sign-in for ChatGPT", async () => {
    graphApiMock.appSignInStatus.mockRejectedValue(new Error("not found"));
    graphApiMock.settings.mockResolvedValue({ companyId: "co-kestrel", enabled: true, retainMode: "extract", appSignIn: false, updatedAt: null });
    await render();
    await pickApp("ChatGPT");
    expect(body()).toContain("this GSAM does not offer that sign-in");
    expect(button("Connect ChatGPT")).toBeUndefined();
  });

  it("lets an owner turn on app sign-in, then shows the ChatGPT steps with the address", async () => {
    graphApiMock.appSignInStatus.mockResolvedValue({ mcpUrl: "https://memory.example.com/api/mcp/memory-tools" });
    graphApiMock.settings.mockResolvedValue({ companyId: "co-kestrel", enabled: true, retainMode: "extract", appSignIn: false, updatedAt: null });
    graphApiMock.updateSettings.mockResolvedValue({ companyId: "co-kestrel", enabled: true, retainMode: "extract", appSignIn: true, updatedAt: null });
    await render();
    await pickApp("ChatGPT");
    expect(body()).toContain("App sign-in is off");
    await act(async () => button("Turn on app sign-in")!.click());
    await flush();
    expect(graphApiMock.updateSettings).toHaveBeenCalledWith("co-kestrel", { appSignIn: true });
    expect(body()).toContain("https://memory.example.com/api/mcp/memory-tools");
    expect(body()).toContain("voice mode");
    expect(button("Connect ChatGPT")).toBeUndefined();
  });
});
