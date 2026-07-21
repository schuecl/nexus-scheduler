import { z } from "zod";

// A user-owned, reusable named list of notification-recipient email
// addresses (issue #219) — saved once, then attached to any Job's
// notifications (setJobNotificationsSchema.mailingListIds) instead of
// retyping the same addresses into ccRecipients on every Job. Raw
// strings, same validation posture as Job.ccRecipients: shape-checked
// only, never cross-referenced against a real User account.
const MAX_EMAILS_PER_LIST = 100;

export const createMailingListSchema = z.object({
  name: z.string().trim().min(1).max(200),
  emails: z.array(z.string().email()).min(1).max(MAX_EMAILS_PER_LIST),
});
export type CreateMailingListInput = z.infer<typeof createMailingListSchema>;

export const updateMailingListSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  emails: z.array(z.string().email()).min(1).max(MAX_EMAILS_PER_LIST).optional(),
});
export type UpdateMailingListInput = z.infer<typeof updateMailingListSchema>;
