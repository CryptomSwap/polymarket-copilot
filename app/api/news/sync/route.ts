import { NextResponse } from "next/server";
import { runNewsSync } from "@/lib/news/sync";

export const dynamic = "force-dynamic";

/**
 * POST /api/news/sync
 * Run full news pipeline: fetch enabled sources, ingest, dedupe, link to markets, compute features, fill summaries.
 */
export async function POST() {
  try {
    const result = await runNewsSync();
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[POST /api/news/sync]", error);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
