import { useState, type ClipboardEvent, type DragEvent } from "react";

// One way in for files on the client pages: drop them, paste them (a
// screenshot straight from the clipboard), or pick them. Pasted images arrive
// as "image.png", so they get a dated name that still reads well in a list.

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** Give a clipboard image a readable name; other files keep theirs. */
export function nameClipboardFile(file: File, now = new Date()) {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic) return file;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return new File([file], `Pasted image ${stamp}.${extension}`, { type: file.type, lastModified: file.lastModified });
}

/** Files on a paste event, or none when the clipboard only holds text. */
export function filesFromPaste(event: Pick<ClipboardEvent, "clipboardData">) {
  const items = Array.from(event.clipboardData?.items ?? []);
  const files = items
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return files.map((file) => nameClipboardFile(file));
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Drop and paste handlers for one target. Spread `targetProps` on the element;
 * it is focusable so a paste lands on it. `single` keeps only the first file.
 */
export function useFileIntake(
  onFiles: (files: File[]) => void,
  { disabled = false, single = false }: { disabled?: boolean; single?: boolean } = {},
) {
  const [dragging, setDragging] = useState(false);
  const take = (files: File[]) => {
    if (disabled || files.length === 0) return;
    onFiles(single ? files.slice(0, 1) : files);
  };

  return {
    dragging,
    targetProps: {
      tabIndex: 0,
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (!dragging) setDragging(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDragging(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        take(Array.from(event.dataTransfer.files ?? []));
      },
      onPaste: (event: ClipboardEvent<HTMLElement>) => {
        const files = filesFromPaste(event);
        if (files.length === 0) return;
        event.preventDefault();
        take(files);
      },
    },
  };
}
