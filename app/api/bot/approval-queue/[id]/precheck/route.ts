import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { hasStoredCredentials } from "@/lib/polymarket/auth";
import { buildOrderPreview } from "@/lib/polymarket/order-preview";
import { checkGuardrails } from "@/lib/bot/guardrails";
import { getEffectiveGuardrailConfig } from "@/lib/bot/policy-config";
import { type BotCandidate } from "@/lib/bot/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/approval-queue/[id]/precheck
 * Returns guardrail and impact preview for an APPROVED entry. No order placed; for confirmation modal only.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address." },
      { status: 400 }
    );
  }

  const funderNorm = funder.toLowerCase().trim();
  const { id } = await params;

  const entry = await prisma.approvalQueueEntry.findUnique({
    where: { id },
  });

  if (!entry || entry.funderAddress !== funderNorm) {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }

  if (entry.status !== "APPROVED") {
    return NextResponse.json(
      { error: "Precheck only for APPROVED entries.", status: entry.status },
      { status: 400 }
    );
  }

  const credentialsOk = await hasStoredCredentials();
  const connection = await prisma.connectedWallet.findFirst({ orderBy: { updatedAt: "desc" } });
  const connectionOk = Boolean(connection?.funderAddress?.trim());

  const candidate: BotCandidate = {
    recommendationId: entry.recommendationId,
    marketId: entry.marketId,
    assetId: entry.assetId,
    outcome: entry.outcome,
    side: entry.side as "BUY" | "SELL",
    limitPrice: entry.limitPrice,
    size: entry.size,
    primaryActionType: null,
    policyState: "",
    finalSuggestedSize: entry.size,
    marketTitle: entry.marketTitle,
  };

  const effectiveConfig = await getEffectiveGuardrailConfig();
  const guardrail = await checkGuardrails(funderNorm, candidate, effectiveConfig);
  const preview = await buildOrderPreview({
    funderAddress: funderNorm,
    marketId: entry.marketId,
    assetId: entry.assetId,
    outcome: entry.outcome,
    side: entry.side,
    limitPrice: entry.limitPrice,
    size: entry.size,
    recommendationId: entry.recommendationId,
  });

  return NextResponse.json({
    guardrailAllowed: guardrail.allowed,
    guardrailReason: guardrail.reason,
    guardrailFailures: guardrail.failures ?? [],
    credentialsOk,
    connectionOk,
    previewValid: preview.valid,
    riskPreview: preview.riskPreview ? {
      concentrationImpact: preview.riskPreview.concentrationImpact,
      blocked: preview.riskPreview.blocked,
      warnings: preview.riskPreview.warnings,
    } : null,
    validationErrors: preview.validationErrors ?? [],
  });
}
