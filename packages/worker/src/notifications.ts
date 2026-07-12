import { renderRunReportPdf } from "@nexus-scheduler/pdf";
import { prisma } from "./db.js";
import { recordAuditEvent } from "./audit.js";
import { sendEmail, SmtpNotConfiguredError, type EmailAttachment } from "./email.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";

// Sends a completion/failure email to the Job owner (§2.2), optionally
// with the run's PDF report attached (§2.5's "instead of, or alongside,
// inline text" — here it replaces the inline output to avoid a large
// duplicate blob in both the email body and the attachment). Best-effort,
// same posture as deliverWebhooksForRun: a failure here is logged and
// audited but never fails the run itself or triggers a BullMQ retry.
export async function sendRunNotificationEmail(
  runId: string,
  jobId: string,
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { createdBy: true, project: { include: { classificationLabel: true } } },
  });
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });

  const shouldNotify =
    (run.status === "SUCCESS" && job.notifyOnSuccess) || (run.status === "FAILED" && job.notifyOnFailure);
  if (!shouldNotify) {
    return;
  }

  try {
    let attachments: EmailAttachment[] | undefined;
    if (job.attachPdfToEmail) {
      const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
      const label = job.project.classificationLabel;
      const pdf = await renderRunReportPdf({
        productName: settings?.productName ?? "Nexus Scheduler",
        primaryColor: settings?.primaryColor ?? "#1976d2",
        banner: {
          text: settings?.classificationBannerText ?? "UNCLASSIFIED // CLASSIFICATION BANNER NOT CONFIGURED",
          backgroundColor: settings?.classificationBannerBgColor ?? "#800000",
          textColor: settings?.classificationBannerTextColor ?? "#ffffff",
        },
        classification: label
          ? {
              text: label.abbreviation ? `${label.text} (${label.abbreviation})` : label.text,
              badgeBgColor: label.badgeBgColor,
              badgeTextColor: label.badgeTextColor,
            }
          : null,
        jobName: job.name,
        runId: run.id,
        triggerType: run.triggerType,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        computedCost: run.computedCost?.toString() ?? null,
        output: run.output,
        errorMessage: run.errorMessage,
      });
      attachments = [{ filename: `run-${run.id}.pdf`, content: pdf, contentType: "application/pdf" }];
    }

    const subject = `[Nexus Scheduler] ${job.name} — ${run.status}`;
    const bodyLines = [
      `Job: ${job.name}`,
      `Status: ${run.status}`,
      `Run ID: ${run.id}`,
      `Started: ${run.startedAt?.toISOString() ?? "—"}`,
      `Completed: ${run.completedAt?.toISOString() ?? "—"}`,
    ];
    if (attachments) {
      bodyLines.push("", "See the attached PDF report for the full output.");
    } else if (run.status === "FAILED" && run.errorMessage) {
      bodyLines.push("", "Error:", run.errorMessage);
    } else if (run.output) {
      bodyLines.push("", "Output:", run.output);
    }

    await sendEmail(config, job.createdBy.email, subject, bodyLines.join("\n"), attachments);

    await recordAuditEvent({
      actorType: "SERVICE",
      actorId: "system:scheduler",
      actorEmail: "system:scheduler",
      action: "run.notify_email",
      targetType: "run",
      targetId: run.id,
      result: "SUCCESS",
      correlationId: run.id,
    });
  } catch (err) {
    if (err instanceof SmtpNotConfiguredError) {
      logger.warn({ runId, jobId }, "run notification skipped — SMTP not configured");
    } else {
      logger.warn({ runId, jobId, err }, "run notification email failed");
    }
    await recordAuditEvent({
      actorType: "SERVICE",
      actorId: "system:scheduler",
      actorEmail: "system:scheduler",
      action: "run.notify_email",
      targetType: "run",
      targetId: runId,
      result: "FAILURE",
      errorMessage: err instanceof Error ? err.message : "unknown error",
      correlationId: runId,
    });
  }
}
