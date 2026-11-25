/**
 * The files that make a GSAM server a fleet spoke (GSAM for Mac, P1). The Mac
 * app's activation writes them into the instance root; nothing else does.
 *
 *   fleet/spoke.json        hub URL, instance id and code, the pinned hub
 *                           entitlement public key, the operator email. No secret.
 *   fleet/key.json          the spoke's Ed25519 private key (mode 600). Never sent.
 *   fleet/operator.json     the operator log-in from activation (mode 600), until
 *                           the server has made it; then deleted.
 *   fleet/owner-invite.json the owner's one-time set-up link (mode 600), while
 *                           no owner exists; then deleted.
 *   fleet/spoke-state.json  the last seq sent and the last check-in result.
 *   fleet/orders.json       (P2) the last order seq obeyed, the hold it set
 *                           (paused or stopped) and results not yet reported.
 *   fleet/tailscale.json    (P2) the one-use Tailscale auth key from activation
 *                           (mode 600), until gsam.sh `tailscale` has joined.
 *   fleet/tailnet.json      (P2) the install's tailnet name, written by gsam.sh.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fleetInstanceCodeSchema } from "@greatstone/shared/fleet";

export const fleetSpokeConfigSchema = z
  .object({
    v: z.literal(1),
    hubUrl: z.string().url(),
    instanceId: z.string().uuid(),
    code: fleetInstanceCodeSchema,
    /** Raw 32 bytes, base64url. Pinned at activation; every document must carry this key's signature. */
    entitlementPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    operatorEmail: z.string().email(),
    activatedAt: z.string(),
  })
  .strict();
export type FleetSpokeConfig = z.infer<typeof fleetSpokeConfigSchema>;

export function fleetSpokePaths(instanceRoot: string) {
  const dir = path.join(instanceRoot, "fleet");
  return {
    dir,
    config: path.join(dir, "spoke.json"),
    key: path.join(dir, "key.json"),
    operator: path.join(dir, "operator.json"),
    ownerInvite: path.join(dir, "owner-invite.json"),
    state: path.join(dir, "spoke-state.json"),
    orders: path.join(dir, "orders.json"),
    tailnet: path.join(dir, "tailnet.json"),
  };
}

/** Null when this instance is not a spoke. Throws when the file is there but wrong: a spoke never runs half set up. */
export function readFleetSpokeConfig(instanceRoot: string): FleetSpokeConfig | null {
  let text: string;
  try {
    text = readFileSync(fleetSpokePaths(instanceRoot).config, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = fleetSpokeConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`fleet/spoke.json is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}
