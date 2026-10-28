# Delegated personal tool setup

This fork takes a narrow part of upstream `13709b4c7`. It does not take the
upstream default agent grants or gateway-token migration `0380`. The source
commit is recorded as **partial** in the implementation commit trailer.

## Agent API

| Route | Allowed result |
| --- | --- |
| `POST /api/agents/me/tool-connections` | Save a personal, credential-free remote MCP draft for the current responsible user. The body names a supported gallery method and a credential-free HTTPS `/mcp` URL. The response gives the user an Apps setup path. |
| `GET /api/agents/me/tool-connections/{connectionId}` | Return name, status, provider and ownership metadata. No credential values or secret references are returned. |
| `PATCH /api/agents/me/tool-connections/{connectionId}` | Rename an owned or personally granted tool connection. |
| `POST /api/agents/me/tool-connections/{connectionId}/reconnect` | Return the existing setup wizard for a draft or the retained reconnect wizard for an active connection. The agent cannot enter or rotate the credential. |
| `POST /api/agents/me/tool-connections/{connectionId}/installs/{targetAgentId}` | Add one named-agent install without replacing other installs. Both the agent and the responsible user need agent-config authority for the target. |

All routes require an explicit agent `tools:manage_connections` grant, a
running standard assigned task, a current run identity, active same-company
agent and responsible-user memberships, standard key scope, and standard
trust. The responsible user's permission is checked directly even if the
instance runs the general intersection in shadow mode. The resource must be a
personal tool connection owned by or personally granted to that user.

The management grant accepts `connectionId`, `provider`, `purpose`, `operation`
and `targetAgentId` selectors. Every specified selector must match. Unknown
keys and malformed selectors deny access. Creation is checked against provider,
purpose and operation before an ID exists. The saved connection is checked
again after creation. Discovery and later operations recheck authority before
writing. Configure rechecks after endpoint validation and before writing. An
archived connection recovered by name is checked before reuse.

This API cannot create organization grants, install company-wide, delegate
grants, edit policies, mutate AI or chat connections, change gateways or
runtime state, or run tests that spend or send. Existing board routes retain
their established permissions.
