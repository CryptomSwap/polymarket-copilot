import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const RUNTIME_CONTROL_ID = "default";

/**
 * POST /api/ops/runtime/kill-switch/clear
 * Requests the worker to clear the global kill switch (re-enable automation for the current session).
 * The worker polls RuntimeControl and will call clearGlobalStop() then clear the flag.
 * Use for controlled paper sessions only; no effect on live (execution policy remains fail-closed).
 */
export async function POST() {
  try {
    await prisma.runtimeControl.upsert({
      where: { id: RUNTIME_CONTROL_ID },
      create: {
        id: RUNTIME_CONTROL_ID,
        clearGlobalStopRequested: true,
        updatedAt: new Date(),
      },
      update: {
        clearGlobalStopRequested: true,
        updatedAt: new Date(),
      },
    });
    return NextResponse.json({
      ok: true,
      message: "Clear global stop requested; worker will apply on next poll.",
    });
  } catch (err) {
    console.error("[api/ops/runtime/kill-switch/clear]", err);
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
}
