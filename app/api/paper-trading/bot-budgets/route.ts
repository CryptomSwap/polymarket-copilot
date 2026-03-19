import { NextRequest, NextResponse } from "next/server";
import { computeBotBudgets, BOT_BUDGET_ALLOCATOR_VERSION } from "@/lib/paper-trading/bot-budget-allocator";
import { enablePaperBotBudgetAllocatorV1 } from "@/lib/ml/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/bot-budgets
 * Read-only view of current paper-only bot budget allocator decisions.
 * Query: lookbackDays (optional, default 30).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lookbackStr = searchParams.get("lookbackDays");
    const lookbackDays = (() => {
      if (!lookbackStr) return 30;
      const n = parseInt(lookbackStr, 10);
      return Number.isFinite(n) && n > 0 && n <= 365 ? n : 30;
    })();

    const budgets = await computeBotBudgets({ lookbackDays });

    return NextResponse.json({
      allocatorVersion: BOT_BUDGET_ALLOCATOR_VERSION,
      featureFlagEnabled: enablePaperBotBudgetAllocatorV1(),
      lookbackDays,
      budgets,
    });
  } catch (e) {
    console.error("[GET /api/paper-trading/bot-budgets]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Bot budget allocator failed" },
      { status: 500 }
    );
  }
}

