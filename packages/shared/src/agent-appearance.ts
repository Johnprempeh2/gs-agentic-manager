import { z } from "zod";

/**
 * The 17 original ClipLab palettes, in their original order. FROZEN: migration
 * 0280_unique_genesis.sql backfilled every pre-appearance agent by hashing its
 * id over exactly this list (modulo 17), and legacyAgentAppearance must keep
 * reproducing that result. Never reorder, remove or append to this list; add
 * new palettes to GREATSTONE_AGENT_PALETTE_IDS (or a new group) instead.
 */
export const LEGACY_AGENT_PALETTE_IDS = ["bubblegum-sky", "pink-lemonade", "orchid-peach", "coral-mint", "lime-lagoon", "arctic-blue", "solar-flare", "violet-ember", "deep-tide", "coral-current", "golden-hour", "tangerine-cobalt", "electric-grove", "flamingo-jade", "cherry-pop", "turquoise-cherry", "ultraviolet-tide"] as const;
/** Greatstone-toned palettes (void, lime, emerald, teal, paper, purple). New hires draw from these. */
export const GREATSTONE_AGENT_PALETTE_IDS = ["gs-lime", "gs-emerald", "gs-void", "gs-tide", "gs-lagoon", "gs-paper", "gs-orchid", "gs-sunrise"] as const;
/** Every palette an agent may store. Legacy ids stay first so index-based defaults never move. */
export const AGENT_PALETTE_IDS = [...LEGACY_AGENT_PALETTE_IDS, ...GREATSTONE_AGENT_PALETTE_IDS] as const;
export type LegacyAgentPaletteId = typeof LEGACY_AGENT_PALETTE_IDS[number];
export type GreatstoneAgentPaletteId = typeof GREATSTONE_AGENT_PALETTE_IDS[number];
export type AgentPaletteId = typeof AGENT_PALETTE_IDS[number];
/** Picker groups, Greatstone first. */
export const AGENT_PALETTE_GROUPS = [
  { id: "greatstone", label: "Greatstone", paletteIds: GREATSTONE_AGENT_PALETTE_IDS },
  { id: "classic", label: "Classic", paletteIds: LEGACY_AGENT_PALETTE_IDS },
] as const;
export function isGreatstoneAgentPalette(paletteId: string): paletteId is GreatstoneAgentPaletteId {
  return (GREATSTONE_AGENT_PALETTE_IDS as readonly string[]).includes(paletteId);
}
/** Human name for a palette id: "gs-lime" is "Lime", "bubblegum-sky" is "Bubblegum sky". */
export function agentPaletteLabel(paletteId: string): string {
  const words = paletteId.replace(/^gs-/, "").split("-");
  return words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
}
export type CharacterPaletteId = AgentPaletteId | "muted-dream";
export const AGENT_AVATAR_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512] as const;
export type AgentAvatarSize = typeof AGENT_AVATAR_SIZES[number];
export const CHARACTER_STATES = ["rest", "idle", "listening", "thinking", "working", "success", "confused", "sleepy", "loading"] as const;
export type CharacterState = typeof CHARACTER_STATES[number];
export const agentAppearanceSchema = z.object({
  schemaVersion: z.literal(1),
  characterVersion: z.literal("cap-v1"),
  paletteId: z.enum(AGENT_PALETTE_IDS),
}).strict();
export type AgentAppearance = z.infer<typeof agentAppearanceSchema>;

export function appearanceForPalette(paletteId: AgentPaletteId): AgentAppearance {
  return { schemaVersion: 1, characterVersion: "cap-v1", paletteId };
}
/** A persisted choice, never randomize while rendering. New hires get a Greatstone palette. */
export function randomAgentAppearance(pool: readonly AgentPaletteId[] = GREATSTONE_AGENT_PALETTE_IDS): AgentAppearance {
  const bytes = new Uint32Array(1);
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x100000000 / pool.length) * pool.length;
  do { globalThis.crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
  return appearanceForPalette(pool[bytes[0] % pool.length]!);
}
/**
 * Must match migration 0280: rolling base-31 hash, modulo 17 at every step,
 * over LEGACY_AGENT_PALETTE_IDS only. Hashing over AGENT_PALETTE_IDS would
 * silently re-colour every agent that has no stored appearance.
 */
export function legacyAgentAppearance(id: string): AgentAppearance {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % LEGACY_AGENT_PALETTE_IDS.length;
  return appearanceForPalette(LEGACY_AGENT_PALETTE_IDS[hash]!);
}
export function resolveAgentAppearance(appearance: unknown, id = "agent"): AgentAppearance {
  const parsed = agentAppearanceSchema.safeParse(appearance);
  return parsed.success ? parsed.data : legacyAgentAppearance(id);
}
export function agentAvatarUrl(appearance: AgentAppearance, size: AgentAvatarSize = 512, scale: 1 | 2 = 1, pose: CharacterState = "rest", muted = false): string {
  return `/api/agent-avatars/${appearance.characterVersion}/${muted ? "muted-dream" : appearance.paletteId}/${pose}.png?size=${size}&scale=${scale}`;
}
export function characterStateForAgent(status: string): CharacterState {
  if (status === "running") return "working";
  if (status === "error") return "confused";
  if (status === "paused" || status === "terminated" || status === "pending_approval") return "rest";
  return "idle";
}

/** Hydrate compact agent projections without an additional per-agent request. */
export function withAgentAppearance<T extends { id: string; appearance?: AgentAppearance | null }>(agent: T) {
  const appearance = resolveAgentAppearance(agent.appearance, agent.id);
  return { ...agent, appearance, avatarUrl: agentAvatarUrl(appearance) };
}
