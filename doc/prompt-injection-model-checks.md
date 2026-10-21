# Prompt injection model checks (GRE-1743)

Greatstone's version of upstream `2c96f7678` ("model-backed prompt injection
prevention"). Beacon's port-boundary decision (GRE-1742) was not to take the
upstream commit as it is. This version has no migration, no new settings page,
and no second gateway.

## The switch

Settings > Experimental > **Prompt injection model checks**
(`enablePromptInjectionModelChecks`). It is off by default on cloud and on
self-hosted. Client editions pin it off (`scripts/client-instance/editions.ts`).

## What it does

The tool gateway (`server/src/services/tool-gateway.ts`) already checks every
tool result with a regex before an agent sees it. With the switch on, the five
result guards also ask a model
(`validateToolResultContent` in `tool-content-guards.ts`, called through
`prompt-injection-classifier.ts`):

- A valid model verdict replaces the regex verdict. An unsafe verdict blocks the
  result with `prompt_injection_blocked`, as before.
- Any gate or failure falls back to the regex over the full original result.
  The tool audit row records `promptInjection: { detector, fallbackReason }`.
- With the switch off there is no model call, and audit rows do not change.

Model: `openai/gpt-oss-safeguard-20b` on OpenRouter. There is one request per
result, a 10 second deadline, a 256 KiB request limit and 4,096 output tokens.
The model receives the tool result with secrets removed. If removing secrets
would hide text that the agent still receives, there is no model call
(`input_redaction_mismatch`).

## Spend: never silent

A check is a paid call. The gates below run in order, before any call:

1. **Switch on.** Off means no classifier at all.
2. **A person turned it on in Settings.** The toggle shows a cost dialog. When a
   person confirms, the server records `promptInjectionModelChecksEnabledAt`.
   A managed-config "on" does not set this field, so it cannot spend by itself
   (`spend_not_acknowledged`).
3. **An agent owns the cost.** Every call writes a cost event under the calling
   agent (`no_cost_owner` if there is none).
4. **One shared OpenRouter API-key AI connection** in the company. It must be
   usable under the existing access rules: an active responsible user in the
   credential audience, and an install for the company or the agent. If not,
   the reason is `not_configured` or `connection_unavailable`.

The cost event is in Costs with `provider` and `biller` set to `openrouter`,
`billingType` `metered_api` and `billingCode` `prompt_injection_check`. A call
that may have reached the provider without a reported price is recorded as
`unpriced`. Rejected requests (4xx) are not billed and not recorded.

## Not ported from upstream

Upstream has these parts. This version does not:

- The per-company settings table and the Connections settings page.
- The model picker and the "Test model checks" button.
- Budget reservation before the call, and the invocation ledger.
- Company sponsorship for runs that have no responsible user. Those runs use
  the regex.

## Tests

`tests/release-switch-tests/switch-tests.json` lists the tests for this switch:
gateway on and off with a real database, gate order, provider parsing, the
settings cutoff, and the Settings card.
