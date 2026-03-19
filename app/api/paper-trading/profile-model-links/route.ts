import { NextRequest, NextResponse } from "next/server";
import {
  createProfileModelLink,
  listProfileModelLinks,
  type ProfileModelLinkRole,
} from "@/lib/paper-trading/profile-model-links";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/profile-model-links
 * List paper-only linkages between bot profile revisions and model runs.
 * Optional query: botType, profileRevisionId.
 *
 * POST /api/paper-trading/profile-model-links
 * Create a new linkage.
 * Body: { botType, profileRevisionId, modelRunId, linkageRole, notes? }.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const botType = searchParams.get("botType") ?? undefined;
    const profileRevisionId = searchParams.get("profileRevisionId") ?? undefined;
    const links = await listProfileModelLinks({ botType, profileRevisionId });
    return NextResponse.json({ links });
  } catch (e) {
    console.error("[GET /api/paper-trading/profile-model-links]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Profile-model links fetch failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const botType = typeof body.botType === "string" ? body.botType : null;
    const profileRevisionId =
      typeof body.profileRevisionId === "string" ? body.profileRevisionId : null;
    const modelRunId = typeof body.modelRunId === "string" ? body.modelRunId : null;
    const linkageRole = body.linkageRole as ProfileModelLinkRole | undefined;

    if (!botType || !profileRevisionId || !modelRunId || !linkageRole) {
      return NextResponse.json(
        { error: "botType, profileRevisionId, modelRunId, and linkageRole are required" },
        { status: 400 }
      );
    }

    if (
      linkageRole !== "EVALUATED_WITH" &&
      linkageRole !== "INTENDED_ACTIVE" &&
      linkageRole !== "ROLLBACK_TARGET"
    ) {
      return NextResponse.json(
        { error: "linkageRole must be one of EVALUATED_WITH | INTENDED_ACTIVE | ROLLBACK_TARGET" },
        { status: 400 }
      );
    }

    const link = await createProfileModelLink({
      botType,
      profileRevisionId,
      modelRunId,
      linkageRole,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });

    return NextResponse.json({ link });
  } catch (e) {
    console.error("[POST /api/paper-trading/profile-model-links]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Profile-model link creation failed" },
      { status: 500 }
    );
  }
}

