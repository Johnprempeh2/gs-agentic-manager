import { Router } from "express";
import { hiddenSettingFloor } from "../services/settings-visibility.js";

/**
 * Client editions hide Releases (`instance.releases` in GSAM_HIDDEN_SETTINGS,
 * GRE-129). Mount before every other router: each release route, reads
 * included, answers 403 `settings_operator_managed` for every actor, the
 * board too. With the key not hidden, requests pass through unchanged.
 */
export function releasesFloorRoutes() {
  const router = Router();
  router.use("/companies/:companyId/releases", hiddenSettingFloor("instance.releases", "Releasing"));
  return router;
}
