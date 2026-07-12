import { Prisma } from "@nexus-scheduler/shared/prisma";
import { prisma } from "./db.js";

// Cost is computed from tracked token counts using admin-configured
// rates, since this deployment is offline/air-gapped with no external
// billing API to pull real costs from (REQUIREMENTS.md §8). Uses the
// rate *in effect at run time*, not the latest rate, so historical costs
// don't shift if rates change later.
export async function computeCost(
  agentId: string,
  promptTokens: number,
  completionTokens: number,
  asOf: Date,
): Promise<Prisma.Decimal | null> {
  const rate =
    (await prisma.costRate.findFirst({
      where: { agentId, effectiveFrom: { lte: asOf } },
      orderBy: { effectiveFrom: "desc" },
    })) ??
    (await prisma.costRate.findFirst({
      where: { agentId: null, effectiveFrom: { lte: asOf } },
      orderBy: { effectiveFrom: "desc" },
    }));

  if (!rate) {
    return null; // "not costed" — no rate configured yet (§8)
  }

  const promptCost = rate.promptRatePerMillion.mul(promptTokens).div(1_000_000);
  const completionCost = rate.completionRatePerMillion.mul(completionTokens).div(1_000_000);
  return promptCost.add(completionCost);
}
