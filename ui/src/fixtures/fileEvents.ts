import { act } from "react";

/** Fire a drop or paste the way a browser would, with files attached. */
export function fireFiles(target: Element, kind: "drop" | "paste", files: File[]) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  if (kind === "drop") {
    Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  } else {
    const items = files.map((file) => ({ kind: "file", getAsFile: () => file }));
    Object.defineProperty(event, "clipboardData", { value: { items, getData: () => "" } });
  }
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
