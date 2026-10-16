import { Router } from "express";
import type { Db } from "@greatstone/db";
import { HIGGSFIELD_API_KEYS_URL, type IntegrationKeyItem, type IntegrationKeysStatus } from "@greatstone/shared";
import { resolvePaperclipEnvPath } from "../paths.js";
import { higgsfieldCredentialsFromEnv } from "../services/image-generation/higgsfield.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const set = (env: NodeJS.ProcessEnv, name: string) => Boolean(env[name]?.trim());

/**
 * Every integration that is waiting on an outside key or a sign-in, with the
 * exact variable names and whether the server has them. Values are never
 * returned. Built from the environment on each call, so it is right after a
 * restart.
 */
export function integrationKeyItems(env: NodeJS.ProcessEnv): IntegrationKeyItem[] {
  const higgsfield = Boolean(higgsfieldCredentialsFromEnv(env));
  const google = set(env, "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID") && set(env, "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET");
  return [
    {
      id: "higgsfield",
      name: "Image generation (Higgsfield)",
      unlocks: "Lets agents make images for proposals, posts and decks.",
      state: higgsfield ? "ready" : "needs_key",
      variables: [
        { name: "HIGGSFIELD_API_KEY_ID", set: higgsfield },
        { name: "HIGGSFIELD_API_KEY_SECRET", set: higgsfield },
      ],
      howToGet:
        "In the Higgsfield console, make an API key: you get an ID and a secret, and the secret is shown only once. No higgsfield.ai plan is needed. The API uses its own prepaid US dollar balance (5 dollars minimum), separate from plan credits, and only finished images are charged.",
      getKey: { url: HIGGSFIELD_API_KEYS_URL, label: "Open the Higgsfield console" },
      note: higgsfield ? null : "Nothing is generated or charged until both are set.",
    },
    {
      id: "google",
      name: "Google sign-in (website analytics, later two-way calendar)",
      unlocks: "Connects Search Console and Analytics on the Website page. Two-way Google Calendar sync would use the same pair once built.",
      state: google ? "ready" : "needs_key",
      variables: [
        { name: "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID", set: set(env, "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID") },
        { name: "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET", set: set(env, "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET") },
      ],
      howToGet:
        "In Google Cloud Console, create an OAuth client (Web application) with this instance's address plus /api/website/google/callback as the redirect. Free.",
      note: "Deadlines already reach Google Calendar one way through the calendar feed, with no key.",
    },
    {
      id: "microsoft",
      name: "Two-way Outlook calendar sync",
      unlocks: "Would put tasks in Outlook and bring meeting times back. Not built yet.",
      state: "not_built",
      variables: [
        { name: "GSAM_TOOL_OAUTH_MICROSOFT_CLIENT_ID", set: set(env, "GSAM_TOOL_OAUTH_MICROSOFT_CLIENT_ID") },
        { name: "GSAM_TOOL_OAUTH_MICROSOFT_CLIENT_SECRET", set: set(env, "GSAM_TOOL_OAUTH_MICROSOFT_CLIENT_SECRET") },
      ],
      howToGet: "Register an app in Microsoft Entra with calendar permissions and make a client secret. Free.",
      note: "Setting these does nothing yet. Say the word and the sync can be built. Deadlines already reach Outlook one way through the calendar feed.",
    },
    {
      id: "hubspot",
      name: "HubSpot live connection",
      unlocks: "Keeps companies, contacts and deals in step with HubSpot instead of uploading exports.",
      state: "sign_in",
      variables: [],
      howToGet: "No key to paste. Press Connect on the HubSpot card and sign in to HubSpot with an account that can see your CRM.",
      note: "Uploading a HubSpot export works today without signing in.",
    },
  ];
}

export function integrationKeyRoutes(_db: Db, deps: { env?: NodeJS.ProcessEnv; envFile?: string } = {}) {
  const router = Router();
  router.get("/companies/:companyId/integration-keys", (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const status: IntegrationKeysStatus = {
      envFile: deps.envFile ?? resolvePaperclipEnvPath(),
      items: integrationKeyItems(deps.env ?? process.env),
    };
    res.json(status);
  });
  return router;
}
