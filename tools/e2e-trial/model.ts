// The model for agent steps. e2e does not support Claude subscriptions, so this
// needs a provider John approves (GRE-905 step 2). Until then there is no model:
// `e2e list` works, and agent steps fail with a configuration error.
import type { LanguageModel } from 'ai';

export function trialModel(): LanguageModel | undefined {
  return undefined;
}
