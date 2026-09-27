// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PALETTE_IDS, GREATSTONE_AGENT_PALETTE_IDS, appearanceForPalette } from "@greatstone/shared";
import { AgentAppearanceEditor } from "./AgentAppearanceEditor";
import { AgentAppearancePicker } from "./AgentAppearancePicker";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { id: "agent-1", name: "Everest", status: "idle", appearance: appearanceForPalette("violet-ember") };
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(JSON.stringify({ ...agent, ...JSON.parse(String(init?.body ?? "{}")) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function radio(label: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`);
  if (!input) throw new Error(`No palette option labelled ${label}`);
  return input;
}
function button(name: string) {
  const match = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
  if (!match) throw new Error(`No button ${name}`);
  return match;
}

describe("AgentAppearanceEditor", () => {
  it("PATCHes the agent with the chosen palette as its appearance", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => root.render(
      <QueryClientProvider client={client}><AgentAppearanceEditor agent={agent} companyId="company-1" /></QueryClientProvider>,
    ));

    await act(async () => button("Change Everest's colour").click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Agent colour");
    expect(radio("Violet ember").checked).toBe(true);
    expect(document.activeElement).toBe(radio("Violet ember"));
    expect(button("Save colour").disabled).toBe(true);

    await act(async () => radio("Lime").click());
    expect(radio("Lime").checked).toBe(true);
    expect(document.body.textContent).toContain("Lime, Greatstone");
    expect(button("Save colour").disabled).toBe(false);

    await act(async () => button("Save colour").click());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/agents/agent-1?companyId=company-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "gs-lime" },
    });
    // Every avatar of this agent reads its palette from these queries.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents", "detail"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents", "company-1"], exact: true });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the picker open with the message when saving fails, and Cancel discards the draft", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Agent not found" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}><AgentAppearanceEditor agent={agent} companyId="company-1" /></QueryClientProvider>,
    ));
    await act(async () => button("Change Everest's colour").click());
    await act(async () => radio("Tide").click());
    await act(async () => button("Save colour").click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => button("Cancel").click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Change Everest's colour").click());
    expect(radio("Violet ember").checked).toBe(true);
  });
});

describe("AgentAppearancePicker", () => {
  it("offers every palette as one labelled radio group, Greatstone first", async () => {
    await act(async () => root.render(
      <AgentAppearancePicker value={appearanceForPalette("deep-tide")} agentName="Atlas" onSave={() => undefined}>
        <button type="button">Open</button>
      </AgentAppearancePicker>,
    ));
    await act(async () => button("Open").click());
    const legends = [...document.body.querySelectorAll("fieldset > legend")].map((legend) => legend.textContent);
    expect(legends).toEqual(["Greatstone", "Classic"]);
    const radios = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(AGENT_PALETTE_IDS.length);
    expect(new Set(radios.map((input) => input.name)).size).toBe(1);
    expect(radios.slice(0, GREATSTONE_AGENT_PALETTE_IDS.length).map((input) => input.value)).toEqual([...GREATSTONE_AGENT_PALETTE_IDS]);
    expect(radios.every((input) => input.getAttribute("aria-label"))).toBe(true);
    const preview = document.body.querySelector('[role="img"]');
    expect(preview?.getAttribute("aria-label")).toBe("Atlas in Deep tide");
    await act(async () => radio("Orchid").click());
    expect(document.body.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Atlas in Orchid");
    expect(document.body.querySelector('[role="img"] img')?.getAttribute("src")).toContain("/cap-v1/gs-orchid/rest.png?size=64");
  });
});
