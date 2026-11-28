# Private WhatsApp Web pilot

This pilot connects one dedicated WhatsApp bot to one linked GSAM owner and one GSAM agent. GSAM owns the conversation, its audit trail and its final replies. The Mac relay carries text in both directions. The existing Hermes gateway can run independently.

## Before activation

- Release the GSAM changes and apply migration 0431 through the normal release process. Host GSAM in private deployment mode. Keep /api/private-chat/whatsapp-web/ on the tailnet and outside any public Funnel or reverse-proxy route.
- Configure Everest to use GSAM Runner with the ACPX provider. Plan this separately if Everest currently uses a direct adapter. GSAM forces deny-all provider permissions, removes assigned MCP access and exposes only the current wake comments to WhatsApp turns. The WhatsApp task uses Ask mode and produces text replies. Voice transcription and task mutations from WhatsApp are outside this pilot.
- Confirm a registered spare WhatsApp bot number and the owner's one sender number. Use international digits only. The linked owner must keep active membership with write access in the configured GSAM company.
- Use a separate tailnet-only HTTPS listener to forward to the relay on Mac loopback. Keep it separate from the existing Hermes API. GSAM must see the configured HTTPS request origin. If TLS terminates ahead of the app, trust only the immediate private proxy and preserve the original host and port.

## Private configuration

Create separate owner-readable JSON files with mode 0600, outside repositories and agent workspaces. Point the GSAM service at its file with `GSAM_WHATSAPP_WEB_CONFIG_FILE`. Point the Mac relay at its file with `GSAM_WHATSAPP_WEB_RELAY_CONFIG_FILE`. Use separate random 32-byte values encoded as 64 lowercase hex characters for the ingress and reply keys.

| Setting | GSAM service file | Mac relay file |
| --- | --- | --- |
| Ownership | `companyId`, `agentId`, `ownerUserId` | |
| WhatsApp numbers | `sender`, `bot` | Same values |
| Keys | `ingressKey`, `replyKey` | Same values |
| Private HTTPS | `ingressOrigin` for GSAM, `relayOrigin` for the Mac | `ingressUrl` from the GSAM endpoint setup |
| Mac paths and listener | | `bridgeDirectory`, `sessionDirectory`, `port` |

Use HTTPS origins on the same Tailscale DNS suffix, with no paths in either origin. The relay ingress URL includes the private endpoint path and ID. The bridge directory is the separately staged, dependency-installed Hermes WhatsApp Web bridge. Reserve the session directory for this bot and keep it private with mode 0700.

As the configured GSAM owner, create a chat endpoint with provider `whatsapp-web` and the configured `assignedAgentId` using `POST /api/companies/{companyId}/chat-endpoints`. The endpoint's setup returns the private ingress URL. Configure it with `POST /api/chat-endpoints/{endpointId}/setup` and body `{"action":"configure"}`. Leave the channel in verification until the round trip succeeds.

## Pair and verify

1. From the staged bridge directory, run the bridge in pairing-only mode so the operational relay and Hermes gateway stay separate.

   ```sh
   node bridge.js --pair-only --mode bot --session /absolute/private/session
   ```

2. On the authorised spare phone, go to **WhatsApp → Linked devices → Link a device** and scan the QR directly. Keep the QR and pairing files local. Set the dedicated WhatsApp profile name to Everest.
3. Start `node scripts/whatsapp-web-relay.mjs` on the Mac with Node.js 24 and the Mac configuration file referenced in its service environment. The relay checks the paired account against the configured bot.
4. From the authorised sender, send two intentional test messages. Verify they appear in the same Everest conversation and that the selected Everest reply arrives. Then call `POST /api/chat-endpoints/{endpointId}/test` as the operator to complete activation.

The relay persists accepted inbound envelopes before relaying them and discards their text after GSAM acknowledges receipt. GSAM deduplicates provider messages. Reply retries reuse the same publication ID and WhatsApp message ID, and the relay saves acknowledged reply receipts across restarts. For an ambiguous delivery at the provider boundary, inspect the conversation before replaying a delivery flagged for review. WhatsApp Web is an unofficial transport and can require re-pairing or face account restrictions.

## Synthetic checks

- Run `node --test scripts/whatsapp-web-relay.test.mjs` for local sender, group, authentication and reply receipt checks against a fake WhatsApp socket.
- Run the `binds private WhatsApp Web` test in `server/src/__tests__/chat-channels.integration.test.ts` with a disposable, migrated PostgreSQL database.
