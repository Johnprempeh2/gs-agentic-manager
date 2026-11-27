import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyActionLabel } from "./CopyActionLabel";

const label = (copy: { copied: boolean; failed: boolean }) =>
  renderToStaticMarkup(<CopyActionLabel copy={copy}>Copy as an update</CopyActionLabel>);

describe("CopyActionLabel", () => {
  it("reads the resting words, then the answer, and nothing else", () => {
    expect(label({ copied: false, failed: false })).toContain(">Copy as an update<");
    expect(label({ copied: true, failed: false })).toContain(">Copied<");
    expect(label({ copied: false, failed: true })).toContain(">Could not copy<");
  });

  it("keeps the resting words as its reserved width while the answer shows", () => {
    expect(label({ copied: true, failed: false })).toContain('data-reserve="Copy as an update"');
  });
});
