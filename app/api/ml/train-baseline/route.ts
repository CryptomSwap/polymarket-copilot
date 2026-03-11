import { NextResponse } from "next/server";
import { trainAndPersistBaseline, type TargetLabel } from "@/lib/ml/train-and-persist";

export const dynamic = "force-dynamic";

/**
 * POST /api/ml/train-baseline
 * Train logistic regression baseline, persist MlModelRun. Body: { funderAddress?, targetLabel?: "labelPositive6h" | "labelPositive24h" }.
 */
export async function POST(request: Request) {
  try {
    let funderAddress: string | undefined;
    let targetLabel: TargetLabel = "labelPositive24h";
    try {
      const body = await request.json().catch(() => ({}));
      funderAddress = typeof body?.funderAddress === "string" ? body.funderAddress : undefined;
      if (body?.targetLabel === "labelPositive6h" || body?.targetLabel === "labelPositive24h") {
        targetLabel = body.targetLabel;
      }
    } catch {
      // use defaults
    }
    const result = await trainAndPersistBaseline(funderAddress, targetLabel);
    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error, targetLabel: result.targetLabel, datasetSize: result.datasetSize },
        { status: 400 }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/ml/train-baseline]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Training failed" },
      { status: 500 }
    );
  }
}
