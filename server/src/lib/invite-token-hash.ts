import { createHash } from "node:crypto";

/**
 * How an invite token is stored: `invites.tokenHash` holds the sha256 hex
 * digest and the raw token is only ever returned once, on creation.
 *
 * Shared by the invite routes and the invite-backed sign-up gate so both look
 * an invite up the same way.
 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
