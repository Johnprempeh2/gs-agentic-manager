export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.GSAM_API_URL);
  if (!apiUrl) {
    throw new Error("Missing GSAM_API_URL");
  }
  const apiKey = nonEmpty(env.GSAM_API_KEY);
  if (!apiKey) {
    throw new Error("Missing GSAM_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.GSAM_COMPANY_ID),
    agentId: nonEmpty(env.GSAM_AGENT_ID),
    runId: nonEmpty(env.GSAM_RUN_ID),
  };
}
