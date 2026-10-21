// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Camera, Palette } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioComposer, type StudioComposerChip } from "./StudioComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHIPS: StudioComposerChip[] = [
  { id: "style", icon: Palette, label: "Style", panel: <p>Style settings</p> },
  { id: "camera", icon: Camera, label: "Camera", panel: <input aria-label="Lens" /> },
];

function Harness() {
  const [openChip, setOpenChip] = useState<string | null>(null);
  return (
    <StudioComposer title="Make an image" chips={CHIPS} openChip={openChip} onOpenChipChange={setOpenChip} action={<button type="button">Make image</button>}>
      <textarea aria-label="Prompt" />
    </StudioComposer>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const panel = (id: string) => container.querySelector<HTMLElement>(`[data-testid="studio-panel-${id}"]`)!;
const click = (testId: string) =>
  act(() => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click());

describe("StudioComposer", () => {
  it("opens one settings panel at a time from its chip", () => {
    expect(panel("style").hidden).toBe(true);
    click("studio-chip-style");
    expect(panel("style").hidden).toBe(false);
    click("studio-chip-camera");
    expect(panel("style").hidden).toBe(true);
    expect(panel("camera").hidden).toBe(false);
  });

  it("closes the open panel from its close button, so a phone user is never stuck with it", () => {
    click("studio-chip-camera");
    click("studio-panel-close-camera");
    expect(panel("camera").hidden).toBe(true);
    expect(container.querySelector('[data-testid="studio-chip-camera"]')!.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the open panel on Escape from inside it", () => {
    click("studio-chip-camera");
    const lens = container.querySelector<HTMLInputElement>('input[aria-label="Lens"]')!;
    act(() => {
      lens.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel("camera").hidden).toBe(true);
  });
});
