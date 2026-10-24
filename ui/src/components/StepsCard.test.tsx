// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequestStepsInteraction } from "../lib/issue-thread-interactions";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { stepsAsText } from "./StepsCard";
import { stepsKindLabel } from "../lib/decision-kind-label";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issuesApiMocks = vi.hoisted(() => ({
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
  saveStepsProgress: vi.fn(),
}));
vi.mock("../api/issues", () => ({ issuesApi: issuesApiMocks }));
const clipboardMock = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: clipboardMock }));

const SECRET = "rk_test_not_a_real_key";

function card(overrides: Partial<RequestStepsInteraction["payload"]> = {}): RequestStepsInteraction {
  return {
    id: "steps-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_steps",
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "governed_action",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    title: "Stripe test key for the agents",
    payload: {
      version: 1,
      title: "Stripe test key for the agents",
      why: "So Lintel can test checkout on the staging site.",
      minutes: 2,
      risk: "money_or_live",
      steps: [
        {
          text: "Open **Developers → API keys → Create restricted key**.",
          copy: ["GSAM agents"],
          link: { label: "Open Stripe", url: "https://dashboard.stripe.com/test/apikeys" },
        },
        { text: "Copy the key.", expect: "It starts rk_test_." },
      ],
      afterDone: "I run the payment tests.",
      ...overrides,
    },
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
  } as RequestStepsInteraction;
}

const withSecret = (access?: { addresseeCanSave: boolean; whoCan: string[] }) =>
  card({
    secret: { secretName: "stripe/sandbox-agents", description: "Stripe sandbox key", expectedPrefix: "rk_test_" },
    secretAccess: access ?? { addresseeCanSave: true, whoCan: ["John"] },
  });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(interaction: RequestStepsInteraction) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeProvider>
            <IssueThreadInteractionCard interaction={interaction} />
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function tickAll(host: HTMLElement) {
  for (const box of host.querySelectorAll('[role="checkbox"]')) await click(box);
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("StepsCard", () => {
  it("shows why, time, a prominent risk chip, links in a new tab and what to expect", () => {
    const host = render(card());
    expect(host.textContent).toContain("So Lintel can test checkout");
    expect(host.querySelector('[data-testid="steps-minutes"]')?.textContent).toBe("About 2 min");
    expect(host.querySelector('[data-testid="steps-risk"]')?.textContent).toBe("Money or live");
    const link = host.querySelector('a[href="https://dashboard.stripe.com/test/apikeys"]')!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(host.textContent).toContain("You should see: It starts rk_test_.");
  });

  it("saves ticks and enables Done only when every step is ticked", async () => {
    issuesApiMocks.saveStepsProgress.mockResolvedValue(card({ progress: { tickedSteps: [0] } }));
    issuesApiMocks.acceptInteraction.mockResolvedValue({ ...card(), status: "accepted" });
    const host = render(card());
    expect(button(host, "Done").disabled).toBe(true);
    const boxes = host.querySelectorAll('[role="checkbox"]');
    await click(boxes[0]!);
    expect(issuesApiMocks.saveStepsProgress).toHaveBeenLastCalledWith("issue-1", "steps-1", [0]);
    expect(button(host, "Done").disabled).toBe(true);
    await click(boxes[1]!);
    expect(issuesApiMocks.saveStepsProgress).toHaveBeenLastCalledWith("issue-1", "steps-1", [0, 1]);
    expect(button(host, "Done").disabled).toBe(false);
    await click(button(host, "Done"));
    expect(issuesApiMocks.acceptInteraction).toHaveBeenCalledWith("issue-1", "steps-1", {});
  });

  it("restores ticks saved on the card", () => {
    const host = render(card({ progress: { tickedSteps: [0, 1] } }));
    const states = [...host.querySelectorAll('[role="checkbox"]')].map((box) => box.getAttribute("data-state"));
    expect(states).toEqual(["checked", "checked"]);
    expect(button(host, "Done").disabled).toBe(false);
  });

  it("copies a value chip and says Copied", async () => {
    const host = render(card());
    const chip = host.querySelector('button[aria-label="Copy GSAM agents"]')!;
    await click(chip);
    expect(clipboardMock).toHaveBeenCalledWith("GSAM agents");
    expect(chip.textContent).toContain("Copied");
  });

  it("Copy steps copies clean text without any secret", async () => {
    const host = render(withSecret());
    type(host.querySelector('input[type="password"]') as HTMLInputElement, SECRET);
    await click(button(host, "Copy steps"));
    const copied = clipboardMock.mock.calls.at(-1)![0] as string;
    expect(copied).toContain("1. Open Developers → API keys → Create restricted key.");
    expect(copied).toContain("Link: Open Stripe (https://dashboard.stripe.com/test/apikeys)");
    expect(copied).not.toContain(SECRET);
    expect(copied).not.toContain("**");
    expect(stepsAsText(withSecret().payload)).not.toContain("stripe/sandbox-agents");
  });

  it("needs the secret before Done, warns on a prefix mismatch, and sends it once", async () => {
    issuesApiMocks.saveStepsProgress.mockResolvedValue(withSecret());
    issuesApiMocks.acceptInteraction.mockResolvedValue({ ...withSecret(), status: "accepted" });
    const host = render(withSecret());
    await tickAll(host);
    expect(button(host, "Done").disabled).toBe(true);
    const field = host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(host.textContent).toContain("Saved straight into GSAM's encrypted secrets. Nobody, including the agent, sees it.");

    type(field, "sk_live_wrong");
    expect(host.textContent).toContain("This usually starts with rk_test_");
    expect(button(host, "Done").disabled).toBe(false);

    await click(host.querySelector('button[aria-label="Show the secret"]')!);
    expect(host.querySelector('input[type="text"]')).not.toBeNull();

    type(host.querySelector('input[type="text"]') as HTMLInputElement, SECRET);
    expect(host.textContent).not.toContain("This usually starts with");
    await click(button(host, "Done"));
    expect(issuesApiMocks.acceptInteraction).toHaveBeenCalledWith("issue-1", "steps-1", { secretValue: SECRET });
  });

  it("says who can save the secret when the addressee cannot", () => {
    const host = render(withSecret({ addresseeCanSave: false, whoCan: ["John Prempeh"] }));
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelector('[data-testid="steps-secret-who-can"]')?.textContent).toContain("Ask John Prempeh.");
  });

  it("I can't do this asks for a short reason", async () => {
    issuesApiMocks.rejectInteraction.mockResolvedValue({ ...card(), status: "rejected" });
    const host = render(card());
    await click(button(host, "I can't do this"));
    expect(button(host, "Send").disabled).toBe(true);
    type(host.querySelector("textarea") as HTMLTextAreaElement, "No Stripe access");
    await click(button(host, "Send"));
    expect(issuesApiMocks.rejectInteraction).toHaveBeenCalledWith("issue-1", "steps-1", "No Stripe access");
  });

  it("shows the saved secret by name only once done", () => {
    const done = {
      ...withSecret(),
      status: "accepted",
      resolvedAt: "2026-10-24T10:05:00.000Z",
      result: {
        version: 1,
        outcome: "accepted",
        secret: { secretId: "secret-1", secretName: "stripe/sandbox-agents", linkedAgentIds: ["agent-2"] },
      },
    } as RequestStepsInteraction;
    const host = render(done);
    expect(host.querySelector('[data-testid="steps-secret-saved"]')?.textContent).toContain(
      "Saved as stripe/sandbox-agents in Secrets, linked to 1 agent.",
    );
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it("labels the Decisions chip with the time and risk", () => {
    expect(stepsKindLabel({ minutes: 2, risk: "money_or_live" })).toBe("Steps · 2 min · Money or live");
    expect(stepsKindLabel(undefined)).toBe("Steps");
  });
});
