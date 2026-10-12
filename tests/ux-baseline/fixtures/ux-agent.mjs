// Scripted agent for the UX baseline. No model calls; every write goes through
// the real run-authenticated APIs, so it shows up in the UI exactly as an agent's
// work would.
// - Chat turn: files one task from the message and replies with a link to it,
//   the way Everest does.
// - Task whose description has a `ux-script:` line: posts the scripted comments
//   and decision, then applies the scripted update (status, reassignment).
// - Woken by an answered decision: closes the task.
// - Anything else: closes its turn with a short note.
const base = process.env.GSAM_API_URL;
const headers = {
  Authorization: `Bearer ${process.env.GSAM_API_KEY}`,
  "Content-Type": "application/json",
};
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const run = await api(`/heartbeat-runs/${process.env.GSAM_RUN_ID}`);
const ctx = run.contextSnapshot;
if (!ctx?.issueId) process.exit(0);
const task = await api(`/issues/${ctx.issueId}`);

if (task.conversationAgentId) {
  const comments = await api(`/issues/${task.id}/comments?order=asc`);
  const current =
    comments.find((c) => c.id === ctx.wakeCommentId) ??
    comments.filter((c) => c.authorUserId).at(-1);
  if (!current) process.exit(0);
  const request = current.body.trim().replace(/\s+/g, " ");
  const result = await api("/mcp/project-tools", "POST", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "create_task",
      arguments: {
        title: request.slice(0, 120),
        description: `Filed from chat: ${request}`,
        idempotencyKey: current.id,
      },
    },
  });
  if (result.result?.isError || result.error) throw new Error(JSON.stringify(result));
  const child = result.result.structuredContent;
  await api(`/issues/${task.id}/comments`, "POST", {
    body: `Filed "${child.title}" as [${child.identifier}](/issues/${child.id})`,
  });
  process.exit(0);
}

// Woken by John's answer to a decision: acknowledge it and finish the task.
if (ctx.interactionId) {
  await api(`/issues/${task.id}`, "PATCH", { status: "done", comment: "Thanks, going ahead with that." });
  process.exit(0);
}

const line = (task.description ?? "").split("\n").find((l) => l.startsWith("ux-script:"));
if (!line) process.exit(0);
const script = JSON.parse(Buffer.from(line.slice("ux-script:".length).trim(), "base64url").toString());
for (const body of script.comments ?? []) await api(`/issues/${task.id}/comments`, "POST", { body });
if (script.interaction) await api(`/issues/${task.id}/interactions`, "POST", script.interaction);
if (script.update) await api(`/issues/${task.id}`, "PATCH", script.update);
