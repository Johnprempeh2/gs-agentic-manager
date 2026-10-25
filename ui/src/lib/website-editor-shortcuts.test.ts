// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isTextField, websiteEditorEscape, websiteEditorShortcut, type WebsiteEditorKey } from "./website-editor-shortcuts";

const key = (value: string, extra: Partial<WebsiteEditorKey> = {}): WebsiteEditorKey => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  inTextField: false,
  ...extra,
});

describe("websiteEditorShortcut", () => {
  it("Cmd+S or Ctrl+S saves, even from a text field", () => {
    expect(websiteEditorShortcut(key("s", { metaKey: true }))).toBe("save");
    expect(websiteEditorShortcut(key("S", { ctrlKey: true }))).toBe("save");
    expect(websiteEditorShortcut(key("s", { metaKey: true, inTextField: true }))).toBe("save");
    expect(websiteEditorShortcut(key("s"))).toBeNull();
  });

  it("Cmd+Z undoes, Cmd+Shift+Z and Ctrl+Y redo, but a text field keeps its own undo", () => {
    expect(websiteEditorShortcut(key("z", { metaKey: true }))).toBe("undo");
    expect(websiteEditorShortcut(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(websiteEditorShortcut(key("y", { ctrlKey: true }))).toBe("redo");
    expect(websiteEditorShortcut(key("z", { metaKey: true, inTextField: true }))).toBeNull();
    expect(websiteEditorShortcut(key("z", { metaKey: true, altKey: true }))).toBeNull();
  });

  it("Esc is the editor's, except in a text field", () => {
    expect(websiteEditorShortcut(key("Escape"))).toBe("escape");
    expect(websiteEditorShortcut(key("Escape", { inTextField: true }))).toBeNull();
  });
});

describe("websiteEditorEscape", () => {
  it("closes the drawer first, then clears the selection, then leaves", () => {
    expect(websiteEditorEscape({ drawerOpen: true, selected: true })).toBe("close-drawer");
    expect(websiteEditorEscape({ drawerOpen: false, selected: true })).toBe("deselect");
    expect(websiteEditorEscape({ drawerOpen: false, selected: false })).toBe("leave");
  });
});

describe("isTextField", () => {
  it("knows text inputs, text areas and editable text from buttons", () => {
    expect(isTextField(document.createElement("textarea"))).toBe(true);
    expect(isTextField(Object.assign(document.createElement("input"), { type: "search" }))).toBe(true);
    expect(isTextField(Object.assign(document.createElement("input"), { type: "checkbox" }))).toBe(false);
    expect(isTextField(document.createElement("button"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
