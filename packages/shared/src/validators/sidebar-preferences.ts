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

const sidebarKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/**
 * A user's own sidebar arrangement: item order per section, hidden and pinned
 * items, and which sections they folded. Keys are short slugs; the UI owns the
 * defaults and merges this over them, so unknown keys are dropped there.
 */
export const sidebarLayoutSchema = z.object({
  sections: z.record(sidebarKeySchema, z.array(sidebarKeySchema).max(100)).optional(),
  hidden: z.array(sidebarKeySchema).max(100).optional(),
  pinned: z.array(sidebarKeySchema).max(100).optional(),
  collapsed: z.record(sidebarKeySchema, z.boolean()).optional(),
});

export type SidebarLayout = z.infer<typeof sidebarLayoutSchema>;

export const upsertSidebarLayoutSchema = z.object({ layout: sidebarLayoutSchema });
