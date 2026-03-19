/**
 * Hard audit: target truth end-to-end (schema, population, trainable, active model).
 * Outputs: dump/ml-target-truth-audit.json, dump/ml-target-truth-audit.md
 */

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../lib/db";
import { ML_SHADOW_LABEL_COLUMNS } from "../lib/ml/targets/schema";
import { ML_TARGET_REGISTRY, getTargetDefinition } from "../lib/ml/targets/registry";
import type { MlTargetKey } from "../lib/ml/types/targets";
import { validateActiveModelTarget } from "../lib/ml/targets/validate";

const DUMP_DIR = path.join(process.cwd(), "dump");
const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

async function getPopulationCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const col of ML_SHADOW_LABEL_COLUMNS) {
    try {
      const result = await prisma.mlShadowTrainingExample.count({
        where: { [col]: { not: null } },
      });
      counts[col] = result;
    } catch {
      counts[col] = 0;
    }
  }
  return counts;
}

async function getLabelGoodDecision12hStats() {
  const totalRows = await prisma.mlShadowTrainingExample.count();
  const populatedTotal = await prisma.mlShadowTrainingExample.count({
    where: { labelGoodDecision12h: { not: null } },
  });
  const populatedCanonical = await prisma.mlShadowTrainingExample.count({
    where: {
      labelGoodDecision12h: { not: null },
      candidateSource: { not: "offline_historical" },
    },
  });
  const populatedOffline = await prisma.mlShadowTrainingExample.count({
    where: {
      labelGoodDecision12h: { not: null },
      candidateSource: "offline_historical",
    },
  });
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  const last7dTotal = await prisma.mlShadowTrainingExample.count({
    where: {
      createdAt: { gte: daysAgo(7) },
      labelGoodDecision12h: { not: null },
    },
  });
  const last30dTotal = await prisma.mlShadowTrainingExample.count({
    where: {
      createdAt: { gte: daysAgo(30) },
      labelGoodDecision12h: { not: null },
    },
  });
  const positives = await prisma.mlShadowTrainingExample.count({
    where: { labelGoodDecision12h: true },
  });
  const negatives = await prisma.mlShadowTrainingExample.count({
    where: { labelGoodDecision12h: false },
  });

  return {
    totalRows,
    populatedTotal,
    populatedCanonical,
    populatedOffline,
    last7dPopulated: last7dTotal,
    last30dPopulated: last30dTotal,
    positives,
    negatives,
  };
}

async function getActiveRun(): Promise<{
  id: string;
  targetLabel: string;
  featureSetName: string;
  status: string;
  trainCount: number | null;
  validationCount: number | null;
} | null> {
  const run = await prisma.mlModelRun.findFirst({
    where: { modelType: SHADOW_MODEL_TYPE, status: { in: ["ACTIVE", "APPROVED"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!run) return null;
  return {
    id: run.id,
    targetLabel: run.targetLabel,
    featureSetName: run.featureSetName,
    status: run.status,
    trainCount: run.trainCount,
    validationCount: run.validationCount,
  };
}

function main(): void {
  ensureDumpDir();
  const runAudit = async () => {
    const schemaTargetFields = [...ML_SHADOW_LABEL_COLUMNS];
    const populationCounts = await getPopulationCounts();
    const activeRun = await getActiveRun();
    const label12hStats = await getLabelGoodDecision12hStats();

    const registryTargets = (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).map((key) => {
      const def = ML_TARGET_REGISTRY[key];
      const popCount = def.schemaPresent ? (populationCounts[key] ?? 0) : null;
      const classification =
        def.implementationStatus === "implemented"
          ? "implemented"
          : def.implementationStatus === "partial"
            ? "partial"
            : def.implementationStatus === "scaffolded"
              ? "scaffolded"
              : "schema_only";
      return {
        key,
        description: def.description,
        schemaPresent: def.schemaPresent,
        populatedByCanonicalBuilder: def.populatedByCanonicalBuilder,
        populatedByOfflineHistorical: def.populatedByOfflineHistorical,
        trainableNow: def.trainableNow,
        scoringSupportedNow: def.scoringSupportedNow,
        implementationStatus: def.implementationStatus,
        classification,
        populationCount: popCount,
        schema_only: classification === "schema_only",
        scaffolded: classification === "scaffolded",
        populated: popCount != null && popCount > 0,
        trainable: def.trainableNow,
        currently_active: activeRun?.targetLabel === key,
      };
    });

    const activeValidation =
      activeRun != null
        ? validateActiveModelTarget(activeRun.targetLabel, {
            hasCanonicalPopulation: (() => {
              const d =
                (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).includes(activeRun!.targetLabel as MlTargetKey)
                  ? getTargetDefinition(activeRun!.targetLabel as MlTargetKey)
                  : undefined;
              return d?.populatedByCanonicalBuilder ?? false;
            })(),
          })
        : null;

    const mismatches: string[] = [];
    if (activeRun) {
      const activeDef = (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).includes(activeRun.targetLabel as MlTargetKey)
        ? getTargetDefinition(activeRun.targetLabel as MlTargetKey)
        : undefined;
      if (!activeDef) {
        mismatches.push(`Active model target "${activeRun.targetLabel}" is not in registry.`);
      } else {
        if (activeDef.implementationStatus === "scaffolded" || activeDef.implementationStatus === "schema_only") {
          mismatches.push(
            `Active model target ${activeRun.targetLabel} is ${activeDef.implementationStatus}; not populated by any builder.`
          );
        }
        if (activeDef.implementationStatus === "partial" && !activeDef.populatedByCanonicalBuilder) {
          mismatches.push(
            `Active model target ${activeRun.targetLabel} is only populated by offline-historical; canonical build does not set it.`
          );
        }
        const pop = populationCounts[activeRun.targetLabel];
        if (activeDef.schemaPresent && pop != null && pop === 0) {
          mismatches.push(`Active model target ${activeRun.targetLabel} has zero rows in DB.`);
        }
      }
    }
    const registryKeysNotInSchema = (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).filter(
      (k) => ML_TARGET_REGISTRY[k].schemaPresent && !(ML_SHADOW_LABEL_COLUMNS as readonly string[]).includes(k)
    );
    const schemaColumnsNotInRegistry = ML_SHADOW_LABEL_COLUMNS.filter(
      (col) => !(Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).includes(col as MlTargetKey)
    );
    if (registryKeysNotInSchema.length) {
      mismatches.push(`Registry claims schemaPresent for keys not in ML_SHADOW_LABEL_COLUMNS: ${registryKeysNotInSchema.join(", ")}.`);
    }
    if (schemaColumnsNotInRegistry.length) {
      mismatches.push(
        `Schema has label columns not in registry (no MlTargetKey): ${schemaColumnsNotInRegistry.join(", ")}.`
      );
    }

    const recommendedCorrections: string[] = [];
    if (activeRun && activeValidation && !activeValidation.ok) {
      recommendedCorrections.push("Review active model target; consider training on an implemented target (e.g. labelGoodDecision) or ensure offline-historical data exists for partial targets.");
    }
    if (schemaColumnsNotInRegistry.length) {
      recommendedCorrections.push(
        `Add registry entries or mark as non-trainable for: ${schemaColumnsNotInRegistry.join(", ")}.`
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      schemaTargetFields,
      registryTargets,
      populationCounts,
      activeModelRun: activeRun,
      activeModelValidation: activeValidation
        ? {
            ok: activeValidation.ok,
            warnings: activeValidation.warnings,
            errors: activeValidation.errors,
          }
        : null,
      mismatches,
      recommendedCorrections,
      summary: {
        labelGoodDecision12h: getTargetDefinition("labelGoodDecision12h"),
        activeModelTargetTrustworthy:
          activeRun == null
            ? null
            : (() => {
                const d = (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).includes(activeRun.targetLabel as MlTargetKey)
                  ? getTargetDefinition(activeRun.targetLabel as MlTargetKey)
                  : undefined;
                if (!d) return false;
                if (d.implementationStatus === "implemented") return true;
                if (d.implementationStatus === "partial" && (populationCounts[activeRun.targetLabel] ?? 0) > 0)
                  return true;
                return false;
              })(),
      },
      labelGoodDecision12hStats: label12hStats,
    };
  };

  runAudit()
    .then((report) => {
      const jsonPath = path.join(DUMP_DIR, "ml-target-truth-audit.json");
      const mdPath = path.join(DUMP_DIR, "ml-target-truth-audit.md");
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
      console.log(`Wrote ${jsonPath}`);

      const md = [
        "# ML Target Truth Audit",
        "",
        `Generated: ${report.generatedAt}`,
        "",
        "## Schema target fields (MlShadowTrainingExample)",
        report.schemaTargetFields.join(", "),
        "",
        "## Population counts",
        "| Target | Count |",
        "|--------|-------|",
        ...Object.entries(report.populationCounts).map(([k, v]) => `| ${k} | ${v} |`),
        "",
        "## labelGoodDecision12h coverage",
        `- total MlShadowTrainingExample rows: ${report.labelGoodDecision12hStats.totalRows}`,
        `- rows with labelGoodDecision12h populated: ${report.labelGoodDecision12hStats.populatedTotal}`,
        `- populated via canonical builder (candidateSource != offline_historical): ${report.labelGoodDecision12hStats.populatedCanonical}`,
        `- populated via offline-historical (candidateSource = offline_historical): ${report.labelGoodDecision12hStats.populatedOffline}`,
        `- populated in last 7d: ${report.labelGoodDecision12hStats.last7dPopulated}`,
        `- populated in last 30d: ${report.labelGoodDecision12hStats.last30dPopulated}`,
        `- class balance (true/false): ${report.labelGoodDecision12hStats.positives} / ${report.labelGoodDecision12hStats.negatives}`,
        "",
        "## Registry per-target status",
        "| Key | implementationStatus | schemaPresent | canonical | offline | trainableNow | populated |",
        "|-----|----------------------|---------------|-----------|---------|--------------|-----------|",
        ...report.registryTargets.map(
          (r) =>
            `| ${r.key} | ${r.implementationStatus} | ${r.schemaPresent} | ${r.populatedByCanonicalBuilder} | ${r.populatedByOfflineHistorical} | ${r.trainableNow} | ${r.populationCount ?? "N/A"} |`
        ),
        "",
        "## Active model run",
        report.activeModelRun
          ? `- id: ${report.activeModelRun.id}\n- targetLabel: ${report.activeModelRun.targetLabel}\n- featureSetName: ${report.activeModelRun.featureSetName}\n- status: ${report.activeModelRun.status}\n- trainCount: ${report.activeModelRun.trainCount ?? "N/A"}\n- validationCount: ${report.activeModelRun.validationCount ?? "N/A"}`
          : "No ACTIVE or APPROVED shadow model.",
        "",
        "## Active model validation",
        report.activeModelValidation
          ? `- ok: ${report.activeModelValidation.ok}\n- warnings: ${report.activeModelValidation.warnings.join("; ") || "none"}\n- errors: ${report.activeModelValidation.errors.join("; ") || "none"}`
          : "N/A",
        "",
        "## Mismatches",
        report.mismatches.length ? report.mismatches.map((m) => `- ${m}`).join("\n") : "None.",
        "",
        "## Recommended corrections",
        report.recommendedCorrections.length
          ? report.recommendedCorrections.map((c) => `- ${c}`).join("\n")
          : "None.",
        "",
        "## labelGoodDecision12h",
        `- implementationStatus: ${report.summary.labelGoodDecision12h.implementationStatus}\n- populatedByCanonicalBuilder: ${report.summary.labelGoodDecision12h.populatedByCanonicalBuilder}\n- populatedByOfflineHistorical: ${report.summary.labelGoodDecision12h.populatedByOfflineHistorical}\n- trainableNow: ${report.summary.labelGoodDecision12h.trainableNow}`,
        "",
        "## Active model target trustworthy?",
        String(report.summary.activeModelTargetTrustworthy),
        "",
      ].join("\n");
      fs.writeFileSync(mdPath, md, "utf-8");
      console.log(`Wrote ${mdPath}`);
    })
    .catch((e) => {
      console.error("Audit failed:", e);
      process.exit(1);
    });
}

main();
