import { describe, expect, it } from "vitest";
import {
  addLiveRunSecretValue,
  collectRunSecretValues,
  redactRunSecretValues,
  releaseLiveRunSecretValues,
  withLiveRunSecretValues,
} from "./run-secret-values.js";

describe("run secret values (GRE-517)", () => {
  const env = {
    GSAM_API_KEY: "run-api-key-fixture-value",
    GSAM_GITHUB_BROKER_TOKEN: "run-broker-token-fixture",
    CUSTOM_PROVIDER_URL: "https://provider.example/listed-secret",
    GSAM_RUN_ID: "run-id-fixture-not-secret",
    SHORT_TOKEN: "abc",
  };

  it("collects secret-named and listed values, skipping short and non-secret ones", () => {
    const values = collectRunSecretValues(env, { secretKeys: ["CUSTOM_PROVIDER_URL"], extraValues: ["minted-run-jwt-fixture", null] });
    expect(values.sort()).toEqual(
      ["https://provider.example/listed-secret", "minted-run-jwt-fixture", "run-api-key-fixture-value", "run-broker-token-fixture"].sort(),
    );
  });

  it("redacts every printed occurrence, longest value first", () => {
    const values = collectRunSecretValues({ A_TOKEN: "abcdefghijklmnop", B_TOKEN: "abcdefghijklmnop-longer" });
    const printed = "A_TOKEN=abcdefghijklmnop\nB_TOKEN=abcdefghijklmnop-longer\nGSAM_RUN_ID=run-id-fixture-not-secret";
    expect(redactRunSecretValues(printed, values)).toBe(
      "A_TOKEN=***REDACTED***\nB_TOKEN=***REDACTED***\nGSAM_RUN_ID=run-id-fixture-not-secret",
    );
  });
});

describe("live run secret values (GRE-6519)", () => {
  it("adds values read after launch to that run only, longest first, until released", () => {
    addLiveRunSecretValue("run-a", "api-read-secret-fixture");
    addLiveRunSecretValue("run-a", "short");
    addLiveRunSecretValue("run-b", "other-run-secret-fixture");

    expect(withLiveRunSecretValues("run-a", ["launch-env-secret-fixture-longer"])).toEqual([
      "launch-env-secret-fixture-longer",
      "api-read-secret-fixture",
    ]);
    expect(withLiveRunSecretValues(undefined, ["launch-env-secret-fixture"])).toEqual(["launch-env-secret-fixture"]);

    releaseLiveRunSecretValues("run-a");
    expect(withLiveRunSecretValues("run-a", [])).toEqual([]);
    expect(withLiveRunSecretValues("run-b", [])).toEqual(["other-run-secret-fixture"]);
    releaseLiveRunSecretValues("run-b");
  });
});
