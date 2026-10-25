import { describe, expect, it } from "vitest";
import {
  BLANK_CHECK_SAMPLE_SIZE,
  dominantColourShare,
  isScreenshotLikeFilename,
  looksBlankScreenshot,
} from "./screenshot-blank-check.js";

const SIZE = BLANK_CHECK_SAMPLE_SIZE;

/** A white canvas with a dark top bar `barRows` rows tall, like the GRE-2350 shots. */
function canvasWithTopBar(barRows: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const o = (y * SIZE + x) * 4;
      const value = y < barRows ? 30 : 255;
      px[o] = value;
      px[o + 1] = value;
      px[o + 2] = value;
      px[o + 3] = 255;
    }
  }
  return px;
}

/** A page with varied content: a gradient so no colour dominates. */
function pageWithContent(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    px[i * 4] = (i * 7) % 256;
    px[i * 4 + 1] = (i * 13) % 256;
    px[i * 4 + 2] = (i * 3) % 256;
    px[i * 4 + 3] = 255;
  }
  return px;
}

describe("isScreenshotLikeFilename", () => {
  it("matches screenshot, before and after names in any case", () => {
    expect(isScreenshotLikeFilename("before-laptop-topbar.png")).toBe(true);
    expect(isScreenshotLikeFilename("after-laptop-thread.png")).toBe(true);
    expect(isScreenshotLikeFilename("Screenshot 2026-10-25.png")).toBe(true);
  });

  it("ignores other names and missing names", () => {
    expect(isScreenshotLikeFilename("logo.png")).toBe(false);
    expect(isScreenshotLikeFilename(null)).toBe(false);
    expect(isScreenshotLikeFilename("")).toBe(false);
  });
});

describe("looksBlankScreenshot", () => {
  it("flags an empty canvas under a thin top bar", () => {
    // 4 of 64 rows of bar: 93.75% white.
    expect(looksBlankScreenshot(canvasWithTopBar(4))).toBe(true);
  });

  it("flags a single flat colour", () => {
    expect(dominantColourShare(canvasWithTopBar(0))).toBe(1);
    expect(looksBlankScreenshot(canvasWithTopBar(0))).toBe(true);
  });

  it("does not flag when the flat colour is 90% or less", () => {
    // 8 of 64 rows of bar: 87.5% white.
    expect(looksBlankScreenshot(canvasWithTopBar(8))).toBe(false);
  });

  it("does not flag a page with content", () => {
    expect(looksBlankScreenshot(pageWithContent())).toBe(false);
  });

  it("treats small compression noise in a flat area as one colour", () => {
    const px = canvasWithTopBar(0);
    for (let i = 0; i < px.length; i += 4) {
      const noise = i % 3;
      px[i] = 255 - noise;
      px[i + 1] = 255 - noise;
      px[i + 2] = 255 - noise;
    }
    expect(looksBlankScreenshot(px)).toBe(true);
  });

  it("treats a fully transparent image as blank and an empty buffer as not blank", () => {
    expect(looksBlankScreenshot(new Uint8ClampedArray(SIZE * SIZE * 4))).toBe(true);
    expect(looksBlankScreenshot(new Uint8ClampedArray(0))).toBe(false);
  });
});
