/** Where an integration that needs an outside key or sign-in stands. */
export type IntegrationKeyState = "ready" | "needs_key" | "sign_in" | "not_built";

export interface IntegrationKeyVariable {
  name: string;
  /** True when the server has a value for it. The value itself is never sent. */
  set: boolean;
}

export interface IntegrationKeyItem {
  id: string;
  name: string;
  /** What turning it on gives you, in one sentence. */
  unlocks: string;
  state: IntegrationKeyState;
  variables: IntegrationKeyVariable[];
  /** Where to get the key, and what it costs. */
  howToGet: string;
  note: string | null;
}

/** Answer of GET /companies/:companyId/integration-keys. */
export interface IntegrationKeysStatus {
  /** The env file the server reads at start, so people know where to paste. */
  envFile: string;
  items: IntegrationKeyItem[];
}
