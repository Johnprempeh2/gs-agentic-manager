# e2e trial (GRE-905)

Two-week trial of the open-source [`e2e`](https://github.com/tester-army/e2e) runner (Apache-2.0).
Five plain-English screen checks run against the release preview (`scripts/greatstone-preview.sh`, port 3200).
Research only: not part of the release process and not in the pnpm workspace.

```bash
cd tools/e2e-trial
npm install
npm run list                 # the checks, no model needed
npm run login                # once, John: signs in to his ChatGPT Plus/Pro plan
npm run check                # runs the checks against the preview
```

- Telemetry is off (`E2E_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`) in the npm scripts and the config.
- Outbound: only the model provider. No TesterArmy Cloud, `testerarmy` CLI or hosted MCP.
- Model: John's ChatGPT Plus/Pro plan (`chatgpt('gpt-6-luna')` in `model.ts`); `e2e` does not support Claude subscriptions. The login is in `~/.config/e2e/oauth.json`, not in the repo. Model traffic goes to `auth.openai.com` and `chatgpt.com/backend-api/codex`.
- `E2E_USED_INVITE_PATH=/invite/<token>` names an already used invite for the invite check.
- The replay cache is in `.e2e/` (not committed).
