// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineFieldDefinition } from "../api/pipelines";
import { fieldKeyFromLabel, parseFieldOptions, PipelineFieldsEditor } from "./PipelineFieldsEditor";

const mockPipelinesApi = vi.hoisted(() => ({
  listFields: vi.fn(),
  createField: vi.fn(),
  updateField: vi.fn(),
}));

vi.mock("../api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));

function field(overrides: Partial<PipelineFieldDefinition>): PipelineFieldDefinition {
  return {
    id: "field-1",
    companyId: "co-1",
    pipelineId: "pipe-1",
    key: "dealValue",
    label: "Deal value",
    description: null,
    type: "number",
    required: true,
    options: [],
    position: 0,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  flushSync(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

describe("fieldKeyFromLabel", () => {
  it("turns a name into a key the server accepts", () => {
    expect(fieldKeyFromLabel("Deal value (GBP)")).toBe("dealValueGbp");
    expect(fieldKeyFromLabel("  close date ")).toBe("closeDate");
    expect(fieldKeyFromLabel("2026 target")).toBe("target");
  });

  it("reads one choice per line and drops blanks and repeats", () => {
    expect(parseFieldOptions("Gold\n\n Silver \nGold")).toEqual(["Gold", "Silver"]);
  });
});

describe("PipelineFieldsEditor", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: ReactNode) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("shows an empty state when the pipeline has no fields", async () => {
    mockPipelinesApi.listFields.mockResolvedValue([]);
    await render(<PipelineFieldsEditor pipelineId="pipe-1" />);
    expect(container.textContent).toContain("No fields yet");
    expect(mockPipelinesApi.listFields).toHaveBeenCalledWith("pipe-1", { includeArchived: true });
  });

  it("lists active fields and keeps archived ones apart", async () => {
    mockPipelinesApi.listFields.mockResolvedValue([
      field({}),
      field({ id: "field-2", key: "tier", label: "Tier", type: "select", required: false, options: ["Gold", "Silver"] }),
      field({ id: "field-3", key: "oldNote", label: "Old note", type: "text", required: false, archivedAt: "2026-10-01T00:00:00Z" }),
    ]);
    await render(<PipelineFieldsEditor pipelineId="pipe-1" />);
    expect(container.textContent).toContain("Deal value");
    expect(container.textContent).toContain("Required");
    expect(container.textContent).toContain("Gold, Silver");
    expect(container.textContent).toContain("Archived (1)");
    expect(container.querySelector('[aria-label="Restore Old note"]')).not.toBeNull();
  });

  it("adds a choice field with a key made from its name", async () => {
    mockPipelinesApi.listFields.mockResolvedValue([]);
    mockPipelinesApi.createField.mockResolvedValue(field({ key: "accountTier", type: "select" }));
    await render(<PipelineFieldsEditor pipelineId="pipe-1" />);

    click(buttonByText(container, "Add field"));
    setValue(container.querySelector<HTMLInputElement>('[aria-label="Field name"]')!, "Account tier");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Field key"]')!.value).toBe("accountTier");
    setValue(container.querySelector<HTMLSelectElement>('[aria-label="Field type"]')!, "select");
    const save = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(save().disabled).toBe(true);
    setValue(container.querySelector<HTMLTextAreaElement>('[aria-label="Choices"]')!, "Gold\nSilver");
    expect(save().disabled).toBe(false);
    click(save());
    await flushReact();

    expect(mockPipelinesApi.createField).toHaveBeenCalledWith("pipe-1", {
      key: "accountTier",
      label: "Account tier",
      type: "select",
      required: false,
      options: ["Gold", "Silver"],
      description: null,
    });
  });

  it("edits a field without sending key or type, and shows server errors", async () => {
    mockPipelinesApi.listFields.mockResolvedValue([field({})]);
    mockPipelinesApi.updateField.mockRejectedValueOnce(new Error("Deal value is in use"));
    await render(<PipelineFieldsEditor pipelineId="pipe-1" />);

    click(container.querySelector('[aria-label="Edit Deal value"]'));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Field key"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Field type"]')!.disabled).toBe(true);
    setValue(container.querySelector<HTMLInputElement>('[aria-label="Field name"]')!, "Value");
    click(container.querySelector('button[type="submit"]'));
    await flushReact();

    expect(mockPipelinesApi.updateField).toHaveBeenCalledWith("pipe-1", "field-1", {
      label: "Value",
      required: true,
      options: [],
      description: null,
    });
    expect(container.textContent).toContain("Deal value is in use");
  });

  it("archives a field", async () => {
    mockPipelinesApi.listFields.mockResolvedValue([field({})]);
    mockPipelinesApi.updateField.mockResolvedValue(field({ archivedAt: "2026-10-09T00:00:00Z" }));
    await render(<PipelineFieldsEditor pipelineId="pipe-1" />);
    click(container.querySelector('[aria-label="Archive Deal value"]'));
    await flushReact();
    expect(mockPipelinesApi.updateField).toHaveBeenCalledWith("pipe-1", "field-1", { archived: true });
  });
});
