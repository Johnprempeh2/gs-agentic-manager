// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioLook } from "@greatstone/shared";
import { StudioLookPicker } from "./StudioLookPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const looksApiMock = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("../api/studioLooks", () => ({ studioLooksApi: looksApiMock }));

const LOOK: StudioLook = {
  id: "look-1",
  companyId: "company-1",
  name: "Acme product",
  description: null,
  style: "photo",
  camera: { camera: "large-format", aperture: "f11" },
  words: "on white marble",
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(onPick = vi.fn(), lookId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <StudioLookPicker
          companyId="company-1"
          idPrefix="image"
          lookId={lookId}
          onPick={onPick}
          current={{ style: "illustration", camera: { lens: "vintage-prime" } }}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
  return onPick;
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement;
}

describe("StudioLookPicker", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    looksApiMock.list.mockResolvedValue({ looks: [LOOK] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hands the picked look to the form and shows what it holds", async () => {
    const onPick = await render();
    const select = container.querySelector("#image-house-look") as HTMLSelectElement;
    await act(async () => setValue(select, "look-1"));
    expect(onPick).toHaveBeenCalledWith(LOOK);

    await render(vi.fn(), "look-1");
    expect(container.textContent).toContain("on white marble");
  });

  it("saves the current style and camera with a name and extra words", async () => {
    looksApiMock.create.mockResolvedValue({ ...LOOK, id: "look-2", name: "Spring" });
    const onPick = await render();
    await act(async () => button("Save as a house look").click());
    await act(async () => setValue(container.querySelector("#image-look-name") as HTMLInputElement, "Spring"));
    await act(async () => setValue(container.querySelector("#image-look-words") as HTMLInputElement, "pastel colours"));
    await act(async () => button("Save look").click());
    await settle();
    expect(looksApiMock.create).toHaveBeenCalledWith("company-1", {
      name: "Spring",
      style: "illustration",
      camera: { lens: "vintage-prime" },
      words: "pastel colours",
    });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "look-2" }));
  });
});
