import { z } from "zod";

// Mirrors packages/pdf/src/templates/banner.ts's ClassificationBannerInfo
// and templates/{runReport,usageReport}.ts's data interfaces exactly.
// Runtime-validated at this HTTP boundary even though every caller is
// internal (API/Worker) — the request body crossing a process boundary
// is reason enough on its own, isolation from the callers' own type
// safety notwithstanding.
//
// Every string field is capped: this endpoint feeds a fresh headless
// Chromium layout/paginate pass per request, so an unbounded field is a
// cheap-request/expensive-response amplification vector, not just a
// data-hygiene nit. `output`/`errorMessage` get a much larger budget
// since they're a real agent transcript; everything else is short,
// structured data with no legitimate reason to be large.
const SHORT_TEXT_MAX = 200;
const OUTPUT_MAX = 256 * 1024; // 256KB, matching the issue's suggested ceiling

const bannerSchema = z
  .object({
    text: z.string().max(SHORT_TEXT_MAX),
    backgroundColor: z.string().max(SHORT_TEXT_MAX),
    textColor: z.string().max(SHORT_TEXT_MAX),
  })
  // null when the admin has the classification banner disabled (issue
  // #228) — the report then carries no header/footer banner at all.
  .nullable();

export const runReportRequestSchema = z.object({
  productName: z.string().max(SHORT_TEXT_MAX),
  primaryColor: z.string().max(SHORT_TEXT_MAX),
  banner: bannerSchema,
  classification: z
    .object({
      text: z.string().max(SHORT_TEXT_MAX),
      badgeBgColor: z.string().max(SHORT_TEXT_MAX),
      badgeTextColor: z.string().max(SHORT_TEXT_MAX),
    })
    .nullable(),
  jobName: z.string().max(SHORT_TEXT_MAX),
  runId: z.string().max(SHORT_TEXT_MAX),
  triggerType: z.string().max(SHORT_TEXT_MAX),
  status: z.string().max(SHORT_TEXT_MAX),
  createdAt: z.string().max(SHORT_TEXT_MAX),
  startedAt: z.string().max(SHORT_TEXT_MAX).nullable(),
  completedAt: z.string().max(SHORT_TEXT_MAX).nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  computedCost: z.string().max(SHORT_TEXT_MAX).nullable(),
  output: z.string().max(OUTPUT_MAX).nullable(),
  errorMessage: z.string().max(OUTPUT_MAX).nullable(),
});

const runStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED", "CANCELLED", "SKIPPED"]);

export const usageReportRequestSchema = z.object({
  productName: z.string().max(SHORT_TEXT_MAX),
  primaryColor: z.string().max(SHORT_TEXT_MAX),
  banner: bannerSchema,
  periodStart: z.string().max(SHORT_TEXT_MAX),
  periodEnd: z.string().max(SHORT_TEXT_MAX),
  generatedAt: z.string().max(SHORT_TEXT_MAX),
  runCounts: z.record(runStatusSchema, z.number()),
  totalPromptTokens: z.number(),
  totalCompletionTokens: z.number(),
  totalCost: z.string().max(SHORT_TEXT_MAX).nullable(),
});
