import { describe, expect, it } from "vitest";
import {
  acceptIssueThreadInteractionSchema,
  createIssueThreadInteractionSchema,
  requestStepsPayloadSchema,
  requestStepsResultSchema,
} from "./validators/issue.js";
import { interactionResolverGovernanceSchema } from "./validators/company.js";

const step = (text = "Open **Settings → API keys**.") => ({ text });
const base = {
  version: 1 as const,
  title: "Stripe test key",
  why: "So the agents can test checkout.",
  minutes: 2,
  risk: "safe" as const,
  steps: [step()],
};

describe("request_steps payload", () => {
  it("accepts a full card", () => {
    const parsed = requestStepsPayloadSchema.parse({
      ...base,
      steps: [
        { text: "Name it:", copy: ["GSAM agents"], link: { label: "Open Stripe", url: "https://dashboard.stripe.com" }, expect: "A new key" },
      ],
      secret: {
        secretName: "stripe/sandbox-agents",
        description: "Stripe sandbox key",
        expectedPrefix: "rk_test_",
        linkToAgentIds: ["11111111-1111-4111-8111-111111111111"],
        adapterEnvKey: "STRIPE_SECRET_KEY",
      },
      afterDone: "I run the tests.",
    });
    expect(parsed.steps[0]!.copy).toEqual(["GSAM agents"]);
  });

  it("allows at most 12 steps and at least one", () => {
    expect(requestStepsPayloadSchema.safeParse({ ...base, steps: Array.from({ length: 12 }, () => step()) }).success).toBe(true);
    expect(requestStepsPayloadSchema.safeParse({ ...base, steps: Array.from({ length: 13 }, () => step()) }).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
  });

  it("only takes https links", () => {
    const withLink = (url: string) => ({ ...base, steps: [{ text: "Go", link: { label: "Open", url } }] });
    expect(requestStepsPayloadSchema.safeParse(withLink("https://example.com")).success).toBe(true);
    expect(requestStepsPayloadSchema.safeParse(withLink("http://example.com")).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse(withLink("javascript:alert(1)")).success).toBe(false);
  });

  it("checks risk and minutes", () => {
    expect(requestStepsPayloadSchema.safeParse({ ...base, risk: "spicy" }).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse({ ...base, minutes: 0 }).success).toBe(false);
  });

  it("enforces the secret field rules", () => {
    const secret = (extra: Record<string, unknown>) => ({
      ...base,
      secret: { secretName: "stripe/key", description: "A key", ...extra },
    });
    expect(requestStepsPayloadSchema.safeParse(secret({})).success).toBe(true);
    expect(requestStepsPayloadSchema.safeParse(secret({ secretName: "has spaces" })).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse(secret({ linkToAgentIds: ["11111111-1111-4111-8111-111111111111"] })).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse(secret({ adapterEnvKey: "STRIPE_KEY" })).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse(secret({ adapterEnvKey: "not-an-env", linkToAgentIds: ["11111111-1111-4111-8111-111111111111"] })).success).toBe(false);
    expect(requestStepsPayloadSchema.safeParse(secret({ linkToAgentIds: ["not-a-uuid"], adapterEnvKey: "KEY" })).success).toBe(false);
  });

  it("keeps ticks within the steps", () => {
    expect(requestStepsPayloadSchema.safeParse({ ...base, progress: { tickedSteps: [0] } }).success).toBe(true);
    expect(requestStepsPayloadSchema.safeParse({ ...base, progress: { tickedSteps: [1] } }).success).toBe(false);
  });

  it("is a create kind that wakes the asker by default", () => {
    const parsed = createIssueThreadInteractionSchema.parse({ kind: "request_steps", payload: base });
    expect(parsed).toMatchObject({ kind: "request_steps", continuationPolicy: "wake_assignee" });
  });

  it("never lets a value into the result's secret block", () => {
    const ok = { secretId: "11111111-1111-4111-8111-111111111111", secretName: "stripe/key", linkedAgentIds: [] };
    expect(requestStepsResultSchema.safeParse({ version: 1, outcome: "accepted", secret: ok }).success).toBe(true);
    expect(requestStepsResultSchema.safeParse({ version: 1, outcome: "accepted", secret: { ...ok, value: "rk_test_x" } }).success).toBe(false);
  });

  it("accepts the secret value only on the accept body", () => {
    expect(acceptIssueThreadInteractionSchema.parse({ secretValue: "rk_test_x" })).toEqual({ secretValue: "rk_test_x" });
    expect(acceptIssueThreadInteractionSchema.safeParse({ secretValue: "" }).success).toBe(false);
  });

  it("can carry company resolver governance like every other kind", () => {
    expect(
      interactionResolverGovernanceSchema.parse({ request_steps: { defaultPolicy: "human_only" } }),
    ).toEqual({ request_steps: { defaultPolicy: "human_only" } });
  });
});
