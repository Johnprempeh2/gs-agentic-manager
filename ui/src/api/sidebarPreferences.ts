import type {
  SidebarLayout,
  SidebarLayoutPreference,
  SidebarOrderPreference,
  UpsertSidebarOrderPreference,
} from "@greatstone/shared";
import { api } from "./client";

export const sidebarPreferencesApi = {
  getCompanyOrder: () => api.get<SidebarOrderPreference>("/sidebar-preferences/me"),
  updateCompanyOrder: (data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>("/sidebar-preferences/me", data),
  getSectionOrder: () => api.get<SidebarOrderPreference>("/sidebar-preferences/me/sections"),
  updateSectionOrder: (data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>("/sidebar-preferences/me/sections", data),
  getLayout: () => api.get<SidebarLayoutPreference>("/sidebar-preferences/me/layout"),
  updateLayout: (layout: SidebarLayout) =>
    api.put<SidebarLayoutPreference>("/sidebar-preferences/me/layout", { layout }),
  getProjectOrder: (companyId: string) =>
    api.get<SidebarOrderPreference>(`/companies/${companyId}/sidebar-preferences/me`),
  updateProjectOrder: (companyId: string, data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>(`/companies/${companyId}/sidebar-preferences/me`, data),
};
