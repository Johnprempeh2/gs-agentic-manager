import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  companyUserSidebarPreferences,
  userSidebarPreferences,
} from "@greatstone/db";
import { sidebarLayoutSchema, type SidebarLayout, type SidebarLayoutPreference, type SidebarOrderPreference } from "@greatstone/shared";

function normalizeOrderedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    orderedIds.push(trimmed);
  }
  return orderedIds;
}

function toPreference(orderedIds: unknown, updatedAt: Date | null): SidebarOrderPreference {
  return {
    orderedIds: normalizeOrderedIds(orderedIds),
    updatedAt,
  };
}

/** A stored layout that no longer parses reads as the default layout. */
function toLayoutPreference(layout: unknown, updatedAt: Date | null): SidebarLayoutPreference {
  const parsed = sidebarLayoutSchema.safeParse(layout ?? {});
  return { layout: parsed.success ? parsed.data : {}, updatedAt };
}

export function sidebarPreferenceService(db: Db) {
  return {
    async getCompanyOrder(userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      return toPreference(row?.companyOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertCompanyOrder(userId: string, orderedIds: string[]): Promise<SidebarOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({
          userId,
          companyOrder: normalized,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: {
            companyOrder: normalized,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.companyOrder ?? normalized, row?.updatedAt ?? now);
    },

    async getSectionOrder(userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      return toPreference(row?.sectionOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertSectionOrder(userId: string, orderedIds: string[]): Promise<SidebarOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({ userId, sectionOrder: normalized, updatedAt: now })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: { sectionOrder: normalized, updatedAt: now },
        })
        .returning();
      return toPreference(row?.sectionOrder ?? normalized, row?.updatedAt ?? now);
    },

    async getLayout(userId: string): Promise<SidebarLayoutPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      return toLayoutPreference(row?.layout, row?.updatedAt ?? null);
    },

    async upsertLayout(userId: string, layout: SidebarLayout): Promise<SidebarLayoutPreference> {
      const now = new Date();
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({ userId, layout, updatedAt: now })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: { layout, updatedAt: now },
        })
        .returning();
      return toLayoutPreference(row?.layout ?? layout, row?.updatedAt ?? now);
    },

    async getProjectOrder(companyId: string, userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.companyUserSidebarPreferences.findFirst({
        where: and(
          eq(companyUserSidebarPreferences.companyId, companyId),
          eq(companyUserSidebarPreferences.userId, userId),
        ),
      });
      return toPreference(row?.projectOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertProjectOrder(
      companyId: string,
      userId: string,
      orderedIds: string[],
    ): Promise<SidebarOrderPreference> {
      const now = new Date();
      const normalized = normalizeOrderedIds(orderedIds);
      const [row] = await db
        .insert(companyUserSidebarPreferences)
        .values({
          companyId,
          userId,
          projectOrder: normalized,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [companyUserSidebarPreferences.companyId, companyUserSidebarPreferences.userId],
          set: {
            projectOrder: normalized,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.projectOrder ?? normalized, row?.updatedAt ?? now);
    },
  };
}
