// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { liveDesignApi } from "../api/liveDesign";
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: null }) }));

import { AgentWork, historyKey, LIVE_VIEW_POLL_MS, LiveDesignChat, saveThenApprove, StagedEdits, useLiveDesign } from "./LiveDesignChat";

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
    // The stream asks for fresh reads now (GRE-5369): the timer is a slow safety net, not a 5-second poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_VIEW_POLL_MS); });
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

describe("Deploy has left the chat", () => {
  it("never shows a deploy button; on a website page it says where Deploy is", () => {
    const el = document.createElement("div");
    act(() => createRoot(el).render(
      <AgentWork view={{ codeTasks: [{ identifier: "GRE-9", title: "Deploy the website", status: "preview", kind: "deploy" }], queued: [] } as never} deployable />,
    ));
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).not.toEqual(expect.arrayContaining([expect.stringMatching(/Deploy/)]));
    // The old agent deploy task is not listed.
    expect(el.textContent).not.toContain("GRE-9");
    expect(el.textContent).toContain("John puts them on greatstoneint.com with Deploy, on the Website module under Releases.");
  });
});

describe("StagedEdits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers Save and approve only to a person who can approve", () => {
    const run = vi.fn(async () => true);
    const view = { status: "idle", stagedCount: 1, attachmentId: "rev-1" };
    const labels = (onApprove?: () => Promise<unknown>) => {
      const el = document.createElement("div");
      act(() => createRoot(el).render(<StagedEdits live={{ view, run } as never} onApprove={onApprove} />));
      return [...el.querySelectorAll("button")].map((b) => b.textContent);
    };
    expect(labels(async () => undefined)).toEqual(expect.arrayContaining(["Save to draft", "Save and approve"]));
    expect(labels()).toContain("Save to draft");
    expect(labels()).not.toContain("Save and approve");
  });

  it("approves only after the save has landed as a new version", async () => {
    const approve = vi.fn(async () => undefined);
    vi.spyOn(liveDesignApi, "helper").mockResolvedValue({ status: 202, body: "{}" });
    // The agent's save: applying for a while, then the new version.
    const get = vi.spyOn(liveDesignApi, "get")
      .mockResolvedValueOnce({ status: "applying", stagedCount: 1, attachmentId: "rev-1" } as never)
      .mockResolvedValueOnce({ status: "applying", stagedCount: 1, attachmentId: "rev-1" } as never)
      .mockResolvedValue({ status: "idle", stagedCount: 0, attachmentId: "rev-2" } as never);
    const view = await saveThenApprove("s1", "rev-1", async () => { expect(get).toHaveBeenCalledTimes(3); await approve(); }, async () => undefined);
    expect(view.attachmentId).toBe("rev-2");
    expect(approve).toHaveBeenCalledOnce();
  });

  it("does not approve when the save fails, conflicts or saves nothing", async () => {
    const approve = vi.fn(async () => undefined);
    const helper = vi.spyOn(liveDesignApi, "helper").mockResolvedValue({ status: 409, body: JSON.stringify({ error: "The page changed since you opened it." }) });
    await expect(saveThenApprove("s1", "rev-1", approve, async () => undefined)).rejects.toThrow(
      "The save did not go through (The page changed since you opened it), so nothing was approved.",
    );
    helper.mockResolvedValue({ status: 200, body: "{}" });
    vi.spyOn(liveDesignApi, "get").mockResolvedValue({ status: "idle", stagedCount: 1, attachmentId: "rev-1" } as never);
    await expect(saveThenApprove("s1", "rev-1", approve, async () => undefined)).rejects.toThrow("The edits were not saved, so nothing was approved.");
    expect(approve).not.toHaveBeenCalled();
  });

  it("shows unsaved direct edits with Save to draft, which asks the helper to apply them", async () => {
    const helper = vi.spyOn(liveDesignApi, "helper").mockResolvedValue({ status: 202, body: "{}" });
    vi.spyOn(liveDesignApi, "get").mockResolvedValue({ id: "s1" } as never);
    const run = vi.fn(async (fn: (id: string) => Promise<unknown>) => { await fn("s1"); return true; });
    const el = document.createElement("div");
    act(() => createRoot(el).render(<StagedEdits live={{ view: { status: "idle", stagedCount: 1 }, run } as never} />));
    expect(el.textContent).toContain("1 edit not saved yet");
    await act(async () => { [...el.querySelectorAll("button")].find((b) => b.textContent === "Save to draft")!.click(); });
    expect(helper).toHaveBeenCalledWith("s1", expect.objectContaining({ path: "/manual-edit-commit" }));
  });
  it("steps through edits with Undo and Redo, and reloads the page after each", async () => {
    const undo = vi.spyOn(liveDesignApi, "undo").mockResolvedValue({ id: "s1" } as never);
    const redo = vi.spyOn(liveDesignApi, "redo").mockResolvedValue({ id: "s1" } as never);
    const run = vi.fn(async (fn: (id: string) => Promise<unknown>) => { await fn("s1"); return true; });
    const changed = vi.fn();
    const el = document.createElement("div");
    const root = createRoot(el);
    const render = (view: Record<string, unknown>) => act(() => root.render(<StagedEdits live={{ view, run } as never} onChanged={changed} />));
    const button = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    render({ status: "idle", stagedCount: 2, redoCount: 0 });
    expect(button("Redo").disabled).toBe(true);
    await act(async () => button("Undo the last edit").click());
    expect(undo).toHaveBeenCalledWith("s1");
    expect(changed).toHaveBeenCalledTimes(1);
    // Everything undone: the bar stays, so Redo can bring the edits back.
    render({ status: "idle", stagedCount: 0, redoCount: 2 });
    expect(el.textContent).toContain("Nothing waiting to save");
    expect(button("Undo the last edit").disabled).toBe(true);
    await act(async () => button("Redo").click());
    expect(redo).toHaveBeenCalledWith("s1");
    expect(changed).toHaveBeenCalledTimes(2);
    // While a save runs, neither works.
    render({ status: "applying", stagedCount: 2, redoCount: 1 });
    expect(button("Undo the last edit").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
  });
  it("says when edits came back from last time, with Discard all beside them", async () => {
    const helper = vi.spyOn(liveDesignApi, "helper").mockResolvedValue({ status: 200, body: "{}" });
    vi.spyOn(liveDesignApi, "get").mockResolvedValue({ id: "s1" } as never);
    const run = vi.fn(async (fn: (id: string) => Promise<unknown>) => { await fn("s1"); return true; });
    const el = document.createElement("div");
    act(() => createRoot(el).render(<StagedEdits live={{ view: { status: "idle", stagedCount: 3, restoredCount: 3 }, run } as never} />));
    expect(el.textContent).toContain("Restored 3 unsaved edits from last time");
    await act(async () => { [...el.querySelectorAll("button")].find((b) => b.textContent === "Discard all")!.click(); });
    expect(helper).toHaveBeenCalledWith("s1", expect.objectContaining({ path: "/manual-edit-discard" }));
  });
});

describe("historyKey", () => {
  const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>>) =>
    historyKey({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  it("reads Cmd or Ctrl Z as undo, with Shift (or Ctrl Y) as redo, and nothing else", () => {
    expect(key("z", { metaKey: true })).toBe("undo");
    expect(key("z", { ctrlKey: true })).toBe("undo");
    expect(key("Z", { metaKey: true, shiftKey: true })).toBe("redo");
    expect(key("y", { ctrlKey: true })).toBe("redo");
    expect(key("y", { metaKey: true })).toBeNull();
    expect(key("z", {})).toBeNull();
    expect(key("z", { metaKey: true, altKey: true })).toBeNull();
  });
});

describe("the chat's quick changes", () => {
  afterEach(() => vi.restoreAllMocks());

  const chat = (onEditsChanged: () => void) => {
    const run = vi.fn(async (fn: (id: string) => Promise<unknown>) => { await fn("s1"); return true; });
    // A form submits only when it is in the document.
    const el = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(el).render(<LiveDesignChat live={{ view: { id: "s1", status: "idle", messages: [], codeTasks: [], queued: [], stagedCount: 0 }, run } as never} onEditsChanged={onEditsChanged} />));
    const box = el.querySelector("textarea")!;
    const type = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = () => act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    return { type, send };
  };

  it("makes a simple change of words at once and shows it on the page, without asking the agent", async () => {
    const quick = vi.spyOn(liveDesignApi, "quick").mockResolvedValue({ id: "s1", quick: { done: true } } as never);
    const steer = vi.spyOn(liveDesignApi, "steer").mockResolvedValue({ id: "s1" } as never);
    const changed = vi.fn();
    const { type, send } = chat(changed);
    type(`change "Book a call" to "Talk to us"`);
    await send();
    expect(quick).toHaveBeenCalledWith("s1", `change "Book a call" to "Talk to us"`);
    expect(steer).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("sends anything else to the agent, as before", async () => {
    vi.spyOn(liveDesignApi, "quick").mockResolvedValue({ id: "s1", quick: { done: false, reason: "not a simple change of words" } } as never);
    const steer = vi.spyOn(liveDesignApi, "steer").mockResolvedValue({ id: "s1" } as never);
    const changed = vi.fn();
    const { type, send } = chat(changed);
    type("make the hero bigger");
    await send();
    expect(steer).toHaveBeenCalledWith("s1", "make the hero bigger");
    expect(changed).not.toHaveBeenCalled();
  });
});
