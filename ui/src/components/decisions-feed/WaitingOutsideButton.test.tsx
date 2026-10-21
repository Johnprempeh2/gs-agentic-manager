// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("../../api/client", () => ({ api }));
vi.mock("../../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

import { WaitingOutsideButton } from "./WaitingOutsideButton";
import { returnAtFromDateInput } from "./NotNowButton";

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>));
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.post.mockReset().mockResolvedValue({});
  pushToast.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Waiting on someone outside", () => {
  it("needs who and a date, then tables the task until then with the note", async () => {
    render(<WaitingOutsideButton companyId="company-1" issueId="issue-7" issueLabel="GRE-7" />);
    await act(async () => (container.querySelector("[data-waiting-outside='issue-7']") as HTMLButtonElement).click());

    const submit = [...document.querySelectorAll("button")].find((button) => button.textContent === "Set aside until then")!;
    expect(submit.disabled).toBe(true);

    const [who, date] = [...document.querySelectorAll<HTMLInputElement>("input")];
    typeInto(who!, "Acme's office manager");
    expect(submit.disabled).toBe(true);
    typeInto(date!, "2026-11-04");
    expect(submit.disabled).toBe(false);

    await act(async () => submit.click());
    expect(api.post).toHaveBeenCalledWith("/issues/issue-7/table", {
      returnAt: returnAtFromDateInput("2026-11-04"),
      waitingOn: "Acme's office manager",
    });
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Waiting on someone outside" }));
  });
});
