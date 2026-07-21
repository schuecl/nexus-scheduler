import { z } from "zod";

// projectId comes from the route (POST /api/projects/:projectId/jobs),
// not the body — same convention as createPromptSchema.
export const createJobSchema = z.object({
  name: z.string().min(1).max(200),
  promptId: z.string().uuid(),
  agentId: z.string().min(1), // LibreChat agent ID (REQUIREMENTS §2.1)
  apiKeyId: z.string().uuid(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600), // 10m default, 60m ceiling
  maxRetries: z.number().int().min(0).max(5).default(2),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  promptId: z.string().uuid().optional(),
  agentId: z.string().min(1).optional(),
  apiKeyId: z.string().uuid().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

// Email notification to the Job owner on completion/failure (§2.2),
// replaces the full set in one call — same convention as
// setJobWebhooksSchema. attachPdfToEmail is meaningful only alongside
// at least one notify flag; enforced in the UI, not here, since sending
// it false-with-both-notify-flags-false is harmless, just a no-op.
export const setJobNotificationsSchema = z.object({
  notifyOnSuccess: z.boolean(),
  notifyOnFailure: z.boolean(),
  attachPdfToEmail: z.boolean(),
  // Extra recipients alongside the Job owner (§58) — capped at 10.
  ccRecipients: z.array(z.string().email()).max(10),
  // Optional custom subject/body (§61) — null/undefined falls back to
  // the default text. No newlines in the subject (header-injection
  // defense in depth, on top of nodemailer's own protections).
  emailSubjectTemplate: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s), "subject cannot contain line breaks")
    .nullable()
    .optional(),
  emailBodyTemplate: z.string().trim().min(1).max(5000).nullable().optional(),
  // Saved mailing lists (issue #219) attached to this Job — expanded to
  // their raw email addresses at send time, alongside ccRecipients.
  // Capped well below ccRecipients' 10: a handful of lists is already a
  // proxy for a lot of recipients, and a Job that needs more than this
  // probably wants a bigger list, not more list slots.
  mailingListIds: z.array(z.string().uuid()).max(5).default([]),
});
export type SetJobNotificationsInput = z.infer<typeof setJobNotificationsSchema>;

// {{variable}} placeholders declared on a prompt version — REQUIREMENTS §2.3.
export const promptVariableSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["text", "number", "date"]),
  defaultValue: z.string().optional(),
});

export type PromptVariable = z.infer<typeof promptVariableSchema>;
