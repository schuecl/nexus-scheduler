import { z } from "zod";

// Admin-editable branding (§5) and the system-wide classification
// banner (§6) — one settings surface, two independent concerns living
// in it (the banner is never derived from anything else, per §6).
export const updateAppSettingsSchema = z.object({
  productName: z.string().min(1).max(100).optional(),
  logoUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().min(1).optional(),
  classificationBannerText: z.string().min(1).max(200).optional(),
  classificationBannerBgColor: z.string().min(1).optional(),
  classificationBannerTextColor: z.string().min(1).optional(),
});
export type UpdateAppSettingsInput = z.infer<typeof updateAppSettingsSchema>;
