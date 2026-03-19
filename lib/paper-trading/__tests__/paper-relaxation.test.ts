/**
 * Paper-only relaxation: eligibility and stake for salvaged BLOCK candidates.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/paper-trading/__tests__/paper-relaxation.test.ts
 */

import assert from "assert";
import {
  classifyPaperRelaxationEligibility,
  getRelaxedPaperStake,
  parseBlockingReasonsFromSnapshot,
  PAPER_RELAXATION_VERSION,
  allowedPaperBlockReasons,
} from "../paper-relaxation";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function staged(
  policyState: string,
  finalSuggestedSize: string,
  reasoningJson: string | null
): { policyState: string; finalSuggestedSize: string; reasoningJson: string | null } {
  return { policyState, finalSuggestedSize, reasoningJson };
}

function run(): void {
  console.log("\n--- 1. BLOCK + only 'Edge too small for action.' => eligible ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged("BLOCK", "0", JSON.stringify({ blockReason: "Edge too small for action.", blockers: [] }))
    );
    check(r.eligible === true, "eligible");
    check(r.mode === "relaxed_block_candidate", "mode relaxed_block_candidate");
    check(r.relaxationReason === "edge_too_small", "relaxationReason edge_too_small");
    check(r.originalBlockingReasons.length === 1 && r.originalBlockingReasons[0] === "Edge too small for action.", "originalBlockingReasons");
    check(r.acceptedBlockingReasons.length === 1, "acceptedBlockingReasons");
  }

  console.log("\n--- 2. BLOCK + only 'Liquidity too low for suggested size.' => eligible ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged("BLOCK", "0", JSON.stringify({ blockReason: "Liquidity too low for suggested size.", blockers: [] }))
    );
    check(r.eligible === true, "eligible");
    check(r.mode === "relaxed_block_candidate", "mode relaxed_block_candidate");
    check(r.relaxationReason === "liquidity_too_low", "relaxationReason liquidity_too_low");
  }

  console.log("\n--- 3. BLOCK + both allowed reasons => eligible (multi_allowed) ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged(
        "BLOCK",
        "0",
        JSON.stringify({
          blockReason: "Edge too small for action.",
          blockers: ["Liquidity too low for suggested size."],
        })
      )
    );
    check(r.eligible === true, "eligible");
    check(r.mode === "relaxed_block_candidate", "mode relaxed_block_candidate");
    check(r.relaxationReason === "multi_allowed", "relaxationReason multi_allowed");
    check(r.originalBlockingReasons.length === 2, "two blocking reasons");
    check(r.acceptedBlockingReasons.length === 2, "both accepted");
  }

  console.log("\n--- 4. BLOCK + 'Market crowded or low liquidity.' => rejected ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged("BLOCK", "0", JSON.stringify({ blockReason: "Market crowded or low liquidity.", blockers: [] }))
    );
    check(r.eligible === false, "not eligible");
    check(r.mode === "rejected", "mode rejected");
    check(r.rejectionReason != null && r.rejectionReason.includes("disallowed"), "rejectionReason mentions disallowed");
  }

  console.log("\n--- 5. BLOCK + allowed + disallowed mixed => rejected ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged(
        "BLOCK",
        "0",
        JSON.stringify({
          blockReason: "Edge too small for action.",
          blockers: ["Theme concentration 55% exceeds limit."],
        })
      )
    );
    check(r.eligible === false, "not eligible");
    check(r.mode === "rejected", "mode rejected");
  }

  console.log("\n--- 6. non-BLOCK decision => not routed through relaxation (rejected) ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged("ALLOW_NORMAL", "100", JSON.stringify({ blockReason: null, blockers: [] }))
    );
    check(r.eligible === false, "not eligible");
    check(r.mode === "rejected", "mode rejected");
    check(r.rejectionReason === "policy_state_not_block", "rejectionReason policy_state_not_block");
  }
  {
    const r = classifyPaperRelaxationEligibility(
      staged("BLOCK", "0", JSON.stringify({ blockReason: "Edge too small for action.", blockers: [] }))
    );
    check(r.eligible === true, "BLOCK with allowed reason is eligible");
  }

  console.log("\n--- 7. Salvaged candidate shape: paperPolicyMode and originalBlockingReasons preserved ---");
  {
    const snap = staged("BLOCK", "0", JSON.stringify({ blockReason: "Liquidity too low for suggested size.", blockers: [] }));
    const r = classifyPaperRelaxationEligibility(snap);
    check(r.mode === "relaxed_block_candidate", "mode");
    check(r.originalBlockingReasons.length >= 1 && r.originalBlockingReasons.includes("Liquidity too low for suggested size."), "originalBlockingReasons preserved");
    check(r.acceptedBlockingReasons.length >= 1, "acceptedBlockingReasons");
  }

  console.log("\n--- 8. getRelaxedPaperStake: conservative fixed notional, isolated ---");
  {
    const stake = getRelaxedPaperStake();
    check(typeof stake === "string", "returns string");
    check(Number(stake) > 0 && Number(stake) < 1000, "conservative notional (small fixed)");
  }

  console.log("\n--- 9. parseBlockingReasonsFromSnapshot: blockReason + blockers ---");
  {
    const reasons = parseBlockingReasonsFromSnapshot({
      reasoningJson: JSON.stringify({ blockReason: "Edge too small for action.", blockers: ["Liquidity too low for suggested size."] }),
    });
    check(reasons.length === 2, "two reasons");
    check(reasons.includes("Edge too small for action."), "blockReason included");
    check(reasons.includes("Liquidity too low for suggested size."), "blockers included");
  }

  console.log("\n--- 10. Constants ---");
  check(PAPER_RELAXATION_VERSION === "paper_relax_v1", "PAPER_RELAXATION_VERSION");
  check(allowedPaperBlockReasons.includes("Edge too small for action."), "allowlist edge");
  check(allowedPaperBlockReasons.includes("Liquidity too low for suggested size."), "allowlist liquidity");
  check(!allowedPaperBlockReasons.includes("Market crowded or low liquidity."), "crowded not in allowlist");

  console.log("\n--- 11. BLOCK + no blocking reasons => rejected ---");
  {
    const r = classifyPaperRelaxationEligibility(staged("BLOCK", "0", JSON.stringify({ blockReason: null, blockers: [] })));
    check(r.eligible === false, "not eligible");
    check(r.rejectionReason === "no_blocking_reasons", "rejectionReason");
  }

  console.log("\n--- 12. BLOCK + finalSuggestedSize > 0 => rejected ---");
  {
    const r = classifyPaperRelaxationEligibility(
      staged("BLOCK", "50", JSON.stringify({ blockReason: "Edge too small for action.", blockers: [] }))
    );
    check(r.eligible === false, "not eligible");
    check(r.rejectionReason === "final_suggested_size_non_zero", "rejectionReason");
  }

  console.log("\nAll paper-relaxation tests passed.");
}

run();
