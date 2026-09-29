// Client "What's new" (GRE-128): the version this install runs and the client
// notes of its stable-* tag. Any member of the company may read it, and it sits
// outside /releases, so the client-edition floor (GRE-129) does not hide it.
import { Router } from "express";
import { getServerInfoSnapshot } from "../server-info.js";
import { gitReader, readClientVersion, SERVER_CHECKOUT_DIR, type GitReader } from "../services/client-version.js";
import { assertCompanyAccess } from "./authz.js";

export function clientVersionRoutes(
  deps: { git?: GitReader; runningCommit?: () => string | null } = {},
) {
  const router = Router();
  const git = deps.git ?? gitReader(SERVER_CHECKOUT_DIR);
  const runningCommit =
    deps.runningCommit ??
    (() => {
      // The same commit /api/health reports.
      const info = getServerInfoSnapshot().git;
      return info.available ? info.fullSha : null;
    });

  router.get("/companies/:companyId/version", (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    res.json(readClientVersion(git, runningCommit()));
  });

  return router;
}
