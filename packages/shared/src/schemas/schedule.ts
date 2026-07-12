import { z } from "zod";

// Recurring schedules use simplified interval pickers, not raw cron
// syntax (REQUIREMENTS.md §2). This is a discriminated union so the API
// and frontend share one validated shape for "how often does this run."
export const intervalConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("every_n_minutes"),
    minutes: z.number().int().min(5), // §2.1 concurrency/timeout defaults assume a sane floor
  }),
  z.object({
    kind: z.literal("every_n_hours"),
    hours: z.number().int().min(1),
    atMinute: z.number().int().min(0).max(59).default(0),
  }),
  z.object({
    kind: z.literal("daily"),
    atTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm"),
  }),
  z.object({
    kind: z.literal("weekly"),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1), // 0 = Sunday
    atTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm"),
  }),
]);

export type IntervalConfig = z.infer<typeof intervalConfigSchema>;

// jobId comes from the route (POST /api/jobs/:jobId/schedules), not the
// body — same convention as createPromptSchema/createJobSchema.
export const createScheduleSchema = z
  .object({
    type: z.enum(["ONE_TIME", "RECURRING"]),
    runAt: z.string().datetime().optional(), // required when type === "ONE_TIME"
    intervalConfig: intervalConfigSchema.optional(), // required when type === "RECURRING"
    timezone: z.string().min(1), // IANA tz name, validated server-side against the tz database
    versionPinMode: z.enum(["PINNED", "LATEST"]).default("LATEST"),
    // required when versionPinMode === "PINNED" (§2.3: the schedule
    // owner's per-schedule choice of which prompt version to run).
    pinnedPromptVersionId: z.string().uuid().optional(),
  })
  .refine((v) => v.type !== "ONE_TIME" || !!v.runAt, {
    message: "runAt is required for a one-time schedule",
    path: ["runAt"],
  })
  .refine((v) => v.type !== "RECURRING" || !!v.intervalConfig, {
    message: "intervalConfig is required for a recurring schedule",
    path: ["intervalConfig"],
  })
  .refine((v) => v.versionPinMode !== "PINNED" || !!v.pinnedPromptVersionId, {
    message: "pinnedPromptVersionId is required when versionPinMode is PINNED",
    path: ["pinnedPromptVersionId"],
  });

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = z
  .object({
    runAt: z.string().datetime().optional(),
    intervalConfig: intervalConfigSchema.optional(),
    timezone: z.string().min(1).optional(),
    versionPinMode: z.enum(["PINNED", "LATEST"]).optional(),
    pinnedPromptVersionId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.versionPinMode !== "PINNED" || !!v.pinnedPromptVersionId, {
    message: "pinnedPromptVersionId is required when versionPinMode is PINNED",
    path: ["pinnedPromptVersionId"],
  });
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
