import { NextRequest, NextResponse } from "next/server";
import { markRevisionActive } from "@/lib/paper-trading/profile-revisions";

export const dynamic = "force-dynamic";

/**
 * POST /api/paper-trading/profile-revisions/promote
 * Explicit paper-only promotion of a bot profile revision to ACTIVE.
 * Body: { revisionId, demotePreviousTo?: "STAGED" | "ARCHIVED" }.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const revisionId = typeof body.revisionId === "string" ? body.revisionId : null;
    if (!revisionId) {
      return NextResponse.json(
        { error: "revisionId is required" },
        { status: 400 }
      );
    }
    const demotePreviousTo =
      body.demotePreviousTo === "STAGED" || body.demotePreviousTo === "ARCHIVED"
        ? body.demotePreviousTo
        : "ARCHIVED";

    const result = await markRevisionActive({ revisionId, demotePreviousTo });
    return NextResponse.json({ promoted: result.promoted, demoted: result.demoted });
  } catch (e) {
    console.error("[POST /api/paper-trading/profile-revisions/promote]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Profile revision promotion failed" },
      { status: 500 }
    );
  }
}

