# GS Agentic Manager MCP Server

Model Context Protocol server for GS Agentic Manager.

This package is a thin MCP wrapper over the existing GS Agentic Manager REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `GSAM_API_URL` - GS Agentic Manager base URL, for example `http://localhost:3100`
- `GSAM_API_KEY` - bearer token used for `/api` requests
- `GSAM_COMPANY_ID` - optional default company for company-scoped tools
- `GSAM_AGENT_ID` - optional default agent for checkout helpers
- `GSAM_RUN_ID` - optional run id forwarded on mutating requests

Inside an active heartbeat, GS Agentic Manager also injects `GSAM_RUNTIME_TOOLS_*` variables. They enable the run-scoped `connections_search` and `connection_request` tools and expire with the run.

## Usage

```sh
npx -y @greatstone/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @greatstone/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Run-scoped connection tools:

- `connections_search`
- `connection_request`

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
