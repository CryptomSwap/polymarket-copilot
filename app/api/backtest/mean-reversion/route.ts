import { NextResponse } from "next/server";
import { runBacktestFromDb } from "@/lib/backtest";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  marketIds: z.array(z.string()).optional(),
  targetProfitPct: z.number().min(0).max(1).optional(),
  maxHoldHours: z.number().min(1).optional(),
  minLiquidity: z.number().min(0).max(1).optional(),
  nearResolutionHours: z.number().min(0).optional(),
  rollingWindowHours: z.number().min(1).optional(),
  entryNearLowThreshold: z.number().min(0).max(1).optional(),
  exitNearHighThreshold: z.number().min(0).max(1).optional(),
});

/**
 * POST /api/backtest/mean-reversion
 * Run mean-reversion strategy backtest over MarketPriceSnapshot data.
 * Body: { startDate, endDate, marketIds?, targetProfitPct?, maxHoldHours?, ... }
 * Returns { config, trades, metrics, runAt }. No live execution.
 */
export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid body.", detail: e instanceof Error ? e.message : "" },
      { status: 400 }
    );
  }

  try {
    const result = await runBacktestFromDb({
      startDate: body.startDate,
      endDate: body.endDate,
      marketIds: body.marketIds,
      targetProfitPct: body.targetProfitPct,
      maxHoldHours: body.maxHoldHours,
      minLiquidity: body.minLiquidity,
      nearResolutionHours: body.nearResolutionHours,
      rollingWindowHours: body.rollingWindowHours,
      entryNearLowThreshold: body.entryNearLowThreshold,
      exitNearHighThreshold: body.exitNearHighThreshold,
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/backtest/mean-reversion]", message);
    return NextResponse.json(
      { error: "Backtest failed.", detail: message },
      { status: 500 }
    );
  }
}
