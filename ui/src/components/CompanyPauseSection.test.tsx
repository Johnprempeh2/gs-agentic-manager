// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@greatstone/shared";
import { CompanyPauseSection } from "./CompanyPauseSection";

const mockCompaniesApi = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    name: "Greatstone",
    status: "active",
    pauseReason: null,
    pausedAt: null,
    ...overrides,
  } as Company;
}

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

async function click(element: HTMLElement | undefined | null) {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

describe("CompanyPauseSection (GRE-1380)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(value: Company) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <CompanyPauseSection company={value} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("pauses with an optional reason through the pause action", async () => {
    mockCompaniesApi.pause.mockResolvedValue(company({ status: "paused" }));
    await render(company());

    await click(button("Pause organization"));
    await typeInto(field<HTMLTextAreaElement>("company-pause-reason"), "  Checking billing  ");
    await click(button("Pause"));

    expect(mockCompaniesApi.pause).toHaveBeenCalledWith("company-1", { reason: "Checking billing" });
  });

  it("pauses without a reason when none is given", async () => {
    mockCompaniesApi.pause.mockResolvedValue(company({ status: "paused" }));
    await render(company());

    await click(button("Pause organization"));
    await click(button("Pause"));

    expect(mockCompaniesApi.pause).toHaveBeenCalledWith("company-1", {});
  });

  it("shows when the company was paused", async () => {
    await render(company({ status: "paused", pausedAt: new Date("2026-10-10T09:30:00Z") }));

    expect(container.querySelector('[data-testid="company-paused-since"]')?.textContent).toMatch(
      /^Paused since 10 Oct 2026/,
    );
    expect(button("Resume organization")).toBeDefined();
    expect(button("Pause organization")).toBeUndefined();
  });

  it("needs an operator name and a reason before it resumes", async () => {
    mockCompaniesApi.resume.mockResolvedValue(company());
    await render(company({ status: "paused", pausedAt: new Date("2026-10-10T09:30:00Z") }));

    await click(button("Resume organization"));
    expect(button("Resume")?.disabled).toBe(true);

    await typeInto(field<HTMLInputElement>("company-resume-operator"), "John");
    expect(button("Resume")?.disabled).toBe(true);

    await typeInto(field<HTMLTextAreaElement>("company-resume-reason"), "Billing fixed");
    expect(button("Resume")?.disabled).toBe(false);

    await click(button("Resume"));
    expect(mockCompaniesApi.resume).toHaveBeenCalledWith("company-1", {
      operator: "John",
      reason: "Billing fixed",
    });
  });

  it("shows the server error when resume fails", async () => {
    mockCompaniesApi.resume.mockRejectedValue(new Error("Company is not paused"));
    await render(company({ status: "paused", pausedAt: new Date("2026-10-10T09:30:00Z") }));

    await click(button("Resume organization"));
    await typeInto(field<HTMLInputElement>("company-resume-operator"), "John");
    await typeInto(field<HTMLTextAreaElement>("company-resume-reason"), "Billing fixed");
    await click(button("Resume"));

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("Company is not paused");
  });
});
