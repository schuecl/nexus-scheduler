import { Router } from "express";
import { renderUsageReportPdf } from "@nexus-scheduler/pdf";
import { prisma } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/requireAuth.js";
import { recordAuditEvent } from "../audit.js";
import { getPublicAppSettings } from "./settings.js";

type RunStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED";

// Defaults to the trailing 30 days when no range is given — REQUIREMENTS
// §8 doesn't mandate a specific default window, just that the report be
// exportable; 30 days is a reasonable "recent activity" snapshot.
function parseDateRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const to = typeof query.to === "string" ? new Date(query.to) : new Date();
  const from =
    typeof query.from === "string" ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// Shared by the JSON, CSV, and PDF routes below so the numbers can
// never disagree between formats — REQUIREMENTS §8: run counts,
// success/failure rates, token usage, cost, admin-facing (distinct
// from the per-user-scoped GET /api/dashboard, which only shows
// Projects the requesting user can see — this is org-wide).
async function getUsageStats(from: Date, to: Date) {
  const where = { createdAt: { gte: from, lte: to } };
  const [statusCounts, tokenSums] = await Promise.all([
    prisma.run.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.run.aggregate({
      where,
      _sum: { promptTokens: true, completionTokens: true, computedCost: true },
    }),
  ]);

  return {
    runCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])) as Partial<
      Record<RunStatus, number>
    >,
    totalPromptTokens: tokenSums._sum.promptTokens ?? 0,
    totalCompletionTokens: tokenSums._sum.completionTokens ?? 0,
    totalCost: tokenSums._sum.computedCost?.toString() ?? null,
  };
}

// RFC 4180-ish: wrap in quotes and escape internal quotes whenever a
// field might contain a comma, quote, or newline — job/project names
// and user emails are admin/user-entered text, not guaranteed comma-free.
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function createAdminReportsRouter(): Router {
  const router = Router();

  router.get("/usage-report", requireAuth, requireAdmin, async (req, res) => {
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const stats = await getUsageStats(from, to);
    res.json({ periodStart: from.toISOString(), periodEnd: to.toISOString(), ...stats });
  });

  router.get("/usage-report/csv", requireAuth, requireAdmin, async (req, res) => {
    const user = req.session.user!;
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);

    const runs = await prisma.run.findMany({
      where: { createdAt: { gte: from, lte: to } },
      include: {
        job: {
          select: {
            name: true,
            agentId: true,
            project: { select: { name: true } },
            createdBy: { select: { email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const header = "createdAt,job,project,owner,agent,status,triggerType,promptTokens,completionTokens,cost";
    const rows = runs.map((r) =>
      [
        r.createdAt.toISOString(),
        csvField(r.job.name),
        csvField(r.job.project.name),
        csvField(r.job.createdBy.email),
        csvField(r.job.agentId),
        r.status,
        r.triggerType,
        r.promptTokens ?? "",
        r.completionTokens ?? "",
        r.computedCost?.toString() ?? "",
      ].join(","),
    );

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "usage_report.export",
      targetType: "system_setting",
      result: "SUCCESS",
      details: { format: "csv", from: from.toISOString(), to: to.toISOString(), rowCount: runs.length },
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="usage-report-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`,
    );
    res.send([header, ...rows].join("\n"));
  });

  router.get("/usage-report/pdf", requireAuth, requireAdmin, async (req, res) => {
    const user = req.session.user!;
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const stats = await getUsageStats(from, to);
    const settings = await getPublicAppSettings();

    const pdf = await renderUsageReportPdf({
      productName: settings.productName,
      primaryColor: settings.primaryColor,
      banner: {
        text: settings.classificationBannerText,
        backgroundColor: settings.classificationBannerBgColor,
        textColor: settings.classificationBannerTextColor,
      },
      periodStart: from.toLocaleDateString(),
      periodEnd: to.toLocaleDateString(),
      generatedAt: new Date().toLocaleString(),
      ...stats,
    });

    await recordAuditEvent({
      req,
      actorType: "USER",
      actorId: user.id,
      actorEmail: user.email,
      action: "usage_report.export",
      targetType: "system_setting",
      result: "SUCCESS",
      details: { format: "pdf", from: from.toISOString(), to: to.toISOString() },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"usage-report.pdf\"");
    res.send(pdf);
  });

  return router;
}
