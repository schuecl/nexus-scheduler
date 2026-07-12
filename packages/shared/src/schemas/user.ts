import { z } from "zod";

// Admin-only user management (§4) — role and active-status changes.
// Everything else about a user (name, email) is sourced from OIDC and
// isn't admin-editable here.
export const updateUserSchema = z.object({
  role: z.enum(["ADMIN", "EDITOR", "VIEW"]).optional(),
  active: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
