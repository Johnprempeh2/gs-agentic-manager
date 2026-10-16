// The CRM product catalogue as GSAM shows it (Pipedrive import, 16 Oct): every
// product with its prices and fields, and the deals it was sold on, so nobody
// has to open Pipedrive to see what a client bought. Read only.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { crmDealProducts, crmProducts, pipelineCases } from "@greatstone/db";
import type { CrmProduct, CrmProductDeal } from "@greatstone/shared";

export function crmProductService(db: Db) {
  return {
    async list(companyId: string): Promise<CrmProduct[]> {
      const products = await db.select().from(crmProducts)
        .where(eq(crmProducts.companyId, companyId))
        .orderBy(asc(crmProducts.name));
      if (products.length === 0) return [];
      const lines = await db
        .select({
          productId: crmDealProducts.productId,
          caseId: pipelineCases.id,
          pipelineId: pipelineCases.pipelineId,
          title: pipelineCases.title,
          quantity: crmDealProducts.quantity,
          sum: crmDealProducts.sum,
          currency: crmDealProducts.currency,
        })
        .from(crmDealProducts)
        .innerJoin(pipelineCases, and(eq(pipelineCases.id, crmDealProducts.caseId), eq(pipelineCases.companyId, crmDealProducts.companyId)))
        .where(eq(crmDealProducts.companyId, companyId))
        .orderBy(asc(pipelineCases.title));
      const dealsByProduct = new Map<string, CrmProductDeal[]>();
      for (const { productId, ...deal } of lines) {
        if (!productId) continue;
        const deals = dealsByProduct.get(productId) ?? [];
        deals.push(deal);
        dealsByProduct.set(productId, deals);
      }
      return products.map((product) => ({
        id: product.id,
        source: product.source,
        name: product.name,
        code: product.code,
        unit: product.unit,
        description: product.description,
        tax: product.tax,
        active: product.active,
        ownerName: product.ownerName,
        prices: product.prices,
        fields: product.fields,
        deals: dealsByProduct.get(product.id) ?? [],
      }));
    },
  };
}
