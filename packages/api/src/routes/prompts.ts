import { Router } from "express";
import { Prisma } from "@nexus-scheduler/shared/prisma";
import {
  createPromptSchema,
  updatePromptSchema,
  createPromptVersionSchema,
  type CreatePromptVersionInput,
} from "@nexus-scheduler/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireProjectAccess } from "../middleware/requireProjectAccess.js";
import { requirePromptAccess } from "../middleware/requirePromptAccess.js";
import { getAccessibleProjectIds } from "../access.js";
import { recordAuditEvent, diffChangedFields } from "../audit.js";

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Read-latest-then-insert-N+1 outside a transaction lets two concurrent
// creates both read the same latest versionNumber and both try to
// insert N+1, violating (promptId, versionNumber)'s unique constraint —
// one request would 500 instead of getting N+2. Retrying on that exact
// conflict (re-reading the latest number fresh each attempt) is simpler
// and cheaper than a serializable transaction for what's just an
// auto-incrementing counter with a unique index as its safety net.
// Verified directly under 20-way concurrent load on the same prompt —
// a 5-attempt budget with no backoff wasn't enough (several requests
// exhausted it and 500'd); jitter plus a larger budget converges
// reliably, mirroring the fix needed for the same failure pattern in
// classificationLabels.ts's isDefault race.
const MAX_VERSION_CONFLICT_RETRIES = 10;

function jitterDelay(attempt: number): Promise<void> {
  const ms = Math.floor(Math.random() * 20 * attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createNextPromptVersion(
  promptId: string,
  data: { content: string; variables: CreatePromptVersionInput["variables"]; createdById: string },
) {
  for (let attempt = 1; ; attempt++) {
    const latest = await prisma.promptVersion.findFirst({
      where: { promptId },
      orderBy: { versionNumber: "desc" },
    });
    try {
      return await prisma.promptVersion.create({
        data: {
          promptId,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          content: data.content,
          variables: data.variables,
          createdById: data.createdById,
        },
      });
    } catch (err) {
      if (!isUniqueConflict(err) || attempt >= MAX_VERSION_CONFLICT_RETRIES) {
        throw err;
      }
      await jitterDelay(attempt);
    }
  }
}

// Mounted at /api/projects/:projectId/prompts (mergeParams) — create/list
// scoped to one Project, gated the same way any other Project content
// mutation is (EDIT to create, READ to list) — REQUIREMENTS.md §2.3.
export function createProjectPromptsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get("/", requireAuth, requireProjectAccess("READ"), async (req, res) => {
    const prompts = await prisma.prompt.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { updatedAt: "desc" },
    });
    res.json(prompts);
  });

  router.post("/", requireAuth, requireProjectAccess("EDIT"), async (req, res) => {
    const parsed = createPromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const projectId = req.params.projectId!;

    const prompt = await prisma.$transaction(async (tx) => {
      const created = await tx.prompt.create({
        data: {
          projectId,
          name: parsed.data.name,
          description: parsed.data.description,
          tags: parsed.data.tags,
        },
      });
      await tx.promptVersion.create({
        data: {
          promptId: created.id,
          versionNumber: 1,
          content: parsed.data.content,
          variables: parsed.data.variables,
          createdById: user.id,
        },
      });
      return created;
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "prompt.create",
      targetType: "prompt",
      targetId: prompt.id,
      targetName: prompt.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(201).json(prompt);
  });

  return router;
}

// Mounted at /api/prompts — prompt-id-scoped operations, plus the
// library-wide search/discovery view (§2.3) across every Project the
// user can see.
export function createPromptsRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const user = req.session.user!;
    const projectIds = await getAccessibleProjectIds(user.id);
    if (projectIds.length === 0) {
      res.json([]);
      return;
    }

    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const favoritesOnly = req.query.favoritesOnly === "true";

    const favoriteIds = favoritesOnly
      ? new Set(
          (await prisma.promptFavorite.findMany({ where: { userId: user.id }, select: { promptId: true } })).map(
            (f) => f.promptId,
          ),
        )
      : null;

    const prompts = await prisma.prompt.findMany({
      where: {
        projectId: { in: projectIds },
        ...(search
          ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] }
          : {}),
        ...(tag ? { tags: { has: tag } } : {}),
        ...(favoriteIds ? { id: { in: [...favoriteIds] } } : {}),
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
    });

    const myFavoriteIds = new Set(
      (await prisma.promptFavorite.findMany({ where: { userId: user.id }, select: { promptId: true } })).map(
        (f) => f.promptId,
      ),
    );

    res.json(prompts.map((p) => ({ ...p, isFavorite: myFavoriteIds.has(p.id) })));
  });

  router.get("/:id", requireAuth, requirePromptAccess("READ"), async (req, res) => {
    const user = req.session.user!;
    const [prompt, isFavorite] = await Promise.all([
      prisma.prompt.findUnique({
        where: { id: req.params.id },
        include: {
          versions: {
            orderBy: { versionNumber: "desc" },
            include: { createdBy: { select: { id: true, email: true, displayName: true } } },
          },
        },
      }),
      prisma.promptFavorite.findUnique({
        where: { userId_promptId: { userId: user.id, promptId: req.params.id! } },
      }),
    ]);
    res.json({ ...prompt, isFavorite: !!isFavorite, projectAccess: req.projectAccess });
  });

  router.patch("/:id", requireAuth, requirePromptAccess("EDIT"), async (req, res) => {
    const parsed = updatePromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;
    const existing = await prisma.prompt.findUniqueOrThrow({ where: { id: req.params.id } });
    const prompt = await prisma.prompt.update({ where: { id: req.params.id }, data: parsed.data });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "prompt.update",
      targetType: "prompt",
      targetId: prompt.id,
      targetName: prompt.name,
      category: "lifecycle",
      changes: diffChangedFields(existing, prompt, Object.keys(parsed.data) as (keyof typeof existing)[]),
      result: "SUCCESS",
    });

    res.json(prompt);
  });

  router.delete("/:id", requireAuth, requirePromptAccess("EDIT"), async (req, res) => {
    const user = req.session.user!;

    // Job.promptId has no cascade path (a Job without a Prompt makes no
    // sense) — block with a clear message instead of surfacing a raw FK
    // constraint error, same pattern as classification labels/teams.
    const jobCount = await prisma.job.count({ where: { promptId: req.params.id } });
    if (jobCount > 0) {
      res.status(409).json({ error: `cannot delete — ${jobCount} Job(s) still use this Prompt` });
      return;
    }

    const prompt = await prisma.prompt.delete({ where: { id: req.params.id } });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "prompt.delete",
      targetType: "prompt",
      targetId: prompt.id,
      targetName: prompt.name,
      category: "lifecycle",
      result: "SUCCESS",
    });

    res.status(204).send();
  });

  router.get("/:id/versions", requireAuth, requirePromptAccess("READ"), async (req, res) => {
    const versions = await prisma.promptVersion.findMany({
      where: { promptId: req.params.id },
      orderBy: { versionNumber: "desc" },
      include: { createdBy: { select: { id: true, email: true, displayName: true } } },
    });
    res.json(versions);
  });

  // Every edit creates a new version rather than mutating content in
  // place (REQUIREMENTS.md §2.3) — prior versions stay intact so
  // schedules pinned to them are unaffected.
  router.post("/:id/versions", requireAuth, requirePromptAccess("EDIT"), async (req, res, next) => {
    const parsed = createPromptVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = req.session.user!;

    let version;
    try {
      version = await createNextPromptVersion(req.params.id!, {
        content: parsed.data.content,
        variables: parsed.data.variables,
        createdById: user.id,
      });
    } catch (err) {
      if (isUniqueConflict(err)) {
        res.status(409).json({ error: "too much concurrent activity creating a version — please retry" });
        return;
      }
      next(err);
      return;
    }
    const prompt = await prisma.prompt.update({
      where: { id: req.params.id },
      data: { updatedAt: new Date() },
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "prompt.version.create",
      targetType: "prompt",
      targetId: req.params.id,
      targetName: prompt.name,
      category: "lifecycle",
      result: "SUCCESS",
      details: { versionNumber: version.versionNumber },
    });

    res.status(201).json(version);
  });

  router.post("/:id/favorite", requireAuth, requirePromptAccess("READ"), async (req, res) => {
    const user = req.session.user!;
    await prisma.promptFavorite.upsert({
      where: { userId_promptId: { userId: user.id, promptId: req.params.id! } },
      create: { userId: user.id, promptId: req.params.id! },
      update: {},
    });
    res.status(204).send();
  });

  router.delete("/:id/favorite", requireAuth, requirePromptAccess("READ"), async (req, res) => {
    const user = req.session.user!;
    await prisma.promptFavorite
      .delete({ where: { userId_promptId: { userId: user.id, promptId: req.params.id! } } })
      .catch(() => undefined); // already-unfavorited is not an error
    res.status(204).send();
  });

  return router;
}
