import { generateResetToken, hashResetToken } from "@nexus-scheduler/shared";
import type { User } from "@nexus-scheduler/shared/prisma";
import { prisma } from "./db.js";
import { sendEmail, SmtpNotConfiguredError } from "./email.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Shared by the self-service "forgot password" flow (auth.ts) and the
// admin-triggered "send password reset" action (users.ts) — one place
// that generates a token, stores its hash, and emails the link, so a
// newly admin-provisioned local account (no password yet) and an
// existing one both go through the identical set/reset path.
export async function issuePasswordResetEmail(
  config: AppConfig,
  logger: Logger,
  user: User,
): Promise<void> {
  const token = generateResetToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  // APP_BASE_URL is the intended source of truth; OIDC_REDIRECT_URI's
  // origin is only a fallback for deployments that configured OIDC
  // before APP_BASE_URL existed. Neither being set means this link is
  // genuinely unopenable — worth a loud warning rather than silently
  // emailing a host-less URL.
  const origin = config.APP_BASE_URL ?? (config.OIDC_REDIRECT_URI ? new URL(config.OIDC_REDIRECT_URI).origin : "");
  if (!origin) {
    logger.warn(
      { userId: user.id },
      "APP_BASE_URL is not configured — the password reset/set link in this email has no host and won't open",
    );
  }
  try {
    await sendEmail(
      config,
      user.email,
      "Nexus Scheduler — set your password",
      `Use this link to set your Nexus Scheduler password. It expires in 1 hour:\n\n` +
        `${origin}/reset-password?token=${token}\n\n` +
        `If you didn't expect this, you can ignore this email.`,
    );
  } catch (err) {
    if (err instanceof SmtpNotConfiguredError) {
      logger.warn({ userId: user.id }, "password reset issued but SMTP is not configured");
    } else {
      logger.error({ err, userId: user.id }, "failed to send password reset email");
    }
  }
}
