import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { hasStoredCredentials } from "@/lib/polymarket/auth";
import { placeLimitOrder } from "@/lib/polymarket/trading";
import { buildOrderPreview } from "@/lib/polymarket/order-preview";
import { runPreflightChecks } from "@/lib/polymarket/preflight";
import { checkGuardrails } from "@/lib/bot/guardrails";
import { getEffectiveGuardrailConfig } from "@/lib/bot/policy-config";
import { type BotCandidate } from "@/lib/bot/types";

export const dynamic = "force-dynamic";

function requestPayloadFromEntry(entry: {
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  limitPrice: string;
  size: string;
  recommendationId: string;
}) {
  return JSON.stringify({
    marketId: entry.marketId,
    assetId: entry.assetId,
    outcome: entry.outcome,
    side: entry.side,
    limitPrice: entry.limitPrice,
    size: entry.size,
    recommendationId: entry.recommendationId,
  });
}

/**
 * POST /api/bot/approval-queue/[id]/execute
 * Manually execute an APPROVED queue entry: revalidate (guardrails, credentials, preflight) then place order.
 * Logs result to BotQueueExecutionLog. No automatic execution; operator-driven only.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const funderNorm = funder.toLowerCase().trim();
  const { id: queueEntryId } = await params;

  const entry = await prisma.approvalQueueEntry.findUnique({
    where: { id: queueEntryId },
  });

  if (!entry || entry.funderAddress !== funderNorm) {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }

  if (entry.status !== "APPROVED") {
    return NextResponse.json(
      { error: `Execution only allowed for APPROVED entries. Current status: ${entry.status}.` },
      { status: 400 }
    );
  }

  if (entry.orderIntentId) {
    return NextResponse.json(
      { error: "Already executed.", orderIntentId: entry.orderIntentId },
      { status: 400 }
    );
  }

  const existingSuccess = await prisma.botQueueExecutionLog.findFirst({
    where: { queueEntryId, resultStatus: "SUCCESS" },
  });
  if (existingSuccess) {
    return NextResponse.json(
      { error: "Already executed (log found).", orderIntentId: entry.orderIntentId },
      { status: 400 }
    );
  }

  const hasCredentials = await hasStoredCredentials();
  if (!hasCredentials) {
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: { status: "FAILED", reason: "Credentials not configured.", updatedAt: new Date() },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "FAILED",
        errorMessage: "Credentials not configured.",
      },
    });
    return NextResponse.json(
      { error: "Credentials not configured. Set API credentials in Polymarket settings." },
      { status: 400 }
    );
  }

  const connection = await prisma.connectedWallet.findFirst({ orderBy: { updatedAt: "desc" } });
  if (!connection?.funderAddress?.trim()) {
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: { status: "FAILED", reason: "Wallet connection missing.", updatedAt: new Date() },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "FAILED",
        errorMessage: "Wallet connection missing.",
      },
    });
    return NextResponse.json(
      { error: "Wallet connection missing. Connect wallet and save connection." },
      { status: 400 }
    );
  }

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
  if (!guardrail.allowed) {
    const reason = guardrail.failures?.length ? guardrail.failures.join(" ") : guardrail.reason;
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: { status: "FAILED", reason: reason ?? "Guardrails failed.", updatedAt: new Date() },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "FAILED",
        errorMessage: reason ?? guardrail.reason,
      },
    });
    return NextResponse.json(
      { error: "Revalidation failed: guardrails.", guardrailFailures: guardrail.failures, reason: guardrail.reason },
      { status: 400 }
    );
  }

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

  if (!preview.valid) {
    const err = preview.validationErrors?.join("; ") ?? "Preview invalid.";
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: { status: "FAILED", reason: err, updatedAt: new Date() },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "FAILED",
        errorMessage: err,
      },
    });
    return NextResponse.json({ error: err, validationErrors: preview.validationErrors }, { status: 400 });
  }

  if (preview.riskPreview?.blocked) {
    const err = "Order blocked by concentration/safety rules.";
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: { status: "FAILED", reason: err, updatedAt: new Date() },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "FAILED",
        errorMessage: err,
      },
    });
    return NextResponse.json({ error: err, riskPreview: preview.riskPreview }, { status: 400 });
  }

  const preflight = await runPreflightChecks({
    funderAddress: funderNorm,
    recommendationId: entry.recommendationId,
    marketId: entry.marketId,
    assetId: entry.assetId,
    limitPrice: entry.limitPrice,
    size: entry.size,
  });

  if (!preflight.passed) {
    const err = preflight.warnings?.join("; ") ?? "Preflight failed.";
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: { status: "FAILED", reason: err, updatedAt: new Date() },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "FAILED",
        errorMessage: err,
      },
    });
    return NextResponse.json(
      { error: "Preflight checks failed.", warnings: preflight.warnings },
      { status: 400 }
    );
  }

  const riskPreviewJson = preview.riskPreview ? JSON.stringify(preview.riskPreview) : undefined;
  let result;
  try {
    result = await placeLimitOrder(
      {
        funderAddress: funderNorm,
        marketId: entry.marketId,
        assetId: entry.assetId,
        outcome: entry.outcome,
        side: entry.side as "BUY" | "SELL",
        limitPrice: entry.limitPrice,
        size: entry.size,
        recommendationId: entry.recommendationId,
        riskPreviewJson,
      },
      { executionSurface: "approval_queue" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("[trading-execution-policy]")) {
      return NextResponse.json(
        { error: message },
        { status: 403 }
      );
    }
    throw err;
  }

  if (result.success && result.orderIntentId) {
    await prisma.approvalQueueEntry.update({
      where: { id: queueEntryId },
      data: {
        status: "EXECUTED",
        orderIntentId: result.orderIntentId,
        updatedAt: new Date(),
      },
    });
    await prisma.botQueueExecutionLog.create({
      data: {
        queueEntryId,
        funderAddress: funderNorm,
        idempotencyKey: entry.idempotencyKey,
        requestPayloadJson: requestPayloadFromEntry(entry),
        resultStatus: "SUCCESS",
        orderIntentId: result.orderIntentId,
      },
    });
    return NextResponse.json({
      success: true,
      orderIntentId: result.orderIntentId,
      polymarketOrderId: result.polymarketOrderId,
      executedOrderId: result.executedOrderId,
    });
  }

  const errorMsg = result.error ?? "Place failed.";
  await prisma.approvalQueueEntry.update({
    where: { id: queueEntryId },
    data: { status: "FAILED", reason: errorMsg, updatedAt: new Date() },
  });
  await prisma.botQueueExecutionLog.create({
    data: {
      queueEntryId,
      funderAddress: funderNorm,
      idempotencyKey: entry.idempotencyKey,
      requestPayloadJson: requestPayloadFromEntry(entry),
      resultStatus: "FAILED",
      errorMessage: errorMsg,
    },
  });
  return NextResponse.json(
    { error: errorMsg, orderIntentId: result.orderIntentId },
    { status: 400 }
  );
}
