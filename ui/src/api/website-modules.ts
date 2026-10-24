import { api } from "./client";
import type {
  CreateWebsiteModule,
  UpdateWebsiteModule,
  WebsiteModule,
  WebsiteModuleCard,
  WebsiteModuleDetail,
} from "@greatstone/shared";

const modulesPath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/modules`;
const modulePath = (companyId: string, siteId: string, moduleId: string) =>
  `${modulesPath(companyId, siteId)}/${encodeURIComponent(moduleId)}`;

/** Website module registry client (GRE-2325). Reads need website:view; changes need website:publish. */
export const websiteModulesApi = {
  list: (companyId: string, siteId: string) => api.get<WebsiteModule[]>(modulesPath(companyId, siteId)),
  /** The Modules cards of Website Home, with their counts and health. */
  cards: (companyId: string, siteId: string) =>
    api.get<WebsiteModuleCard[]>(`/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/module-cards`),
  detail: (companyId: string, siteId: string, moduleId: string) =>
    api.get<WebsiteModuleDetail>(modulePath(companyId, siteId, moduleId)),
  create: (companyId: string, siteId: string, input: CreateWebsiteModule) =>
    api.post<WebsiteModule>(modulesPath(companyId, siteId), input),
  /** Adds the starting modules the site does not have yet. */
  addStartingSet: (companyId: string, siteId: string) =>
    api.post<WebsiteModule[]>(`${modulesPath(companyId, siteId)}/starting-set`, {}),
  update: (companyId: string, siteId: string, moduleId: string, patch: UpdateWebsiteModule) =>
    api.patch<WebsiteModule>(modulePath(companyId, siteId, moduleId), patch),
  remove: (companyId: string, siteId: string, moduleId: string) =>
    api.delete<void>(modulePath(companyId, siteId, moduleId)),
};
