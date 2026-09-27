import { TriangleAlert } from "lucide-react";
import type { AiAuthMethod, AiCredentialInfo, AiProvider } from "@greatstone/shared";
import { cn } from "@/lib/utils";
import { describeAiCredentialLifetime } from "./model";

/** How long the connected token lasts, shown at connect time and on the connection. */
export function AiCredentialLifetime({ credential, connection, className }: {
  credential?: AiCredentialInfo;
  /** Pass for a saved connection, so one with no credential record still gets a line. */
  connection?: { provider: AiProvider; method: AiAuthMethod };
  className?: string;
}) {
  const lifetime = describeAiCredentialLifetime(credential, undefined, connection);
  if (!lifetime) return null;
  return (
    <p
      role={lifetime.tone === "muted" ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2 text-xs",
        lifetime.tone === "muted" ? "text-muted-foreground" : lifetime.tone === "warning" ? "text-foreground" : "text-destructive",
        className,
      )}
    >
      {lifetime.tone !== "muted" && <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <span>{lifetime.text}</span>
    </p>
  );
}
