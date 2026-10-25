import type {
  EffectiveEntitlements,
  InstanceExperimentalSettingsWithManaged,
  InstanceGeneralSettings,
  InstanceSettings,
  InstanceSystemMemory,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@greatstone/shared";
import { api } from "./client";

/** GET /instance/run-admission/recommendation (GRE-116). Read-only. */
export interface RunAdmissionRecommendation {
  windowDays: number;
  current: { maxConcurrentRuns: number; minAvailableMemoryMb: number };
  suggested: { maxConcurrentRuns: number; minAvailableMemoryMb: number };
  reasons: string[];
  usage: {
    runsStarted: number;
    peakConcurrentRuns: number;
    holds: { globalCap: { runs: number }; lowMemory: { runs: number } };
  };
}

/** GET /instance/sign-in-activity: attempts that did not finish, across the instance. Instance admins only. */
export interface InstanceSignInActivity {
  since: string;
  counts: { signedIn: number; wrongPassword: number; codeNeeded: number };
  events: Array<{
    id: string;
    outcome: "wrong_password" | "code_needed";
    ipAddress: string | null;
    userAgent: string | null;
    at: string;
    user: { id: string; email: string | null; name: string | null };
  }>;
}

/** GET /instance/task-drain: true while a release pauses new runs. */
export interface TaskDrainStatus {
  draining: boolean;
  startedAt: string | null;
  expiresAt: string | null;
}

export const instanceSettingsApi = {
  getTaskDrain: () =>
    api.get<TaskDrainStatus>("/instance/task-drain"),
  get: () =>
    api.get<InstanceSettings>("/instance/settings"),
  update: (patch: PatchInstanceSettings) =>
    api.patch<InstanceSettings>("/instance/settings", patch),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental", patch),
  /** GRE-1078: effective features from the signed entitlement document. */
  getEntitlements: () =>
    api.get<EffectiveEntitlements>("/instance/entitlements"),
  /** GRE-1078: re-read the entitlement file now. Instance admins only. */
  syncEntitlements: () =>
    api.post<{ applied: boolean; error: string | null; entitlements: EffectiveEntitlements }>(
      "/instance/entitlements/sync",
      {},
    ),
  getSystemMemory: () =>
    api.get<InstanceSystemMemory>("/instance/system-memory"),
  getRunAdmissionRecommendation: () =>
    api.get<RunAdmissionRecommendation>("/instance/run-admission/recommendation"),
  getSignInActivity: () =>
    api.get<InstanceSignInActivity>("/instance/sign-in-activity"),
};
