/**
 * Paper daily-cap overflow: exploration/threshold resolution on alternate bots (no DB).
 * Run: npx tsx lib/paper-trading/__tests__/paper-daily-cap-overflow.test.ts
 */

import assert from "assert";
import { paperAdmissionExplorationResolveForDailyCapOverflow } from "../paper-daily-cap-overflow";
import { evaluatePaperLiquidityGuards } from "../paper-roi-admission";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
  console.log("\n--- threshold admit on strict min ---");
  {
    const r = paperAdmissionExplorationResolveForDailyCapOverflow({
      admissionScore: 0.5,
      effectiveMinScore: 0.4,
      explorationEnabledForBot: true,
      explorationBandBelowMinScore: 0.05,
      explorationMinScore: 0.35,
      explorationMaxPerTick: 2,
      explorationMaxPerDay: 10,
      explorationOpenedForBot: 0,
      explorationCreatedToday: 0,
    });
    check(r.ok === true && r.mode === "threshold", "threshold path");
  }

  console.log("\n--- no overflow when below alt threshold and outside exploration band ---");
  {
    const r = paperAdmissionExplorationResolveForDailyCapOverflow({
      admissionScore: 0.35,
      effectiveMinScore: 0.5,
      explorationEnabledForBot: true,
      explorationBandBelowMinScore: 0.05,
      explorationMinScore: 0.45,
      explorationMaxPerTick: 2,
      explorationMaxPerDay: 10,
      explorationOpenedForBot: 0,
      explorationCreatedToday: 0,
    });
    check(r.ok === false && r.reject === "outside_exploration_band", "stricter bot rejects score");
  }

  console.log("\n--- exploration admit when in band and under caps ---");
  {
    const r = paperAdmissionExplorationResolveForDailyCapOverflow({
      admissionScore: 0.46,
      effectiveMinScore: 0.5,
      explorationEnabledForBot: true,
      explorationBandBelowMinScore: 0.05,
      explorationMinScore: 0.45,
      explorationMaxPerTick: 2,
      explorationMaxPerDay: 10,
      explorationOpenedForBot: 0,
      explorationCreatedToday: 0,
    });
    check(r.ok === true && r.mode === "exploration", "exploration path");
  }

  console.log("\n--- exploration daily cap blocks alternate bot ---");
  {
    const r = paperAdmissionExplorationResolveForDailyCapOverflow({
      admissionScore: 0.46,
      effectiveMinScore: 0.5,
      explorationEnabledForBot: true,
      explorationBandBelowMinScore: 0.05,
      explorationMinScore: 0.45,
      explorationMaxPerTick: 2,
      explorationMaxPerDay: 3,
      explorationOpenedForBot: 0,
      explorationCreatedToday: 3,
    });
    check(r.ok === false && r.reject === "exploration_cap_day", "exploration cap day");
  }

  console.log("\n--- exploration per-tick cap ---");
  {
    const r = paperAdmissionExplorationResolveForDailyCapOverflow({
      admissionScore: 0.46,
      effectiveMinScore: 0.5,
      explorationEnabledForBot: true,
      explorationBandBelowMinScore: 0.05,
      explorationMinScore: 0.45,
      explorationMaxPerTick: 1,
      explorationMaxPerDay: 10,
      explorationOpenedForBot: 1,
      explorationCreatedToday: 0,
    });
    check(r.ok === false && r.reject === "exploration_cap_tick", "exploration cap tick");
  }

  console.log("\n--- overflow path uses same spread guard as primary (wide spread fails) ---");
  {
    const g = evaluatePaperLiquidityGuards(200, 1, 50, 100);
    check(g.ok === false && g.reason === "spread", "spread_guard");
  }

  console.log("\n--- overflow path uses same slippage guard ---");
  {
    const g = evaluatePaperLiquidityGuards(10, 80, 100, 50);
    check(g.ok === false && g.reason === "slippage", "slippage_guard");
  }

  console.log("\n--- all paper-daily-cap-overflow tests passed ---\n");
}

run();
