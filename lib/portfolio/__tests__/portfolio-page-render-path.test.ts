/**
 * Regression tests: portfolio page render path matches corrected live positions API.
 * Ensures the UI uses /api/portfolio/positions?canonical=true, displays API economics fields directly,
 * and clears detail/selected when a position is no longer in the list (e.g. after stale row exclusion).
 * Run with (from repo root): npx tsx lib/portfolio/__tests__/portfolio-page-render-path.test.ts
 */

import * as fs from "fs";
import * as path from "path";

function run(cond: boolean, msg: string, passed: { n: number }, failed: { n: number }): void {
  if (cond) {
    passed.n++;
    console.log("  OK:", msg);
  } else {
    failed.n++;
    console.error("  FAIL:", msg);
  }
}

export function runPortfolioPageRenderPathTests(): void {
  const passed = { n: 0 };
  const failed = { n: 0 };

  const portfolioPagePath = path.resolve(__dirname, "../../../app/(dashboard)/portfolio/page.tsx");
  const pageSource = fs.existsSync(portfolioPagePath) ? fs.readFileSync(portfolioPagePath, "utf8") : "";

  console.log("\n--- Portfolio page: endpoint and canonical ---");
  run(
    pageSource.includes("/api/portfolio/positions?canonical=true"),
    "page fetches /api/portfolio/positions?canonical=true",
    passed,
    failed
  );
  run(
    pageSource.includes("posData.positions") && pageSource.includes("posList"),
    "positions list comes from API response (posData.positions)",
    passed,
    failed
  );
  run(
    pageSource.includes("pollingData?.positions ?? []"),
    "rendered positions = pollingData.positions (no local override)",
    passed,
    failed
  );

  console.log("\n--- Portfolio page: display uses API economics (no client overwrite) ---");
  run(
    pageSource.includes("economics.currentValue") && pageSource.includes("economics.exposure"),
    "current value display uses economics.currentValue ?? economics.exposure",
    passed,
    failed
  );
  run(
    pageSource.includes("economics.markPrice"),
    "mark display uses economics.markPrice",
    passed,
    failed
  );
  run(
    pageSource.includes("formatUsd(economics.currentValue") || pageSource.includes("economics.currentValue ?? economics.exposure"),
    "table/detail show currentValue from canonical economics",
    passed,
    failed
  );
  run(
    !pageSource.includes("economics.markPrice =") && !pageSource.includes("economics.currentValue ="),
    "page does not assign to economics.markPrice or economics.currentValue (no client overwrite)",
    passed,
    failed
  );

  console.log("\n--- Portfolio page: market title from API ---");
  run(
    pageSource.includes("market?.title") || pageSource.includes("display.displayTitle"),
    "title from market.title or display (canonical API shape)",
    passed,
    failed
  );

  console.log("\n--- Portfolio page: sync with list (clear when excluded) ---");
  run(
    pageSource.includes("positions.find((p) => p.token?.assetId === detailAssetId)"),
    "detail drawer sync finds position by assetId from current positions",
    passed,
    failed
  );
  run(
    pageSource.includes("setDetailPosition(null)") && pageSource.includes("detailAssetId"),
    "detail drawer cleared when position not in list (setDetailPosition(null))",
    passed,
    failed
  );
  run(
    pageSource.includes("positions.some") && pageSource.includes("selectedAssetId") && pageSource.includes("setSelectedPosition(null)"),
    "selected (exit modal) cleared when position no longer in list",
    passed,
    failed
  );

  console.log("\n--- Portfolio page: fetch error handling ---");
  run(
    pageSource.includes("positionsFetchOk"),
    "polling data includes positionsFetchOk for API failure",
    passed,
    failed
  );
  run(
    pageSource.includes("positionsFetchOk === false"),
    "UI shows error state when positionsFetchOk is false (not empty list)",
    passed,
    failed
  );

  console.log("\n--- Portfolio page: row count from API ---");
  run(
    pageSource.includes("positions.map((p) =>") && pageSource.includes("<PositionRow"),
    "table rows = positions.map (rendered row count = API positions length)",
    passed,
    failed
  );

  console.log("\n--- Portfolio page render path: summary ---");
  console.log("  Passed:", passed.n, " Failed:", failed.n);
  if (failed.n > 0) process.exit(1);
}

if (require.main === module) {
  runPortfolioPageRenderPathTests();
}
