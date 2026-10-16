// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationKeysPanel, envSnippet } from "./IntegrationKeysPanel";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@/api/integrationKeys", () => ({ integrationKeysApi: { status: mocks.status } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  {
    id: "higgsfield",
    name: "Image generation (Higgsfield)",
    unlocks: "Lets agents make images.",
    state: "needs_key",
    variables: [
      { name: "HIGGSFIELD_API_KEY_ID", set: false },
      { name: "HIGGSFIELD_API_KEY_SECRET", set: false },
    ],
    howToGet: "Make a key pair at cloud.higgsfield.ai.",
    note: null,
  },
  {
    id: "google",
    name: "Google sign-in",
    unlocks: "Connects analytics.",
    state: "needs_key",
    variables: [
      { name: "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID", set: true },
      { name: "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET", set: false },
    ],
    howToGet: "Google Cloud Console.",
    note: null,
  },
  { id: "hubspot", name: "HubSpot live connection", unlocks: "Keeps HubSpot in step.", state: "sign_in", variables: [], howToGet: "Sign in.", note: null },
] as const;

describe("IntegrationKeysPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.status.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists what is waiting, which variables are missing and where to paste them", async () => {
    mocks.status.mockResolvedValue({ envFile: "/home/john/.gsam/instances/default/.env", items: ITEMS });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IntegrationKeysPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("3 integrations are waiting on you.");
    expect(container.querySelector("[data-testid='integration-key-higgsfield']")?.textContent).toContain("Waiting for a key");
    expect(container.querySelector("[data-testid='integration-key-hubspot']")?.textContent).toContain("Needs a sign-in");
    expect(container.textContent).toContain("/home/john/.gsam/instances/default/.env");
    expect(container.querySelector("pre")?.textContent).toBe(envSnippet(ITEMS as never));
  });

  it("puts only missing variables in the lines to paste", () => {
    expect(envSnippet(ITEMS as never)).toBe(
      [
        "# Image generation (Higgsfield)",
        "HIGGSFIELD_API_KEY_ID=",
        "HIGGSFIELD_API_KEY_SECRET=",
        "# Google sign-in",
        "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET=",
      ].join("\n"),
    );
  });
});
