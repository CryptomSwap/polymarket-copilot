import { NextRequest, NextResponse } from "next/server";
import { buildRepairPacketFromIssue, type RepairPacketInput } from "@/lib/control-plane/repair-packet";
import { getIssueById } from "@/lib/control-plane/issues";

export const dynamic = "force-dynamic";

/**
 * POST /api/issues/:id/repair-packet
 * Build bounded repair packet for Cursor runner consumption.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const issue = await getIssueById(params.id);
    if (!issue) {
      return NextResponse.json(
        {
          error: "issue_not_found",
          reason: "Repair packet generation is fail-closed and requires a current deterministic issue.",
          scope: "paper_only",
        },
        { status: 404 }
      );
    }
    const body = (await request.json().catch(() => ({}))) as RepairPacketInput;
    const packet = buildRepairPacketFromIssue(issue, body);
    return NextResponse.json({
      packet,
      note: "Paper-only bounded repair packet. Autonomous promotion and arbitrary self-editing are forbidden.",
    });
  } catch (error) {
    console.error("[POST /api/issues/:id/repair-packet]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build repair packet" },
      { status: 500 }
    );
  }
}
