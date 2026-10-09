import { z } from "zod";

// Search Console accepts URL-prefix properties (`https://example.com/`) and
// domain properties (`sc-domain:example.com`).
const siteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => {
      if (/^sc-domain:[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return true;
      try {
        const parsed = new URL(value);
        return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    },
    { message: "Use a Search Console property: https://example.com/ or sc-domain:example.com" },
  );

const ga4PropertyIdSchema = z
  .string()
  .trim()
  .regex(/^(properties\/)?\d{1,20}$/, "Use the GA4 property id (digits only)")
  .transform((value) => value.replace(/^properties\//, ""));

export const createWebsitePropertySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    siteUrl: siteUrlSchema,
    ga4PropertyId: ga4PropertyIdSchema,
  })
  .strict();

export type CreateWebsiteProperty = z.infer<typeof createWebsitePropertySchema>;

export const updateWebsitePropertySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    siteUrl: siteUrlSchema.optional(),
    ga4PropertyId: ga4PropertyIdSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export type UpdateWebsiteProperty = z.infer<typeof updateWebsitePropertySchema>;

export const startWebsiteGoogleConnectSchema = z
  .object({
    /** App path to return to after consent. Must start with a single "/". */
    returnTo: z
      .string()
      .max(500)
      .regex(/^\/(?![/\\])/, "returnTo must be an app path")
      .optional(),
  })
  .strict();

export type StartWebsiteGoogleConnect = z.infer<typeof startWebsiteGoogleConnectSchema>;
