// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { MemoryConnectApp, memoryConnectNavigation } from "./MemoryConnectApp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graphApiMock = vi.hoisted(() => ({ appSignInClient: vi.fn(), approveAppSignIn: vi.fn() }));
vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: graphApiMock }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-kestrel", selectedCompany: { name: "Kestrel" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { useSearchParams: actual.useSearchParams };
});

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const challenge = "c".repeat(43);
const query = new URLSearchParams({
  client_id: "client-1",
  redirect_uri: REDIRECT,
  state: "s1",
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

let container: HTMLDivElement;
let root: Root;
const go = vi.fn();

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(search = query) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/memory/connect-app?${search}`]}>
          <Routes>
            <Route path="/memory/connect-app" element={<MemoryConnectApp />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const body = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  memoryConnectNavigation.go = go;
  graphApiMock.appSignInClient.mockResolvedValue({ name: "ChatGPT", app: "chatgpt", redirectHost: "chatgpt.com" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("MemoryConnectApp", () => {
  it("asks before letting ChatGPT use memory, then sends the browser back with the code", async () => {
    graphApiMock.approveAppSignIn.mockResolvedValue({ redirectTo: `${REDIRECT}?code=abc&state=s1` });
    await render();
    expect(graphApiMock.appSignInClient).toHaveBeenCalledWith("client-1", REDIRECT);
    expect(body()).toContain("Let ChatGPT use Kestrel memory?");
    expect(body()).toContain("chatgpt.com");
    await act(async () => button("Allow").click());
    await flush();
    expect(graphApiMock.approveAppSignIn).toHaveBeenCalledWith({
      companyId: "co-kestrel",
      clientId: "client-1",
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      state: "s1",
      canContribute: true,
    });
    expect(go).toHaveBeenCalledWith(`${REDIRECT}?code=abc&state=s1`);
  });

  it("says when an owner has not turned on app sign-in", async () => {
    graphApiMock.approveAppSignIn.mockRejectedValue(new ApiError("off", 403, null));
    await render();
    await act(async () => button("Allow").click());
    await flush();
    expect(body()).toContain("An owner has not turned on app sign-in");
    expect(go).not.toHaveBeenCalled();
  });

  it("cancels back to the app with access_denied", async () => {
    await render();
    await act(async () => button("Cancel").click());
    expect(go).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=s1`);
  });

  it("never offers a way back for a link the server does not recognise", async () => {
    graphApiMock.appSignInClient.mockRejectedValue(new ApiError("not valid", 404, null));
    await render();
    expect(body()).toContain("This sign-in link is not valid");
    expect(button("Cancel")).toBeUndefined();
  });
});
