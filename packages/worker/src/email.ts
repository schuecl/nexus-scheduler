import nodemailer from "nodemailer";
import { decryptSecret } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import type { WorkerConfig } from "./config.js";

export class SmtpNotConfiguredError extends Error {
  constructor() {
    super("SMTP is not configured");
    this.name = "SmtpNotConfiguredError";
  }
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

// Mirrors packages/api/src/email.ts (same one-shot-transporter rationale
// — SMTP settings live in the DB and can change at any time) plus
// attachment support for the PDF run report (§2.2/§2.5). Two copies
// exist because the API and Worker are separate deployable processes
// with their own Prisma clients; there's no shared "server" package
// today for either to depend on without pulling in the other's runtime.
export async function sendEmail(
  config: WorkerConfig,
  to: string,
  subject: string,
  text: string,
  attachments?: EmailAttachment[],
): Promise<void> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!settings?.smtpHost || !settings.smtpPort || !settings.smtpFromAddress) {
    throw new SmtpNotConfiguredError();
  }

  const auth =
    settings.smtpUsername && settings.smtpEncryptedPassword
      ? {
          user: settings.smtpUsername,
          pass: decryptSecret(settings.smtpEncryptedPassword, config.API_KEY_ENCRYPTION_KEY),
        }
      : undefined;

  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth,
  });

  await transporter.sendMail({
    from: settings.smtpFromAddress,
    to,
    subject,
    text,
    attachments,
  });
}
