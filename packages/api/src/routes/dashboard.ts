import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getAccessibleProjectIds } from "../access.js";

// Aggregate view for the landing page (REQUIREMENTS §8: "Run counts,
// success/failure rates, and upcoming schedules"). Scoped to Projects the
// requesting user can see — same rule as the Projects list itself, so a
// user never sees run activity for a Project they couldn't otherwise open.
export function createDashboardRouter(): Router {
  const router = Router();

  router.get("/", requireAuth, asyncHandler(async (req, res) => {
    const projectIds = await getAccessibleProjectIds(req.session.user!.id);

    if (projectIds.length === 0) {
      res.json({ runCounts: {}, recentRuns: [], upcomingSchedules: [] });
      return;
    }

    const jobWhere = { project: { id: { in: projectIds } } };

    const [statusCounts, recentRuns, upcomingSchedules] = await Promise.all([
      prisma.run.groupBy({
        by: ["status"],
        where: { job: jobWhere },
        _count: { _all: true },
      }),
      prisma.run.findMany({
        where: { job: jobWhere },
        orderBy: { createdAt: "desc" },
        take: 10,
        // Explicit select: Run now carries extractedText (full OCR
        // markdown) — a broad read here would ship it 10x per
        // dashboard load for a card that shows four fields.
        select: {
          id: true,
          status: true,
          triggerType: true,
          createdAt: true,
          job: { select: { id: true, name: true, projectId: true } },
        },
      }),
      prisma.schedule.findMany({
        where: {
          job: jobWhere,
          paused: false,
          approvalStatus: "APPROVED",
          nextFireAt: { not: null },
        },
        orderBy: { nextFireAt: "asc" },
        take: 10,
        include: { job: { select: { id: true, name: true, projectId: true } } },
      }),
    ]);

    res.json({
      runCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
      recentRuns,
      upcomingSchedules,
    });
  }));

  return router;
}
