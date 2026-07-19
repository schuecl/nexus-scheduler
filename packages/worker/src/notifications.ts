import { requestRunReportPdf } from "@nexus-scheduler/shared";
import { renderMarkdownToSafeHtml } from "@nexus-scheduler/pdf";
import { prisma } from "./db.js";
import { recordAuditEvent } from "./audit.js";
import { sendEmail, SmtpNotConfiguredError, type EmailAttachment } from "./email.js";
import { renderNotificationTemplate } from "./notificationTemplate.js";
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
  // Explicit select: the email/PDF uses run metadata + output only —
  // without it, every notification for a run with attachments would
  // read the full OCR extractedText into worker memory.
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      triggerType: true,
      status: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      promptTokens: true,
      completionTokens: true,
      computedCost: true,
      output: true,
      errorMessage: true,
    },
  });

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
      const pdf = await requestRunReportPdf(config.PDF_SERVICE_URL, {
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
      }, config.PDF_SERVICE_SHARED_SECRET);
      attachments = [{ filename: `run-${run.id}.pdf`, content: pdf, contentType: "application/pdf" }];
    }

    const defaultSubject = `[Nexus Scheduler] ${job.name} — ${run.status}`;
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

    // Custom subject/body (§61) — a "pretty" report aimed at a specific
    // audience (e.g. a leader) rather than the generic default above.
    // {{placeholder}} substitution first, then the (possibly templated)
    // body is treated as Markdown and rendered to a safe HTML part
    // alongside the plain-text one, same rendering path already trusted
    // for run output (§39) and PDF reports.
    const templateContext = {
      jobName: job.name,
      status: run.status,
      runId: run.id,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      output: run.output,
      errorMessage: run.errorMessage,
      ownerEmail: job.createdBy.email,
      ownerFullName:
        job.createdBy.displayName ||
        [job.createdBy.givenName, job.createdBy.familyName].filter(Boolean).join(" ") ||
        job.createdBy.email,
    };
    const subject = job.emailSubjectTemplate
      ? renderNotificationTemplate(job.emailSubjectTemplate, templateContext)
      : defaultSubject;
    const text = job.emailBodyTemplate
      ? renderNotificationTemplate(job.emailBodyTemplate, templateContext)
      : bodyLines.join("\n");
    const html = job.emailBodyTemplate ? renderMarkdownToSafeHtml(text) : undefined;

    const recipients = [job.createdBy.email, ...job.ccRecipients].join(", ");
    await sendEmail(config, recipients, subject, text, { html, attachments });

    await recordAuditEvent({
      actorType: "SERVICE",
      actorId: "system:scheduler",
      actorEmail: "system:scheduler",
      action: "run.notify_email",
      targetType: "run",
      targetId: run.id,
      targetName: job.name,
      category: "lifecycle",
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
      targetName: job.name,
      category: "lifecycle",
      result: "FAILURE",
      errorMessage: err instanceof Error ? err.message : "unknown error",
      correlationId: runId,
    });
  }
}
