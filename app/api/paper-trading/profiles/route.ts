import { NextResponse } from "next/server";
import { getEffectiveBotProfiles } from "@/lib/paper-trading/bot-profiles";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/profiles
 * Effective paper bot profiles: code-defined profiles resolved with global config + DB overrides.
 */
export async function GET() {
  try {
    const profiles = await getEffectiveBotProfiles();
    return NextResponse.json({ profiles });
  } catch (e) {
    console.error("[GET /api/paper-trading/profiles]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Profiles fetch failed" },
      { status: 500 }
    );
  }
}

