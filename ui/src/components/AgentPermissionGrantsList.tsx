import { PERMISSION_KEYS, type PrincipalPermissionGrant } from "@greatstone/shared";
import { Badge } from "@/components/ui/badge";

/**
 * Read-only list of every known permission grant key and whether this agent
 * holds it. Grants come from the agent detail response (`access.grants`).
 */
export function AgentPermissionGrantsList({
  grants,
}: {
  grants: Pick<PrincipalPermissionGrant, "permissionKey">[];
}) {
  const granted = new Set<string>(grants.map((grant) => grant.permissionKey));

  return (
    <div>
      <h3 className="text-sm font-medium mb-1">Grants</h3>
      <p className="text-xs text-muted-foreground mb-3">
        Permission grants this agent holds. Read-only.
      </p>
      <ul className="border border-border rounded-lg divide-y divide-border" aria-label="Permission grants">
        {PERMISSION_KEYS.map((key) => {
          const isGranted = granted.has(key);
          return (
            <li
              key={key}
              data-permission-key={key}
              data-granted={isGranted ? "true" : "false"}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
            >
              <code className="font-mono text-xs break-all">{key}</code>
              <Badge variant={isGranted ? "default" : "outline"} className={isGranted ? undefined : "text-muted-foreground"}>
                {isGranted ? "granted" : "not granted"}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
