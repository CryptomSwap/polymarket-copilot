/**
 * Audit artifact for paper_trading_close_due: root cause, wiring, last run snapshot.
 * Writes dump/paper-trade-close-due-audit.md and .json
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");

const ROOT_CAUSE_MD = `
## Root cause (fixed)

**Paper trades stayed \`open\` because \`closePaperTradesAt12h\` required a \`MarketPriceSnapshot\` row whose \`marketId\` exactly matched \`PaperTrade.marketId\`.**

Runtime paper candidates often persist **\`conditionId\`** (or another external id) in \`marketId\`, while \`captureMarketSnapshots\` stores snapshots under **\`SyncedMarket.id\`**. Shadow evaluation already widened lookups via \`SyncedMarket\` (\`id\` OR \`conditionId\`); the paper close path used a single-id query, so \`getPriceAt\` returned \`null\`, the loop hit \`continue\`, and **no status update** occurred.

The job **did run** (\`scheduled-jobs.ts\` → \`closePaperTradesAt12h\`); the failure mode was **silent skip** (errors only in memory; trades never closed).

## Fix (minimal)

1. **Shared lookup** — \`lib/polymarket/market-price-snapshot-lookup.ts\`: \`resolveSnapshotMarketIds\` + \`getSnapshotPriceAtOrBefore\` (used by shadow evaluation) + \`resolvePaperTradeCloseExitPrice\` (lte → gte after horizon → latest any).
2. **Paper close** — \`closePaperTradesAt12h\` uses that resolver, **always closes** due trades when snapshot is still missing (markout null, \`metadataJson.paperClose.closeReason = no_exit_price_snapshot\`).
3. **Observability** — structured result persisted to \`PaperTradingState.lastCloseTickResultJson\` and \`console.info\` summary line.
`;

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  let state: {
    lastCloseTickAt: Date | null;
    lastCloseTickError: string | null;
    lastCloseTickResultJson: string | null;
  } | null = null;
  let openCount = 0;
  let dueApprox = 0;
  const horizonMs = 12 * 60 * 60 * 1000;
  const horizonEnd = new Date(Date.now() - horizonMs);

  try {
    state = await prisma.paperTradingState.findUnique({
      where: { id: "default" },
      select: {
        lastCloseTickAt: true,
        lastCloseTickError: true,
        lastCloseTickResultJson: true,
      },
    });
    openCount = await prisma.paperTrade.count({ where: { status: "open" } });
    dueApprox = await prisma.paperTrade.count({
      where: { status: "open", entryTime: { lte: horizonEnd } },
    });
  } catch (e) {
    console.warn("DB snapshot skipped:", e);
  }

  let lastResult: Record<string, unknown> | null = null;
  if (state?.lastCloseTickResultJson) {
    try {
      lastResult = JSON.parse(state.lastCloseTickResultJson) as Record<string, unknown>;
    } catch {
      lastResult = { parseError: true };
    }
  }

  const json = {
    generatedAt: new Date().toISOString(),
    rootCause: {
      summary:
        "Paper close queried MarketPriceSnapshot with PaperTrade.marketId only; conditionId vs SyncedMarket.id mismatch caused null exit price and trades were never updated (continue without close).",
      primaryBugLocation: "lib/paper-trading/engine.ts getPriceAt + closePaperTradesAt12h (before fix)",
      jobWiringWasCorrect: true,
    },
    involvedFiles: [
      "lib/ops/scheduled-jobs.ts (case paper_trading_close_due)",
      "app/api/ops/run-job/route.ts",
      "app/api/paper-trading/close-due/route.ts",
      "lib/paper-trading/engine.ts (closePaperTradesAt12h)",
      "lib/polymarket/market-price-snapshot-lookup.ts (resolveSnapshotMarketIds, resolvePaperTradeCloseExitPrice)",
      "lib/shadow-evaluation/evaluate.ts (now uses getSnapshotPriceAtOrBefore)",
      "lib/polymarket/market-snapshots.ts (snapshot marketId = SyncedMarket.id)",
    ],
    behavior: {
      before:
        "Due open trades with snapshot id mismatch: exit price null → continue → remain open forever; lastCloseTickResultJson only { closed, errors } with little visibility.",
      after:
        "Same trades resolve snapshot via synced market ids; optional fallbacks (gte, latest); if still no data, close with paperClose.closeReason and counts in lastCloseTickResultJson.",
    },
    proof: {
      note: "After deploy, run paper_trading_close_due; lastCloseTickResultJson should show dueCount > 0 → closed > 0 when trades are past horizon; openCount should drop.",
      lastCloseTickAt: state?.lastCloseTickAt?.toISOString() ?? null,
      lastCloseTickError: state?.lastCloseTickError ?? null,
      lastCloseTickResult: lastResult,
      dbSnapshot: { openPaperTrades: openCount, openDueApprox: dueApprox, horizonEnd: horizonEnd.toISOString() },
    },
  };

  const md: string[] = [];
  md.push("# Paper trade close-due audit");
  md.push("");
  md.push("**Generated:** " + json.generatedAt);
  md.push("");
  md.push(ROOT_CAUSE_MD.trim());
  md.push("");
  md.push("## Files / functions");
  md.push("");
  for (const f of json.involvedFiles) {
    md.push("- `" + f + "`");
  }
  md.push("");
  md.push("## Before / after");
  md.push("");
  md.push("- **Before:** " + json.behavior.before);
  md.push("- **After:** " + json.behavior.after);
  md.push("");
  md.push("## Proof / current DB snapshot");
  md.push("");
  md.push("- " + json.proof.note);
  md.push("- **lastCloseTickAt:** " + (json.proof.lastCloseTickAt ?? "—"));
  md.push("- **lastCloseTickError:** " + (json.proof.lastCloseTickError ?? "—"));
  md.push("- **open paper trades (now):** " + json.proof.dbSnapshot.openPaperTrades);
  md.push("- **open & due (approx, entryTime ≤ horizonEnd):** " + json.proof.dbSnapshot.openDueApprox);
  md.push("");
  md.push("### lastCloseTickResultJson (parsed)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(lastResult, null, 2));
  md.push("```");
  md.push("");

  const jsonPath = path.join(DUMP_DIR, "paper-trade-close-due-audit.json");
  const mdPath = path.join(DUMP_DIR, "paper-trade-close-due-audit.md");
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), "utf8");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
