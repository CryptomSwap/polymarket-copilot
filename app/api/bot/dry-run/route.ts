import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { runDryRun } from "@/lib/bot/dry-run";
import { runRegimeScan } from "@/lib/markets/regime";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/dry-run
 * Returns what the bot would consider for placement (suggest-only). No orders placed.
 * Uses current recommendations + decision snapshots + guardrails. Bot v1 is dry-run only.
 * Optional ?regime=1 to attach regime classification and signals per candidate (by marketId).
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const includeRegime = searchParams.get("regime") === "1";

  try {
    const result = await runDryRun(funder);

    if (includeRegime && result.candidates.length > 0) {
      const marketIds = [...new Set(result.candidates.map((c) => c.candidate.marketId))];
      const regimeByMarket = new Map<
        string,
        { regime: { regime: string; explanation: string }; signals: { meanReversionBuyCandidate: boolean; meanReversionSellCandidate: boolean; breakoutRisk: boolean; explanation: string[] } }
      >();
      for (const marketId of marketIds) {
        const scan = await runRegimeScan({ marketId });
        if (scan) {
          regimeByMarket.set(marketId, {
            regime: scan.regime,
            signals: scan.signals,
          });
        }
      }
      const candidatesWithRegime = result.candidates.map((c) => ({
        ...c,
        regimeSnapshot: regimeByMarket.get(c.candidate.marketId) ?? null,
      }));
      return NextResponse.json({ ...result, candidates: candidatesWithRegime });
    }

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/bot/dry-run]", message);
    return NextResponse.json(
      { error: "Dry-run failed.", detail: message },
      { status: 500 }
    );
  }
}
