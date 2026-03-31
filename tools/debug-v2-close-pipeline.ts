/**
 * Read-only V2 close-pipeline diagnostic for open PaperTrade rows.
 * Run: npx tsx tools/debug-v2-close-pipeline.ts
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { resolveSnapshotMarketIds } from "../lib/polymarket/market-price-snapshot-lookup";

type CloseBlockReason = "not_due" | "missing_exit_snapshot" | "close_logic_not_triggered" | "unknown";

type OpenV2Row = {
  id: string;
  marketId: string;
  assetId: string;
  entryTime: Date;
  entryPrice: string;
  dedupeKey: string;
};

type DiagnosticRow = {
  id: string;
  entryTime: Date;
  ageMinutes: number;
  expectedClose: boolean;
  hasExitSnapshot: boolean;
  closeBlockReason: CloseBlockReason;
};

function resolvePaperCloseMaxHoldHours(): number {
  const fallback = 12;
  const raw = process.env.PAPER_TRADING_MAX_HOLD_HOURS?.trim();
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function hasAnyExitSnapshot(marketId: string, assetId: string, horizonAt: Date): Promise<boolean> {
  const marketIds = await resolveSnapshotMarketIds(marketId);
  if (marketIds.length === 0) return false;

  const lte = await prisma.marketPriceSnapshot.findFirst({
    where: {
      marketId: { in: marketIds },
      assetId,
      capturedAt: { lte: horizonAt },
    },
    orderBy: { capturedAt: "desc" },
    select: { price: true },
  });
  if (lte && Number.isFinite(parseFloat(String(lte.price))) && parseFloat(String(lte.price)) > 0) return true;

  const gte = await prisma.marketPriceSnapshot.findFirst({
    where: {
      marketId: { in: marketIds },
      assetId,
      capturedAt: { gte: horizonAt },
    },
    orderBy: { capturedAt: "asc" },
    select: { price: true },
  });
  if (gte && Number.isFinite(parseFloat(String(gte.price))) && parseFloat(String(gte.price)) > 0) return true;

  const latest = await prisma.marketPriceSnapshot.findFirst({
    where: {
      marketId: { in: marketIds },
      assetId,
    },
    orderBy: { capturedAt: "desc" },
    select: { price: true },
  });
  if (latest && Number.isFinite(parseFloat(String(latest.price))) && parseFloat(String(latest.price)) > 0) return true;

  return false;
}

function classifyCloseBlockReason(
  expectedClose: boolean,
  hasExitSnapshot: boolean,
  entryTime: Date,
  now: Date
): CloseBlockReason {
  if (!Number.isFinite(entryTime.getTime())) return "unknown";
  if (!expectedClose) return "not_due";
  if (entryTime.getTime() > now.getTime()) return "unknown";
  if (!hasExitSnapshot) return "missing_exit_snapshot";
  return "close_logic_not_triggered";
}

function fmtBool(v: boolean): string {
  return v ? "true" : "false";
}

async function main(): Promise<void> {
  const now = new Date();
  const maxHoldHours = resolvePaperCloseMaxHoldHours();
  const maxHoldMinutes = maxHoldHours * 60;

  const openV2Trades: OpenV2Row[] = await prisma.paperTrade.findMany({
    where: {
      status: "open",
      dedupeKey: { contains: "|v2|" },
    },
    select: {
      id: true,
      marketId: true,
      assetId: true,
      entryTime: true,
      entryPrice: true,
      dedupeKey: true,
    },
    orderBy: { entryTime: "asc" },
  });

  const rows: DiagnosticRow[] = [];
  for (const t of openV2Trades) {
    const ageMinutesRaw = (now.getTime() - t.entryTime.getTime()) / (60 * 1000);
    const ageMinutes = Number.isFinite(ageMinutesRaw) ? ageMinutesRaw : 0;
    const expectedClose = ageMinutes >= maxHoldMinutes;
    const horizonAt = new Date(t.entryTime.getTime() + maxHoldHours * 60 * 60 * 1000);
    const hasExitSnapshot = expectedClose ? await hasAnyExitSnapshot(t.marketId, t.assetId, horizonAt) : false;
    const closeBlockReason = classifyCloseBlockReason(expectedClose, hasExitSnapshot, t.entryTime, now);
    rows.push({
      id: t.id,
      entryTime: t.entryTime,
      ageMinutes,
      expectedClose,
      hasExitSnapshot,
      closeBlockReason,
    });
  }

  const totalOpenTrades = rows.length;
  const expectedCloseCount = rows.filter((r) => r.expectedClose).length;
  const missingSnapshotCount = rows.filter((r) => r.closeBlockReason === "missing_exit_snapshot").length;
  const blockedByLogicCount = rows.filter((r) => r.closeBlockReason === "close_logic_not_triggered").length;

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "14-v2-close-debug.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# V2 Close Pipeline Debug");
  lines.push("");
  lines.push("Read-only diagnostic over open `PaperTrade` rows where `dedupeKey` contains `|v2|`.");
  lines.push("");
  lines.push("## Runtime assumptions");
  lines.push(`- now: ${now.toISOString()}`);
  lines.push(`- maxHoldHours: ${maxHoldHours}`);
  lines.push(`- expectedClose rule: ageMinutes >= maxHoldHours * 60`);
  lines.push(
    "- hasExitSnapshot rule: true when at least one valid (>0) `MarketPriceSnapshot.price` exists for the trade's market/asset (preferring <= horizon, then >= horizon, then latest any)."
  );
  lines.push("");
  lines.push("## Open V2 trades diagnostic table");
  lines.push("| id | entryTime | ageMinutes | expectedClose | hasExitSnapshot | closeBlockReason |");
  lines.push("| --- | --- | ---: | :---: | :---: | --- |");
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.entryTime.toISOString()} | ${r.ageMinutes.toFixed(2)} | ${fmtBool(r.expectedClose)} | ${fmtBool(
        r.hasExitSnapshot
      )} | ${r.closeBlockReason} |`
    );
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(`- total open trades: ${totalOpenTrades}`);
  lines.push(`- count expectedClose=true: ${expectedCloseCount}`);
  lines.push(`- count missing snapshots: ${missingSnapshotCount}`);
  lines.push(`- count blocked by logic: ${blockedByLogicCount}`);

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
