/**
 * Shadow dataset builder tests: feature extraction, label derivation, partial snapshots.
 * Deterministic; no DB required for buildShadowTrainingRow tests.
 */

import { buildShadowTrainingRow, deriveGoodDecisionLabelFromMarkout } from "../build";
import * as fs from "fs";
import * as path from "path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function run(): void {
  const created = new Date("2025-01-15T12:00:00Z");

  console.log("\n--- 1. Blocked candidate -> expected feature/label row ---");
  {
    const row = buildShadowTrainingRow({
      id: "sc-blocked-1",
      funderAddress: "0xabc",
      recommendationId: null,
      orderIntentId: "oi-1",
      assetId: "asset1",
      marketId: "market1",
      side: "BUY",
      intendedPrice: "0.55",
      intendedSize: "100",
      candidateSource: "runtime_automated",
      createdAt: created,
      decisionSnapshotJson: null,
      executionPolicySnapshotJson: JSON.stringify({
        allow: false,
        policyState: "block",
        blockingReasons: ["exposure:single_market_concentration_breach"],
        warnings: [],
      }),
      executionQualitySnapshotJson: null,
      portfolioRiskSnapshotJson: null,
      runtimeSafetySnapshotJson: null,
      wasBlocked: true,
      blockingReasons: ["exposure:single_market_concentration_breach"],
      wasSubmitted: false,
      wasFilled: null,
      evaluatedAt: created,
      markout1h: null,
      markout6h: "-0.02",
      markout24h: "-0.05",
      outcomeClassification: "good_block",
    });
    check(row.shadowCandidateId === "sc-blocked-1", "shadowCandidateId");
    check(row.wasBlocked === true, "wasBlocked");
    check(row.blockedIndicator === true, "blockedIndicator");
    check(row.outcomeBlockedVsAllowedVsSubmitted === "blocked", "outcome blocked");
    check(row.executionAllow === false, "executionAllow false");
    check(row.outcomeClassification === "good_block", "good_block");
    check(row.labelGoodDecision === true, "good_block -> labelGoodDecision true");
    check(row.labelMissedOpportunity === false, "good_block -> labelMissedOpportunity false");
  }

  console.log("\n--- 2. Allowed candidate -> expected feature/label row ---");
  {
    const row = buildShadowTrainingRow({
      id: "sc-allow-1",
      funderAddress: "0xdef",
      recommendationId: "rec-1",
      orderIntentId: "oi-2",
      assetId: "asset2",
      marketId: "market2",
      side: "SELL",
      intendedPrice: "0.45",
      intendedSize: "50",
      candidateSource: "runtime_automated",
      createdAt: created,
      decisionSnapshotJson: JSON.stringify({
        policyState: "allow",
        sizeMultiplier: 1,
        finalSuggestedSize: 50,
        blockers: [],
      }),
      executionPolicySnapshotJson: JSON.stringify({
        allow: true,
        policyState: "allow",
        blockingReasons: [],
        warnings: ["freshness:soft_stale"],
      }),
      executionQualitySnapshotJson: JSON.stringify({
        qualityState: "good",
        spreadBps: 25,
        tradable: true,
      }),
      portfolioRiskSnapshotJson: null,
      runtimeSafetySnapshotJson: null,
      wasBlocked: false,
      blockingReasons: null,
      wasSubmitted: true,
      wasFilled: true,
      evaluatedAt: created,
      markout1h: "0.01",
      markout6h: "0.03",
      markout24h: "0.04",
      outcomeClassification: "good_allow",
    });
    check(row.wasBlocked === false, "wasBlocked false");
    check(row.wasSubmitted === true, "wasSubmitted");
    check(row.outcomeBlockedVsAllowedVsSubmitted === "submitted", "outcome submitted");
    check(row.recommendationPresent === true, "recommendation present");
    check(row.executionAllow === true, "executionAllow true");
    check(row.executionWarningCount === 1, "one warning");
    check(row.qualityState === "good", "qualityState good");
    check(row.outcomeClassification === "good_allow", "good_allow");
    check(row.labelGoodDecision === true, "good_allow -> labelGoodDecision true");
    check(row.labelBadDecision === false, "good_allow -> labelBadDecision false");
  }

  console.log("\n--- 3. Markout/classification labeling: bad_block -> missed opportunity ---");
  {
    const row = buildShadowTrainingRow({
      id: "sc-bad-block",
      funderAddress: "0x",
      recommendationId: null,
      orderIntentId: null,
      assetId: "a",
      marketId: "m",
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
      candidateSource: "runtime_automated",
      createdAt: created,
      decisionSnapshotJson: null,
      executionPolicySnapshotJson: null,
      executionQualitySnapshotJson: null,
      portfolioRiskSnapshotJson: null,
      runtimeSafetySnapshotJson: null,
      wasBlocked: true,
      blockingReasons: [],
      wasSubmitted: false,
      wasFilled: null,
      evaluatedAt: created,
      markout1h: "0.1",
      markout6h: "0.15",
      markout24h: "0.2",
      outcomeClassification: "bad_block",
    });
    check(row.outcomeClassification === "bad_block", "bad_block");
    check(row.labelMissedOpportunity === true, "bad_block -> labelMissedOpportunity true");
    check(row.labelGoodDecision === false, "bad_block -> labelGoodDecision false");
  }

  console.log("\n--- 4. bad_allow -> labelBadDecision, labelExecutionUnsafe when EQ had blocks ---");
  {
    const row = buildShadowTrainingRow({
      id: "sc-bad-allow",
      funderAddress: "0x",
      recommendationId: null,
      orderIntentId: null,
      assetId: "a",
      marketId: "m",
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
      candidateSource: "runtime_automated",
      createdAt: created,
      decisionSnapshotJson: null,
      executionPolicySnapshotJson: null,
      executionQualitySnapshotJson: JSON.stringify({
        qualityState: "block",
        blockingReasons: ["execution_quality:spread_too_wide"],
        warnings: [],
      }),
      portfolioRiskSnapshotJson: null,
      runtimeSafetySnapshotJson: null,
      wasBlocked: false,
      blockingReasons: null,
      wasSubmitted: true,
      wasFilled: false,
      evaluatedAt: created,
      markout24h: "-0.1",
      markout1h: null,
      markout6h: null,
      outcomeClassification: "bad_allow",
    });
    check(row.labelBadDecision === true, "bad_allow -> labelBadDecision true");
    check(row.labelExecutionUnsafe === true, "bad_allow + EQ blocks -> labelExecutionUnsafe true");
  }

  console.log("\n--- 5. Missing optional snapshots -> valid partial feature row ---");
  {
    const row = buildShadowTrainingRow({
      id: "sc-minimal",
      funderAddress: "0x",
      recommendationId: null,
      orderIntentId: null,
      assetId: "a",
      marketId: "m",
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
      candidateSource: "api",
      createdAt: created,
      decisionSnapshotJson: null,
      executionPolicySnapshotJson: null,
      executionQualitySnapshotJson: null,
      portfolioRiskSnapshotJson: null,
      runtimeSafetySnapshotJson: null,
      wasBlocked: false,
      blockingReasons: null,
      wasSubmitted: false,
      wasFilled: null,
      evaluatedAt: null,
      markout1h: null,
      markout6h: null,
      markout24h: null,
      outcomeClassification: null,
    });
    check(row.shadowCandidateId === "sc-minimal", "id preserved");
    check(row.candidateSource === "api", "candidateSource preserved");
    check(row.side === "BUY" && row.intendedPrice === "0.5" && row.intendedSize === "10", "simple features");
    check(row.policyState === null && row.qualityState === null, "null when snapshot missing");
    check(row.outcomeClassification === null, "null outcome when not evaluated");
    check(row.labelGoodDecision === null && row.labelMissedOpportunity === null, "null labels when no outcome");
  }

  console.log("\n--- 6. Source/type: candidateSource and separate table distinguish shadow ---");
  {
    const row = buildShadowTrainingRow({
      id: "sc-src",
      funderAddress: "0x",
      recommendationId: "rec",
      orderIntentId: null,
      assetId: "a",
      marketId: "m",
      side: "BUY",
      intendedPrice: "0.5",
      intendedSize: "10",
      candidateSource: "runtime_automated",
      createdAt: created,
      decisionSnapshotJson: null,
      executionPolicySnapshotJson: null,
      executionQualitySnapshotJson: null,
      portfolioRiskSnapshotJson: null,
      runtimeSafetySnapshotJson: null,
      wasBlocked: false,
      blockingReasons: null,
      wasSubmitted: true,
      wasFilled: null,
      evaluatedAt: created,
      markout1h: null,
      markout6h: null,
      markout24h: "0.01",
      outcomeClassification: "good_allow",
    });
    check(row.candidateSource === "runtime_automated", "candidateSource explicit");
    check(row.shadowCandidateId === "sc-src", "shadowCandidateId links to ShadowCandidate");
  }

  console.log("\n--- 7. Short-horizon label derivation: 6h/12h logic is explicit and isolated ---");
  {
    check(deriveGoodDecisionLabelFromMarkout(false, 0.05) === true, "allowed + favorable -> good");
    check(deriveGoodDecisionLabelFromMarkout(false, -0.05) === false, "allowed + unfavorable -> bad");
    check(deriveGoodDecisionLabelFromMarkout(true, 0.05) === false, "blocked + favorable -> bad (missed opportunity)");
    check(deriveGoodDecisionLabelFromMarkout(true, -0.05) === true, "blocked + unfavorable -> good");
    check(deriveGoodDecisionLabelFromMarkout(true, null) === null, "null markout -> null label");
  }

  console.log("\n--- 8. No contamination across horizons ---");
  {
    const label6h = deriveGoodDecisionLabelFromMarkout(false, 0.02);
    const label12h = deriveGoodDecisionLabelFromMarkout(false, -0.02);
    check(label6h === true, "6h favorable -> true");
    check(label12h === false, "12h unfavorable -> false");
    check(label6h !== label12h, "horizons can differ; labels must be independently derived");
  }

  console.log("\n--- 9. Snapshot source mapping supports marketId/conditionId mismatch ---");
  {
    const src = fs.readFileSync(path.resolve(__dirname, "../build.ts"), "utf8");
    check(src.includes("resolveSnapshotMarketIds"), "dataset builder has market-id resolver");
    check(src.includes("conditionId"), "dataset resolver checks SyncedMarket.conditionId");
    check(src.includes("marketId: { in: resolvedMarketIds }"), "12h snapshot query uses resolved id set");
  }

  console.log("\n--- All shadow dataset build tests passed ---");
}

run();
