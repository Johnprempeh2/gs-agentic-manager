import { describe, expect, it, vi } from "vitest";
import { checkAiCredential } from "./ai-credential-check.js";

const subscription = { provider: "anthropic", method: "subscription" } as const;
const respond = (status: number) => vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

describe("checkAiCredential", () => {
  it("counts only a clear authentication refusal as rejected", async () => {
    expect(await checkAiCredential(subscription, "sk-ant-oat-fixture", respond(200))).toBe("valid");
    expect(await checkAiCredential(subscription, "sk-ant-oat-fixture", respond(401))).toBe("rejected");
    // A setup-token without the profile scope, an outage, or a rate limit does
    // not prove the credential is dead.
    for (const status of [403, 429, 500, 529])
      expect(await checkAiCredential(subscription, "sk-ant-oat-fixture", respond(status))).toBe("unknown");
    const offline = vi.fn(async () => { throw new Error("sk-ant-oat-fixture refused"); }) as unknown as typeof fetch;
    expect(await checkAiCredential(subscription, "sk-ant-oat-fixture", offline)).toBe("unknown");
  });

  it("sends the credential the way each sign-in method expects", async () => {
    const fetcher = respond(200);
    await checkAiCredential(subscription, "oauth-fixture", fetcher);
    await checkAiCredential({ provider: "anthropic", method: "api_key" }, "key-fixture", fetcher);
    expect(vi.mocked(fetcher).mock.calls.map(([url, init]) => [url, (init as RequestInit).headers])).toEqual([
      ["https://api.anthropic.com/api/oauth/usage", expect.objectContaining({ Authorization: "Bearer oauth-fixture" })],
      ["https://api.anthropic.com/v1/models?limit=1", expect.objectContaining({ "x-api-key": "key-fixture" })],
    ]);
  });

  it("does not guess for a subscription it has no check for", async () => {
    const fetcher = respond(200);
    expect(await checkAiCredential({ provider: "openai", method: "subscription" }, "{}", fetcher)).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
