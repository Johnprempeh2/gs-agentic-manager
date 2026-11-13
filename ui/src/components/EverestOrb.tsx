import { MessageCircle } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { openAskEverest } from "../lib/ask-everest-events";
import { cn } from "../lib/utils";
import { ProductMark } from "./BrandLockup";
import { useLeadAgent } from "./MobileEverestButton";

export function isLeadWorking(liveAgents: readonly { agentId: string }[], leadId: string): boolean {
  return liveAgents.some((agent) => agent.agentId === leadId);
}

/** Persistent Ask Everest launcher. Its ring moves only while the lead has a running run. */
export function EverestOrb() {
  const { selectedCompanyId } = useCompany();
  const lead = useLeadAgent();
  const { liveAgents } = useLiveAgents(selectedCompanyId);
  if (!lead) return null;

  const working = isLeadWorking(liveAgents, lead.id);
  return (
    <button
      type="button"
      onClick={() => openAskEverest()}
      aria-label={`Ask ${lead.name}${working ? ", working now" : ""}`}
      className="group fixed bottom-20 right-4 z-chrome flex size-14 items-center justify-center rounded-full bg-sidebar text-sidebar-foreground shadow-lg outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring md:bottom-4"
      data-testid="everest-orb"
      data-tour="global-ask"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 rounded-full border-2 border-primary",
          working && "motion-safe:animate-spin border-t-transparent",
        )}
      />
      <ProductMark className="h-8 w-auto transition-transform group-hover:scale-105" />
      <MessageCircle className="absolute -left-1 -top-1 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" aria-hidden="true" />
    </button>
  );
}
