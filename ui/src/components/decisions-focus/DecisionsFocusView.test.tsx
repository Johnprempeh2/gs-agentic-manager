// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@greatstone/shared";
import { defaultFocusPrefs, type FocusPrefs } from "../../lib/focus-prefs";

const state = vi.hoisted(() => ({
  interactionsByIssue: new Map<string, unknown[]>(),
  respond: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => ({
    data: state.interactionsByIssue.get(String(queryKey[2])) ?? [],
    isLoading: false,
    error: null,
  }),
  // Enough of useMutation for the shared answer hook: run, then onSuccess.
  useMutation: ({
    mutationFn,
    onSuccess,
  }: {
    mutationFn: (input: unknown) => Promise<unknown>;
    onSuccess?: (result: unknown) => void;
  }) => ({
    isPending: false,
    mutateAsync: async (input: unknown) => {
      const result = await mutationFn(input);
      onSuccess?.(result);
      return result;
    },
  }),
}));

vi.mock("../../api/issues", () => ({
  issuesApi: {
    listInteractions: vi.fn(),
    respondToInteraction: state.respond,
    acceptInteraction: vi.fn(),
    rejectInteraction: vi.fn(),
    cancelInteraction: vi.fn(),
    submitInteractionVerdicts: vi.fn(),
  },
}));

vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: state.pushToast }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../AgentAvatar", () => ({ AgentAvatar: () => <span /> }));

import { DecisionsFocusView } from "./DecisionsFocusView";

// ---- Browser speech mocks -------------------------------------------------

class FakeUtterance {
  rate = 1;
  voice: unknown = null;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const synth = {
  speak: vi.fn(),
  cancel: vi.fn(),
  getVoices: () => [],
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

class FakeRecognition {
  static last: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
  say(transcript: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] });
  }
}

// ---- Fixtures -------------------------------------------------------------

function question(id: string, issueId: string, prompt: string) {
  return {
    id,
    companyId: "company-1",
    issueId,
    kind: "ask_user_questions",
    status: "pending",
    title: null,
    summary: "Two runs stopped last night. A restart is safe for most tasks.",
    createdByAgentId: "agent-ridge",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    payload: {
      version: 1,
      questions: [
        {
          id: "q1",
          prompt,
          selectionMode: "single",
          options: [
            { id: "own", label: "Restart on its own" },
            { id: "except", label: "Restart, except email and code tasks" },
            { id: "ask", label: "Always ask me first" },
          ],
        },
      ],
    },
  };
}

function feedItem(interactionId: string, issueId: string, identifier: string): AttentionItem {
  return {
    id: `attention-${interactionId}`,
    sourceKind: "issue_thread_interaction",
    subject: {
      kind: "interaction",
      id: interactionId,
      title: "Question",
      href: `/GRE/issues/${identifier}#interaction-${interactionId}`,
      metadata: { kind: "ask_user_questions", issueId, createdByAgentId: "agent-ridge" },
    },
    relatedIssue: { id: issueId, identifier, title: "Stalled runs recovery", href: `/GRE/issues/${identifier}` },
    originAgentName: "Ridge",
  } as unknown as AttentionItem;
}

const agentMap = new Map([["agent-ridge", { id: "agent-ridge", name: "Ridge" }]]) as never;

let container: HTMLDivElement;
let root: Root;

function render(items: AttentionItem[], prefs: FocusPrefs = defaultFocusPrefs) {
  act(() => {
    root.render(
      <DecisionsFocusView
        items={items}
        companyId="company-1"
        agentMap={agentMap}
        currentUserId="user-1"
        prefs={prefs}
        onPrefsChange={vi.fn()}
        onShowList={vi.fn()}
      />,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match as HTMLButtonElement;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(window, { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance, webkitSpeechRecognition: FakeRecognition });
  sessionStorage.clear();
  state.interactionsByIssue = new Map([
    ["issue-44", [question("int-1", "issue-44", "When a run is stuck, should I restart it?")]],
    ["issue-45", [question("int-2", "issue-45", "Ship the watchdog today?")]],
  ]);
  state.respond.mockReset().mockImplementation(async (_issueId: string, interactionId: string) => ({
    ...question(interactionId, _issueId, ""),
    status: "answered",
  }));
  state.pushToast.mockReset();
  synth.speak.mockClear();
  synth.cancel.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe("DecisionsFocusView", () => {
  const items = () => [feedItem("int-1", "issue-44", "GRE-44"), feedItem("int-2", "issue-45", "GRE-45")];

  it("fills the note by voice, picks the spoken option, and Submit & next answers on the original card", async () => {
    render(items());
    expect(container.textContent).toContain("When a run is stuck, should I restart it?");
    expect(container.textContent).toContain("0 of 2 answered");

    act(() => button("Speak your answer").click());
    act(() => FakeRecognition.last!.say("Option two. And tell me in the morning"));

    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("Option two. And tell me in the morning");
    const picked = container.querySelector("[role='radio'][aria-checked='true']");
    expect(picked?.textContent).toContain("Restart, except email and code tasks");
    // Nothing is sent until Submit & next.
    expect(state.respond).not.toHaveBeenCalled();

    await act(async () => button("Submit & next").click());

    expect(state.respond).toHaveBeenCalledTimes(1);
    expect(state.respond).toHaveBeenCalledWith("issue-44", "int-1", {
      answers: [{ questionId: "q1", optionIds: ["except"], otherText: "Option two. And tell me in the morning" }],
    });
    expect(container.textContent).toContain("Ship the watchdog today?");
    expect(container.textContent).toContain("1 of 2 answered");
  });

  it("drops a question answered elsewhere without submitting it", () => {
    render(items());
    render([feedItem("int-2", "issue-45", "GRE-45")]);
    expect(container.textContent).toContain("Ship the watchdog today?");
    expect(container.textContent).not.toContain("GRE-44");
    expect(state.respond).not.toHaveBeenCalled();
  });

  it("toasts once when the feed drops the open question", () => {
    render(items());
    render([feedItem("int-2", "issue-45", "GRE-45")]);
    render([feedItem("int-2", "issue-45", "GRE-45")]);
    expect(state.pushToast).toHaveBeenCalledTimes(1);
    expect(state.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Answered elsewhere" }));
  });

  it("toasts once when the card finds its question already answered, then the feed catches up", () => {
    state.interactionsByIssue.set("issue-44", [
      { ...question("int-1", "issue-44", "When a run is stuck, should I restart it?"), status: "answered" },
    ]);
    render(items());
    expect(container.textContent).toContain("Ship the watchdog today?");
    expect(state.pushToast).toHaveBeenCalledTimes(1);
    expect(state.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Answered elsewhere" }));
    render([feedItem("int-2", "issue-45", "GRE-45")]);
    expect(state.pushToast).toHaveBeenCalledTimes(1);
    expect(state.respond).not.toHaveBeenCalled();
  });

  it("does not toast for a question answered here", async () => {
    render(items());
    act(() => (container.querySelector("[role='radio']") as HTMLButtonElement).click());
    await act(async () => button("Submit & next").click());
    render([feedItem("int-2", "issue-45", "GRE-45")]);
    expect(state.respond).toHaveBeenCalledTimes(1);
    expect(state.pushToast).not.toHaveBeenCalled();
  });

  it("keeps progress after leaving the page and coming back", async () => {
    render(items());
    act(() => (container.querySelector("[role='radio']") as HTMLButtonElement).click());
    await act(async () => button("Submit & next").click());
    expect(container.textContent).toContain("1 of 2 answered");

    // Open task, then Back: the view unmounts, and the feed no longer lists the answered row.
    act(() => root.unmount());
    root = createRoot(container);
    render([feedItem("int-2", "issue-45", "GRE-45")]);
    expect(container.textContent).toContain("1 of 2 answered");
    expect(container.textContent).toContain("Ship the watchdog today?");
    expect(container.textContent).toContain("GRE-44");
    expect(state.pushToast).not.toHaveBeenCalled();
  });

  it("skips, then shows the caught-up screen once the rest are answered", async () => {
    render(items());
    act(() => button("Skip for now").click());
    expect(container.textContent).toContain("Ship the watchdog today?");
    act(() => (container.querySelector("[role='radio']") as HTMLButtonElement).click());
    await act(async () => button("Submit & next").click());
    expect(container.textContent).toContain("You are all caught up.");
    expect(container.textContent).toContain("1 skipped question is still open.");
  });

  it("reads the question aloud when auto-read is on, and stops on question change", () => {
    render(items(), { ...defaultFocusPrefs, autoRead: true });
    const spoken = synth.speak.mock.calls.map(([utterance]) => (utterance as FakeUtterance).text);
    expect(spoken[0]).toBe("Ridge asks, on GRE-44, Stalled runs recovery.");
    expect(spoken).toContain("Option 2: Restart, except email and code tasks.");
    synth.cancel.mockClear();
    act(() => button("Skip for now").click());
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("hides the mic when the browser has no speech recognition", () => {
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    render(items());
    expect(container.querySelector("[aria-label='Speak your answer']")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("hides the mic after the microphone permission is refused", () => {
    render(items());
    act(() => button("Speak your answer").click());
    act(() => {
      FakeRecognition.last!.onerror?.({ error: "not-allowed" });
      FakeRecognition.last!.onend?.();
    });
    expect(container.querySelector("[aria-label='Speak your answer']")).toBeNull();
  });
});
