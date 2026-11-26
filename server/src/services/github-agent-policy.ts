import { WEBSITE_REPO } from "./website/deploy-changes.js";

/**
 * What an agent run may do with the managed GitHub credential (GRE-6168).
 * The GitHub App user token reaches every repository John owns, so GSAM
 * narrows it here: the git credential helper answers only for these
 * repositories, and the launcher refuses repository creation, forks, gists,
 * releases, visibility changes and pushes anywhere else.
 */
export type AgentGitHubPolicy = {
  /** Lower-case `owner/name` repositories the run may authenticate to. */
  repositories: string[];
  /** Only release agents push tags. Server release tooling uses host git, not this path. */
  allowTagPush: boolean;
};

export const DEFAULT_AGENT_GITHUB_REPOSITORIES: readonly string[] = [
  "Johnprempeh2/gs-agentic-manager",
  WEBSITE_REPO,
];

/** Keystone reviews, merges and releases; it alone may push tags from a run. */
export const DEFAULT_TAG_PUSH_AGENT_IDS: readonly string[] = [
  "003c68ec-ee61-4134-b748-01443997f802",
];

function listFromEnv(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

const REPOSITORY_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export function agentGitHubPolicy(agentId: string, env: NodeJS.ProcessEnv = process.env): AgentGitHubPolicy {
  const repositories = (listFromEnv(env.GSAM_GITHUB_AGENT_REPOSITORIES) ?? DEFAULT_AGENT_GITHUB_REPOSITORIES)
    .map((repository) => repository.toLowerCase().replace(/\.git$/, ""))
    .filter((repository) => REPOSITORY_RE.test(repository));
  const tagAgents = listFromEnv(env.GSAM_GITHUB_TAG_PUSH_AGENT_IDS) ?? DEFAULT_TAG_PUSH_AGENT_IDS;
  return { repositories: [...new Set(repositories)], allowTagPush: tagAgents.includes(agentId) };
}
