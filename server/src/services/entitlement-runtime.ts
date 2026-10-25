/**
 * Live entitlement state for this instance (GRE-1078).
 *
 * Holds the last good signed document and re-reads the entitlement file on a
 * timer (every minute) or on "sync now". A missing, unreadable, unsigned or
 * older file never replaces the last good copy, and no state ever means "all
 * on": with no valid document the base floor applies. The last good copy is
 * saved next to the file, so it survives a restart.
 *
 * The state is read through `applyEntitlementsToExperimental`, which
 * `instanceSettingsService.getExperimental` calls, so every route and service
 * that reads a switch (including the GRE-1077 gate) sees the same answer.
 * Entitlement only narrows: effective = stored setting AND entitled. Nothing
 * stored is changed or deleted when a feature stops being entitled.
 *
 * Syncs run one at a time (a timer tick and "sync now" cannot interleave), and
 * a sync of an unchanged file is a no-op, so repeated wakes are safe.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_RELOAD_INTERVAL_MS,
  RESTART_WIRED_ENTITLEMENT_KEYS,
  type EffectiveEntitlements,
  type EntitlementDocument,
  type EntitlementFeatureKey,
  type EntitlementState,
} from "@greatstone/shared";
import {
  EntitlementDocumentError,
  entitledFeatures,
  entitlementGraceEndsAt,
  hashEntitlementFile,
  ignoredEntitlementFeatureKeys,
  resolveEntitlementState,
  verifyEntitlementEnvelope,
  type EntitlementConfig,
} from "./entitlement-document.js";

export type EntitlementSyncTrigger = "startup" | "file_reload" | "sync_now";

export interface EntitlementFeatureChange {
  key: EntitlementFeatureKey;
  from: boolean;
  to: boolean;
}

/** One audit record: who, what, when, why. */
export type EntitlementAuditEvent =
  | {
      kind: "changed";
      at: string;
      trigger: EntitlementSyncTrigger | "grace_expired";
      /** Hub admin who issued the document now in force (null on the base floor). */
      issuedBy: string | null;
      /** Instance user who pressed "sync now", if any. */
      requestedBy: string | null;
      reason: string;
      fromState: EntitlementState;
      toState: EntitlementState;
      fromVersion: number | null;
      toVersion: number | null;
      changes: EntitlementFeatureChange[];
      pendingRestart: EntitlementFeatureKey[];
    }
  | {
      kind: "rejected";
      at: string;
      trigger: EntitlementSyncTrigger;
      requestedBy: string | null;
      reason: string;
      fileSha256: string | null;
      keptVersion: number | null;
    };

export interface EntitlementRuntimeOptions extends EntitlementConfig {
  now?: () => Date;
  restartWiredKeys?: readonly EntitlementFeatureKey[];
  onAudit?: (event: EntitlementAuditEvent) => void | Promise<void>;
  onError?: (err: unknown, context: string) => void;
}

export interface EntitlementSyncResult {
  applied: boolean;
  error: string | null;
  entitlements: Omit<EffectiveEntitlements, "features"> & {
    entitled: Record<EntitlementFeatureKey, boolean>;
    pendingRestart: EntitlementFeatureKey[];
  };
}

interface LastGood {
  document: EntitlementDocument;
  text: string;
  sha256: string;
}

export function createEntitlementRuntime(options: EntitlementRuntimeOptions) {
  const now = options.now ?? (() => new Date());
  const restartWiredKeys = new Set(options.restartWiredKeys ?? RESTART_WIRED_ENTITLEMENT_KEYS);

  let lastGood: LastGood | null = null;
  /** Hash of the last file content handled (applied or rejected): an unchanged file is a no-op. */
  let lastSeenSha256: string | null = null;
  /** The error that file content produced (null when it verified). */
  let lastSeenError: string | null = null;
  let lastError: string | null = null;
  let lastCheckedAt: Date | null = null;
  /** Entitled values for restart-wired keys, fixed at start-up. */
  let bootEntitled: Partial<Record<EntitlementFeatureKey, boolean>> = {};
  /** What the last audit record left in force; changes are diffed against it. */
  let recorded: { state: EntitlementState; entitled: Record<EntitlementFeatureKey, boolean>; version: number | null } | null =
    null;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;

  function documentEntitled(at: Date) {
    const document = lastGood?.document ?? null;
    const state = resolveEntitlementState(document, at);
    return { document, state, entitled: entitledFeatures(document, state) };
  }

  /** The values the server uses now: restart-wired keys keep their start-up value. */
  function liveEntitled(at: Date = now()) {
    const { document, state, entitled } = documentEntitled(at);
    const live = { ...entitled };
    const pendingRestart: EntitlementFeatureKey[] = [];
    for (const key of ENTITLEMENT_FEATURE_KEYS) {
      if (!restartWiredKeys.has(key) || bootEntitled[key] === undefined) continue;
      live[key] = bootEntitled[key];
      if (entitled[key] !== bootEntitled[key]) pendingRestart.push(key);
    }
    return { document, state, entitled: live, pendingRestart };
  }

  async function audit(event: EntitlementAuditEvent) {
    try {
      await options.onAudit?.(event);
    } catch (err) {
      options.onError?.(err, "entitlement audit write failed");
    }
  }

  /** Record a change when the state, version or any live value moved since the last record. */
  async function recordIfChanged(
    trigger: EntitlementSyncTrigger | "grace_expired",
    requestedBy: string | null,
  ): Promise<boolean> {
    const at = now();
    const current = liveEntitled(at);
    const version = current.state === "floor" ? null : current.document?.version ?? null;
    const previous = recorded;
    const changes: EntitlementFeatureChange[] = [];
    for (const key of ENTITLEMENT_FEATURE_KEYS) {
      const from = previous ? previous.entitled[key] : false;
      if (from !== current.entitled[key]) changes.push({ key, from, to: current.entitled[key] });
    }
    if (previous && previous.state === current.state && previous.version === version && changes.length === 0) {
      return false;
    }
    recorded = { state: current.state, entitled: current.entitled, version };
    const graceExpired = previous && previous.state !== "floor" && current.state === "floor" && current.document;
    await audit({
      kind: "changed",
      at: at.toISOString(),
      trigger: graceExpired && trigger === "file_reload" ? "grace_expired" : trigger,
      issuedBy: current.state === "floor" ? null : current.document?.issuedBy ?? null,
      requestedBy,
      reason:
        current.state === "floor"
          ? current.document
            ? `valid until ${current.document.validUntil} plus grace has passed; base floor applies`
            : "no valid entitlement document; base floor applies"
          : current.state === "grace"
            ? `valid until ${current.document?.validUntil} has passed; the last good copy applies until ${
                current.document ? entitlementGraceEndsAt(current.document).toISOString() : "the grace end"
              }`
            : current.document?.reason ?? `entitlement document v${current.document?.version} applied`,
      fromState: previous?.state ?? "floor",
      toState: current.state,
      fromVersion: previous?.version ?? null,
      toVersion: version,
      changes,
      pendingRestart: current.pendingRestart,
    });
    return true;
  }

  async function persistLastGood(text: string) {
    const target = options.lastGoodPath;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, target);
  }

  async function readText(file: string): Promise<string | null> {
    try {
      return await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Accept `document` only if it is newer than the last good copy (or the same bytes). */
  function checkNewer(document: EntitlementDocument, sha256: string) {
    if (!lastGood || lastGood.sha256 === sha256) return;
    if (document.client !== lastGood.document.client) {
      throw new EntitlementDocumentError(
        `entitlement document is for client "${document.client}", but the last good copy is for "${lastGood.document.client}"`,
      );
    }
    if (document.version <= lastGood.document.version) {
      throw new EntitlementDocumentError(
        `entitlement document v${document.version} is not newer than the last good copy v${lastGood.document.version}`,
      );
    }
  }

  async function syncOnce(trigger: EntitlementSyncTrigger, requestedBy: string | null): Promise<EntitlementSyncResult> {
    lastCheckedAt = now();
    let applied = false;
    let text: string | null = null;
    const keeping = lastGood ? `keeping the last good copy v${lastGood.document.version}` : "keeping the base floor";
    try {
      text = await readText(options.filePath);
      if (text === null) lastError = `entitlement file is missing; ${keeping}`;
    } catch (err) {
      lastError = `entitlement file could not be read: ${(err as Error).message}; ${keeping}`;
    }
    if (text !== null) {
      const sha256 = hashEntitlementFile(text);
      // Same bytes as last time: nothing to verify, apply or log (a retried wake is a no-op).
      if (sha256 === lastSeenSha256 && trigger !== "sync_now") lastError = lastSeenError;
      if (sha256 !== lastSeenSha256 || trigger === "sync_now") {
        const firstSight = sha256 !== lastSeenSha256;
        lastSeenSha256 = sha256;
        try {
          const document = verifyEntitlementEnvelope(text, options.publicKey, options.expectedClient);
          checkNewer(document, sha256);
          if (lastGood?.sha256 !== sha256) {
            lastGood = { document, text, sha256 };
            applied = true;
            try {
              await persistLastGood(text);
            } catch (err) {
              options.onError?.(err, "could not save the last good entitlement copy");
            }
          }
          lastError = null;
          lastSeenError = null;
        } catch (err) {
          if (!(err instanceof EntitlementDocumentError)) throw err;
          lastError = `${err.message}; ${keeping}`;
          lastSeenError = lastError;
          if (firstSight || trigger === "sync_now") {
            await audit({
              kind: "rejected",
              at: lastCheckedAt.toISOString(),
              trigger,
              requestedBy,
              reason: err.message,
              fileSha256: sha256,
              keptVersion: lastGood?.document.version ?? null,
            });
          }
        }
      }
    }
    await recordIfChanged(trigger, requestedBy);
    return { applied, error: lastError, entitlements: summary() };
  }

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const turn = queue.then(run);
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  function summary(at: Date = now()) {
    const { document, state, entitled, pendingRestart } = liveEntitled(at);
    return {
      state,
      document: document
        ? {
            client: document.client,
            version: document.version,
            issuedAt: document.issuedAt,
            issuedBy: document.issuedBy,
            validUntil: document.validUntil,
            graceEndsAt: entitlementGraceEndsAt(document).toISOString(),
          }
        : null,
      entitled,
      pendingRestart,
      limits: state === "floor" || !document ? {} : { ...document.limits },
      ignoredFeatureKeys: ignoredEntitlementFeatureKeys(document),
      lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
      lastError,
    };
  }

  return {
    /** Load the saved last good copy, then the file; fixes restart-wired values. */
    start: () =>
      serialized(async () => {
        const saved = await readText(options.lastGoodPath).catch(() => null);
        if (saved !== null) {
          try {
            const document = verifyEntitlementEnvelope(saved, options.publicKey, options.expectedClient);
            lastGood = { document, text: saved, sha256: hashEntitlementFile(saved) };
          } catch (err) {
            options.onError?.(err, "saved last good entitlement copy is not valid; ignoring it");
          }
        }
        const result = await syncOnce("startup", null);
        const { entitled } = documentEntitled(now());
        bootEntitled = Object.fromEntries([...restartWiredKeys].map((key) => [key, entitled[key]]));
        return result;
      }),

    sync: (input: { trigger: EntitlementSyncTrigger; requestedBy?: string | null }) =>
      serialized(() => syncOnce(input.trigger, input.requestedBy ?? null)),

    /** Re-read the file every `intervalMs` (default one minute, so a new document applies within 5 minutes). */
    startPolling(intervalMs: number = ENTITLEMENT_RELOAD_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void serialized(() => syncOnce("file_reload", null)).catch((err) =>
          options.onError?.(err, "entitlement reload failed"),
        );
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** Live entitled values; computed from the clock on every read, so the floor applies on time. */
    entitled: (): Record<EntitlementFeatureKey, boolean> => liveEntitled().entitled,

    summary,
  };
}

export type EntitlementRuntime = ReturnType<typeof createEntitlementRuntime>;

let activeRuntime: EntitlementRuntime | null = null;

/** Install (or clear, with null) the process-wide runtime. Boot calls this once. */
export function setEntitlementRuntime(runtime: EntitlementRuntime | null) {
  activeRuntime?.stop();
  activeRuntime = runtime;
}

export function getEntitlementRuntime(): EntitlementRuntime | null {
  return activeRuntime;
}

/**
 * Narrow experimental settings to what the instance is entitled to. Without a
 * runtime (no hub key) the settings pass through unchanged.
 */
export function applyEntitlementsToExperimental<T extends Partial<Record<EntitlementFeatureKey, unknown>>>(
  experimental: T,
  runtime: EntitlementRuntime | null = activeRuntime,
): T {
  if (!runtime) return experimental;
  const entitled = runtime.entitled();
  const next = { ...experimental } as Record<string, unknown>;
  for (const key of ENTITLEMENT_FEATURE_KEYS) {
    if (!entitled[key]) next[key] = false;
  }
  return next as T;
}

export function effectiveEntitlements(
  storedExperimental: Partial<Record<EntitlementFeatureKey, unknown>>,
  runtime: EntitlementRuntime | null = activeRuntime,
): EffectiveEntitlements {
  if (!runtime) {
    return {
      state: "disabled",
      document: null,
      features: Object.fromEntries(
        ENTITLEMENT_FEATURE_KEYS.map((key) => [
          key,
          { entitled: true, effective: storedExperimental[key] === true, pendingRestart: false },
        ]),
      ) as EffectiveEntitlements["features"],
      limits: {},
      ignoredFeatureKeys: [],
      lastCheckedAt: null,
      lastError: null,
    };
  }
  const { entitled, pendingRestart, ...rest } = runtime.summary();
  const pending = new Set(pendingRestart);
  return {
    ...rest,
    features: Object.fromEntries(
      ENTITLEMENT_FEATURE_KEYS.map((key) => [
        key,
        {
          entitled: entitled[key],
          effective: entitled[key] && storedExperimental[key] === true,
          pendingRestart: pending.has(key),
        },
      ]),
    ) as EffectiveEntitlements["features"],
  };
}
