// Keyboard shortcuts of the full-screen website editor (GRE-2296). These run
// while focus is in GSAM's own top bar or drawer; inside the frame the site's
// editor keeps Cmd+S and Cmd+Z itself and sends `editor-key` for Esc.

export type WebsiteEditorShortcut = "save" | "undo" | "redo" | "escape";

export interface WebsiteEditorKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The key went to a text field (the page search, alt text): its own undo and Esc win. */
  inTextField: boolean;
}

/** The editor shortcut a key press means, or null. Cmd on a Mac, Ctrl elsewhere. */
export function websiteEditorShortcut(event: WebsiteEditorKey): WebsiteEditorShortcut | null {
  if (event.key === "Escape") return event.inTextField ? null : "escape";
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  // Save works from a text field too: a browser's own Save Page is never wanted here.
  if (key === "s" && !event.shiftKey) return "save";
  if (event.inTextField) return null;
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey) return "redo";
  return null;
}

export function isTextField(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((element as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return element.isContentEditable === true;
}

export type WebsiteEditorEscape = "close-drawer" | "deselect" | "leave";

/**
 * What Esc does, one layer at a time: close GSAM's drawer, else clear the
 * editor's selected block, else leave the editor for where the person came from.
 */
export function websiteEditorEscape(state: { drawerOpen: boolean; selected: boolean }): WebsiteEditorEscape {
  if (state.drawerOpen) return "close-drawer";
  if (state.selected) return "deselect";
  return "leave";
}
