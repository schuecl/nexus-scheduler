import { renderUsageReportPdf } from "@nexus-scheduler/pdf";
import { prisma } from "./db.js";
import { sendEmail, SmtpNotConfiguredError, type EmailAttachment } from "./email.js";
import { recordAuditEvent } from "./audit.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";

const FREQUENCY_MS: Record<"WEEKLY" | "MONTHLY", number> = {
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000, // calendar-approximate, not exact month boundaries
};

// Same aggregation as the API's admin usage-report routes
// (packages/api/src/routes/adminReports.ts) — duplicated rather than
// shared because the API and Worker are separate processes with their
// own Prisma clients, same rationale as email.ts/audit.ts.
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
    runCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
    totalPromptTokens: tokenSums._sum.promptTokens ?? 0,
    totalCompletionTokens: tokenSums._sum.completionTokens ?? 0,
    totalCost: tokenSums._sum.computedCost?.toString() ?? null,
  };
}

// Checks hourly whether the admin-configured recurring usage report
// (§2.5/§8) is due, and sends it if so. Deliberately driven by
// `usageReportLastSentAt` rather than a cron-like next-fire-time
// column: REQUIREMENTS frames this as one admin-wide on/off setting
// with a frequency, not a schedulable entity in its own right the way
// Job Schedules are, so "has enough time elapsed since last send" is
// the whole rule.
export function startUsageReportLoop(config: WorkerConfig, logger: Logger): NodeJS.Timeout {
  const checkIntervalMs = 60 * 60 * 1000; // hourly is plenty for a weekly/monthly cadence

  const tick = async () => {
    try {
      const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
      if (!settings?.usageReportEnabled || settings.usageReportRecipients.length === 0) {
        return;
      }

      const periodMs = FREQUENCY_MS[settings.usageReportFrequency];
      const now = new Date();
      const periodStart = settings.usageReportLastSentAt ?? new Date(now.getTime() - periodMs);
      const due = now.getTime() - periodStart.getTime() >= periodMs;
      if (!due) {
        return;
      }

      const stats = await getUsageStats(periodStart, now);
      const pdf = await renderUsageReportPdf({
        productName: settings.productName,
        primaryColor: settings.primaryColor,
        banner: {
          text: settings.classificationBannerText,
          backgroundColor: settings.classificationBannerBgColor,
          textColor: settings.classificationBannerTextColor,
        },
        periodStart: periodStart.toLocaleDateString(),
        periodEnd: now.toLocaleDateString(),
        generatedAt: now.toLocaleString(),
        ...stats,
      });
      const attachment: EmailAttachment = {
        filename: `usage-report-${now.toISOString().slice(0, 10)}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      };

      await sendEmail(
        config,
        settings.usageReportRecipients.join(","),
        `[${settings.productName}] Usage Report — ${periodStart.toLocaleDateString()} to ${now.toLocaleDateString()}`,
        "See the attached PDF for this period's run counts, success/failure rates, token usage, and cost.",
        [attachment],
      );

      await prisma.appSettings.update({ where: { id: 1 }, data: { usageReportLastSentAt: now } });

      await recordAuditEvent({
        actorType: "SERVICE",
        actorId: "system:scheduler",
        actorEmail: "system:scheduler",
        action: "usage_report.send_email",
        targetType: "system_setting",
        result: "SUCCESS",
        details: { recipients: settings.usageReportRecipients, periodStart, periodEnd: now },
      });
    } catch (err) {
      if (err instanceof SmtpNotConfiguredError) {
        logger.warn("recurring usage report skipped — SMTP not configured");
      } else {
        logger.error({ err }, "recurring usage report send failed");
      }
      await recordAuditEvent({
        actorType: "SERVICE",
        actorId: "system:scheduler",
        actorEmail: "system:scheduler",
        action: "usage_report.send_email",
        targetType: "system_setting",
        result: "FAILURE",
        errorMessage: err instanceof Error ? err.message : "unknown error",
      });
    }
  };

  const interval = setInterval(tick, checkIntervalMs);
  void tick();
  return interval;
}
