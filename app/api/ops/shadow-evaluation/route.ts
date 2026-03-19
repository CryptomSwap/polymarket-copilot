import { NextResponse } from "next/server";
import {
  getShadowEvaluationSummary,
  getShadowCandidatesSample,
  evaluateShadowCandidates,
} from "@/lib/shadow-evaluation";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/shadow-evaluation
 *
 * Returns shadow telemetry summary: total/blocked/allowed/evaluated counts,
 * good_block, bad_block, good_allow, bad_allow, average markouts, and recent sample.
 * Query: funderAddress (optional), limit (sample size, default 50).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const funderAddress = searchParams.get("funderAddress") ?? undefined;
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10) || 50));

    const summary = await getShadowEvaluationSummary(funderAddress);
    const sample = await getShadowCandidatesSample(limit, funderAddress);

    return NextResponse.json({
      summary: {
        totalCandidates: summary.totalCandidates,
        blockedCandidates: summary.blockedCandidates,
        allowedCandidates: summary.allowedCandidates,
        evaluatedCandidates: summary.evaluatedCandidates,
        goodBlocks: summary.goodBlocks,
        badBlocks: summary.badBlocks,
        goodAllows: summary.goodAllows,
        badAllows: summary.badAllows,
        averageMarkout1h: summary.averageMarkout1h,
        averageMarkout6h: summary.averageMarkout6h,
        averageMarkout24h: summary.averageMarkout24h,
        byClassification: summary.byClassification,
      },
      sample,
    });
  } catch (error) {
    console.error("[GET /api/ops/shadow-evaluation]", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Shadow evaluation summary failed",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ops/shadow-evaluation
 *
 * Trigger evaluation of unevaluated shadow candidates older than horizon.
 * Body: { minAgeMs?: number, limit?: number } (optional).
 */
export async function POST(request: Request) {
  try {
    let body: { minAgeMs?: number; limit?: number } = {};
    try {
      const raw = await request.json();
      if (raw && typeof raw === "object") body = raw;
    } catch {
      // no body
    }
    const result = await evaluateShadowCandidates({
      minAgeMs: body.minAgeMs,
      limit: body.limit,
    });
    return NextResponse.json({
      evaluated: result.evaluated,
      errors: result.errors,
    });
  } catch (error) {
    console.error("[POST /api/ops/shadow-evaluation]", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Shadow evaluation run failed",
      },
      { status: 500 }
    );
  }
}
