import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/decision/summary
 * Returns policy-state distribution, performance by policy state, setup performance profiles.
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const snapshots = await prisma.decisionPolicySnapshot.findMany({
    where: { funderAddress: funder },
    select: { policyState: true, blendedScore: true, recommendationId: true },
  });

  const policyDistribution: Record<string, number> = {};
  for (const s of snapshots) {
    policyDistribution[s.policyState] = (policyDistribution[s.policyState] ?? 0) + 1;
  }

  const outcomes = await prisma.recommendationExecutionOutcome.findMany({
    where: { funderAddress: funder },
    include: { recommendation: { include: { decisionSnapshots: { where: { funderAddress: funder }, take: 1 } } } },
  });

  const performanceByPolicy: Record<string, { count: number; winCount: number; avgReturn24h: number }> = {};
  function parseNum(s: string | null | undefined): number {
    if (s == null || s === "") return 0;
    const n = parseFloat(String(s).trim());
    return Number.isFinite(n) ? n : 0;
  }
  for (const o of outcomes) {
    const policyState = o.recommendation.decisionSnapshots[0]?.policyState ?? "UNKNOWN";
    if (!performanceByPolicy[policyState]) performanceByPolicy[policyState] = { count: 0, winCount: 0, avgReturn24h: 0 };
    performanceByPolicy[policyState].count++;
    const r24 = parseNum(o.forwardReturn24h);
    if (r24 > 0) performanceByPolicy[policyState].winCount++;
    performanceByPolicy[policyState].avgReturn24h += r24;
  }
  for (const k of Object.keys(performanceByPolicy)) {
    const p = performanceByPolicy[k];
    if (p.count > 0) p.avgReturn24h /= p.count;
  }

  const profiles = await prisma.setupPerformanceProfile.findMany({
    orderBy: { sampleCount: "desc" },
    take: 50,
  });

  const blendedScores = snapshots.map((s) => parseFloat(s.blendedScore)).filter((n) => Number.isFinite(n));
  const avgBlended = blendedScores.length > 0 ? blendedScores.reduce((a, b) => a + b, 0) / blendedScores.length : null;

  return NextResponse.json({
    policyDistribution,
    performanceByPolicy,
    setupProfiles: profiles.map((p) => ({
      signalType: p.signalType,
      category: p.category,
      theme: p.theme,
      reviewStatus: p.reviewStatus,
      sampleCount: p.sampleCount,
      actedWinRate: p.actedWinRate,
      ignoredWinRate: p.ignoredWinRate,
      avgForwardReturn6h: p.avgForwardReturn6h,
      avgForwardReturn24h: p.avgForwardReturn24h,
      overrideWinRate: p.overrideWinRate,
    })),
    snapshotCount: snapshots.length,
    avgBlendedScore: avgBlended,
  });
}
