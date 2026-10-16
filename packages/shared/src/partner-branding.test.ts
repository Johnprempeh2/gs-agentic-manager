import { describe, expect, it } from "vitest";
import {
  BRAND_LOGO_URL_ENV_KEY,
  BRAND_NAME_ENV_KEY,
  BRAND_PRIMARY_COLOR_ENV_KEY,
  THEME_BACKGROUNDS,
  checkPartnerColor,
  contrastRatio,
  parsePartnerBranding,
} from "./partner-branding.js";

describe("parsePartnerBranding", () => {
  it("returns no branding and no warnings when all three env vars are unset", () => {
    expect(parsePartnerBranding({})).toEqual({ branding: null, warnings: [] });
  });

  it("treats blank values as unset", () => {
    expect(
      parsePartnerBranding({
        [BRAND_NAME_ENV_KEY]: "  ",
        [BRAND_LOGO_URL_ENV_KEY]: "",
        [BRAND_PRIMARY_COLOR_ENV_KEY]: " ",
      }),
    ).toEqual({ branding: null, warnings: [] });
  });

  it("parses a full partner brand", () => {
    const { branding, warnings } = parsePartnerBranding({
      [BRAND_NAME_ENV_KEY]: "  Partner Co  ",
      [BRAND_LOGO_URL_ENV_KEY]: "https://cdn.example.com/partner-logo.svg",
      [BRAND_PRIMARY_COLOR_ENV_KEY]: "#0F766E",
    });
    expect(warnings).toEqual([]);
    expect(branding).toEqual({
      name: "Partner Co",
      logoUrl: "https://cdn.example.com/partner-logo.svg",
      colors: {
        light: { primary: "#0f766e", primaryForeground: "#f5f7f2" },
        dark: { primary: "#0f766e", primaryForeground: "#f5f7f2" },
      },
    });
  });

  it("accepts a name on its own", () => {
    const { branding } = parsePartnerBranding({ [BRAND_NAME_ENV_KEY]: "Partner Co" });
    expect(branding).toEqual({ name: "Partner Co", logoUrl: null, colors: { light: null, dark: null } });
  });

  it("accepts a same-origin logo path and short hex", () => {
    const { branding } = parsePartnerBranding({
      [BRAND_LOGO_URL_ENV_KEY]: "/partner/logo.png",
      [BRAND_PRIMARY_COLOR_ENV_KEY]: "036",
    });
    expect(branding?.logoUrl).toBe("/partner/logo.png");
    expect(branding?.colors.light?.primary).toBe("#003366");
  });

  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//evil.example/logo.png", "not a url"])(
    "refuses the logo URL %s with a warning",
    (logo) => {
      const { branding, warnings } = parsePartnerBranding({ [BRAND_LOGO_URL_ENV_KEY]: logo });
      expect(branding).toBeNull();
      expect(warnings).toEqual([expect.stringContaining(BRAND_LOGO_URL_ENV_KEY)]);
    },
  );

  it("ignores an over-long name with a warning", () => {
    const { branding, warnings } = parsePartnerBranding({ [BRAND_NAME_ENV_KEY]: "x".repeat(61) });
    expect(branding).toBeNull();
    expect(warnings).toEqual([expect.stringContaining("longer than 60")]);
  });

  it("ignores a colour that is not hex", () => {
    const { branding, warnings } = parsePartnerBranding({
      [BRAND_NAME_ENV_KEY]: "Partner Co",
      [BRAND_PRIMARY_COLOR_ENV_KEY]: "teal",
    });
    expect(branding?.colors).toEqual({ light: null, dark: null });
    expect(warnings).toEqual([expect.stringContaining("hex colour")]);
  });

  it("keeps the default theme in a mode where the colour fails contrast", () => {
    // Dark navy: strong on the light page, invisible on the dark one.
    const { branding, warnings } = parsePartnerBranding({ [BRAND_PRIMARY_COLOR_ENV_KEY]: "#1e3a8a" });
    expect(branding?.colors.light).toEqual({ primary: "#1e3a8a", primaryForeground: "#f5f7f2" });
    expect(branding?.colors.dark).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/fails the contrast check in dark mode .*against the dark page/)]);
  });

  it("rejects a colour in both modes when button text cannot be read on it", () => {
    // Mid grey: neither light nor dark button text reaches 4.5:1.
    const { branding, warnings } = parsePartnerBranding({ [BRAND_PRIMARY_COLOR_ENV_KEY]: "#7a7a7a" });
    expect(branding).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/light mode \(button text on it is .*needs 4.5:1\)/);
  });
});

describe("checkPartnerColor", () => {
  it("passes our own light theme primary in light mode", () => {
    expect(checkPartnerColor("#1b5039", "light")).toEqual({
      color: { primary: "#1b5039", primaryForeground: "#f5f7f2" },
    });
  });

  it("passes our own dark theme primary in dark mode with dark button text", () => {
    expect(checkPartnerColor("#c8ff00", "dark")).toEqual({
      color: { primary: "#c8ff00", primaryForeground: "#0e1611" },
    });
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio(THEME_BACKGROUNDS.light, THEME_BACKGROUNDS.light)).toBe(1);
  });
});
