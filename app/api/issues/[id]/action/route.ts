import { NextRequest, NextResponse } from "next/server";
import { getIssueById } from "@/lib/control-plane/issues";
import { decideIssueAction } from "@/lib/control-plane/action-policy";

export const dynamic = "force-dynamic";

/**
 * GET /api/issues/:id/action
 * Resolve current issue and return deterministic next-action policy decision.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const lookbackDaysRaw = Number(searchParams.get("lookbackDays") ?? "14");
    const lookbackDays = Number.isFinite(lookbackDaysRaw)
      ? Math.max(1, Math.min(90, Math.floor(lookbackDaysRaw)))
      : 14;
    const issue = await getIssueById(params.id, lookbackDays);
    if (!issue) {
      return NextResponse.json(
        {
          error: "issue_not_found",
          reason: "Issue is not present in current deterministic audit output.",
          scope: "paper_only",
        },
        { status: 404 }
      );
    }
    const decision = decideIssueAction(issue);
    return NextResponse.json(decision);
  } catch (error) {
    console.error("[GET /api/issues/:id/action]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Issue action resolution failed" },
      { status: 500 }
    );
  }
}
