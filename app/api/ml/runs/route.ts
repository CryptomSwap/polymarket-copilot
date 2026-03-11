import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/ml/runs
 * List recent ML model runs. Query: limit (default 20).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
    const runs = await prisma.mlModelRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const runsWithMetrics = runs.map((r) => ({
      id: r.id,
      modelType: r.modelType,
      targetLabel: r.targetLabel,
      featureSetName: r.featureSetName,
      status: r.status ?? "TRAINED",
      trainCount: r.trainCount,
      validationCount: r.validationCount,
      trainedFrom: r.trainedFrom?.toISOString() ?? null,
      trainedTo: r.trainedTo?.toISOString() ?? null,
      validatedFrom: r.validatedFrom?.toISOString() ?? null,
      validatedTo: r.validatedTo?.toISOString() ?? null,
      leakageCheckPassed: r.leakageCheckPassed,
      metricsJson: r.metricsJson,
      artifactPath: r.artifactPath,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return NextResponse.json({ runs: runsWithMetrics });
  } catch (error) {
    console.error("[GET /api/ml/runs]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list runs" },
      { status: 500 }
    );
  }
}
