import type { BillingAccountView, OperatorBillingAccountView } from "@greatstone/shared/billing-account";
import { api } from "./client";

export const billingApi = {
  /** Every board user may read: clients get the percent-only view, the operator the full one (GRE-1395). Writes are operator-only. */
  get: () => api.get<BillingAccountView | OperatorBillingAccountView>("/instance/billing-account"),
};
