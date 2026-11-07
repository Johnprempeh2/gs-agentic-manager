import { Router } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_GAP_MS = 60_000;

/**
 * The website says "something new" (an enquiry, an account change) so GSAM pulls that site now instead of
 * polling it. The ping carries no data and needs no key: GSAM fetches over its own signed bridge, and a
 * forged ping can at most cause one extra pull a minute per site. Always 202, so it reveals nothing.
 */
export function websitePingRoutes(pull: (siteId: string) => void) {
  const router = Router();
  const last = new Map<string, number>(); // last pull per site id, pruned past 1000
  router.post("/website-ping/:siteId", (req, res) => {
    // One key per site, whatever the letter case, so case variants of an id share the limit.
    const siteId = String(req.params.siteId).toLowerCase();
    const now = Date.now();
    if (last.size > 1000) for (const [id, at] of last) if (now - at >= MIN_GAP_MS) last.delete(id);
    if (UUID_RE.test(siteId) && now - (last.get(siteId) ?? 0) >= MIN_GAP_MS) {
      last.set(siteId, now);
      pull(siteId);
    }
    res.status(202).end();
  });
  return router;
}
