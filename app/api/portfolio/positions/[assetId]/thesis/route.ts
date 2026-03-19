import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import {
  getPositionThesisForApi,
  upsertPositionThesis,
  THESIS_STATUSES,
  type ThesisStatus,
  type PositionThesisPayload,
} from "@/lib/portfolio/position-thesis";

export const dynamic = "force-dynamic";

const MAX_TEXT_LENGTH = 10000;

function isValidThesisPayload(body: unknown): body is PositionThesisPayload {
  if (body == null || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  if (o.entryThesis !== undefined && o.entryThesis !== null && typeof o.entryThesis !== "string") return false;
  if (o.exitReason !== undefined && o.exitReason !== null && typeof o.exitReason !== "string") return false;
  if (o.notes !== undefined && o.notes !== null && typeof o.notes !== "string") return false;
  if (o.currentThesisStatus !== undefined && o.currentThesisStatus !== null) {
    if (typeof o.currentThesisStatus !== "string") return false;
    if (!THESIS_STATUSES.includes(o.currentThesisStatus as ThesisStatus)) return false;
  }
  if (o.marketId !== undefined && o.marketId !== null && typeof o.marketId !== "string") return false;
  return true;
}

function clampString(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t === "" ? null : t.slice(0, max);
}

/**
 * GET /api/portfolio/positions/[assetId]/thesis
 * Returns thesis for the authenticated funder and assetId. If no thesis exists, returns stable empty shape.
 * 404 if the funder has no position for this assetId.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { assetId } = await params;
  const id = assetId?.trim();
  if (!id) {
    return NextResponse.json({ error: "assetId is required." }, { status: 400 });
  }

  try {
    const response = await getPositionThesisForApi(funder, id);
    if (response === null) {
      return NextResponse.json({ error: "Position not found for this asset." }, { status: 404 });
    }
    return NextResponse.json(response);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/portfolio/positions/[assetId]/thesis
 * Upserts thesis for (funder, assetId). Body: entryThesis?, currentThesisStatus?, exitReason?, notes?
 * 404 if no position. Validates payload; no cross-user access (assetId from path, funder from auth).
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { assetId } = await params;
  const id = assetId?.trim();
  if (!id) {
    return NextResponse.json({ error: "assetId is required." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON. Body may include: entryThesis, currentThesisStatus, exitReason, notes." },
      { status: 400 }
    );
  }

  if (!isValidThesisPayload(body)) {
    return NextResponse.json(
      { error: `Invalid payload. currentThesisStatus must be one of: ${THESIS_STATUSES.join(", ")}. Other fields must be strings or null.` },
      { status: 400 }
    );
  }

  const entryThesis = clampString(body.entryThesis, MAX_TEXT_LENGTH);
  const exitReason = clampString(body.exitReason, MAX_TEXT_LENGTH);
  const notes = clampString(body.notes, MAX_TEXT_LENGTH);
  const currentThesisStatus = body.currentThesisStatus != null ? (body.currentThesisStatus as ThesisStatus) : undefined;

  try {
    const row = await upsertPositionThesis(funder, id, {
      entryThesis,
      currentThesisStatus,
      exitReason,
      notes,
    });
    const response = await getPositionThesisForApi(funder, id);
    return NextResponse.json(response ?? {
      assetId: row.assetId,
      marketId: row.marketId,
      marketTitle: null,
      currentThesisStatus: row.currentThesisStatus,
      entryThesis: row.entryThesis,
      exitReason: row.exitReason,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Position not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
