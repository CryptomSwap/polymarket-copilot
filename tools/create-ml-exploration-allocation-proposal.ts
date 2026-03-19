/**
 * Dump exploration allocation proposal (config-driven, paper-only).
 * Outputs: dump/ml-exploration-allocation-proposal.json, dump/ml-exploration-allocation-proposal.md
 */

import * as fs from "fs";
import * as path from "path";
import { getExplorationPolicyMode } from "../lib/paper-trading/exploration-policy";
import type { ExplorationAllocationBucket } from "../lib/paper-trading/exploration-types";

const DUMP_DIR = path.join(process.cwd(), "dump");

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function main(): void {
  ensureDumpDir();
  const mode = getExplorationPolicyMode();
  const report = {
    generatedAt: new Date().toISOString(),
    currentMode: mode,
    defaultMode: "legacy_threshold_only",
    allocationBuckets: [
      "exploit_high_score",
      "explore_uncertain",
      "explore_under_sampled_segment",
      "explore_specific_block_reason",
    ] as ExplorationAllocationBucket[],
    gating: "ENABLE_PAPER_EXPLORATION_ALLOCATOR_V1=1 to enable blended_allocator_v1. Default: legacy (score >= threshold only).",
    note: "Paper-only; no change to live execution. When blended_allocator_v1 is enabled, quotas/weights can be configured in exploration-policy.",
  };
  const jsonPath = path.join(DUMP_DIR, "ml-exploration-allocation-proposal.json");
  const mdPath = path.join(DUMP_DIR, "ml-exploration-allocation-proposal.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);
  const md = [
    "# ML Exploration Allocation Proposal",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Current mode",
    report.currentMode,
    "",
    "## Allocation buckets (blended_allocator_v1)",
    ...report.allocationBuckets.map((b) => `- ${b}`),
    "",
    "## Gating",
    report.gating,
    "",
    report.note,
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
