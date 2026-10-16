import { describe, expect, it } from "vitest";
import { IMAGE_ALT_TEXT_MAX_LENGTH, composeImagePrompt, imageAltText } from "./image-generation.js";

describe("imageAltText", () => {
  it("keeps what the picture shows and drops directions to the image service", () => {
    expect(
      imageAltText("bright photo of a small team celebrating in a modern office, natural light, no text, 4k"),
    ).toBe("Bright photo of a small team celebrating in a modern office, natural light");
  });

  it("names an illustration as one", () => {
    expect(imageAltText("a lighthouse guiding ships at dawn", "illustration")).toBe(
      "Illustration: A lighthouse guiding ships at dawn",
    );
  });

  it("stays short, cutting at a word", () => {
    const alt = imageAltText(`a market stall ${"with fresh fruit and flowers ".repeat(12)}`);
    expect(alt.length).toBeLessThanOrEqual(IMAGE_ALT_TEXT_MAX_LENGTH + 3);
    expect(alt.endsWith("...")).toBe(true);
    expect(alt).not.toMatch(/\s\.\.\.$/);
  });

  it("falls back when only directions were given", () => {
    expect(imageAltText("no text, high resolution")).toBe("Generated image");
  });
});

describe("composeImagePrompt", () => {
  it("adds the style guidance after the person's words", () => {
    expect(composeImagePrompt("a lighthouse", null)).toBe("a lighthouse");
    expect(composeImagePrompt("a lighthouse", "illustration")).toMatch(/^a lighthouse\. /);
  });
});
