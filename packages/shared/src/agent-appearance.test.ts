import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_PALETTE_GROUPS, AGENT_PALETTE_IDS, GREATSTONE_AGENT_PALETTE_IDS, LEGACY_AGENT_PALETTE_IDS, agentAppearanceSchema,
  agentPaletteLabel, appearanceForPalette, isGreatstoneAgentPalette, legacyAgentAppearance, randomAgentAppearance,
  resolveAgentAppearance, agentAvatarUrl,
} from "./agent-appearance.js";
import { CAP_V1_COLORS } from "./cliplab/palette-tokens.js";
import { renderAgentSvg } from "./cliplab/static.js";

const MIGRATION_0280 = readFileSync(new URL("../../db/src/migrations/0280_unique_genesis.sql", import.meta.url), "utf8");

describe("agent palettes", () => {
  it("keeps the legacy list identical to the one migration 0280 hashed over", () => {
    const array = /ARRAY\[([^\]]+)\]/.exec(MIGRATION_0280)?.[1];
    const modulo = /\)\)\s*%\s*(\d+)/.exec(MIGRATION_0280)?.[1];
    expect(array).toBeDefined();
    expect(array!.split(",").map(id => id.trim().replace(/^'|'$/g, ""))).toEqual([...LEGACY_AGENT_PALETTE_IDS]);
    expect(Number(modulo)).toBe(LEGACY_AGENT_PALETTE_IDS.length);
    expect(LEGACY_AGENT_PALETTE_IDS).toHaveLength(17);
  });
  it("pins the legacy id to palette mapping so adding palettes can never re-colour existing agents", () => {
    // Recorded from the original 17-palette implementation. If any of these
    // change, agents with no stored appearance change colour: do not update
    // these values, fix the hash instead.
    const pinned: Record<string, string> = {
      "": "bubblegum-sky",
      "a": "electric-grove",
      "agent": "deep-tide",
      "agent-1": "coral-mint",
      "00000000-0000-0000-0000-000000000000": "ultraviolet-tide",
      "34dad57e-b5ad-4a72-9400-9eba645c99f6": "tangerine-cobalt",
      "7c9e6679-7425-40de-944b-e07fc1f90ae7": "deep-tide",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479": "turquoise-cherry",
      "123e4567-e89b-12d3-a456-426614174000": "electric-grove",
    };
    for (const [id, paletteId] of Object.entries(pinned)) expect(legacyAgentAppearance(id).paletteId, id).toBe(paletteId);
    for (let i = 0; i < 200; i++) {
      expect(LEGACY_AGENT_PALETTE_IDS).toContain(legacyAgentAppearance(`agent-${i}`).paletteId);
    }
  });
  it("adds the Greatstone set after the legacy ids, with no duplicates and tokens for every palette", () => {
    expect(AGENT_PALETTE_IDS.slice(0, LEGACY_AGENT_PALETTE_IDS.length)).toEqual([...LEGACY_AGENT_PALETTE_IDS]);
    expect(AGENT_PALETTE_IDS.slice(LEGACY_AGENT_PALETTE_IDS.length)).toEqual([...GREATSTONE_AGENT_PALETTE_IDS]);
    expect(new Set(AGENT_PALETTE_IDS).size).toBe(AGENT_PALETTE_IDS.length);
    expect(GREATSTONE_AGENT_PALETTE_IDS.length).toBeGreaterThanOrEqual(6);
    expect(GREATSTONE_AGENT_PALETTE_IDS.every(id => id.startsWith("gs-"))).toBe(true);
    for (const id of AGENT_PALETTE_IDS) {
      const colors = (CAP_V1_COLORS as Record<string, { a: string; b: string }>)[id];
      expect(colors?.a, id).toMatch(/^#[0-9a-f]{6}$/);
      expect(colors?.b, id).toMatch(/^#[0-9a-f]{6}$/);
      expect(agentAppearanceSchema.safeParse(appearanceForPalette(id)).success).toBe(true);
    }
  });
  it("groups Greatstone first and labels palettes in plain words", () => {
    expect(AGENT_PALETTE_GROUPS.map(group => group.id)).toEqual(["greatstone", "classic"]);
    expect(AGENT_PALETTE_GROUPS.flatMap(group => [...group.paletteIds]).sort()).toEqual([...AGENT_PALETTE_IDS].sort());
    expect(agentPaletteLabel("gs-lime")).toBe("Lime");
    expect(agentPaletteLabel("bubblegum-sky")).toBe("Bubblegum sky");
    expect(isGreatstoneAgentPalette("gs-tide")).toBe(true);
    expect(isGreatstoneAgentPalette("deep-tide")).toBe(false);
  });
});

describe("agent appearance", () => {
  it("assigns new hires a Greatstone palette by default", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const { paletteId } = randomAgentAppearance();
      expect(GREATSTONE_AGENT_PALETTE_IDS).toContain(paletteId);
      seen.add(paletteId);
    }
    // 400 draws over 8 palettes: missing one is a ~1e-22 event, so this catches a stuck generator.
    expect(seen.size).toBe(GREATSTONE_AGENT_PALETTE_IDS.length);
    for (let i = 0; i < 50; i++) expect(LEGACY_AGENT_PALETTE_IDS).toContain(randomAgentAppearance(LEGACY_AGENT_PALETTE_IDS).paletteId);
    expect(agentAppearanceSchema.safeParse({ schemaVersion: 1, characterVersion: "cap-v1", paletteId: "muted-dream" }).success).toBe(false);
  });
  it("preserves a saved appearance and resolves legacy IDs deterministically", () => {
    const appearance = appearanceForPalette("deep-tide");
    expect(resolveAgentAppearance(appearance, "different-id")).toEqual(appearance);
    expect(resolveAgentAppearance(null, "agent-1")).toEqual(legacyAgentAppearance("agent-1"));
    expect(legacyAgentAppearance("agent-1")).toEqual(legacyAgentAppearance("agent-1"));
    expect(agentAvatarUrl(appearance, 24, 2)).toBe("/api/agent-avatars/cap-v1/deep-tide/rest.png?size=24&scale=2");
  });
  it("renders without a browser and preserves logical-size detail at high density", () => {
    const appearance = appearanceForPalette("bubblegum-sky");
    // ClipLab v0.2.0 draws an enlarged compact face from 16px; only 12px and
    // below (not a logical size) is body-only.
    const small = renderAgentSvg(appearance, 16, 2);
    expect(small).toContain('width="32"');
    expect(small).toContain('id="agent-face-visible"');
    const eyes = renderAgentSvg(appearance, 24, 2);
    expect(eyes).toContain('width="48"');
    expect(eyes).toContain('id="agent-face-visible"');
    expect(eyes).not.toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 48, 1)).toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 24, 2)).toBe(eyes);
  });
});
