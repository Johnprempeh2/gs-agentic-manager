// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueComment } from "@greatstone/shared";
import { buildTeamChatRows, formatTeamChatDay } from "@/lib/team-chat-messages";
import { TeamChatThread, type TeamChatThreadProps } from "./TeamChatThread";

vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/lib/router", async () => ({ Link: (await import("react-router-dom")).Link }));
vi.mock("@/plugins/slots",() => ({ PluginSlotOutlet: () => null }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string }) => (
    <textarea
      aria-label={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) onSubmit();
      }}
    />
  ),
}));

const ME = "u-me";
let seq = 0;
function message(author: { user?: string; agent?: string; system?: boolean }, at: string, body = "hi"): IssueComment {
  seq += 1;
  return {
    id: `c${seq}`,
    companyId: "co",
    issueId: "chat",
    authorType: author.agent ? "agent" : author.system ? "system" : "user",
    authorAgentId: author.agent ?? null,
    authorUserId: author.user ?? null,
    body,
    presentation: null,
    metadata: null,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  } as IssueComment;
}

describe("buildTeamChatRows", () => {
  it("groups consecutive messages from one sender within five minutes", () => {
    const rows = buildTeamChatRows(
      [
        message({ user: ME }, "2026-10-15T09:00:00"),
        message({ user: ME }, "2026-10-15T09:03:00"),
        message({ user: "u-ama" }, "2026-10-15T09:04:00"),
        message({ user: "u-ama" }, "2026-10-15T09:20:00"),
        message({ agent: "a-atlas" }, "2026-10-15T09:21:00"),
      ],
      ME,
    );
    expect(rows.map((row) => (row.kind === "date" ? "date" : `${row.sender.kind}x${row.messages.length}`))).toEqual([
      "date",
      "selfx2",
      "userx1",
      "userx1",
      "agentx1",
    ]);
  });

  it("starts a new day with a date separator and breaks the group there", () => {
    const rows = buildTeamChatRows(
      [message({ user: ME }, "2026-10-14T23:58:00"), message({ user: ME }, "2026-10-15T00:01:00")],
      ME,
    );
    expect(rows.map((row) => row.kind)).toEqual(["date", "group", "date", "group"]);
  });

  it("labels today and yesterday", () => {
    const now = new Date("2026-10-15T12:00:00");
    expect(formatTeamChatDay(new Date("2026-10-15T08:00:00"), now)).toBe("Today");
    expect(formatTeamChatDay(new Date("2026-10-14T08:00:00"), now)).toBe("Yesterday");
  });
});

describe("TeamChatThread", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render(overrides: Partial<TeamChatThreadProps> = {}) {
    const props: TeamChatThreadProps = {
      comments: [],
      currentUserId: ME,
      senderName: (comment) => (comment.authorUserId === ME ? "You" : comment.authorAgentId ? "Atlas" : "Ama"),
      onSend: vi.fn(async () => {}),
      ...overrides,
    };
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TeamChatThread {...props} />
        </MemoryRouter>,
      );
    });
    return props;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const groups = () => [...container.querySelectorAll<HTMLElement>("[data-testid=team-chat-group]")];

  it("puts my messages on the right and others on the left with their name", async () => {
    await render({
      comments: [
        message({ user: ME }, "2026-10-15T09:00:00", "mine"),
        message({ user: "u-ama" }, "2026-10-15T09:01:00", "hers"),
        message({ agent: "a-atlas" }, "2026-10-15T09:02:00", "bot"),
      ],
    });
    const [own, person, agent] = groups();
    expect(own.dataset.sender).toBe("self");
    expect(own.className).toContain("justify-end");
    expect(own.textContent).not.toContain("You");
    expect(own.querySelector("[data-testid=team-chat-message]")?.className).toContain("gs-human-bubble");

    expect(person.dataset.sender).toBe("user");
    expect(person.className).toContain("justify-start");
    expect(person.textContent).toContain("Ama");
    expect(person.textContent).not.toContain("Agent");

    expect(agent.dataset.sender).toBe("agent");
    expect(agent.textContent).toContain("Atlas");
    expect(agent.textContent).toContain("Agent");
  });

  it("shows one name for a run of messages from the same sender", async () => {
    await render({
      comments: [
        message({ user: "u-ama" }, "2026-10-15T09:00:00", "one"),
        message({ user: "u-ama" }, "2026-10-15T09:01:00", "two"),
        message({ user: "u-ama" }, "2026-10-15T09:02:00", "three"),
      ],
    });
    expect(groups()).toHaveLength(1);
    expect(groups()[0].querySelectorAll("[data-testid=team-chat-message]")).toHaveLength(3);
    expect(groups()[0].textContent?.match(/Ama/g)).toHaveLength(1);
    expect(container.querySelectorAll("[role=separator]")).toHaveLength(1);
  });

  it("sends on Enter and clears the composer", async () => {
    const props = await render();
    const box = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hello @Atlas");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(props.onSend).toHaveBeenCalledWith("hello @Atlas");
    expect(box.value).toBe("");
  });

  it("scrolls to the newest message", async () => {
    await render({ comments: [message({ user: "u-ama" }, "2026-10-15T09:00:00")] });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  describe("following new replies", () => {
    let main: HTMLElement;
    const metrics = { scrollHeight: 2000, clientHeight: 500 };
    beforeEach(() => {
      main = document.createElement("main");
      main.id = "main-content";
      Object.defineProperty(main, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
      Object.defineProperty(main, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
      document.body.append(main);
    });
    afterEach(() => main.remove());

    const first = [message({ user: "u-ama" }, "2026-10-15T09:00:00", "one")];
    const readHistory = async () => {
      await act(async () => {
        main.scrollTop = 100;
        main.dispatchEvent(new Event("scroll"));
      });
    };
    const jumpButton = () =>
      [...container.querySelectorAll("button")].find((button) => /New messages|Jump to latest/.test(button.textContent ?? ""));

    it("keeps a reader's place in older messages and offers a jump to the newest", async () => {
      await render({ comments: first });
      expect(main.scrollTop).toBe(2000);
      await readHistory();
      expect(jumpButton()?.textContent).toContain("Jump to latest");

      await render({ comments: [...first, message({ agent: "a-atlas" }, "2026-10-15T09:05:00", "reply")] });
      expect(main.scrollTop).toBe(100);
      expect(jumpButton()?.textContent).toContain("New messages");

      await act(async () => jumpButton()!.click());
      expect(main.scrollTop).toBe(2000);
    });

    it("follows a reply when the reader is already at the newest message", async () => {
      await render({ comments: first });
      metrics.scrollHeight = 2400;
      await render({ comments: [...first, message({ agent: "a-atlas" }, "2026-10-15T09:05:00", "reply")] });
      expect(main.scrollTop).toBe(2400);
      expect(jumpButton()).toBeUndefined();
      metrics.scrollHeight = 2000;
    });

    it("always goes to the newest message after I send one", async () => {
      await render({ comments: first });
      await readHistory();
      await render({ comments: [...first, message({ user: ME }, "2026-10-15T09:05:00", "mine")] });
      expect(main.scrollTop).toBe(2000);
    });
  });

  it("shows the reason instead of the composer when sending is off", async () => {
    await render({ composerDisabledReason: "Team Chat is off." });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Team Chat is off.");
  });
});
