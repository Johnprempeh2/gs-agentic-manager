import type {
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

export const instanceSettingsApi = {
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
  getSystemMemory: () =>
    api.get<InstanceSystemMemory>("/instance/system-memory"),
  getRunAdmissionRecommendation: () =>
    api.get<RunAdmissionRecommendation>("/instance/run-admission/recommendation"),
};
