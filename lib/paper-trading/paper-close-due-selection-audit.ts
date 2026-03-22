/**
 * Live DB audit: paper close-due Prisma filter vs actual PaperTrade rows (read-only).
 */

import { prisma } from "@/lib/db";
import { paperCloseDueBefore, PAPER_CLOSE_HORIZON_MS } from "./paper-close-helpers";
import { normalizeCloseTickResult, type NormalizedCloseTickResult } from "./normalize-close-tick-result";

const DUE_FILTER_DESCRIPTION =
  '{ status: "open", entryTime: { lte: horizonEnd } } where horizonEnd = now - PAPER_CLOSE_HORIZON_MS (12h)';

export interface PaperCloseDueSelectionAudit {
  generatedAt: string;
  horizonMs: number;
  horizonEndIso: string;
  dueFilterDescription: string;
  counts: {
    openTotal: number | null;
    dueByEntryTimeLteHorizonEnd: number | null;
    openNotYetDueByEntryTime: number | null;
    /** Same horizon cutoff applied to createdAt (diagnostic only; engine does not use this). */
    wouldBeDueIfUsingCreatedAtInstead: number | null;
  };
  paperTradeFieldsReferenced: string[];
  mismatchExplanation: string;
  rootCauseFromPersistedCloseResult: {
    lastCloseTickAt: string | null;
    normalized: NormalizedCloseTickResult;
    interpretation: string;
  };
  sampleOpenTrades: Array<{
    id: string;
    status: string;
    entryTime: string;
    createdAt: string;
    ageHoursByEntry: number;
    ageHoursByCreated: number;
    dueByEngineRule: boolean;
    botType: string;
    assetId: string;
  }>;
  /** Trades that are open but not due by entryTime (first 10 by entryTime desc among "not due"). */
  sampleOpenNotDue: Array<{
    id: string;
    entryTime: string;
    createdAt: string;
    ageHoursByEntry: number;
    reasonExcluded: string;
  }>;
}

function hoursBetween(older: Date, newer: Date): number {
  return (newer.getTime() - older.getTime()) / (60 * 60 * 1000);
}

export async function runPaperCloseDueSelectionAudit(): Promise<PaperCloseDueSelectionAudit> {
  const now = new Date();
  const horizonMs = PAPER_CLOSE_HORIZON_MS;
  const horizonEnd = paperCloseDueBefore(now, horizonMs);

  try {
  const [openTotal, dueByEntry, openRows, state] = await Promise.all([
    prisma.paperTrade.count({ where: { status: "open" } }),
    prisma.paperTrade.count({
      where: { status: "open", entryTime: { lte: horizonEnd } },
    }),
    prisma.paperTrade.findMany({
      where: { status: "open" },
      select: {
        id: true,
        status: true,
        entryTime: true,
        createdAt: true,
        assetId: true,
        botType: true,
      },
      orderBy: { entryTime: "asc" },
      take: 30,
    }),
    prisma.paperTradingState.findUnique({
      where: { id: "default" },
      select: { lastCloseTickAt: true, lastCloseTickResultJson: true },
    }),
  ]);

  const wouldBeDueCreated = await prisma.paperTrade.count({
    where: { status: "open", createdAt: { lte: horizonEnd } },
  });

  let parsedClose: Record<string, unknown> | null = null;
  if (state?.lastCloseTickResultJson) {
    try {
      parsedClose = JSON.parse(state.lastCloseTickResultJson) as Record<string, unknown>;
    } catch {
      parsedClose = null;
    }
  }
  const normalized = normalizeCloseTickResult(parsedClose);

  const sampleOpenTrades = openRows.slice(0, 15).map((r) => {
    const dueByEngine = r.entryTime.getTime() <= horizonEnd.getTime();
    return {
      id: r.id,
      status: r.status,
      entryTime: r.entryTime.toISOString(),
      createdAt: r.createdAt.toISOString(),
      ageHoursByEntry: hoursBetween(r.entryTime, now),
      ageHoursByCreated: hoursBetween(r.createdAt, now),
      dueByEngineRule: dueByEngine,
      botType: r.botType,
      assetId: r.assetId.slice(0, 20) + (r.assetId.length > 20 ? "…" : ""),
    };
  });

  const notDueRows = await prisma.paperTrade.findMany({
    where: { status: "open", entryTime: { gt: horizonEnd } },
    select: { id: true, entryTime: true, createdAt: true },
    orderBy: { entryTime: "asc" },
    take: 10,
  });

  const sampleOpenNotDue = notDueRows.map((r) => ({
    id: r.id,
    entryTime: r.entryTime.toISOString(),
    createdAt: r.createdAt.toISOString(),
    ageHoursByEntry: hoursBetween(r.entryTime, now),
    reasonExcluded: `entryTime (${r.entryTime.toISOString()}) > horizonEnd (${horizonEnd.toISOString()}) — open < 12h by engine clock`,
  }));

  let interpretation =
    "If dueByEntryTimeLteHorizonEnd > 0 but trades stay open, the running closePaperTradesAt12h build is likely pre-fix (skips updates when exit snapshot missing). Deploy engine with resolvePaperTradeCloseExitPrice + unconditional close.";
  if (openTotal != null && dueByEntry != null && dueByEntry === 0 && openTotal > 0) {
    interpretation =
      "All open trades have entryTime within the last 12h (by server clock). None are due yet; closed count 0 is expected until they age.";
  }
  if (normalized.legacyShape && normalized.dueCount != null && normalized.dueCount > 0 && normalized.closed === 0) {
    interpretation =
      "Persisted close result is legacy shape with many errors and closed=0: due trades WERE selected; old code refused to close without a snapshot price. Deploy fixed close path.";
  }
  if (normalized.parseFailed) {
    interpretation =
      "lastCloseTickResultJson is not valid JSON (truncated?). Diagnostics fields may be blank; fix persistence size or repair JSON.";
  }

  const mismatchParts: string[] = [];
  if (wouldBeDueCreated !== dueByEntry) {
    mismatchParts.push(
      `createdAt-based due count (${wouldBeDueCreated}) ≠ entryTime-based (${dueByEntry}). Engine uses entryTime only.`
    );
  }
  if (openTotal > 0 && dueByEntry === 0) {
    mismatchParts.push("Every open row has entryTime newer than horizonEnd — none match the due filter.");
  }
  if (normalized.legacyShape) {
    mismatchParts.push(
      "Persisted lastCloseTickResultJson lacks dueCount/openTotalCount (legacy). Diagnostics must normalize or deployment must run new engine."
    );
  }

  return {
    generatedAt: now.toISOString(),
    horizonMs,
    horizonEndIso: horizonEnd.toISOString(),
    dueFilterDescription: DUE_FILTER_DESCRIPTION,
    counts: {
      openTotal,
      dueByEntryTimeLteHorizonEnd: dueByEntry,
      openNotYetDueByEntryTime: openTotal - dueByEntry,
      wouldBeDueIfUsingCreatedAtInstead: wouldBeDueCreated,
    },
    paperTradeFieldsReferenced: ["status", "entryTime", "entryPrice", "marketId", "assetId", "side", "metadataJson"],
    mismatchExplanation:
      mismatchParts.length > 0
        ? mismatchParts.join(" ")
        : "No entryTime vs createdAt mismatch for due set; filter is consistent with schema.",
    rootCauseFromPersistedCloseResult: {
      lastCloseTickAt: state?.lastCloseTickAt?.toISOString() ?? null,
      normalized,
      interpretation,
    },
    sampleOpenTrades,
    sampleOpenNotDue,
  };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      generatedAt: now.toISOString(),
      horizonMs,
      horizonEndIso: horizonEnd.toISOString(),
      dueFilterDescription: DUE_FILTER_DESCRIPTION,
      counts: {
        openTotal: null,
        dueByEntryTimeLteHorizonEnd: null,
        openNotYetDueByEntryTime: null,
        wouldBeDueIfUsingCreatedAtInstead: null,
      },
      paperTradeFieldsReferenced: ["status", "entryTime", "entryPrice", "marketId", "assetId", "side", "metadataJson"],
      mismatchExplanation: "Database unavailable for live counts: " + msg,
      rootCauseFromPersistedCloseResult: {
        lastCloseTickAt: null,
        normalized: normalizeCloseTickResult(null),
        interpretation:
          "Re-run this report with DATABASE_URL reachable. Use repo file paper-diagnostics-raw.json offline: legacy lastCloseTickResult with many 'No 12h price' errors proves due rows were selected; deploy fixed closePaperTradesAt12h.",
      },
      sampleOpenTrades: [],
      sampleOpenNotDue: [],
    };
  }
}
