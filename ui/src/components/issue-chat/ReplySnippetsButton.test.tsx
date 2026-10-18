// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplySnippetsButton } from "./ReplySnippetsButton";
import { DEFAULT_REPLY_SNIPPETS, loadReplySnippets } from "../../lib/reply-snippets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(currentBody: string, onInsert = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ReplySnippetsButton currentBody={currentBody} onInsert={onInsert} />);
  });
  await act(async () => {
    (document.querySelector('[data-testid="reply-snippets-trigger"]') as HTMLButtonElement).click();
  });
  return onInsert;
}

function menuButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="reply-snippets-menu"] button')].find(
    (button) => button.textContent === label,
  );
}

describe("ReplySnippetsButton", () => {
  it("inserts a saved reply", async () => {
    const onInsert = await render("");
    await act(async () => {
      menuButton(DEFAULT_REPLY_SNIPPETS[0]!)!.click();
    });
    expect(onInsert).toHaveBeenCalledWith(DEFAULT_REPLY_SNIPPETS[0]);
  });

  it("saves the current reply for next time", async () => {
    await render("Thanks, merge it.");
    await act(async () => {
      menuButton("Save this reply for next time")!.click();
    });
    expect(loadReplySnippets()[0]).toBe("Thanks, merge it.");
    expect(menuButton("Thanks, merge it.")).toBeDefined();
  });

  it("cannot save an empty reply", async () => {
    await render("   ");
    expect(menuButton("Save this reply for next time")!.disabled).toBe(true);
  });
});
