import type { BillingAccountView } from "@greatstone/shared/billing-account";
import { api } from "./client";

export const billingApi = {
  /** Every board user may read; writes are operator-only (403 `settings_operator_managed`). */
  get: () => api.get<BillingAccountView>("/instance/billing-account"),
};
