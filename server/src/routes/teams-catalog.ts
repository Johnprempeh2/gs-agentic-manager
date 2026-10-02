import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  catalogTeamInstallSchema,
  catalogTeamListQuerySchema,
  catalogTeamPreviewSchema,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, instanceSettingsService } from "../services/index.js";
import {
  catalogTeamMatchesFilter,
  getCatalogTeamOrThrow,
  listCatalogTeams,
  readCatalogTeamFile,
  teamsCatalogService,
} from "../services/teams-catalog.js";
import { forbidden, notFound } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

export function teamsCatalogRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = teamsCatalogService(db);
  const instanceSettings = instanceSettingsService(db);

  async function catalogFilter() {
    return (await instanceSettings.getGeneral()).teamCatalogFilter;
  }

  // A team hidden by the instance filter (GRE-427) reads as absent everywhere:
  // listing, detail, files, preview and install.
  async function assertCatalogTeamOffered(catalogRef: string) {
    const team = await getCatalogTeamOrThrow(catalogRef);
    if (!catalogTeamMatchesFilter(team, await catalogFilter())) {
      throw notFound("Catalog team not found");
    }
    return team;
  }

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  async function assertCanInstallCatalogTeam(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  router.get("/teams/catalog", async (req, res) => {
    assertAuthenticated(req);
    const query = catalogTeamListQuerySchema.parse({
      kind: firstQueryString(req.query.kind),
      category: firstQueryString(req.query.category),
      q: firstQueryString(req.query.q),
    });
    const filter = await catalogFilter();
    res.json(await listCatalogTeams(filter === "all" ? query : { ...query, filter }));
  });

  router.get("/teams/catalog/:catalogId/files", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    const relativePath = firstQueryString(req.query.path) ?? "TEAM.md";
    await assertCatalogTeamOffered(catalogRef);
    res.json(await readCatalogTeamFile(catalogRef, relativePath));
  });

  router.get("/teams/catalog/:catalogId", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    res.json(await assertCatalogTeamOffered(catalogRef));
  });

  router.get("/companies/:companyId/teams/catalog/installed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listInstalledCatalogTeams(companyId));
  });

  router.post(
    "/companies/:companyId/teams/catalog/:catalogId/preview",
    validate(catalogTeamPreviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
      assertCompanyAccess(req, companyId);
      await assertCatalogTeamOffered(catalogRef);
      const result = await svc.previewCatalogTeamImport(companyId, catalogRef, {
        ...req.body,
        actor: getActorInfo(req),
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/teams/catalog/:catalogId/install",
    validate(catalogTeamInstallSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
      await assertCanInstallCatalogTeam(req, companyId);
      await assertCatalogTeamOffered(catalogRef);
      const result = await svc.installCatalogTeam(companyId, catalogRef, {
        ...req.body,
        actor: getActorInfo(req),
      });
      res.status(201).json(result);
    },
  );

  return router;
}
