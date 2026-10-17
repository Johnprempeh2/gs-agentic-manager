/**
 * "Who can help": rank a company's agents against a plain-words need, using
 * the name, role, title and the capabilities each agent publishes. Agents use
 * it to find the right colleague to hand work to (SPEC: agents publish when
 * they are relevant so others can discover who can help with what).
 */

export interface DirectoryAgentInput {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  status: string;
  reportsTo: string | null;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  status: string;
  reportsTo: string | null;
  /** Higher is a better match; 0 when no query was given. */
  score: number;
  /** The words of the query this agent matched. */
  matched: string[];
}

const STOP_WORDS = new Set(["a", "an", "and", "the", "for", "of", "to", "in", "on", "with", "who", "can", "help", "me", "my", "is"]);

export function directoryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
    ),
  ];
}

function hits(text: string | null | undefined, term: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(term);
}

/**
 * Removed agents never show. With no query, every working agent is listed by
 * name. With a query, an agent must match at least one term; a match in the
 * capabilities counts most, then title and role, then name. Paused agents and
 * agents in error sort after working ones with the same score.
 */
export function rankDirectory(agents: readonly DirectoryAgentInput[], query: string, limit = 20): DirectoryEntry[] {
  const terms = directoryTerms(query);
  const live = agents.filter((agent) => agent.status !== "terminated");
  const entries: DirectoryEntry[] = [];
  for (const agent of live) {
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      let termScore = 0;
      if (hits(agent.capabilities, term)) termScore += 3;
      if (hits(agent.title, term)) termScore += 2;
      if (hits(agent.role, term)) termScore += 2;
      if (hits(agent.name, term)) termScore += 1;
      if (termScore > 0) matched.push(term);
      score += termScore;
    }
    if (terms.length > 0 && score === 0) continue;
    entries.push({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      capabilities: agent.capabilities,
      status: agent.status,
      reportsTo: agent.reportsTo,
      score,
      matched,
    });
  }
  const available = (status: string) => (status === "paused" || status === "error" ? 1 : 0);
  entries.sort(
    (a, b) => b.score - a.score || available(a.status) - available(b.status) || a.name.localeCompare(b.name),
  );
  return entries.slice(0, Math.max(1, Math.min(limit, 50)));
}
