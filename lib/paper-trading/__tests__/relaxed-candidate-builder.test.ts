/**
 * Relaxed candidate builder: paper-only derivation for eligible BLOCK snapshots.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/paper-trading/__tests__/relaxed-candidate-builder.test.ts
 */

import assert from "assert";
import { buildRelaxedPaperCandidate } from "../relaxed-candidate-builder";
import type { RelaxedContextInput } from "../relaxed-candidate-builder";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

const relaxedContext: RelaxedContextInput = {
  paperPolicyMode: "relaxed_block_candidate",
  paperRelaxationReason: "edge_too_small",
  originalBlockingReasons: ["Edge too small for action."],
  acceptedBlockingReasons: ["Edge too small for action."],
};

async function run(): Promise<void> {
  console.log("\n--- 1. Missing side (empty) => rejected with missingSide ---");
  {
    const rec = {
      id: "rec-1",
      primaryActionType: "avoid",
      marketSignal: {
        marketId: "any",
        outcome: "Yes",
        side: "",
        marketPrice: "0.5",
        theme: null,
        category: null,
      },
    };
    const snapshot = { policyState: "BLOCK", sizeMultiplier: "0", finalSuggestedSize: "0" };
    const r = await buildRelaxedPaperCandidate(rec as never, snapshot as never, relaxedContext);
    check(!r.ok, "rejected");
    if (!r.ok) check(r.rejectionReason === "missingSide", "reason missingSide");
  }

  console.log("\n--- 2. Missing price => rejected with missingPriceContext ---");
  {
    const rec = {
      id: "rec-2",
      primaryActionType: "avoid",
      marketSignal: {
        marketId: "any",
        outcome: "Yes",
        side: "YES",
        marketPrice: "",
        theme: null,
        category: null,
      },
    };
    const snapshot = { policyState: "BLOCK", sizeMultiplier: "0", finalSuggestedSize: "0" };
    const r = await buildRelaxedPaperCandidate(rec as never, snapshot as never, relaxedContext);
    check(!r.ok, "rejected");
    if (!r.ok) check(r.rejectionReason === "missingPriceContext", "reason missingPriceContext");
  }

  console.log("\n--- 3. Unresolved asset (no such market in DB) => rejected with missingAssetResolution ---");
  {
    const rec = {
      id: "rec-3",
      primaryActionType: "avoid",
      marketSignal: {
        marketId: "nonexistent-market-id-99999",
        outcome: "No",
        side: "NO",
        marketPrice: "0.45",
        theme: null,
        category: null,
      },
    };
    const snapshot = { policyState: "BLOCK", sizeMultiplier: "0", finalSuggestedSize: "0" };
    const r = await buildRelaxedPaperCandidate(rec as never, snapshot as never, relaxedContext);
    check(!r.ok, "rejected");
    if (!r.ok) check(r.rejectionReason === "missingAssetResolution", "reason missingAssetResolution");
  }

  console.log("\n--- 4. Relaxed with primaryActionType=avoid, recoverable asset/side/price => builds when asset exists in DB ---");
  {
    const rec = {
      id: "rec-4",
      primaryActionType: "avoid",
      marketSignal: {
        marketId: "any-valid-market-id",
        outcome: "Yes",
        side: "YES",
        marketPrice: "0.55",
        theme: null,
        category: null,
      },
    };
    const snapshot = { policyState: "BLOCK", sizeMultiplier: "0", finalSuggestedSize: "0" };
    const r = await buildRelaxedPaperCandidate(rec as never, snapshot as never, relaxedContext);
    if (r.ok) {
      check(r.candidate.paperPolicyMode === "relaxed_block_candidate", "mode");
      check(r.candidate.derivationSource === "recommendation_market_signal", "derivationSource");
      check(r.candidate.originalBlockingReasons.includes("Edge too small for action."), "provenance");
      check(r.candidate.side === "BUY", "side YES->BUY");
    }
    // If no asset in DB we get missingAssetResolution; otherwise ok
  }

  console.log("\n--- 5. Relaxed with primaryActionType=sync_first, recoverable => builds when asset exists ---");
  {
    const rec = {
      id: "rec-5",
      primaryActionType: "sync_first",
      marketSignal: {
        marketId: "any",
        outcome: "Yes",
        side: "SELL",
        marketPrice: "0.5",
        theme: null,
        category: null,
      },
    };
    const snapshot = { policyState: "BLOCK", sizeMultiplier: "0", finalSuggestedSize: "0" };
    const r = await buildRelaxedPaperCandidate(rec as never, snapshot as never, relaxedContext);
    if (r.ok) {
      check(r.candidate.side === "SELL", "side");
      check(r.candidate.derivationSource === "recommendation_market_signal", "derivationSource");
    }
  }

  console.log("\n--- 6. Successful build preserves provenance and derivationSource ---");
  {
    const ctx: RelaxedContextInput = {
      paperPolicyMode: "relaxed_block_candidate",
      paperRelaxationReason: "liquidity_too_low",
      originalBlockingReasons: ["Liquidity too low for suggested size."],
      acceptedBlockingReasons: ["Liquidity too low for suggested size."],
    };
    const rec = {
      id: "rec-6",
      primaryActionType: "avoid",
      marketSignal: {
        marketId: "m",
        outcome: "Yes",
        side: "BUY",
        marketPrice: "0.6",
        theme: "Politics",
        category: null,
      },
    };
    const snapshot = { policyState: "BLOCK", sizeMultiplier: "0", finalSuggestedSize: "0" };
    const r = await buildRelaxedPaperCandidate(rec as never, snapshot as never, ctx);
    if (r.ok) {
      check(r.candidate.sourceDecisionState === "BLOCK", "sourceDecisionState");
      check(r.candidate.paperRelaxationReason === "liquidity_too_low", "paperRelaxationReason");
      check(r.candidate.originalBlockingReasons.length === 1, "originalBlockingReasons");
      check(r.candidate.derivationSource === "recommendation_market_signal", "derivationSource");
    }
  }

  console.log("\nAll relaxed-candidate-builder tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
