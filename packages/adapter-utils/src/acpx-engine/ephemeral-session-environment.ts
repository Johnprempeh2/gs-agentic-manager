import type { AcpSessionStore } from "acpx/runtime";
import { collectRunSecretValues, redactRunSecretValuesDeep } from "../run-secret-values.js";

/** Keep the current run's environment in memory, outside persisted conversation state. */
export function createEphemeralSessionEnvironmentStore(
  persistedStore: AcpSessionStore,
  currentEnvironment: Readonly<Record<string, string>>,
): AcpSessionStore {
  const secretValues = collectRunSecretValues(currentEnvironment);
  return {
    async load(id) {
      const record = await persistedStore.load(id);
      if (!record) return undefined;
      return {
        ...record,
        acpx: {
          ...record.acpx,
          session_options: {
            ...record.acpx?.session_options,
            env: { ...currentEnvironment },
          },
        },
      };
    },
    save(record) {
      const persisted = { ...record };
      if (record.acpx?.session_options !== undefined) {
        const { env: _environment, ...sessionOptions } = record.acpx.session_options;
        persisted.acpx = { ...record.acpx, session_options: sessionOptions };
      }
      // An agent that prints its environment puts the run's credentials into
      // tool output inside `messages` (GRE-517); redact them by value too.
      return persistedStore.save(redactRunSecretValuesDeep(persisted, secretValues));
    },
  };
}
