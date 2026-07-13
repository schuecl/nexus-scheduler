import { z } from "zod";

// Internal cost computation rates (§8) — no external billing API exists
// in an air-gapped deployment, so an admin sets these directly. Rates
// are per-million-tokens, matching how the Worker's costCalculator.ts
// applies them.
export const createCostRateSchema = z.object({
  agentId: z.string().min(1).optional(), // omitted = global default rate
  promptRatePerMillion: z.coerce.number().nonnegative(),
  completionRatePerMillion: z.coerce.number().nonnegative(),
  effectiveFrom: z.string().datetime().optional(), // defaults to now server-side
});
export type CreateCostRateInput = z.infer<typeof createCostRateSchema>;

export const updateCostRateSchema = z.object({
  agentId: z.string().min(1).nullable().optional(),
  promptRatePerMillion: z.coerce.number().nonnegative().optional(),
  completionRatePerMillion: z.coerce.number().nonnegative().optional(),
  effectiveFrom: z.string().datetime().optional(),
});
export type UpdateCostRateInput = z.infer<typeof updateCostRateSchema>;
