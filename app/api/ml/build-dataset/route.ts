import { NextResponse } from "next/server";
import { buildDataset } from "@/lib/ml/dataset";

export const dynamic = "force-dynamic";

/**
 * POST /api/ml/build-dataset
 * Build ML training examples from recommendations with evaluations. Optional body: { funderAddress }.
 */
export async function POST(request: Request) {
  try {
    let funderAddress: string | undefined;
    try {
      const body = await request.json().catch(() => ({}));
      funderAddress = typeof body?.funderAddress === "string" ? body.funderAddress : undefined;
    } catch {
      funderAddress = undefined;
    }
    const result = await buildDataset(funderAddress);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("[POST /api/ml/build-dataset]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Build failed" },
      { status: 500 }
    );
  }
}
