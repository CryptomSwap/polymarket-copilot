import { NextRequest, NextResponse } from "next/server";
import { trainShadowModel, type ShadowTargetLabel } from "@/lib/ml/shadow-train";

export const dynamic = "force-dynamic";

/**
 * POST /api/ops/ml-shadow-train
 *
 * Trigger shadow ML training on MlShadowTrainingExample. Persists MlModelRun with modelType "logistic_regression_shadow".
 * Body: { funderAddress?, limit?, createdAfter?, createdBefore?, trainRatio?, targetLabel?: "labelGoodDecision" | "labelMissedOpportunity" }.
 */
export async function POST(request: NextRequest) {
  try {
    let body: {
      funderAddress?: string;
      limit?: number;
      createdAfter?: string;
      createdBefore?: string;
      trainRatio?: number;
      targetLabel?: ShadowTargetLabel;
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

    const targetLabel: ShadowTargetLabel =
      body.targetLabel === "labelMissedOpportunity" ? "labelMissedOpportunity" : "labelGoodDecision";

    const result = await trainShadowModel(targetLabel, {
      funderAddress: body.funderAddress,
      limit: body.limit,
      createdAfter,
      createdBefore,
      trainRatio: body.trainRatio,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          targetLabel: result.targetLabel,
          datasetSize: result.datasetSize,
        },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/ops/ml-shadow-train]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Shadow training failed" },
      { status: 500 }
    );
  }
}
