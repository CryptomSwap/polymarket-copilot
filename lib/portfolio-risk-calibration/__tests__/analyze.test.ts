/**
 * Portfolio-risk calibration tests: subtype grouping, recommendation logic, threshold exposure.
 */

import {
  portfolioRiskSubtypeFromRaw,
  subtypesFromBlockingReasons,
  hasPortfolioRiskBlock,
  subtypesFromPortfolioRiskSnapshot,
  buildRecommendation,
} from "../index";
import type { RiskSubtypeStats, PortfolioRiskSubtype } from "../types";
import { getPortfolioRiskThresholds } from "@/lib/portfolio-risk/config";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function emptyStats(subtype: PortfolioRiskSubtype): RiskSubtypeStats {
  return {
    subtype,
    blockedCount: 0,
    evaluatedBlocked: 0,
    goodBlockCount: 0,
    badBlockCount: 0,
    allowedCount: 0,
    evaluatedAllowed: 0,
    goodAllowCount: 0,
    badAllowCount: 0,
    averageMarkout24hBlocked: null,
    averageMarkout24hAllowed: null,
    rawSamples: [],
  };
}

function run(): void {
  console.log("\n--- 1. Subtype grouping from raw reasons ---");
  {
    check(
      portfolioRiskSubtypeFromRaw("exposure_total_breach") === "total_exposure",
      "exposure_total_breach -> total_exposure"
    );
    check(
      portfolioRiskSubtypeFromRaw("single_market_concentration_breach") === "single_market_concentration",
      "single_market_concentration_breach -> single_market_concentration"
    );
    check(
      portfolioRiskSubtypeFromRaw("single_theme_concentration_breach") === "single_theme_concentration",
      "single_theme_concentration_breach -> single_theme_concentration"
    );
    check(
      portfolioRiskSubtypeFromRaw("single_market") === "single_market_concentration",
      "single_market -> single_market_concentration"
    );
    check(
      portfolioRiskSubtypeFromRaw("market_concentration_breach") === "single_market_concentration",
      "market_concentration_breach"
    );
    check(
      portfolioRiskSubtypeFromRaw("near_resolution_concentration") === "near_resolution_exposure",
      "near_resolution_concentration"
    );
    check(
      portfolioRiskSubtypeFromRaw("theme_concentration_breach") === "single_theme_concentration",
      "theme_concentration_breach"
    );
    check(portfolioRiskSubtypeFromRaw("kill_switch") === null, "non-risk returns null");
  }

  console.log("\n--- 2. subtypesFromBlockingReasons ---");
  {
    const subs = subtypesFromBlockingReasons([
      "exposure_total_breach",
      "single_market_concentration_breach",
    ]);
    check(subs.includes("total_exposure"), "total_exposure in list");
    check(subs.includes("single_market_concentration"), "single_market_concentration in list");
  }

  console.log("\n--- 3. hasPortfolioRiskBlock ---");
  {
    check(hasPortfolioRiskBlock(["exposure_total_breach"]) === true, "exposure breach true");
    check(hasPortfolioRiskBlock(["single_theme_concentration_breach"]) === true, "theme concentration true");
    check(hasPortfolioRiskBlock(["quote_stale"]) === false, "non-risk false");
    check(hasPortfolioRiskBlock([]) === false, "empty false");
  }

  console.log("\n--- 4. subtypesFromPortfolioRiskSnapshot ---");
  {
    const snap = JSON.stringify({
      concentrationFlags: [{ code: "market_concentration_breach" }, { code: "theme_concentration_breach" }],
      riskFlags: [{ code: "near_resolution_concentration" }],
    });
    const subs = subtypesFromPortfolioRiskSnapshot(snap);
    check(subs.includes("single_market_concentration"), "snapshot market");
    check(subs.includes("single_theme_concentration"), "snapshot theme");
    check(subs.includes("near_resolution_exposure"), "snapshot near_resolution");
    check(subtypesFromPortfolioRiskSnapshot(null)?.length === 0, "null snapshot empty");
  }

  console.log("\n--- 5. review_loosen for high bad_block rate ---");
  {
    const stats = emptyStats("single_market_concentration");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 3;
    stats.badBlockCount = 7;
    const row = buildRecommendation("single_market_concentration", stats, 5);
    check(row.recommendation === "review_loosen", "high bad_block -> review_loosen");
    check(row.summary.includes("bad_block"), "summary mentions bad_block");
  }

  console.log("\n--- 6. keep_strict for high good_block rate ---");
  {
    const stats = emptyStats("single_theme_concentration");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 8;
    stats.badBlockCount = 2;
    const row = buildRecommendation("single_theme_concentration", stats, 5);
    check(row.recommendation === "keep_strict", "high good_block -> keep_strict");
    check(row.summary.includes("good_block"), "summary mentions good_block");
  }

  console.log("\n--- 7. review_tighten for bad allows in allowed cohort ---");
  {
    const stats = emptyStats("total_exposure");
    stats.allowedCount = 20;
    stats.evaluatedAllowed = 10;
    stats.goodAllowCount = 3;
    stats.badAllowCount = 7;
    const row = buildRecommendation("total_exposure", stats, 5);
    check(row.recommendation === "review_tighten", "high bad_allow -> review_tighten");
    check(
      row.summary.includes("bad_allows") || row.summary.includes("tighten"),
      "summary mentions tighten/bad_allows"
    );
  }

  console.log("\n--- 8. insufficient_data on small sample ---");
  {
    const stats = emptyStats("near_resolution_exposure");
    stats.blockedCount = 3;
    stats.evaluatedBlocked = 3;
    stats.goodBlockCount = 1;
    stats.badBlockCount = 2;
    const row = buildRecommendation("near_resolution_exposure", stats, 5);
    check(row.recommendation === "insufficient_data", "below minEvaluated -> insufficient_data");
  }

  console.log("\n--- 9. monitor when no strong signal ---");
  {
    const stats = emptyStats("single_market_concentration");
    stats.blockedCount = 10;
    stats.evaluatedBlocked = 10;
    stats.goodBlockCount = 5;
    stats.badBlockCount = 4;
    const row = buildRecommendation("single_market_concentration", stats, 5);
    check(row.recommendation === "monitor", "mixed rates -> monitor");
  }

  console.log("\n--- 10. Current threshold config (getPortfolioRiskThresholds) ---");
  {
    const t = getPortfolioRiskThresholds();
    check(typeof t.maxTotalExposure === "number", "maxTotalExposure number");
    check(typeof t.maxSingleMarketConcentrationPct === "number", "maxSingleMarketConcentrationPct number");
    check(typeof t.nearResolutionHoursThreshold === "number", "nearResolutionHoursThreshold number");
    check(t.maxTotalExposure === 100_000, "default maxTotalExposure 100_000");
    check(t.maxSingleMarketConcentrationPct === 50, "default maxSingleMarketConcentrationPct 50");
    check(t.nearResolutionHoursThreshold === 72, "default nearResolutionHoursThreshold 72");
  }

  console.log("\nAll portfolio-risk-calibration tests passed.");
}

run();
