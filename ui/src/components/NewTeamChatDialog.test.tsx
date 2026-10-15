// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTeamChatDialog, type NewTeamChatDialogProps } from "./NewTeamChatDialog";

const people = [
  { id: "u-ama", name: "Ama" },
  { id: "u-kofi", name: "Kofi" },
];
const agents = [{ id: "a-atlas", name: "Atlas" }];

let root: Root;
let container: HTMLDivElement;
let props: NewTeamChatDialogProps;

async function render(overrides: Partial<NewTeamChatDialogProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => {
    root.render(<NewTeamChatDialog {...props} />);
  });
}
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const option = (name: string) => options().find((el) => el.textContent?.includes(name))!;
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes(name))!;
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = { mode: "group", open: true, onOpenChange: vi.fn(), people, agents, onSubmit: vi.fn(async () => {}) };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("NewTeamChatDialog", () => {
  it("creates a group from a name and the picked people and agents", async () => {
    await render();
    expect(options().map((el) => el.textContent)).toEqual(["Ama", "Kofi", "Atlas"]);
    expect(button("Create group").disabled).toBe(true);

    await click(option("Kofi"));
    await click(option("Atlas"));
    expect(button("Create group").disabled).toBe(true);
    await type(document.querySelector<HTMLInputElement>("#team-chat-title")!, "Launch plan");
    expect(document.body.textContent).toContain("2 selected");

    await click(button("Create group"));
    expect(props.onSubmit).toHaveBeenCalledWith({ mode: "group", title: "Launch plan", userIds: ["u-kofi"], agentIds: ["a-atlas"] });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("toggles a pick off again and shows a failure without closing", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Choose people who are members of this company");
    });
    await render({ onSubmit });
    await click(option("Ama"));
    await click(option("Ama"));
    expect(document.body.textContent).toContain("Pick at least one member");
    await click(option("Ama"));
    await type(document.querySelector<HTMLInputElement>("#team-chat-title")!, "Ops");
    await click(button("Create group"));
    expect(document.querySelector("[role=alert]")?.textContent).toContain("members of this company");
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("opens a direct message with one pick and offers people only", async () => {
    await render({ mode: "direct" });
    expect(options().map((el) => el.textContent)).toEqual(["Ama", "Kofi"]);
    expect(document.querySelector("#team-chat-title")).toBeNull();
    await click(option("Ama"));
    expect(props.onSubmit).toHaveBeenCalledWith({ mode: "direct", userId: "u-ama" });
  });
});
