import { useEffect, useState } from "react";
import type { Agent, DecisionCard, DecisionCardAgentRef } from "@greatstone/shared";
import { Curtain } from "../DecisionShelf";
import { DecisionFeedCard } from "./DecisionFeedCard";

/**
 * Split the feed (GRE-450): cards that need John at the computer go to "At
 * your desk"; the rest are phone decisions. Feed order is kept in both.
 */
export function splitAtDeskCards(cards: DecisionCard[]): { phone: DecisionCard[]; desk: DecisionCard[] } {
  const phone: DecisionCard[] = [];
  const desk: DecisionCard[] = [];
  for (const card of cards) (card.atDesk ? desk : phone).push(card);
  return { phone, desk };
}

/**
 * "At your desk" (GRE-450): host commands, sign-ins and restarts. Open on a
 * laptop, where John can act; folded on a phone, where he cannot.
 */
export function AtDeskGroup({
  cards,
  defaultOpen,
  companyId,
  assignableAgents,
  agentMap,
  currentUserId,
  onActed,
}: {
  cards: DecisionCard[];
  defaultOpen: boolean;
  companyId: string;
  assignableAgents: DecisionCardAgentRef[];
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  onActed?: (cardId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A phone turned into a laptop window (or back) follows the screen.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  if (cards.length === 0) return null;
  return (
    <div data-at-desk-group>
      <Curtain label="At your desk" count={cards.length} open={open} onToggle={() => setOpen((value) => !value)}>
        <p className="text-xs text-muted-foreground">
          These need you at the computer. They are not in the phone count.
        </p>
        {cards.map((card) => (
          <DecisionFeedCard
            key={card.id}
            card={card}
            companyId={companyId}
            assignableAgents={assignableAgents}
            agentMap={agentMap}
            currentUserId={currentUserId}
            onActed={onActed ? () => onActed(card.id) : undefined}
          />
        ))}
      </Curtain>
    </div>
  );
}
