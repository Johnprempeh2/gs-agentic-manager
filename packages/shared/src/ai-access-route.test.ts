import { describe, expect, it } from "vitest";
import {
  AI_ACCESS_ROUTES,
  AI_ACCESS_ROUTE_DEFINITIONS,
  AI_CONNECTION_CAPABILITIES,
  isAiAuthRequiredErrorCode,
} from "./ai-connections.js";
import { instanceGeneralSettingsSchema, patchInstanceGeneralSettingsSchema } from "./validators/instance.js";

describe("AI access route setting (GRE-139)", () => {
  it("is absent by default, accepts each route, and clears with null", () => {
    expect(instanceGeneralSettingsSchema.parse({}).aiAccessRoute).toBeUndefined();
    for (const route of AI_ACCESS_ROUTES) {
      expect(patchInstanceGeneralSettingsSchema.parse({ aiAccessRoute: route })).toEqual({ aiAccessRoute: route });
    }
    expect(patchInstanceGeneralSettingsSchema.parse({ aiAccessRoute: null })).toEqual({ aiAccessRoute: null });
    expect(patchInstanceGeneralSettingsSchema.safeParse({ aiAccessRoute: "claude_bedrock" }).success).toBe(false);
  });

  it("maps every route to a harness that supports its sign-in method", () => {
    for (const route of AI_ACCESS_ROUTES) {
      const { provider, method, adapterType } = AI_ACCESS_ROUTE_DEFINITIONS[route];
      expect(AI_CONNECTION_CAPABILITIES[provider].methods[method]?.adapters).toContain(adapterType);
    }
  });
});

describe("isAiAuthRequiredErrorCode", () => {
  it("treats a rejected login on every route as needing a person", () => {
    expect(isAiAuthRequiredErrorCode("claude_auth_required")).toBe(true);
    expect(isAiAuthRequiredErrorCode("codex_auth_required")).toBe(true);
    expect(isAiAuthRequiredErrorCode("refresh_token_expired")).toBe(true);
    expect(isAiAuthRequiredErrorCode("refresh_token_invalidated")).toBe(true);
  });

  it("leaves races, probes and other failures to their own handling", () => {
    expect(isAiAuthRequiredErrorCode("refresh_token_reused")).toBe(false);
    expect(isAiAuthRequiredErrorCode("claude_hello_probe_auth_required")).toBe(false);
    expect(isAiAuthRequiredErrorCode("provider_quota")).toBe(false);
    expect(isAiAuthRequiredErrorCode(null)).toBe(false);
  });
});
