/**
 * Portfolio risk calculator tests: deterministic metrics.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio-risk/__tests__/calculate.test.ts
 */

import assert from "assert";
import { calculatePortfolioRisk } from "../calculate";
import { buildPortfolioRiskInputFromDerived } from "../build-input";
import type { PortfolioRiskInput } from "../types";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
  console.log("\n--- 1. Gross exposure calculation ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", size: 100, marketValue: 50 },
        { assetId: "a2", marketId: "m2", size: 50, marketValue: 25 },
      ],
    };
    const s = calculatePortfolioRisk(input);
    check(s.grossExposure === 75, "gross = 50 + 25");
    check(s.totalOpenExposure === 75, "totalOpenExposure = gross");
    check(s.marketConcentrations.length === 2, "two markets");
  }

  console.log("\n--- 2. Single-market concentration ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", size: 100, marketValue: 80 },
        { assetId: "a2", marketId: "m2", size: 20, marketValue: 20 },
      ],
    };
    const s = calculatePortfolioRisk(input);
    check(s.maxSingleMarketExposure === 80, "max market exposure 80");
    check(s.maxSingleMarketConcentrationPct === 80, "m1 is 80%");
    check(s.marketConcentrations[0].marketId === "m1" && s.marketConcentrations[0].exposure === 80, "first row m1");
  }

  console.log("\n--- 3. Single-theme concentration ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", theme: "Politics", size: 50, marketValue: 60 },
        { assetId: "a2", marketId: "m2", theme: "Politics", size: 40, marketValue: 40 },
        { assetId: "a3", marketId: "m3", theme: "Sports", size: 10, marketValue: 10 },
      ],
    };
    const s = calculatePortfolioRisk(input);
    check(s.maxSingleThemeExposure === 100, "Politics 60+40");
    check(
      Math.abs(s.maxSingleThemeConcentrationPct - (100 / 110) * 100) < 0.01,
      "Politics largest theme %"
    );
    check(s.themeConcentrations.some((t) => t.theme === "Politics" && t.exposure === 100), "theme Politics");
  }

  console.log("\n--- 4. Cluster concentration heuristic ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", theme: "T1", category: "C1", size: 50, marketValue: 50 },
        { assetId: "a2", marketId: "m2", theme: "T1", category: "C1", size: 30, marketValue: 30 },
      ],
      correlationHeuristics: "theme_category",
    };
    const s = calculatePortfolioRisk(input);
    check(s.clusterConcentrations.length >= 1, "at least one cluster");
    check(s.eventClusterExposure === 80, "cluster exposure 80");
    check(s.clusterConcentrations[0].clusterKey === "T1::C1" || s.clusterConcentrations[0].exposure === 80, "cluster key or value");
  }

  console.log("\n--- 5. Worst-case loss estimate ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", size: 100, marketValue: 50, maxPayout: 100 },
        { assetId: "a2", marketId: "m2", size: 50, marketValue: 25 },
      ],
    };
    const s = calculatePortfolioRisk(input);
    check(s.worstCaseLossEstimate >= 75, "worst case at least total notional");
  }

  console.log("\n--- 6. Near-resolution exposure flag ---");
  {
    const in72h = new Date(Date.now() + 36 * 60 * 60 * 1000);
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", size: 100, marketValue: 100, endDate: in72h },
        { assetId: "a2", marketId: "m2", size: 50, marketValue: 50 },
      ],
      nearResolutionHoursThreshold: 72,
    };
    const s = calculatePortfolioRisk(input);
    check(s.nearResolutionExposure === 100, "near-resolution exposure 100");
    check(
      s.riskFlags.some((f) => f.code === "near_resolution_concentration"),
      "near-resolution flag when large"
    );
  }

  console.log("\n--- 7. Illiquid / missing-liquidity warning ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [
        { assetId: "a1", marketId: "m1", size: 50, marketValue: 50, illiquid: true },
        { assetId: "a2", marketId: "m2", size: 50, marketValue: 50 },
      ],
    };
    const s = calculatePortfolioRisk(input);
    check(s.illiquidExposureEstimate === 50, "illiquid estimate 50");
    const inputNoLiquidity: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [{ assetId: "a1", marketId: "m1", size: 50, marketValue: 50 }],
    };
    const s2 = calculatePortfolioRisk(inputNoLiquidity);
    check(s2.liquidityContextMissing === true, "liquidity context missing");
    check(s2.warnings.some((w) => w.includes("Liquidity")), "warning when missing");
  }

  console.log("\n--- 8. Working order exposure ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [{ assetId: "a1", marketId: "m1", size: 10, marketValue: 50 }],
      workingOrders: [
        { assetId: "a2", marketId: "m2", size: 20, price: 0.5 },
      ],
    };
    const s = calculatePortfolioRisk(input);
    check(s.totalWorkingOrderExposure === 10, "working order 20*0.5=10");
    check(s.totalAtRiskExposure === 60, "50+10");
  }

  console.log("\n--- 9. Total exposure breach flag ---");
  {
    const input: PortfolioRiskInput = {
      funderAddress: "0xtest",
      positions: [{ assetId: "a1", marketId: "m1", size: 200, marketValue: 200 }],
      maxTotalExposure: 100,
    };
    const s = calculatePortfolioRisk(input);
    check(s.riskFlags.some((f) => f.code === "total_exposure_breach"), "total exposure breach");
  }

  console.log("\n--- 10. Decision recompute: theme exposure and total from snapshot ---");
  {
    const derivedLike = [
      { assetId: "a1", marketId: "m1", marketTitle: "M1", outcome: "Yes", side: "LONG", size: "100", marketValue: "60", theme: "Politics", category: "C1", syncedMarket: { endDate: null } },
      { assetId: "a2", marketId: "m2", marketTitle: "M2", outcome: "No", side: "LONG", size: "50", marketValue: "40", theme: "Politics", category: "C1", syncedMarket: { endDate: null } },
    ];
    const riskInput = buildPortfolioRiskInputFromDerived("0xfunder", derivedLike, { correlationHeuristics: "theme" });
    const snapshot = calculatePortfolioRisk(riskInput);
    check(snapshot.totalOpenExposure === 100, "totalOpenExposure 60+40");
    check(snapshot.themeConcentrations.length >= 1, "theme rows");
    const politics = snapshot.themeConcentrations.find((t) => t.theme === "Politics");
    check(politics != null && politics.exposure === 100, "Politics theme exposure 100");
    check(snapshot.maxSingleThemeConcentrationPct === 100, "top theme 100%");
  }

  console.log("\nAll portfolio risk calculate tests passed.");
}

run();
