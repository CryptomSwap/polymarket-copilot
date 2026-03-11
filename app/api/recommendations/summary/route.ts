import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

const PRIMARY_ACTION_ORDER = [
  "add",
  "review_existing",
  "trim",
  "hedge",
  "avoid",
  "monitor",
  "sync_first",
] as const;

/**
 * GET /api/recommendations/summary
 * Returns counts by primaryActionType (unfiltered) for the connected funder.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const recs = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    select: { primaryActionType: true },
  });

  const byPrimaryAction: Record<string, number> = {};
  for (const key of PRIMARY_ACTION_ORDER) {
    byPrimaryAction[key] = 0;
  }
  let other = 0;
  for (const r of recs) {
    const t = (r.primaryActionType ?? "unknown").toLowerCase();
    if (PRIMARY_ACTION_ORDER.includes(t as (typeof PRIMARY_ACTION_ORDER)[number])) {
      byPrimaryAction[t]++;
    } else {
      other++;
    }
  }
  if (other > 0) byPrimaryAction["unknown"] = other;

  return NextResponse.json({
    byPrimaryAction,
    total: recs.length,
  });
}
