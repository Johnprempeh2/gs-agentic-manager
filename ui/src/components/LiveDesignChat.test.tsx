// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { liveDesignApi } from "../api/liveDesign";
import { issuesApi } from "../api/issues";
import { AgentWork, DeployCard, useLiveDesign } from "./LiveDesignChat";

describe("useLiveDesign", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts a new session when GSAM has forgotten the open one (a release restart)", async () => {
    vi.useFakeTimers();
    let n = 0;
    const start = vi.fn(async () => ({ id: `s${++n}`, status: "idle", messages: [] }) as never);
    vi.spyOn(liveDesignApi, "get").mockRejectedValue(new ApiError("Live session not found", 404, null));
    vi.spyOn(liveDesignApi, "end").mockResolvedValue(undefined as never);
    const result = { current: null as unknown as ReturnType<typeof useLiveDesign> };
    function Probe() { result.current = useLiveDesign(start, "page", true); return null; }
    act(() => createRoot(document.createElement("div")).render(<Probe />));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.sessionId).toBe("s1");
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(result.current.sessionId).toBe("s2");
  });
});

describe("AgentWork", () => {
  it("lists the agent's code changes with their links, and what is waiting", () => {
    const el = document.createElement("div");
    const view = {
      codeTasks: [{ identifier: "GRE-1", title: "Logo carousel", status: "preview", previewUrl: "https://p.netlify.app", prUrl: "https://github.com/x/y/pull/1" }],
      queued: ["h2: Bigger heading"],
    } as never;
    act(() => createRoot(el).render(<AgentWork view={view} />));
    expect(el.textContent).toContain("GRE-1");
    expect(el.textContent).toContain("Preview ready");
    const saved = document.createElement("div");
    act(() => createRoot(saved).render(<AgentWork view={{ codeTasks: [{ identifier: "GRE-2", title: "Hover lift", status: "done" }], queued: [] } as never} />));
    expect(saved.textContent).toContain("Saved to staging, not live");
    expect(el.querySelector('a[href="https://p.netlify.app"]')).not.toBeNull();
    expect(el.textContent).toContain("Up next (1)");
  });
});

describe("Deploy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers the deploy button, and holds it while a deploy is under way", () => {
    const el = document.createElement("div");
    const onDeploy = vi.fn();
    act(() => createRoot(el).render(<AgentWork view={{ codeTasks: [], queued: [] } as never} onDeploy={onDeploy} />));
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Deploy these changes")!;
    act(() => button.click());
    expect(onDeploy).toHaveBeenCalledOnce();
    const busy = document.createElement("div");
    act(() => createRoot(busy).render(
      <AgentWork view={{ codeTasks: [{ identifier: "GRE-9", title: "Deploy the website", status: "working", kind: "deploy" }], queued: [] } as never} onDeploy={onDeploy} />,
    ));
    expect([...busy.querySelectorAll("button")].find((b) => b.textContent === "Deploy in progress")?.disabled).toBe(true);
  });

  it("lists what is not live yet next to the button, and shows nothing when GSAM cannot say", async () => {
    const el = document.createElement("div");
    const changes = vi.fn(async () => ({ liveCommit: "a", stagingCommit: "b", liveContentRelease: 3, stagingContentRelease: 4, commits: [{ sha: "0117d3e0000", title: "Logo carousel" }] }));
    act(() => createRoot(el).render(<AgentWork view={{ codeTasks: [], queued: [] } as never} onDeploy={() => undefined} deployChanges={changes} />));
    await act(async () => { await Promise.resolve(); });
    expect(el.textContent).toContain("Saved to staging, not live yet (2)");
    expect(el.textContent).toContain("Page edits: content release 4 (live has 3)");
    expect(el.textContent).toContain("0117d3e Logo carousel");
    const down = document.createElement("div");
    act(() => createRoot(down).render(<AgentWork view={{ codeTasks: [], queued: [] } as never} onDeploy={() => undefined} deployChanges={() => Promise.reject(new Error("503"))} />));
    await act(async () => { await Promise.resolve(); });
    expect(down.textContent).not.toContain("not live yet");
    expect(down.textContent).toContain("Deploy these changes");
  });

  it("disables the deploy button when everything saved is live", async () => {
    const el = document.createElement("div");
    const changes = vi.fn(async () => ({ liveCommit: "a", stagingCommit: "a", liveContentRelease: 4, stagingContentRelease: 4, commits: [] }));
    act(() => createRoot(el).render(<AgentWork view={{ codeTasks: [], queued: [] } as never} onDeploy={() => undefined} deployChanges={changes} />));
    await act(async () => { await Promise.resolve(); });
    expect(el.textContent).toContain("Everything saved is live");
    expect([...el.querySelectorAll("button")].find((b) => b.textContent === "Deploy these changes")?.disabled).toBe(true);
  });

  it("shows what goes live and accepts the agent's card on Deploy", async () => {
    const details = "Approve production deploy: greatstone-home abc\n- Logo carousel";
    vi.spyOn(issuesApi, "listInteractions").mockResolvedValue([
      { id: "old", kind: "request_confirmation", status: "accepted", payload: { detailsMarkdown: details } },
      { id: "c1", kind: "request_confirmation", status: "pending", payload: { detailsMarkdown: details } },
    ] as never);
    const accept = vi.spyOn(issuesApi, "acceptInteraction").mockResolvedValue({} as never);
    const el = document.createElement("div");
    act(() => createRoot(el).render(<DeployCard identifier="GRE-9" />));
    await act(async () => { await Promise.resolve(); });
    expect(el.textContent).toContain("Logo carousel");
    await act(async () => { [...el.querySelectorAll("button")].find((b) => b.textContent === "Deploy")!.click(); });
    expect(accept).toHaveBeenCalledWith("GRE-9", "c1");
  });
});
