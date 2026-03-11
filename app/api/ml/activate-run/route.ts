import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/ml/activate-run
 * Set run to ACTIVE and demote any current ACTIVE run to VALIDATED. Only one ACTIVE at a time. Body: { runId: string }.
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
    const currentActive = await prisma.mlModelRun.findMany({
      where: { status: "ACTIVE" },
    });
    for (const r of currentActive) {
      if (r.id !== runId) {
        await prisma.mlModelRun.update({
          where: { id: r.id },
          data: { status: "VALIDATED" },
        });
      }
    }
    await prisma.mlModelRun.update({
      where: { id: runId },
      data: { status: "ACTIVE" },
    });
    return NextResponse.json({ success: true, runId, status: "ACTIVE" });
  } catch (error) {
    console.error("[POST /api/ml/activate-run]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Activate failed" },
      { status: 500 }
    );
  }
}
