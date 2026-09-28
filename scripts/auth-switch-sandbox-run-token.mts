// Mints an agent run token the way the heartbeat does at run spawn, for
// scripts/auth-switch-sandbox-check.sh (GRE-125). Reads the instance from
// GSAM_HOME / GSAM_INSTANCE_ID, so run it with the sandbox's environment only.
//
//   tsx scripts/auth-switch-sandbox-run-token.mts <agentId> <companyId>
import { randomUUID } from "node:crypto";
import { createLocalAgentJwt } from "../server/src/agent-auth-jwt.js";

const [agentId, companyId] = process.argv.slice(2);
if (!agentId || !companyId) {
  console.error("usage: auth-switch-sandbox-run-token.mts <agentId> <companyId>");
  process.exit(2);
}
const token = createLocalAgentJwt(agentId, companyId, "process", randomUUID(), "local-board");
if (!token) {
  console.error("could not mint a run token: no agent JWT secret for this instance");
  process.exit(1);
}
console.log(token);
