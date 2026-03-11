import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import {
  getPositionThesis,
  listPositionTheses,
  upsertPositionThesis,
  THESIS_STATUSES,
  type ThesisStatus,
} from "@/lib/portfolio/position-thesis";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/position-thesis
 * Query: assetId (optional). If assetId provided, returns thesis for that position; else returns list of all theses for funder.
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
  const assetId = searchParams.get("assetId") ?? undefined;

  try {
    if (assetId) {
      const thesis = await getPositionThesis(funder, assetId);
      if (!thesis) {
        return NextResponse.json({ thesis: null });
      }
      return NextResponse.json({
        thesis: {
          id: thesis.id,
          funderAddress: thesis.funderAddress,
          assetId: thesis.assetId,
          marketId: thesis.marketId,
          entryThesis: thesis.entryThesis,
          currentThesisStatus: thesis.currentThesisStatus,
          exitReason: thesis.exitReason,
          notes: thesis.notes,
          createdAt: thesis.createdAt.toISOString(),
          updatedAt: thesis.updatedAt.toISOString(),
        },
      });
    }
    const list = await listPositionTheses(funder);
    return NextResponse.json({
      theses: list.map((t) => ({
        id: t.id,
        funderAddress: t.funderAddress,
        assetId: t.assetId,
        marketId: t.marketId,
        entryThesis: t.entryThesis,
        currentThesisStatus: t.currentThesisStatus,
        exitReason: t.exitReason,
        notes: t.notes,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/portfolio/position-thesis
 * Body: { assetId, entryThesis?, currentThesisStatus?, exitReason?, notes?, marketId? }
 * Upserts thesis for the position. Position must exist.
 */
export async function PUT(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  let body: {
    assetId: string;
    entryThesis?: string | null;
    currentThesisStatus?: string;
    exitReason?: string | null;
    notes?: string | null;
    marketId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON. Required: assetId. Optional: entryThesis, currentThesisStatus, exitReason, notes, marketId." },
      { status: 400 }
    );
  }

  const assetId = body.assetId?.trim();
  if (!assetId) {
    return NextResponse.json({ error: "assetId is required." }, { status: 400 });
  }

  const status = body.currentThesisStatus?.toLowerCase();
  if (status != null && !THESIS_STATUSES.includes(status as ThesisStatus)) {
    return NextResponse.json(
      { error: `currentThesisStatus must be one of: ${THESIS_STATUSES.join(", ")}.` },
      { status: 400 }
    );
  }

  try {
    const row = await upsertPositionThesis(funder, assetId, {
      entryThesis: body.entryThesis,
      currentThesisStatus: status as ThesisStatus | undefined,
      exitReason: body.exitReason,
      notes: body.notes,
      marketId: body.marketId,
    });
    return NextResponse.json({
      thesis: {
        id: row.id,
        funderAddress: row.funderAddress,
        assetId: row.assetId,
        marketId: row.marketId,
        entryThesis: row.entryThesis,
        currentThesisStatus: row.currentThesisStatus,
        exitReason: row.exitReason,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Position not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
