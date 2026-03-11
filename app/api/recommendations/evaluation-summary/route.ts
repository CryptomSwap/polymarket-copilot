import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/recommendations/evaluation-summary
 * Returns recommendation performance: win rate by action, avg edge by signal type, outcome summary.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const recs = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: { marketSignal: true, evaluations: true, review: true },
  });

  const byAction: Record<string, { total: number; positive: number; edges: number[] }> = {};
  const bySignalType: Record<string, { count: number; edges: number[] }> = {};
  const byReviewStatus: Record<string, { count: number; edges: number[]; evalCount: number; evalPositive: number }> = {};
  let totalEvaluations = 0;
  let totalPositive = 0;

  for (const r of recs) {
    const edge = parseFloat(r.marketSignal.edge);
    const action = r.action;
    const signalType = r.marketSignal.signalType;
    const reviewStatus = r.review?.status ?? "NEW";

    if (!byAction[action]) byAction[action] = { total: 0, positive: 0, edges: [] };
    byAction[action].total++;
    byAction[action].edges.push(edge);

    if (!bySignalType[signalType]) bySignalType[signalType] = { count: 0, edges: [] };
    bySignalType[signalType].count++;
    bySignalType[signalType].edges.push(edge);

    if (!byReviewStatus[reviewStatus]) byReviewStatus[reviewStatus] = { count: 0, edges: [], evalCount: 0, evalPositive: 0 };
    byReviewStatus[reviewStatus].count++;
    byReviewStatus[reviewStatus].edges.push(edge);
    for (const e of r.evaluations) {
      byReviewStatus[reviewStatus].evalCount++;
      if (e.wasPositive) byReviewStatus[reviewStatus].evalPositive++;
    }

    for (const e of r.evaluations) {
      totalEvaluations++;
      if (e.wasPositive) totalPositive++;
    }
  }

  const winRateByAction: Record<string, { winRate: number; count: number; avgEdge: number }> = {};
  for (const [action, data] of Object.entries(byAction)) {
    const evals = recs.filter((r) => r.action === action).flatMap((r) => r.evaluations);
    const positive = evals.filter((e) => e.wasPositive === true).length;
    winRateByAction[action] = {
      winRate: evals.length > 0 ? positive / evals.length : 0,
      count: evals.length,
      avgEdge: data.edges.length > 0 ? data.edges.reduce((a, b) => a + b, 0) / data.edges.length : 0,
    };
  }

  const avgEdgeBySignalType: Record<string, { avgEdge: number; count: number }> = {};
  for (const [st, data] of Object.entries(bySignalType)) {
    avgEdgeBySignalType[st] = {
      count: data.count,
      avgEdge:
        data.edges.length > 0 ? data.edges.reduce((a, b) => a + b, 0) / data.edges.length : 0,
    };
  }

  const countByReviewStatus: Record<string, number> = {};
  const avgEdgeByReviewStatus: Record<string, number> = {};
  const approvedVsRejected: { approved: { evalCount: number; winRate: number }; rejected: { evalCount: number; winRate: number } } = {
    approved: { evalCount: 0, winRate: 0 },
    rejected: { evalCount: 0, winRate: 0 },
  };
  const evaluatedByReviewed: { reviewed: { total: number; positive: number }; notReviewed: { total: number; positive: number } } = {
    reviewed: { total: 0, positive: 0 },
    notReviewed: { total: 0, positive: 0 },
  };

  for (const [status, data] of Object.entries(byReviewStatus)) {
    countByReviewStatus[status] = data.count;
    avgEdgeByReviewStatus[status] = data.edges.length > 0 ? data.edges.reduce((a, b) => a + b, 0) / data.edges.length : 0;
    if (status === "APPROVED") {
      approvedVsRejected.approved.evalCount = data.evalCount;
      approvedVsRejected.approved.winRate = data.evalCount > 0 ? data.evalPositive / data.evalCount : 0;
    } else if (status === "REJECTED") {
      approvedVsRejected.rejected.evalCount = data.evalCount;
      approvedVsRejected.rejected.winRate = data.evalCount > 0 ? data.evalPositive / data.evalCount : 0;
    }
    const isReviewed = ["REVIEWED", "APPROVED", "REJECTED", "ARCHIVED"].includes(status);
    if (isReviewed) {
      evaluatedByReviewed.reviewed.total += data.evalCount;
      evaluatedByReviewed.reviewed.positive += data.evalPositive;
    } else {
      evaluatedByReviewed.notReviewed.total += data.evalCount;
      evaluatedByReviewed.notReviewed.positive += data.evalPositive;
    }
  }

  return NextResponse.json({
    funderAddress: funder,
    totalEvaluations,
    winRateOverall: totalEvaluations > 0 ? totalPositive / totalEvaluations : 0,
    winRateByAction,
    avgEdgeBySignalType,
    countByReviewStatus,
    avgEdgeByReviewStatus,
    approvedVsRejected,
    evaluatedByReviewed: {
      reviewed: {
        total: evaluatedByReviewed.reviewed.total,
        winRate: evaluatedByReviewed.reviewed.total > 0 ? evaluatedByReviewed.reviewed.positive / evaluatedByReviewed.reviewed.total : 0,
      },
      notReviewed: {
        total: evaluatedByReviewed.notReviewed.total,
        winRate: evaluatedByReviewed.notReviewed.total > 0 ? evaluatedByReviewed.notReviewed.positive / evaluatedByReviewed.notReviewed.total : 0,
      },
    },
  });
}
