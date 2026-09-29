import { AI_CONNECTION_CAPABILITIES, type AiConnectionBinding } from "@greatstone/shared";
import type { Db } from "@greatstone/db";
import { aiConnectionService } from "./ai-connections.js";
import { AI_AUTH_ENV_KEYS } from "./ai-connection-runtime.js";

export type BoardChatClaudeCredential = { envKey: string; value: string };

/**
 * The Claude account the Conference Room relay runs the `claude` CLI with
 * (GRE-254): the requesting user's own Claude default, else a company-shared
 * Claude account. Never the host's login. Returns null when the company has
 * no Claude account this user can use; throws when the chosen account is not
 * usable (expired, disconnected, not shared with the user).
 */
export async function resolveBoardChatClaudeCredential(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<BoardChatClaudeCredential | null> {
  const service = aiConnectionService(db);
  const accounts = (await service.list(input.companyId, input.userId)).filter(
    (account) => account.provider === "anthropic",
  );
  const personal = accounts.find((account) => account.ownership === "personal" && account.isDefault);
  const shared =
    accounts.find((account) => account.ownership === "shared" && account.status === "connected") ??
    accounts.find((account) => account.ownership === "shared");
  let binding: AiConnectionBinding;
  if (personal) {
    binding = { provider: "anthropic", method: personal.method, mode: "responsible_user" };
  } else if (shared) {
    binding = {
      provider: "anthropic",
      method: shared.method,
      mode: "shared",
      connectionId: shared.id,
      grantId: shared.grantId,
    };
  } else {
    return null;
  }
  // The relay is the operator's own chat, not an agent, so there is no agent
  // install to check; select() still enforces membership, sharing and health.
  const selection = await service.select({
    companyId: input.companyId,
    userId: input.userId,
    agentId: "",
    adapterType: "claude_local",
    binding,
    allowUninstalledPersonal: true,
    allowUninstalledShared: true,
  });
  const value = await service.credential(selection);
  const envKey = AI_CONNECTION_CAPABILITIES.anthropic.methods[selection.attribution.method]!.envKey;
  return { envKey, value };
}

/**
 * The relay's CLI environment: the server's environment with every inherited
 * AI credential and provider override removed, the company credential set, and
 * a fresh config directory so the host's Claude login and settings (for
 * example an apiKeyHelper) cannot take precedence.
 */
export function boardChatClaudeEnv(
  baseEnv: NodeJS.ProcessEnv,
  credential: BoardChatClaudeCredential,
  configDir: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of AI_AUTH_ENV_KEYS) delete env[key];
  return { ...env, ...extra, CLAUDE_CONFIG_DIR: configDir, [credential.envKey]: credential.value };
}
