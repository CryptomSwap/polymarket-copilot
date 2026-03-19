/**
 * Inspect durable fill ledger state: count, last 20 entries, validate with ledgerEntryToPositionFill.
 * Run from repo root with:
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register scripts/debug-fill-ledger.ts [funderAddress]
 */

import { prisma } from "../lib/db";
import { getFillsForRebuild, ledgerEntryToPositionFill, type UnappliedFillEntry } from "../lib/live/fill-ledger";

async function main(): Promise<void> {
  const funderArg = process.argv[2];
  const funder = funderArg?.toLowerCase().trim() ?? null;

  console.log("\n--- Fill ledger diagnostics ---\n");

  try {
    const count = await prisma.fillLedgerEntry.count(funder ? { where: { funderAddress: funder } } : undefined);
    console.log("Total ledger rows:", funder ? ` ${count} (funder ${funder})` : ` ${count} (all funders)`);

    const last20 = await prisma.fillLedgerEntry.findMany({
      where: funder ? { funderAddress: funder } : undefined,
      orderBy: { filledAt: "desc" },
      take: 20,
    });
    console.log("\nLast 20 entries (newest first):");
    console.log(JSON.stringify(last20, null, 2));

    if (funder) {
      console.log("\n--- getFillsForRebuild(funder) ---");
      const fills = await getFillsForRebuild(funder);
      console.log("Rows returned:", fills.length);

      console.log("\n--- Validate each with ledgerEntryToPositionFill ---");
      for (let i = 0; i < fills.length; i++) {
        const entry = fills[i] as UnappliedFillEntry;
        try {
          ledgerEntryToPositionFill(entry);
        } catch (e) {
          console.error(`Conversion failed at index ${i}:`, {
            id: entry.id,
            assetId: entry.assetId,
            side: entry.side,
            size: entry.size,
            price: entry.price,
            error: e instanceof Error ? e.message : String(e),
          });
          process.exit(1);
        }
      }
      console.log("All entries validated successfully.");
    } else {
      console.log("\n(Provide funderAddress as first arg to run getFillsForRebuild + validation)");
    }
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
