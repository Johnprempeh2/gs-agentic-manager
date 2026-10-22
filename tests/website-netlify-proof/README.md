# Netlify publish and cache proof

This fixture tests the Website module publish assumption against real Next.js App Router routes on a disposable Netlify site. The base is `Johnprempeh2/greatstone-website` main at commit `ade98a0` (GRE-1833 proof merged). It never targets the live site.

## Prepare

Set `GSAM_RUN_SCRATCH_DIR` to an empty, private scratch directory. Put a Netlify personal access token in `$GSAM_RUN_SCRATCH_DIR/netlify.token` with mode `0600`. Do not print or commit the token. Use a Netlify team and site that you may create and delete.

```sh
gh repo clone Johnprempeh2/greatstone-website "$GSAM_RUN_SCRATCH_DIR/greatstone-website" -- --depth 1
node "$GSAM_RUN_SCRATCH_DIR/greatstone-website/next-proof/scripts/prepare-netlify.mjs" "$GSAM_RUN_SCRATCH_DIR/proof"
cp -R tests/website-netlify-proof/app/. "$GSAM_RUN_SCRATCH_DIR/proof/app/"
mkdir -p "$GSAM_RUN_SCRATCH_DIR/proof/netlify/functions"
cp tests/website-netlify-proof/netlify/functions/cdn-check.mjs "$GSAM_RUN_SCRATCH_DIR/proof/netlify/functions/"
cp tests/website-netlify-proof/writer.mjs tests/website-netlify-proof/probe.py "$GSAM_RUN_SCRATCH_DIR/proof/"
printf '\n[functions]\n  directory = "netlify/functions"\n' >> "$GSAM_RUN_SCRATCH_DIR/proof/netlify.toml"
cd "$GSAM_RUN_SCRATCH_DIR/proof"
npm ci --no-audit --no-fund
npm install --save-exact @netlify/blobs --no-audit --no-fund
```

Create a site using `POST https://api.netlify.com/api/v1/sites` with `{"name":"<unique-scratch-name>","account_slug":"<team-slug>"}`. Save only its `id`, `name`, and `url` in `$GSAM_RUN_SCRATCH_DIR/site.json`. Keep the site ID for cleanup.

## Run

```sh
node writer.mjs "$(python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["GSAM_RUN_SCRATCH_DIR"],"site.json")))["id"])')" "$GSAM_RUN_SCRATCH_DIR/netlify.token" r1
NETLIFY_AUTH_TOKEN="$(cat "$GSAM_RUN_SCRATCH_DIR/netlify.token")" npx --yes netlify-cli deploy --build --prod --site "$(python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["GSAM_RUN_SCRATCH_DIR"],"site.json")))["id"])')" --json
python3 probe.py > "$GSAM_RUN_SCRATCH_DIR/probe-output.txt"
```

The probe warms `/check/home`, `/check/inner`, `/check/product`, the redirect `/check/old`, `/_release`, and a tagged CDN function. It writes `r2` from the external process, submits an intentionally invalid purge, then submits a real tag purge. It polls for up to 15 rounds. `Cache-Status` and `Age` identify which cache served each response. A successful purge must move **every** check page to `r2` before the probe reports `ALL_LIVE_MS_FROM_SWITCH`; `NOT_REACHED` is a failure.

Delete the scratch site with `DELETE https://api.netlify.com/api/v1/sites/<site-id>` after recording results. Check that a subsequent `GET` returns 404. Do not run the fixture against the production site. Production deploys on the scratch site consume credits; the result on 22 October 2026 took three deployments, including a fallback rebuild.
