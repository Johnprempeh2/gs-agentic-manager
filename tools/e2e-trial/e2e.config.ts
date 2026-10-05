// GRE-905 trial: plain-English screen checks against the release preview.
// The preview runs a copy of the live data at http://localhost:3200 with agents off.
// Never point this at port 3100 (live).
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { trialModel } from './model';

process.env.E2E_TELEMETRY_DISABLED = '1';
process.env.DO_NOT_TRACK = '1';

const model = trialModel();
const url = process.env.E2E_PREVIEW_URL ?? 'http://localhost:3200';
if (/:3100\b/.test(url)) throw new Error('e2e trial: port 3100 is live; use the preview on 3200.');

export default {
  targets: [{ name: 'web', engine: web({ browser: 'chromium' }), app: { url } }],
  ...(model ? { agents: { default: { model } } } : {}),
  retries: 0,
  cache: 'read-write',
} satisfies E2EConfig;
