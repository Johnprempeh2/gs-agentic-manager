import { agentWebsiteAccessLevel, type AgentWebsiteAccessLevel } from "@greatstone/shared";
import { NativeSelect } from "@/components/ui/native-select";

const WEBSITE_ACCESS_HINTS: Record<AgentWebsiteAccessLevel, string> = {
  none: "Cannot open the website pages.",
  view: "Sees the website pages and drafts on every site.",
  edit: "Also edits drafts and proposes a Publish on every site.",
};

/**
 * "Website access" on Agent → Permissions (GRE-2239): None, View or Edit on
 * every site. There is no Publish option; publishing stays with people.
 */
export function AgentWebsiteAccessSelect({
  grants,
  disabled = false,
  onChange,
}: {
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
  disabled?: boolean;
  onChange: (level: AgentWebsiteAccessLevel) => void;
}) {
  const level = agentWebsiteAccessLevel(grants);
  return (
    <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="space-y-1">
        <div>Website access</div>
        <p className="text-xs text-muted-foreground">
          {WEBSITE_ACCESS_HINTS[level]} Publishing stays with people.
        </p>
      </div>
      <NativeSelect
        aria-label="Website access"
        className="h-8 w-36"
        value={level}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AgentWebsiteAccessLevel)}
      >
        <option value="none">None</option>
        <option value="view">View</option>
        <option value="edit">Edit</option>
      </NativeSelect>
    </div>
  );
}
