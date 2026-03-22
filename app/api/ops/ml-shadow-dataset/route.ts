import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { persistShadowTrainingExamples } from "@/lib/ml/shadow-dataset";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/ml-shadow-dataset
 *
 * Returns counts/status and recent MlShadowTrainingExample rows.
 * Query: funderAddress (optional), limit (default 10 for recent examples).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const funderAddress = searchParams.get("funderAddress") ?? undefined;
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") ?? "10", 10) || 10));

    const where = funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {};

    const [totalShadowCandidates, totalExamples, recentExamples] = await Promise.all([
      prisma.shadowCandidate.count({ where: funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {} }),
      prisma.mlShadowTrainingExample.count({ where }),
      prisma.mlShadowTrainingExample.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          shadowCandidateId: true,
          funderAddress: true,
          assetId: true,
          side: true,
          wasBlocked: true,
          wasSubmitted: true,
          outcomeClassification: true,
          createdAt: true,
        },
      }),
    ]);

    const evaluatedCount = await prisma.shadowCandidate.count({
      where: { ...(funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {}), evaluatedAt: { not: null } },
    });

    return NextResponse.json({
      status: "ok",
      counts: {
        totalShadowCandidates,
        evaluatedShadowCandidates: evaluatedCount,
        totalMlShadowExamples: totalExamples,
      },
      recentExamples: recentExamples.map((e) => ({
        id: e.id,
        shadowCandidateId: e.shadowCandidateId,
        funderAddress: e.funderAddress,
        assetId: e.assetId,
        side: e.side,
        wasBlocked: e.wasBlocked,
        wasSubmitted: e.wasSubmitted,
        outcomeClassification: e.outcomeClassification,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[GET /api/ops/ml-shadow-dataset]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ML shadow dataset status failed" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ops/ml-shadow-dataset
 *
 * Trigger dataset build: convert eligible ShadowCandidates to MlShadowTrainingExample.
 * Body: { funderAddress?: string, limit?: number, createdAfter?: string (ISO), createdBefore?: string (ISO), evaluatedOnly?: boolean, dryRun?: boolean }.
 */
export async function POST(request: NextRequest) {
  try {
    let body: {
      funderAddress?: string;
      limit?: number;
      createdAfter?: string;
      createdBefore?: string;
      evaluatedOnly?: boolean;
      dryRun?: boolean;
      datasetCandidateSelection?: "sequential" | "prefer_missing_12h_label";
    } = {};
    try {
      const raw = await request.json();
      if (raw && typeof raw === "object") body = raw;
    } catch {
      // no body
    }

    const createdAfter = body.createdAfter ? new Date(body.createdAfter) : undefined;
    const createdBefore = body.createdBefore ? new Date(body.createdBefore) : undefined;
    if (body.createdAfter && isNaN(createdAfter!.getTime())) {
      return NextResponse.json({ error: "Invalid createdAfter date" }, { status: 400 });
    }
    if (body.createdBefore && isNaN(createdBefore!.getTime())) {
      return NextResponse.json({ error: "Invalid createdBefore date" }, { status: 400 });
    }

    const envDefaultLimit = parseInt(process.env.SHADOW_DATASET_BUILD_JOB_LIMIT ?? "3000", 10);
    const defaultLimit =
      Number.isFinite(envDefaultLimit) && envDefaultLimit > 0 ? Math.min(envDefaultLimit, 50_000) : 3000;
    const requestedLimit = body.limit ?? defaultLimit;
    const limit = Math.min(50_000, Math.max(1, requestedLimit));
    const envSel = (process.env.SHADOW_DATASET_CANDIDATE_SELECTION ?? "").toLowerCase().trim();
    const datasetCandidateSelection =
      body.datasetCandidateSelection === "sequential"
        ? ("sequential" as const)
        : body.datasetCandidateSelection === "prefer_missing_12h_label"
          ? ("prefer_missing_12h_label" as const)
          : envSel === "sequential"
            ? ("sequential" as const)
            : ("prefer_missing_12h_label" as const);

    const result = await persistShadowTrainingExamples({
      funderAddress: body.funderAddress,
      limit,
      createdAfter,
      createdBefore,
      evaluatedOnly: body.evaluatedOnly !== false,
      dryRun: body.dryRun === true,
      datasetCandidateSelection,
    });

    return NextResponse.json({
      examplesBuilt: result.examplesBuilt,
      examplesSkipped: result.examplesSkipped,
      persisted: result.persisted,
      errors: result.errors,
    });
  } catch (error) {
    console.error("[POST /api/ops/ml-shadow-dataset]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ML shadow dataset build failed" },
      { status: 500 }
    );
  }
}
