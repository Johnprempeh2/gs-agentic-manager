import { z } from "zod";

const sidebarOrderedIdSchema = z.string().guid();

export const sidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
});

export type UpsertSidebarOrderPreference = z.infer<typeof upsertSidebarOrderPreferenceSchema>;

/** Sidebar section keys ("work", "team"...): short slugs, not database ids. */
export const upsertSidebarSectionOrderSchema = z.object({
  orderedIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(50),
});
