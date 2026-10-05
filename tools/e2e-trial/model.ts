// The model for agent steps. e2e does not support Claude subscriptions; John
// approved his ChatGPT Plus/Pro plan for the trial (GRE-905 step 2). He signs in
// once with `npm run login`; e2e.sh keeps it in <real home>/.config/e2e/oauth.json,
// never in this repo. Nothing is read until the first agent step, so `e2e list`
// works without a login. e2e.sh unsets OPENAI_BASE_URL and OPENAI_API_KEY:
// agent runs set them empty, and the OpenAI SDK rejects an empty baseURL.
// `E2E_MODEL` picks another id from `npx e2e models openai`.
import type { LanguageModel } from 'ai';
import { chatgpt } from 'e2e/oauth/chatgpt';

export function trialModel(): LanguageModel | undefined {
  return chatgpt(process.env.E2E_MODEL ?? 'gpt-6-luna');
}
