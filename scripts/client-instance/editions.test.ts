// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/editions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTANCE_FEATURE_CATALOG } from "../../packages/shared/src/feature-catalog.js";
import { parseManagedConfigEnv } from "../../server/src/services/managed-config.js";
import {
  MANAGED_FEATURES_OFF,
  MANAGED_FEATURES_ON,
  MANAGED_HIDDEN_SETTINGS,
  buildEditionValues,
} from "./editions.js";

const catalogVersion = "test";

test("Managed values are accepted by the app's own GSAM_MANAGED_CONFIG parser", () => {
  const values = buildEditionValues({ edition: "managed", catalogVersion });
  const parsed = parseManagedConfigEnv({ GSAM_MANAGED_CONFIG: values.managedConfig });
  assert.ok(parsed);
  for (const key of MANAGED_FEATURES_ON) {
    if (INSTANCE_FEATURE_CATALOG[key].tier === "managed") assert.equal(parsed.features[key as never], true, key);
  }
  for (const key of MANAGED_FEATURES_OFF) {
    assert.equal(parsed.features[key as never], false, key);
  }
  assert.deepEqual(parsed.plugins.autoInstall, []);
});

test("Managed pins exactly the section 5 features", () => {
  const values = buildEditionValues({ edition: "managed", catalogVersion });
  const parsed = parseManagedConfigEnv({ GSAM_MANAGED_CONFIG: values.managedConfig });
  assert.ok(parsed);
  const managedOn = MANAGED_FEATURES_ON.filter((key) => INSTANCE_FEATURE_CATALOG[key].tier === "managed");
  assert.deepEqual(Object.keys(parsed.features).sort(), [...managedOn, ...MANAGED_FEATURES_OFF].sort());
  assert.deepEqual(values.expectOff, [...MANAGED_FEATURES_OFF].sort());
  assert.deepEqual(values.expectOn, [...MANAGED_FEATURES_ON].sort());
});

test("hidden settings are exactly section 5", () => {
  const values = buildEditionValues({ edition: "managed", catalogVersion });
  assert.equal(values.hiddenSettings, MANAGED_HIDDEN_SETTINGS.join(","));
  assert.equal(
    buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["enableCases"], catalogVersion }).hiddenSettings,
    values.hiddenSettings,
  );
});

test("the same input gives the same values", () => {
  const a = buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["enableCases", "enablePipelines"], catalogVersion });
  const b = buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["enablePipelines", "enableCases"], catalogVersion });
  assert.deepEqual(a, b);
});

test("Managed plus turns on only the passed features", () => {
  const values = buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["enablePipelines"], catalogVersion });
  const parsed = parseManagedConfigEnv({ GSAM_MANAGED_CONFIG: values.managedConfig });
  assert.ok(parsed);
  assert.equal(parsed.features.enablePipelines, true);
  assert.equal(parsed.features.enableCases, false);
  assert.ok(values.expectOn.includes("enablePipelines"));
  assert.ok(!values.expectOff.includes("enablePipelines"));
});

test("Managed plus with no passed features equals Managed features", () => {
  const managed = buildEditionValues({ edition: "managed", catalogVersion });
  const plus = buildEditionValues({ edition: "managed-plus", passedBetaFeatures: [], catalogVersion });
  assert.equal(plus.managedConfig, managed.managedConfig);
});

test("rejects features without a place in section 5", () => {
  assert.throws(() => buildEditionValues({ edition: "managed", passedBetaFeatures: ["enableCases"], catalogVersion }), /Managed edition/);
  assert.throws(
    () => buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["enableApps"], catalogVersion }),
    /not a Managed "off" beta feature/,
  );
  assert.throws(
    () => buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["notAFeature"], catalogVersion }),
    /not a Managed "off" beta feature/,
  );
  assert.throws(
    () => buildEditionValues({ edition: "managed-plus", passedBetaFeatures: ["enableOwnerInstanceAdmin"], catalogVersion }),
    /never part of Managed plus/,
  );
  assert.throws(() => buildEditionValues({ edition: "self-run" as never, catalogVersion }), /Unknown edition/);
});
