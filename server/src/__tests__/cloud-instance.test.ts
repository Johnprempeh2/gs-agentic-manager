import { describe, expect, it } from "vitest";
import {
  getCloudStackContext,
  isCloudManagedInstance,
  type CloudInstanceEnv,
} from "../services/cloud-instance.js";

describe("isCloudManagedInstance", () => {
  it("unifies both prior signals without weakening either restrictive floor", () => {
    const cases: CloudInstanceEnv[] = [
      {},
      { GSAM_CLOUD_TENANT_SERVER_TOKEN: "tenant-token" },
      { GSAM_MANAGED_CONFIG: "" },
      {
        GSAM_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
        GSAM_MANAGED_CONFIG: "managed-document",
      },
    ];

    for (const env of cases) {
      const priorTokenFloor = Boolean(env.GSAM_CLOUD_TENANT_SERVER_TOKEN?.trim());
      const priorManagedConfigFloor = env.GSAM_MANAGED_CONFIG !== undefined;
      const canonicalFloor = isCloudManagedInstance(env);

      expect(canonicalFloor).toBe(priorTokenFloor || priorManagedConfigFloor);
      expect(canonicalFloor || !priorTokenFloor).toBe(true);
      expect(canonicalFloor || !priorManagedConfigFloor).toBe(true);
    }
  });

  it("does not treat a blank tenant token alone as a managed signal", () => {
    expect(isCloudManagedInstance({ GSAM_CLOUD_TENANT_SERVER_TOKEN: "   " })).toBe(false);
  });
});

describe("getCloudStackContext", () => {
  it("returns null outside Paperclip Cloud even when stray stack metadata exists", () => {
    expect(getCloudStackContext({ GSAM_STACK_SLUG: "stray-stack" })).toBeNull();
  });

  it("returns normalized provisioner metadata for cloud instances", () => {
    expect(getCloudStackContext({
      GSAM_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
      GSAM_CLOUD_STACK_ID: " stack-1 ",
      GSAM_STACK_SLUG: " acme ",
      GSAM_CLOUD_ACCOUNT_GROUP_ID: " account-group-1 ",
      GSAM_PRIMARY_HOST: " acme.paperclip.app ",
      GSAM_CLOUD_API_ORIGIN: " https://app.paperclip.app ",
    })).toEqual({
      stackId: "stack-1",
      stackSlug: "acme",
      accountGroupId: "account-group-1",
      primaryHost: "acme.paperclip.app",
      cloudOrigin: "https://app.paperclip.app",
    });
  });

  it("represents missing managed metadata explicitly without failing health checks", () => {
    expect(getCloudStackContext({ GSAM_MANAGED_CONFIG: "managed-document" })).toEqual({
      stackId: null,
      stackSlug: null,
      accountGroupId: null,
      primaryHost: null,
      cloudOrigin: null,
    });
  });
});
