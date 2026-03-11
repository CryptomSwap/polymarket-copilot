import { NextResponse } from "next/server";
import { evaluateRecommendations } from "@/lib/polymarket/recommendation-eval";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ funderAddress: z.string().optional() }).optional();

/**
 * POST /api/recommendations/evaluate
 * Evaluates recent recommendations: creates RecommendationEvaluation rows with current price and forward returns.
 */
export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema> = undefined;
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch {
    body = undefined;
  }
  const result = await evaluateRecommendations(body?.funderAddress);
  return NextResponse.json({ success: true, result });
}
