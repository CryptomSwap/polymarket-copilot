/**
 * Classify existing BehaviorFlag rows with sourceScope for audit + consistent policy.
 *
 * Default: dry-run. Use --apply to write.
 *
 * Rules:
 * - OVERCONCENTRATION, CORRELATED_STACKING → portfolio
 * - OVERTRADING, CHASING, LOW_QUALITY_LONGSHOT → manual
 * - metadata.sourceScope if valid → use (explicit override from future tooling)
 * - Unknown type → manual (does not count toward automation penalty; visible in report)
 *
 * npm run backfill:behavior-flag-sources
 * npm run backfill:behavior-flag-sources -- --apply
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  BEHAVIOR_FLAG_SOURCE_SCOPES,
  type BehaviorFlagSourceScope,
} from "../lib/polymarket/behavior-flags";
import { markFunderPolicyRefreshNeeded } from "../lib/policy-refresh-queue";

const VALID = new Set<string>(BEHAVIOR_FLAG_SOURCE_SCOPES);

function classifyRow(row: {
  type: string;
  sourceScope: string | null;
  metadata: unknown;
}):
  | { action: "skip"; scope: BehaviorFlagSourceScope }
  | { action: "set"; scope: BehaviorFlagSourceScope; rule: string } {
  if (row.sourceScope && VALID.has(row.sourceScope)) {
    return { action: "skip", scope: row.sourceScope as BehaviorFlagSourceScope };
  }
  const meta = row.metadata as Record<string, unknown> | null;
  const fromMeta = meta?.sourceScope;
  if (typeof fromMeta === "string" && VALID.has(fromMeta)) {
    return {
      action: "set",
      scope: fromMeta as BehaviorFlagSourceScope,
      rule: "metadata.sourceScope",
    };
  }

  switch (row.type) {
    case "OVERCONCENTRATION":
    case "CORRELATED_STACKING":
      return { action: "set", scope: "portfolio", rule: "type→portfolio" };
    case "OVERTRADING":
    case "CHASING":
    case "LOW_QUALITY_LONGSHOT":
      return { action: "set", scope: "manual", rule: "type→manual" };
    default:
      return { action: "set", scope: "manual", rule: "unknown_type→manual_safe" };
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const flags = await prisma.behaviorFlag.findMany({
    orderBy: { createdAt: "asc" },
  });

  const counts = {
    total: flags.length,
    classifiedManual: 0,
    classifiedPortfolio: 0,
    classifiedAutomation: 0,
    classifiedRuntime: 0,
    unknownTypeInferredManual: 0,
    skippedAlreadySet: 0,
    wouldUpdate: 0,
    applied: 0,
  };

  const samples: Record<string, unknown[]> = {
    manual: [],
    portfolio: [],
    automation: [],
    runtime: [],
    unknownType: [],
  };

  const updates: {
    id: string;
    funderAddress: string;
    from: string | null;
    to: BehaviorFlagSourceScope;
    rule: string;
  }[] = [];

  for (const row of flags) {
    const c = classifyRow(row);
    if (c.action === "skip") {
      counts.skippedAlreadySet++;
      if (c.scope === "manual") counts.classifiedManual++;
      else if (c.scope === "portfolio") counts.classifiedPortfolio++;
      else if (c.scope === "automation") counts.classifiedAutomation++;
      else counts.classifiedRuntime++;
      continue;
    }

    const { scope, rule } = c;
    if (rule === "unknown_type→manual_safe") {
      counts.unknownTypeInferredManual++;
      if (samples.unknownType.length < 8) {
        samples.unknownType.push({
          id: row.id.slice(0, 12),
          type: row.type,
          severity: row.severity,
        });
      }
    }
    if (scope === "manual") counts.classifiedManual++;
    else if (scope === "portfolio") counts.classifiedPortfolio++;
    else if (scope === "automation") counts.classifiedAutomation++;
    else counts.classifiedRuntime++;

    if (row.sourceScope === scope) {
      continue;
    }

    counts.wouldUpdate++;
    updates.push({
      id: row.id,
      funderAddress: row.funderAddress.trim().toLowerCase(),
      from: row.sourceScope,
      to: scope,
      rule,
    });

    const key =
      scope === "manual"
        ? "manual"
        : scope === "portfolio"
          ? "portfolio"
          : scope === "automation"
            ? "automation"
            : "runtime";
    if (samples[key].length < 3 && rule !== "unknown_type→manual_safe") {
      samples[key].push({
        id: row.id.slice(0, 12),
        type: row.type,
        severity: row.severity,
        rule,
      });
    }
  }

  const policyRefreshFunders = new Set<string>();
  if (apply) {
    for (const u of updates) {
      await prisma.behaviorFlag.update({
        where: { id: u.id },
        data: { sourceScope: u.to },
      });
      counts.applied++;
      policyRefreshFunders.add(u.funderAddress);
    }
    for (const f of policyRefreshFunders) {
      try {
        await markFunderPolicyRefreshNeeded(f);
      } catch (e) {
        console.warn("[backfill-behavior-flag-sources] markFunderPolicyRefreshNeeded", f, e);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: !apply,
    counts,
    updatesPreview: updates.slice(0, 100),
    updatesTotal: updates.length,
    sampleClassifications: samples,
  };

  const jsonPath = path.join(dumpDir, "backfill-behavior-flag-sources.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md: string[] = [
    "# Backfill BehaviorFlag sourceScope",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    "| Mode | " + (apply ? "APPLY" : "dry-run") + " |",
    "| Total scanned | " + counts.total + " |",
    "| Would update / applied | " + (apply ? counts.applied : counts.wouldUpdate) + " |",
    "| Skipped (already had valid scope) | " + counts.skippedAlreadySet + " |",
    "| Unknown type → manual | " + counts.unknownTypeInferredManual + " |",
    "| Classified manual (total rows) | " + counts.classifiedManual + " |",
    "| Classified portfolio (total rows) | " + counts.classifiedPortfolio + " |",
    "",
    "## Sample classifications",
    "",
    "```json",
    JSON.stringify(samples, null, 2),
    "```",
    "",
    apply
      ? "Updates written; funders queued for automatic policy refresh (worker job policy_refresh_pending)."
      : "Re-run with `--apply` to write.",
  ];

  const mdPath = path.join(dumpDir, "backfill-behavior-flag-sources.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
