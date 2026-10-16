import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  addTeamChatMembersSchema,
  createDirectMessageSchema,
  createTeamChatSchema,
  setTeamChatMuteSchema,
} from "@greatstone/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { requireEntitlement } from "../services/entitlements.js";
import { teamChatService, type TeamChatService } from "../services/team-chats.js";
import { assertCompanyAccess, hasCompanyAccess, hasCompanyBoardRole } from "./authz.js";

// Team chats (enableTeamChat): direct messages and group chats of people and
// agents. These routes manage the chats and their members; messages go
// through the ordinary issue comment routes, which check membership for team
// chats (see `teamChatAccessGuard` in routes/issues.ts).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boardUserId(req: Request) {
  if (req.actor.type !== "board" || !req.actor.userId) throw forbidden("Board user access required");
  return req.actor.userId;
}

export function teamChatRoutes(db: Db, opts: { service?: TeamChatService } = {}) {
  const router = Router();
  const chats = opts.service ?? teamChatService(db);
  router.use("/companies/:companyId/team-chats", requireEntitlement(db, "enableTeamChat"));
  router.use("/team-chats", requireEntitlement(db, "enableTeamChat"));

  /** The chat when the caller is a member or a company owner (moderation); 404 otherwise. */
  async function loadChat(req: Request) {
    const id = req.params.id as string;
    const chat = UUID_RE.test(id) ? await chats.getChat(id) : null;
    // One 404 for missing and cross-company chats, so ids from another
    // company cannot be probed (403 vs 404).
    if (!chat || !hasCompanyAccess(req, chat.companyId)) throw notFound("Chat not found");
    assertCompanyAccess(req, chat.companyId);
    const userId = boardUserId(req);
    if (!(await chats.isParticipant(chat.id, { type: "user", id: userId })) && !hasCompanyBoardRole(req, chat.companyId)) {
      throw notFound("Chat not found");
    }
    return { chat, userId };
  }

  router.get("/companies/:companyId/team-chats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await chats.list(companyId, boardUserId(req)));
  });

  router.post("/companies/:companyId/team-chats", validate(createTeamChatSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = boardUserId(req);
    const chat = await chats.createGroup(companyId, userId, req.body);
    res.status(201).json(await chats.summary(chat, userId));
  });

  router.post("/companies/:companyId/team-chats/direct", validate(createDirectMessageSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = boardUserId(req);
    const { chat, created } = await chats.ensureDirect(companyId, userId, req.body.userId);
    res.status(created ? 201 : 200).json(await chats.summary(chat, userId));
  });

  router.get("/team-chats/:id", async (req, res) => {
    const { chat, userId } = await loadChat(req);
    res.json(await chats.summary(chat, userId));
  });

  router.post("/team-chats/:id/members", validate(addTeamChatMembersSchema), async (req, res) => {
    const { chat, userId } = await loadChat(req);
    await chats.addMembers(chat, userId, req.body);
    res.json(await chats.summary(chat, userId));
  });

  router.put("/team-chats/:id/mute", validate(setTeamChatMuteSchema), async (req, res) => {
    const { chat, userId } = await loadChat(req);
    await chats.setMuted(chat, userId, req.body.muted);
    res.json(await chats.summary(chat, userId));
  });

  router.delete("/team-chats/:id/members/:type/:principalId", async (req, res) => {
    const { chat, userId } = await loadChat(req);
    const type = req.params.type;
    if (type !== "user" && type !== "agent") throw unprocessable("Member type must be user or agent");
    await chats.removeMember(chat, { type, id: req.params.principalId as string });
    res.json(await chats.summary(chat, userId));
  });

  return router;
}
