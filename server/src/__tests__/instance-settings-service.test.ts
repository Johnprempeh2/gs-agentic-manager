import { describe, expect, it, vi } from "vitest";
import type { InstanceExperimentalSettings } from "@greatstone/shared";
import {
  applyExperimentalSettingsPatch,
  applyManagedExperimentalOverlay,
  normalizeExperimentalSettings,
  resolveWorktreeRunExecutionActivationState,
} from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("always reads the graduated Runner flag as on (GRE-1436)", () => {
    for (const stored of [undefined, {}, { enableNativeRunner: false }, { enableNativeRunner: true }]) {
      expect(normalizeExperimentalSettings(stored).enableNativeRunner).toBe(true);
    }
    const patched = applyExperimentalSettingsPatch({}, { enableNativeRunner: false });
    expect(normalizeExperimentalSettings(JSON.parse(JSON.stringify(patched))).enableNativeRunner).toBe(true);
  });
  it("always reads the graduated Chat and Memory connectors flags as on (GRE-1620)", () => {
    for (const stored of [
      undefined,
      {},
      { enableChatConnectors: false, enableMemoryConnectors: false },
      { enableChatConnectors: true, enableMemoryConnectors: true },
    ]) {
      expect(normalizeExperimentalSettings(stored)).toMatchObject({ enableChatConnectors: true, enableMemoryConnectors: true });
    }
    const patched = applyExperimentalSettingsPatch({}, { enableChatConnectors: false, enableMemoryConnectors: false });
    expect(normalizeExperimentalSettings(JSON.parse(JSON.stringify(patched))))
      .toMatchObject({ enableApps: true, enableChatConnectors: true, enableMemoryConnectors: true });
  });
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableNativeRunner: false,
      enableManagedSandboxOnly: false,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableBuiltInAgents: true,
      enableGoalsSidebarLink: true,
      enableServerInfoDebugView: true,
      enablePaperclipDeveloperMode: true,
      autoRestartDevServerWhenIdle: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: false,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableNativeRunner: true,
      enableManagedSandboxOnly: false,
      enableIsolatedWorkspaces: true,
      enableIsolatedWorkspacesByDefault: false,
      enableStreamlinedLeftNavigation: true,
      enableStreamlinedUi: true,
      enableApps: true,
    enableMcpAggregators: true,
      enableAgentChat: true,
      enableChatConnectors: true,
      enableMemoryConnectors: true,
      enableConferenceRoomChat: true,
      enableClassicTaskInterface: false,
      enableExternalObjects: true,
      enableSmokeLab: false,
      enablePipelines: false,
      enableCases: true,
      enableDeepDive: false,
      enableStrategy: true,
      enableStrategyBoard: false,
      strategyBoardSecretaryAgentId: null,
      enableWebsiteView: false,
      enableIntelligence: false,
      enableTeamChat: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableBuiltInAgents: true,
      enableBetaSkills: true,
      enableSummaries: true,
      enableStatusCards: true,
      enableDecisions: true,
      enableGoalsSidebarLink: true,
      enableServerInfoDebugView: true,
      enablePaperclipDeveloperMode: false,
      enableSimplifiedEnglishInteractions: true,
      enableFirstTaskPlanProposal: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableOwnerInstanceAdmin: false,
      enableSandboxDuplexBridge: false,
      enableRunnerPreviewIngress: false,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
      enablePromptInjectionModelChecks: false,
      promptInjectionModelChecksEnabledAt: null,
    });
  });

  it("defaults streamlined UI on without inheriting the retired navigation preference", () => {
    expect(normalizeExperimentalSettings(undefined).enableStreamlinedUi).toBe(true);
    expect(normalizeExperimentalSettings({}).enableStreamlinedUi).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: false }).enableStreamlinedUi,
    ).toBe(true);
    expect(normalizeExperimentalSettings({ enableStreamlinedUi: false }).enableStreamlinedUi).toBe(false);
  });

  it("keeps Apps on for empty, legacy, and explicitly disabled stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableApps).toBe(true);
    expect(normalizeExperimentalSettings({}).enableApps).toBe(true);
    expect(normalizeExperimentalSettings({ enablePipelines: true }).enableApps).toBe(true);
    expect(normalizeExperimentalSettings({ enableApps: false }).enableApps).toBe(true);
  });

  it("keeps Isolated Workspaces on for empty, legacy, patched, and managed-off settings (GRE-1437)", () => {
    expect(normalizeExperimentalSettings(undefined).enableIsolatedWorkspaces).toBe(true);
    expect(normalizeExperimentalSettings({}).enableIsolatedWorkspaces).toBe(true);
    expect(normalizeExperimentalSettings("not an object").enableIsolatedWorkspaces).toBe(true);
    expect(normalizeExperimentalSettings({ enableIsolatedWorkspaces: false }).enableIsolatedWorkspaces).toBe(true);
    expect(
      applyExperimentalSettingsPatch({}, { enableIsolatedWorkspaces: false }).enableIsolatedWorkspaces,
    ).toBe(true);
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(
      normalizeExperimentalSettings({}),
      { features: { enableIsolatedWorkspaces: false } } as unknown as Parameters<
        typeof applyManagedExperimentalOverlay
      >[1],
    );
    expect(experimental.enableIsolatedWorkspaces).toBe(true);
    expect(managedKeys.enableIsolatedWorkspaces).toBeUndefined();
  });

  it("retains the deprecated ingress key for stored-settings compatibility", () => {
    expect(
      normalizeExperimentalSettings({ enableRunnerPreviewIngress: true })
        .enableRunnerPreviewIngress,
    ).toBe(true);
  });

  it("keeps Conference Room Chat on for empty, legacy, patched, invalid, and managed-off settings (GRE-1624)", () => {
    expect(normalizeExperimentalSettings(undefined).enableConferenceRoomChat).toBe(true);
    expect(normalizeExperimentalSettings({}).enableConferenceRoomChat).toBe(true);
    expect(normalizeExperimentalSettings({ enableConferenceRoomChat: false }).enableConferenceRoomChat).toBe(true);
    expect(normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat).toBe(true);
    expect(
      applyExperimentalSettingsPatch({}, { enableConferenceRoomChat: false }).enableConferenceRoomChat,
    ).toBe(true);
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(
      normalizeExperimentalSettings({}),
      { features: { enableConferenceRoomChat: false } } as unknown as Parameters<
        typeof applyManagedExperimentalOverlay
      >[1],
    );
    expect(experimental.enableConferenceRoomChat).toBe(true);
    expect(managedKeys.enableConferenceRoomChat).toBeUndefined();
  });

  it("defaults enableClassicTaskInterface to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableClassicTaskInterface).toBe(false);
    expect(normalizeExperimentalSettings({}).enableClassicTaskInterface).toBe(false);
    // The retired enableTaskChatRedesign key must not bleed into the new flag:
    // an install that had the chat redesign ON opted into chat-style, which is
    // now the default — not into the classic view.
    expect(
      normalizeExperimentalSettings({ enableTaskChatRedesign: true }).enableClassicTaskInterface,
    ).toBe(false);
  });

  it("forces the 4 retired flags off, also when the stored setting says on (GRE-196)", () => {
    const stored = {
      enableClassicTaskInterface: true,
      enableSmokeLab: true,
      enablePaperclipDeveloperMode: true,
      autoRestartDevServerWhenIdle: true,
    };
    expect(normalizeExperimentalSettings(stored)).toMatchObject({
      enableClassicTaskInterface: false,
      enableSmokeLab: false,
      enablePaperclipDeveloperMode: false,
      autoRestartDevServerWhenIdle: false,
    });
    // A patch cannot turn them back on either.
    expect(applyExperimentalSettingsPatch({}, stored)).toMatchObject({
      enableClassicTaskInterface: false,
      enableSmokeLab: false,
      enablePaperclipDeveloperMode: false,
      autoRestartDevServerWhenIdle: false,
    });
  });

  it("reads the GRE-1621 graduated switches as on, ignoring stored off values", () => {
    const keys = [
      "enableAgentChat",
      "enableIssuePlanDecompositions",
      "enableBuiltInAgents",
      "enableBetaSkills",
      "enableSimplifiedEnglishInteractions",
    ] as const;
    const storedOff = Object.fromEntries(keys.map((key) => [key, false]));
    for (const stored of [undefined, {}, storedOff]) {
      const normalized = normalizeExperimentalSettings(stored);
      for (const key of keys) expect(normalized[key], key).toBe(true);
    }
  });

  it("defaults enableSmokeLab to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableSmokeLab).toBe(false);
    expect(normalizeExperimentalSettings({}).enableSmokeLab).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExternalObjects: true }).enableSmokeLab,
    ).toBe(false);
  });

  it("keeps Environments, File Viewer and Server Info on for empty, legacy and stored-off settings (GRE-1623)", () => {
    for (const key of ["enableEnvironments", "enableExperimentalFileViewer", "enableServerInfoDebugView"] as const) {
      expect(normalizeExperimentalSettings(undefined)[key]).toBe(true);
      expect(normalizeExperimentalSettings({})[key]).toBe(true);
      expect(normalizeExperimentalSettings({ autoRestartDevServerWhenIdle: true })[key]).toBe(true);
      expect(normalizeExperimentalSettings({ [key]: false })[key]).toBe(true);
      // An unparseable row takes the fallback branch.
      expect(normalizeExperimentalSettings({ [key]: "yes" })[key]).toBe(true);
    }
  });

  it("defaults enablePaperclipDeveloperMode to false for empty and legacy settings", () => {
    expect(normalizeExperimentalSettings(undefined).enablePaperclipDeveloperMode).toBe(false);
    expect(normalizeExperimentalSettings({}).enablePaperclipDeveloperMode).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableServerInfoDebugView: true })
        .enablePaperclipDeveloperMode,
    ).toBe(false);
  });

  it("defaults enableGoalsSidebarLink to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableGoalsSidebarLink).toBe(false);
    expect(normalizeExperimentalSettings({}).enableGoalsSidebarLink).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableGoalsSidebarLink,
    ).toBe(false);
  });

  it("defaults enableDecisions to true for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableDecisions).toBe(true);
    expect(normalizeExperimentalSettings({}).enableDecisions).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableDecisions,
    ).toBe(true);
    expect(normalizeExperimentalSettings({ enableDecisions: false }).enableDecisions).toBe(false);
  });

  it("defaults workspace branch repair settings to true for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableWorkspaceBranchReconcileForward).toBe(true);
    expect(normalizeExperimentalSettings({}).enableWorkspaceBranchReconcileForward).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableExperimentalFileViewer: true })
        .enableWorkspaceBranchReconcileForward,
    ).toBe(true);
    // GRE-1438: graduated, so a stored off value reads as on.
    expect(
      normalizeExperimentalSettings({ enableWorkspaceBranchReconcileForward: false })
        .enableWorkspaceBranchReconcileForward,
    ).toBe(true);
    // GRE-1439: graduated, so a stored off value reads as on.
    expect(
      normalizeExperimentalSettings({ enableWorkspaceDirtyQuarantineRepair: false })
        .enableWorkspaceDirtyQuarantineRepair,
    ).toBe(true);
    expect(normalizeExperimentalSettings(undefined).enableWorkspaceDirtyQuarantineRepair).toBe(true);
    expect(normalizeExperimentalSettings({}).enableWorkspaceDirtyQuarantineRepair).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableWorkspaceBranchReconcileForward: false })
        .enableWorkspaceDirtyQuarantineRepair,
    ).toBe(true);
  });

  it("sets worktree run execution activation fields on a false to true transition", () => {
    const activatedAt = new Date("2026-07-10T12:00:00.000Z");

    const next = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
      {
        now: () => activatedAt,
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.enableWorktreeRunExecution).toBe(true);
    expect(next.worktreeRunExecutionActivatedAt).toBe("2026-07-10T12:00:00.000Z");
    expect(next.worktreeRunExecutionActivationInstanceId).toBe("worktree-instance");
  });

  it("clears worktree run execution activation fields on a true to false transition", () => {
    const next = applyExperimentalSettingsPatch(
      {
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "worktree-instance",
      },
      { enableWorktreeRunExecution: false },
      {
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.enableWorktreeRunExecution).toBe(false);
    expect(next.worktreeRunExecutionActivatedAt).toBeNull();
    expect(next.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("refreshes the activation cutoff when worktree run execution is re-toggled", () => {
    const firstActivation = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
      {
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      },
    );
    const disabled = applyExperimentalSettingsPatch(
      firstActivation,
      { enableWorktreeRunExecution: false },
      {
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    const secondActivation = applyExperimentalSettingsPatch(
      disabled,
      { enableWorktreeRunExecution: true },
      {
        now: () => new Date("2026-07-10T12:05:00.000Z"),
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(secondActivation.worktreeRunExecutionActivatedAt).toBe("2026-07-10T12:05:00.000Z");
    expect(secondActivation.worktreeRunExecutionActivatedAt).not.toBe(
      firstActivation.worktreeRunExecutionActivatedAt,
    );
  });

  it("strips client-supplied activation fields before applying experimental patches", () => {
    const next = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      {
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      },
      {
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.worktreeRunExecutionActivatedAt).toBeNull();
    expect(next.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("resolves worktree run execution as armed only when the cutoff matches the current instance", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toEqual({
      armed: true,
      cutoff: "2026-07-10T12:00:00.000Z",
      activationInstanceId: "worktree-instance",
      reason: null,
    });
  });

  it("fails closed when worktree run execution is missing a cutoff", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "missing_cutoff",
    });
  });

  it("fails closed when worktree run execution was activated by another instance", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "source-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "target-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      activationInstanceId: "source-instance",
      reason: "instance_id_mismatch",
    });
  });

  it("fails closed on settings read errors and avoids reads outside worktree runtimes", async () => {
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => {
          throw new Error("settings unavailable");
        },
        runtimeEnv: {
          GSAM_IN_WORKTREE: "true",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "settings_read_error",
    });

    const getExperimental = vi.fn<() => Promise<InstanceExperimentalSettings>>();
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental,
        runtimeEnv: {
          GSAM_IN_WORKTREE: "false",
          GSAM_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "not_worktree_runtime",
    });
    expect(getExperimental).not.toHaveBeenCalled();
  });

});

// GRE-1743: no paid model check runs unless a person turned it on in Settings.
describe("prompt injection model checks spend cutoff", () => {
  const now = () => new Date("2026-10-21T09:00:00.000Z");

  it("is off with no cutoff by default", () => {
    const settings = normalizeExperimentalSettings({});
    expect(settings.enablePromptInjectionModelChecks).toBe(false);
    expect(settings.promptInjectionModelChecksEnabledAt).toBeNull();
  });

  it("records the cutoff when a person turns the switch on and clears it when they turn it off", () => {
    const on = applyExperimentalSettingsPatch({}, { enablePromptInjectionModelChecks: true }, { now });
    expect(on.enablePromptInjectionModelChecks).toBe(true);
    expect(on.promptInjectionModelChecksEnabledAt).toBe("2026-10-21T09:00:00.000Z");

    const unrelated = applyExperimentalSettingsPatch(on, { enableDeepDive: true }, { now: () => new Date(0) });
    expect(unrelated.promptInjectionModelChecksEnabledAt).toBe("2026-10-21T09:00:00.000Z");

    const off = applyExperimentalSettingsPatch(on, { enablePromptInjectionModelChecks: false }, { now });
    expect(off.enablePromptInjectionModelChecks).toBe(false);
    expect(off.promptInjectionModelChecksEnabledAt).toBeNull();
  });

  it("a managed-config on sets no cutoff, so it cannot start paid checks alone", () => {
    const { experimental } = applyManagedExperimentalOverlay(
      normalizeExperimentalSettings({}),
      { features: { enablePromptInjectionModelChecks: true } } as unknown as Parameters<
        typeof applyManagedExperimentalOverlay
      >[1],
    );
    expect(experimental.enablePromptInjectionModelChecks).toBe(true);
    expect(experimental.promptInjectionModelChecksEnabledAt).toBeNull();
  });

  it("ignores a client-sent cutoff", () => {
    const next = applyExperimentalSettingsPatch(
      {},
      { promptInjectionModelChecksEnabledAt: "2026-01-01T00:00:00.000Z" } as Record<string, unknown>,
      { now },
    );
    expect(next.enablePromptInjectionModelChecks).toBe(false);
    expect(next.promptInjectionModelChecksEnabledAt).toBeNull();
  });
});
