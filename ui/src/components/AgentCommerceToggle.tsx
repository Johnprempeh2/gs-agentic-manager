import { agentHasCommerce, agentWebsiteAccess } from "@greatstone/shared";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/**
 * "Commerce" on Agent → Permissions (GRE-4814): sets or clears the agent's
 * website:commerce grant. It needs website access View or higher, and takes
 * the same sites. The agent drafts and asks; a person approves each publish
 * and refund.
 */
export function AgentCommerceToggle({
  grants,
  disabled = false,
  onChange,
}: {
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const enabled = agentHasCommerce(grants);
  const hasWebsiteAccess = agentWebsiteAccess(grants).level !== "none";

  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <div className="space-y-1">
        <div id="agent-commerce-label">Commerce</div>
        <p className="text-xs text-muted-foreground" data-testid="agent-commerce-hint">
          {hasWebsiteAccess || enabled
            ? "Catalogue, prices, invoices; asks to publish or refund. A person approves each one."
            : "Needs website access View or Edit first."}
        </p>
      </div>
      <ToggleSwitch
        aria-labelledby="agent-commerce-label"
        checked={enabled}
        onCheckedChange={() => onChange(!enabled)}
        // Turning off stays possible; turning on needs website access.
        disabled={disabled || (!enabled && !hasWebsiteAccess)}
      />
    </div>
  );
}
