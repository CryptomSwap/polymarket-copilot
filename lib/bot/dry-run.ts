/**
 * Bot dry-run v1: build candidates from recommendations + decision, run guardrails, return result.
 * No orders placed. Suggest-only.
 */

import { prisma } from "@/lib/db";
import { checkGuardrails } from "./guardrails";
import { getEffectiveGuardrailConfig } from "./policy-config";
import {
  executionKey,
  type BotCandidate,
  type BotGuardrailConfig,
  type DryRunResult,
} from "./types";

const ALLOWED_POLICY_STATES = [
  "ALLOW_SMALL",
  "ALLOW_NORMAL",
  "ALLOW_HIGH_CONVICTION",
  "TRIM",
  "EXIT",
];

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build dry-run result: candidates from recommendations with allowed policy state, then guardrail check each.
 */
export async function runDryRun(
  funderAddress: string,
  config: Partial<BotGuardrailConfig> = {}
): Promise<DryRunResult> {
  const funder = funderAddress.toLowerCase().trim();
  const effective = await getEffectiveGuardrailConfig();
  const fullConfig: BotGuardrailConfig = { ...effective, ...config };

  const recommendations = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: {
      marketSignal: true,
      decisionSnapshots: { where: { funderAddress: funder }, take: 1 },
    },
  });

  const candidates: BotCandidate[] = [];
  for (const rec of recommendations) {
    const snapshot = rec.decisionSnapshots[0];
    if (!snapshot) continue;
    if (!ALLOWED_POLICY_STATES.includes(snapshot.policyState)) continue;
    if (rec.primaryActionType === "avoid" || rec.primaryActionType === "sync_first") continue;

    const asset = await prisma.syncedAsset.findFirst({
      where: {
        syncedMarketId: rec.marketSignal.marketId,
        outcome: rec.marketSignal.outcome,
      },
    });
    if (!asset) continue;

    const side = rec.marketSignal.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
    const price = rec.marketSignal.marketPrice;
    const size = snapshot.finalSuggestedSize;
    if (parseNum(size) <= 0 && side === "BUY") continue;

    candidates.push({
      recommendationId: rec.id,
      marketId: rec.marketSignal.marketId,
      assetId: asset.tokenId,
      outcome: rec.marketSignal.outcome,
      side,
      limitPrice: price,
      size,
      primaryActionType: rec.primaryActionType,
      policyState: snapshot.policyState,
      finalSuggestedSize: size,
      marketTitle: rec.marketSignal.marketTitle,
      marketTheme: rec.marketSignal.theme,
    });
  }

  const results: DryRunResult["candidates"] = [];
  for (const candidate of candidates) {
    const guardrail = await checkGuardrails(funder, candidate, fullConfig);
    results.push({
      candidate,
      executionKey: executionKey(candidate),
      guardrail,
    });
  }

  const allowed = results.filter((r) => r.guardrail.allowed).length;
  return {
    mode: "dry_run",
    funderAddress: funder,
    at: new Date().toISOString(),
    config: fullConfig,
    candidates: results,
    summary: {
      total: results.length,
      allowed,
      blocked: results.length - allowed,
    },
  };
}
