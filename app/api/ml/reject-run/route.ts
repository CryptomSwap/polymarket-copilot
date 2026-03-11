import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/ml/reject-run
 * Set a model run status to REJECTED. Body: { runId: string }.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const runId = body?.runId;
    if (typeof runId !== "string") {
      return NextResponse.json({ success: false, error: "runId is required" }, { status: 400 });
    }
    const run = await prisma.mlModelRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    }
    await prisma.mlModelRun.update({
      where: { id: runId },
      data: { status: "REJECTED" },
    });
    return NextResponse.json({ success: true, runId, status: "REJECTED" });
  } catch (error) {
    console.error("[POST /api/ml/reject-run]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Reject failed" },
      { status: 500 }
    );
  }
}
