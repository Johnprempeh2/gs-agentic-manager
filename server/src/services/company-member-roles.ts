import { PERMISSION_KEYS } from "@greatstone/shared";
import type { HumanCompanyMembershipRole } from "@greatstone/shared";

const HUMAN_COMPANY_MEMBERSHIP_ROLES: HumanCompanyMembershipRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  return HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(value as HumanCompanyMembershipRole)
    ? (value as HumanCompanyMembershipRole)
    : fallback;
}

/**
 * Company-wide actions (releasing live, rolling back, changing company
 * settings, archiving or deleting the company) are for owners and admins
 * only. Operators and viewers, and any legacy or Cloud role such as
 * "member" or "support", are refused.
 */
export function isCompanyOwnerOrAdminRole(role: unknown): boolean {
  return role === "owner" || role === "admin";
}

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "owner":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
      ];
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
      ];
    case "operator":
      return [{ permissionKey: "tasks:assign", scope: null }];
    case "viewer":
      return [];
  }
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "operator");
}
