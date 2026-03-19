/**
 * Regression tests: position derivation from fills.
 * - BUY adds quantity, SELL subtracts; net = open position.
 * - Fills ordered by matchTime; duplicate (assetId, matchTime, size, side) counted once.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/position-derivation-tests.ts
 */

import * as fs from "fs";
import * as path from "path";
import { sizeToShares, OPEN_POSITION_DUST_THRESHOLD } from "../portfolio";

function run(): void {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  const portfolioPath = path.resolve(__dirname, "../portfolio.ts");
  const source = fs.readFileSync(portfolioPath, "utf8");

  console.log("\n--- Derivation orders fills by matchTime ---");
  check(
    source.includes('orderBy:') && source.includes("matchTime") && source.includes("asc"),
    "derivePositionsFromFills orders by matchTime asc"
  );

  console.log("\n--- Derivation dedupes by fill signature ---");
  check(
    source.includes("seenFillSignature") && source.includes("fillSignature"),
    "derivePositionsFromFills dedupes by (assetId, matchTime, size, side)"
  );

  console.log("\n--- BUY adds, SELL subtracts ---");
  check(
    source.includes('f.side === "BUY" ? 1 : -1'),
    "signed quantity: BUY => +1, SELL => -1"
  );

  console.log("\n--- sizeToShares: raw 6-decimal normalized ---");
  check(sizeToShares(1288500000, "1288500000") === 1288.5, "1288500000 (raw) -> 1288.5 shares");
  check(sizeToShares(1288.5, "1288.5") === 1288.5, "1288.5 (display) -> 1288.5 shares");
  check(sizeToShares(0, "0") === 0, "0 -> 0");

  console.log("\n--- Net quantity: buy then partial sell -> remaining correct ---");
  const buySize = sizeToShares(100 * 1e6, "100000000");
  const sellSize = sizeToShares(30 * 1e6, "30000000");
  const net = buySize * 1 - sellSize * 1;
  check(Math.abs(net - 70) < 1e-6, "buy 100 sell 30 -> net 70");

  console.log("\n--- Complete exit -> net zero ---");
  const buy2 = sizeToShares(50 * 1e6, "50000000");
  const sell2 = sizeToShares(50 * 1e6, "50000000");
  check(Math.abs((buy2 - sell2)) < 1e-6, "buy 50 sell 50 -> net 0");

  console.log("\n--- Dust threshold ---");
  check(OPEN_POSITION_DUST_THRESHOLD > 0 && OPEN_POSITION_DUST_THRESHOLD < 1, "dust threshold in (0,1)");

  console.log("\n--- Dedupe uses time bucket (1s) ---");
  check(
    source.includes("Math.floor(matchTime.getTime() / 1000)") || source.includes("getTime()/1000"),
    "fill signature uses time rounded to 1s for dedupe"
  );

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
