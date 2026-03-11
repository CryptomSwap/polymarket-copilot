import { NextResponse } from "next/server";
import { getEffectiveGuardrailConfig, getStoredPolicyConfig, savePolicyConfig } from "@/lib/bot/policy-config";
import { z } from "zod";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  perMarketCapPct: z.number().min(0).max(100).optional(),
  perThemeCapPct: z.number().min(0).max(100).optional(),
  nearResolutionBlockHours: z.number().min(0).max(720).optional(),
  allowNearResolutionAdd: z.boolean().optional(),
  duplicateThesisThemeCapPct: z.number().min(0).max(100).optional(),
  blockStaleSync: z.boolean().optional(),
  blockUnresolvedCatalog: z.boolean().optional(),
});

/**
 * GET /api/bot/policy-config
 * Returns effective guardrail config (stored merged over defaults) and optional stored row updatedAt.
 */
export async function GET() {
  try {
    const [effective, stored] = await Promise.all([
      getEffectiveGuardrailConfig(),
      getStoredPolicyConfig(),
    ]);
    return NextResponse.json({
      ...effective,
      updatedAt: stored?.updatedAt ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/bot/policy-config]", message);
    return NextResponse.json(
      { error: "Failed to load policy config.", detail: message },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/bot/policy-config
 * Update stored policy config. Body: partial guardrail fields. Returns effective config after save.
 */
export async function PUT(request: Request) {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const effective = await savePolicyConfig(parsed.data);
    const stored = await getStoredPolicyConfig();
    return NextResponse.json({
      ...effective,
      updatedAt: stored?.updatedAt ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[PUT /api/bot/policy-config]", message);
    return NextResponse.json(
      { error: "Failed to save policy config.", detail: message },
      { status: 500 }
    );
  }
}
