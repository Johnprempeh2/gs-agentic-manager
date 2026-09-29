// Edition values for one-client-per-instance deployments (GRE-86 / GRE-87).
//
// An edition is only the pair of env values an instance starts with:
// `GSAM_MANAGED_CONFIG` (features pinned on/off, never stored in the DB) and
// `GSAM_HIDDEN_SETTINGS` (settings hidden in the UI; floored routes get 403).
// The lists below are section 5 of the product brief on GRE-83. Change them
// only when that section changes.

import {
  INSTANCE_FEATURE_CATALOG,
  INSTANCE_FEATURE_KEYS,
  type InstanceFeatureKey,
} from "../../packages/shared/src/feature-catalog.js";
import { parseHiddenSettingsList } from "../../packages/shared/src/settings-visibility.js";

export const EDITIONS = ["managed", "managed-plus"] as const;
export type Edition = (typeof EDITIONS)[number];

/** Section 5, Managed, "Features on". */
export const MANAGED_FEATURES_ON = [
  "enableStreamlinedUi",
  "enableStreamlinedLeftNavigation",
  "enableWorkspaceBranchReconcileForward",
  "enableWorkspaceDirtyQuarantineRepair",
  "enableManagedSandboxOnly",
  "enableIsolatedWorkspaces",
  "enableIsolatedWorkspacesByDefault",
] as const satisfies readonly InstanceFeatureKey[];

/** Section 5, Managed, "Features off" (the named beta features). */
export const MANAGED_FEATURES_OFF = [
  "enablePipelines",
  "enableCases",
  "enableAgentChat",
  "enableConferenceRoomChat",
  "enableSummaries",
  "enableStatusCards",
  "enableChatConnectors",
  "enableMemoryConnectors",
  "enableExternalObjects",
  "enableBuiltInAgents",
  "enableSmokeLab",
  "enableWorktreeRunExecution",
  "enableSandboxDuplexBridge",
  "enableNativeRunner",
  "enableEnvironments",
  "enableOwnerInstanceAdmin",
] as const satisfies readonly InstanceFeatureKey[];

/** Section 5, Managed, "Hidden settings". Managed plus keeps the same list. */
export const MANAGED_HIDDEN_SETTINGS = [
  "instance.experimental",
  "instance.experimental.*",
  "instance.adapters",
  "instance.plugins",
  "instance.access",
  "instance.environments",
  "company.secrets",
  "company.import",
  "company.export",
  "company.invites",
  "instance.general.backupRetention",
  "instance.general.feedbackDataSharingPreference",
] as const;

export interface EditionValues {
  edition: Edition;
  /** Value for GSAM_MANAGED_CONFIG. */
  managedConfig: string;
  /** Value for GSAM_HIDDEN_SETTINGS. */
  hiddenSettings: string;
  /** Every feature the running instance must report as on. */
  expectOn: InstanceFeatureKey[];
  /** Every feature the running instance must report as off. */
  expectOff: InstanceFeatureKey[];
}

export interface EditionInput {
  edition: Edition;
  /**
   * Managed plus only: beta features whose Beacon verdict (GRE-81) has passed.
   * The caller must take this list from the verdicts; nothing is on by default.
   */
  passedBetaFeatures?: readonly string[];
  catalogVersion: string;
}

function tierOf(key: InstanceFeatureKey) {
  return INSTANCE_FEATURE_CATALOG[key].tier;
}

function isFeatureKey(key: string): key is InstanceFeatureKey {
  return Object.prototype.hasOwnProperty.call(INSTANCE_FEATURE_CATALOG, key);
}

/**
 * Build the env values for an edition. Throws when the input or this build's
 * feature catalog does not match section 5, so a wrong edition never starts.
 */
export function buildEditionValues(input: EditionInput): EditionValues {
  if (!EDITIONS.includes(input.edition)) {
    throw new Error(`Unknown edition "${input.edition}" (allowed: ${EDITIONS.join(", ")})`);
  }
  if (input.catalogVersion.trim().length === 0) {
    throw new Error("catalogVersion must not be blank");
  }

  for (const key of [...MANAGED_FEATURES_ON, ...MANAGED_FEATURES_OFF]) {
    if (!isFeatureKey(key)) {
      throw new Error(`Feature "${key}" from section 5 is not in this build's feature catalog`);
    }
  }

  const passed = [...new Set((input.passedBetaFeatures ?? []).map((key) => key.trim()).filter(Boolean))];
  if (input.edition === "managed" && passed.length > 0) {
    throw new Error("The Managed edition takes no passed beta features; use managed-plus");
  }
  const offList: readonly string[] = MANAGED_FEATURES_OFF;
  for (const key of passed) {
    if (!offList.includes(key)) {
      throw new Error(
        `"${key}" is not a Managed "off" beta feature in section 5; only those can be turned on for Managed plus`,
      );
    }
    if (key === "enableOwnerInstanceAdmin") {
      throw new Error(`"${key}" gives instance admin powers and is never part of Managed plus`);
    }
  }

  const on = new Set<InstanceFeatureKey>([...MANAGED_FEATURES_ON, ...(passed as InstanceFeatureKey[])]);

  // GSAM_MANAGED_CONFIG accepts only tier "managed" keys. Pin exactly the
  // section 5 keys; managed keys that section 5 does not name keep the app
  // default until the brief names them.
  const features: Record<string, boolean> = {};
  for (const key of INSTANCE_FEATURE_KEYS) {
    if (tierOf(key) !== "managed") continue;
    if (on.has(key)) features[key] = true;
    else if (offList.includes(key)) features[key] = false;
  }
  for (const key of MANAGED_FEATURES_OFF) {
    if (tierOf(key) !== "managed") {
      throw new Error(`"${key}" has tier "${tierOf(key)}" in this build; the edition cannot pin it off`);
    }
  }

  // A "preference" key cannot be pinned by GSAM_MANAGED_CONFIG. The Managed
  // "on" preference keys (the streamlined UI pair) must default to on in this
  // build; hiding instance.experimental.* then keeps them from being changed.
  for (const key of on) {
    if (tierOf(key) === "managed") continue;
    if (INSTANCE_FEATURE_CATALOG[key].selfHostedDefault !== true) {
      throw new Error(
        `"${key}" has tier "${tierOf(key)}" and does not default to on in this build; the edition cannot pin it`,
      );
    }
  }

  const managedConfig = JSON.stringify({
    v: 1,
    mode: "cloud",
    catalogVersion: input.catalogVersion,
    features,
    plugins: { autoInstall: [] },
  });

  const hiddenSettings = MANAGED_HIDDEN_SETTINGS.join(",");
  const parsedHidden = parseHiddenSettingsList(hiddenSettings);
  if (parsedHidden.unknown.length > 0) {
    throw new Error(`Hidden settings not known to this build: ${parsedHidden.unknown.join(", ")}`);
  }

  const expectOn = [...on].sort();
  const expectOff = MANAGED_FEATURES_OFF.filter((key) => !on.has(key)).sort();

  return { edition: input.edition, managedConfig, hiddenSettings, expectOn, expectOff };
}
