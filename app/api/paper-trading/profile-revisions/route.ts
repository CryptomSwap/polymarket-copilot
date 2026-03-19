import { NextRequest, NextResponse } from "next/server";
import {
  listProfileRevisions,
  registerProfileRevision,
} from "@/lib/paper-trading/profile-revisions";
import { getEffectiveBotProfiles, type EffectiveBotProfile } from "@/lib/paper-trading/bot-profiles";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/profile-revisions
 * List paper-only bot profile revisions. Optional query: botType.
 *
 * POST /api/paper-trading/profile-revisions
 * Register a new revision based on current effective profile snapshot.
 * Body: { botType, revisionKey?, status?, notes?, rollbackTargetRevision? }.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const botType = searchParams.get("botType") ?? undefined;
    const revisions = await listProfileRevisions(botType ?? undefined);
    return NextResponse.json({ revisions });
  } catch (e) {
    console.error("[GET /api/paper-trading/profile-revisions]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Profile revisions fetch failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const botType = typeof body.botType === "string" ? body.botType : null;
    if (!botType) {
      return NextResponse.json(
        { error: "botType is required" },
        { status: 400 }
      );
    }

    const profiles = await getEffectiveBotProfiles();
    const profile: EffectiveBotProfile | undefined = profiles.find((p) => p.botType === botType);
    if (!profile) {
      return NextResponse.json(
        { error: `No effective profile found for botType=${botType}` },
        { status: 404 }
      );
    }

    const revision = await registerProfileRevision({
      profile,
      revisionKey: typeof body.revisionKey === "string" ? body.revisionKey : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      rollbackTargetRevision:
        typeof body.rollbackTargetRevision === "string" ? body.rollbackTargetRevision : undefined,
    });

    return NextResponse.json({ revision });
  } catch (e) {
    console.error("[POST /api/paper-trading/profile-revisions]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Profile revision registration failed" },
      { status: 500 }
    );
  }
}

