import type { AiConnectionMetadata } from "@greatstone/shared";

/**
 * What a direct check of a stored credential says about it. Only a clear
 * authentication refusal counts as `rejected`; a scope refusal, a provider
 * outage or a network error is `unknown`, because none of them proves the
 * credential itself is dead.
 */
export type AiCredentialCheck = "valid" | "rejected" | "unknown";

export type AiCredentialChecker = (
  metadata: Pick<AiConnectionMetadata, "provider" | "method">,
  credential: string,
) => Promise<AiCredentialCheck>;

function request(
  metadata: Pick<AiConnectionMetadata, "provider" | "method">,
  credential: string,
): { url: string; headers: Record<string, string> } | null {
  if (metadata.provider === "anthropic")
    // A subscription token is checked the way a local login import is checked
    // (`fetchClaudeQuota`). A setup-token may lack the profile scope this
    // endpoint needs; that answer is a 403, which stays `unknown`.
    return metadata.method === "api_key"
      ? { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": credential, "anthropic-version": "2023-06-01" } }
      : { url: "https://api.anthropic.com/api/oauth/usage", headers: { Authorization: `Bearer ${credential}`, "anthropic-beta": "oauth-2025-04-20" } };
  if (metadata.method !== "api_key") return null;
  const url = {
    openai: "https://api.openai.com/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    xai: "https://api.x.ai/v1/models",
  }[metadata.provider];
  return url ? { url, headers: { Authorization: `Bearer ${credential}` } } : null;
}

/** Ask the provider, once and cheaply, whether it still accepts this credential. */
export async function checkAiCredential(
  metadata: Pick<AiConnectionMetadata, "provider" | "method">,
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<AiCredentialCheck> {
  const target = request(metadata, credential);
  if (!target) return "unknown";
  try {
    const response = await fetcher(target.url, {
      headers: target.headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "valid";
    return response.status === 401 ? "rejected" : "unknown";
  } catch {
    // Provider errors can echo credential material; never keep them.
    return "unknown";
  }
}
