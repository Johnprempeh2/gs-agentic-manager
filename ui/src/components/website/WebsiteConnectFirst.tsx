import type { LucideIcon } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { EmptyState } from "../EmptyState";

/**
 * A Website tab that needs a connected site, before one is: what the tab will
 * do, and a button straight to Releases, where the site is connected. One look
 * on every tab (Pages already had the button).
 */
export function WebsiteConnectFirst({ icon, message }: { icon: LucideIcon; message: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  return (
    <EmptyState
      icon={icon}
      title="Connect the site first"
      message={message}
      action="Open Releases"
      onAction={() => {
        const params = new URLSearchParams(searchParams);
        params.set("tab", "releases");
        setSearchParams(params, { replace: true });
      }}
    />
  );
}
