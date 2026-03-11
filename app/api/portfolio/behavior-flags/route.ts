import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/behavior-flags
 * Returns behavior/risk flags for the connected funder.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }
  const flags = await prisma.behaviorFlag.findMany({
    where: { funderAddress: funder },
    orderBy: [{ createdAt: "desc" }],
    take: 50,
  });
  return NextResponse.json({
    funderAddress: funder,
    flags: flags.map((f) => ({
      id: f.id,
      type: f.type,
      severity: f.severity,
      marketTitle: f.marketTitle,
      description: f.description,
      metadata: f.metadata,
      createdAt: f.createdAt.toISOString(),
    })),
  });
}
