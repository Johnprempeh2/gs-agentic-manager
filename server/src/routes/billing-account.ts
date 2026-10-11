import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@greatstone/db";
import { SETTINGS_OPERATOR_MANAGED_ERROR_CODE } from "@greatstone/shared";
import {
  cancelBillingAccountSchema,
  recordBillingInvoiceSchema,
  resumeBillingRenewalSchema,
  upsertBillingAccountSchema,
} from "@greatstone/shared/billing-account";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { billingAccountService, noteBillingUsageWarning } from "../services/billing-account.js";
import { logActivity } from "../services/activity-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertBoard, assertBoardOrgAccess, getActorInfo, hasCompanyOwnerOrAdminRole } from "./authz.js";

/**
 * Billing account of this instance (GRE-1369, B2 on GRE-1357). Every board
 * user of the instance can read it. Only the hosting operator (an instance
 * admin, or the implicit local board) writes it; anyone else gets 403
 * `settings_operator_managed`. It is operator-managed on every instance, not
 * only when a hide key is set, because the client must still see it (B1).
 * The one client write is cancel, by a company owner or admin.
 */
function isHostingOperator(req: Request) {
  return req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true);
}

function assertBillingOperator(req: Request) {
  assertBoard(req);
  if (isHostingOperator(req)) return;
  throw forbidden("Billing is managed by the hosting operator on this instance", {
    code: SETTINGS_OPERATOR_MANAGED_ERROR_CODE,
  });
}

/** Runs before body validation, so a client write is refused as operator-managed, not as a bad body. */
const operatorOnly: RequestHandler = (req, _res, next) => {
  assertBillingOperator(req);
  next();
};

function isClientOwnerOrAdmin(req: Request) {
  if (req.actor.type !== "board") return false;
  return (req.actor.memberships ?? []).some(
    (membership) => membership.status === "active" && hasCompanyOwnerOrAdminRole(req, membership.companyId),
  );
}

export function billingAccountRoutes(db: Db, opts: { now?: () => Date } = {}) {
  const router = Router();
  const svc = billingAccountService(db);
  const settings = instanceSettingsService(db);
  const now = opts.now ?? (() => new Date());

  /** One activity row per company on the instance (a client instance has one), as instance settings do. */
  async function audit(req: Request, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    const companyIds = await settings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action,
          entityType: "billing_account",
          entityId,
          details,
        }),
      ),
    );
  }

  router.get("/instance/billing-account", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await svc.view(now()));
  });

  router.put("/instance/billing-account", operatorOnly, validate(upsertBillingAccountSchema), async (req, res) => {
    const { reason, ...input } = req.body;
    const at = now();
    const { before, account } = await svc.upsert(input, req.actor.userId ?? null, at);
    await audit(req, "billing.account_updated", account.id, {
      oldValue: before,
      newValue: account,
      reason: reason ?? null,
    });
    // A lower allowance can put this month's usage over the warn level.
    await noteBillingUsageWarning(db, at);
    res.json(await svc.view(at));
  });

  router.post(
    "/instance/billing-account/invoices",
    operatorOnly,
    validate(recordBillingInvoiceSchema),
    async (req, res) => {
      const { before, invoice } = await svc.recordInvoice(req.body, now());
      await audit(req, "billing.invoice_recorded", invoice.id, { oldValue: before, newValue: invoice });
      res.json(invoice);
    },
  );

  router.post("/instance/billing-account/cancel", validate(cancelBillingAccountSchema), async (req, res) => {
    assertBoard(req);
    if (!isHostingOperator(req) && !isClientOwnerOrAdmin(req)) {
      throw forbidden("Owner or admin role required to cancel");
    }
    const at = now();
    const result = await svc.cancel(req.actor.userId ?? null, req.body.reason ?? null, at);
    if (result.outcome === "no_account") throw notFound("This instance has no billing account");
    if (result.outcome === "cancelled") {
      await audit(req, "billing.cancel_requested", result.account.id, {
        oldValue: { autoRenew: result.before.autoRenew, accessEndsOn: result.before.accessEndsOn },
        newValue: { autoRenew: false, accessEndsOn: result.account.accessEndsOn },
        reason: req.body.reason ?? null,
      });
    }
    res.json(await svc.view(at));
  });

  router.post(
    "/instance/billing-account/resume-renewal",
    operatorOnly,
    validate(resumeBillingRenewalSchema),
    async (req, res) => {
      const at = now();
      const result = await svc.resumeRenewal(req.actor.userId ?? null, at);
      if (!result) throw notFound("This instance has no billing account");
      await audit(req, "billing.renewal_resumed", result.account.id, {
        oldValue: { autoRenew: result.before.autoRenew, accessEndsOn: result.before.accessEndsOn, cancelRequestedAt: result.before.cancelRequestedAt },
        newValue: { autoRenew: true, accessEndsOn: null, cancelRequestedAt: null },
        reason: req.body.reason,
      });
      res.json(await svc.view(at));
    },
  );

  return router;
}
