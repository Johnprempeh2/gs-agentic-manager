import type { SidebarLayout } from "../validators/sidebar-preferences.js";

export interface SidebarOrderPreference {
  orderedIds: string[];
  updatedAt: Date | null;
}

export interface SidebarLayoutPreference {
  layout: SidebarLayout;
  updatedAt: Date | null;
}
