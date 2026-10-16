// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDropArea } from "../components/FileDropArea";
import { fireFiles } from "../fixtures/fileEvents";
import { filesFromPaste, nameClipboardFile } from "./useFileIntake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useFileIntake", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names a pasted screenshot and leaves named files alone", () => {
    const pasted = nameClipboardFile(new File(["x"], "image.png", { type: "image/png" }), new Date(2026, 9, 16, 2, 5, 9));
    expect(pasted.name).toBe("Pasted image 2026-10-16 02.05.09.png");
    const named = new File(["x"], "Accounts.pdf", { type: "application/pdf" });
    expect(nameClipboardFile(named)).toBe(named);
    expect(filesFromPaste({ clipboardData: { items: [{ kind: "string", getAsFile: () => null }] } } as never)).toEqual([]);
  });

  it("takes dropped and pasted files, one at a time when single, and ignores text paste", () => {
    const onFiles = vi.fn();
    act(() => root.render(<FileDropArea label="Drop the NDA" onFiles={onFiles}>Upload</FileDropArea>));
    const area = container.querySelector("[aria-label='Drop the NDA']")!;
    const a = new File(["a"], "a.pdf");
    const b = new File(["b"], "b.pdf");

    const drop = fireFiles(area, "drop", [a, b]);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenLastCalledWith([a]);

    fireFiles(area, "paste", [new File(["png"], "image.png", { type: "image/png" })]);
    expect(onFiles.mock.lastCall?.[0][0].name).toMatch(/^Pasted image .+\.png$/);

    const text = fireFiles(area, "paste", []);
    expect(text.defaultPrevented).toBe(false);
    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it("does nothing while disabled", () => {
    const onFiles = vi.fn();
    act(() => root.render(<FileDropArea label="Drop" disabled onFiles={onFiles}>Upload</FileDropArea>));
    fireFiles(container.querySelector("[aria-label='Drop']")!, "drop", [new File(["a"], "a.pdf")]);
    expect(onFiles).not.toHaveBeenCalled();
  });
});
