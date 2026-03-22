/**
 * ShadowCandidate → paper_trading_tick bridge audit.
 * Writes dump/paper-tick-shadowcandidate-bridge-report.{json,md}
 *
 * Usage: npx tsx tools/create-paper-tick-shadowcandidate-bridge-report.ts [--run-tick]
 */

import * as fs from "fs";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import {
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
} from "../lib/paper-trading/candidates";
import { runPaperTradingTick } from "../lib/paper-trading/engine";

const OUT_JSON = path.join(process.cwd(), "dump", "paper-tick-shadowcandidate-bridge-report.json");
const OUT_MD = path.join(process.cwd(), "dump", "paper-tick-shadowcandidate-bridge-report.md");

async function main(): Promise<void> {
  const runTick = process.argv.includes("--run-tick");
  const config = getPaperTradingConfig();

  let dbError: string | null = null;
  let active: Awaited<ReturnType<typeof getActiveOrApprovedShadowModel>> = null;
  let preferredRaw: string | null = null;
  let countPrimary = 0;
  let countExt = 0;
  let topSubmitters: { funderAddress: string; _count: { id: number } }[] = [];
  let loaderDryRun: Awaited<ReturnType<typeof loadShadowCandidatesForPaperTick>> | null = null;
  let tickResult: Awaited<ReturnType<typeof runPaperTradingTick>> | null = null;
  let state: Awaited<ReturnType<typeof prisma.paperTradingState.findUnique>> = null;

  const pushErr = (e: unknown): void => {
    const m = e instanceof Error ? e.message : String(e);
    dbError = dbError ? `${dbError}; ${m}` : m;
  };

  try {
    active = await getActiveOrApprovedShadowModel();
  } catch (e) {
    pushErr(e);
  }
  try {
    preferredRaw = await getFunderForPaperTradingTick();
  } catch (e) {
    pushErr(e);
  }

  const preferred = normalizePreferredFunderForShadowLoad(preferredRaw);

  const L = config.shadowLookbackMinutes;
  const extL = config.shadowTickExtendedLookbackMinutes;
  const sincePrimary = new Date(Date.now() - L * 60 * 1000);
  const sinceExt = new Date(Date.now() - Math.max(L, extL > 0 ? extL : L) * 60 * 1000);

  try {
    const results = await Promise.all([
      prisma.shadowCandidate.count({
        where: {
          wasSubmitted: true,
          wasBlocked: false,
          candidateSource: "runtime_automated",
          createdAt: { gte: sincePrimary },
        },
      }),
      prisma.shadowCandidate.count({
        where: {
          wasSubmitted: true,
          wasBlocked: false,
          candidateSource: "runtime_automated",
          createdAt: { gte: sinceExt },
        },
      }),
      prisma.shadowCandidate.groupBy({
        by: ["funderAddress"],
        where: {
          wasSubmitted: true,
          wasBlocked: false,
          candidateSource: "runtime_automated",
          createdAt: { gte: sinceExt },
        },
        _count: { id: true },
      }),
    ]);
    countPrimary = results[0];
    countExt = results[1];
    topSubmitters = results[2];
    topSubmitters.sort((a, b) => b._count.id - a._count.id);
    loaderDryRun = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
    if (runTick) {
      tickResult = await runPaperTradingTick(preferredRaw ?? undefined);
    }
    state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
  } catch (e) {
    pushErr(e);
  }

  const topSubmittersSample = topSubmitters.slice(0, 8).map((t) => ({
    funderAddress: t.funderAddress,
    count: t._count.id,
  }));
  let lastTickParsed: Record<string, unknown> | null = null;
  if (state?.lastOpenTickResultJson) {
    try {
      lastTickParsed = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
    } catch {
      lastTickParsed = { parseError: true };
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runTick,
    config: {
      shadowLookbackMinutes: config.shadowLookbackMinutes,
      shadowTickExtendedLookbackMinutes: config.shadowTickExtendedLookbackMinutes,
      paperTickShadowFunderFallback: config.paperTickShadowFunderFallback,
      threshold: config.threshold,
      enabled: config.enabled,
    },
    model: active
      ? { modelRunId: active.run.id, targetLabel: active.run.targetLabel, featureSetName: active.run.featureSetName }
      : null,
    funderResolution: {
      getFunderForPaperTradingTick: preferredRaw,
      normalizedPreferred: preferred,
    },
    shadowCounts: {
      runtimeSubmittedUnblockedPrimaryWindow: countPrimary,
      runtimeSubmittedUnblockedExtendedWindow: countExt,
      primarySince: sincePrimary.toISOString(),
      extendedSince: sinceExt.toISOString(),
    },
    topSubmittersSample,
    dbError,
    loaderDryRun: loaderDryRun
      ? {
          candidatesLoaded: loaderDryRun.candidates.length,
          shadowDiagnostics: loaderDryRun.shadowDiagnostics,
        }
      : null,
    tickInvocation: tickResult,
    paperTradingState: state
      ? {
          lastOpenTickAt: state.lastOpenTickAt?.toISOString() ?? null,
          lastOpenTickError: state.lastOpenTickError,
          lastOpenTickResultSummary: lastTickParsed
            ? {
                opened: lastTickParsed.opened,
                candidatesLoaded: lastTickParsed.candidatesLoaded,
                candidatesScored: lastTickParsed.candidatesScored,
                aboveThresholdCount: lastTickParsed.aboveThresholdCount,
                tickProof: lastTickParsed.tickProof,
                funderUsedForCandidateLoad: lastTickParsed.funderUsedForCandidateLoad,
                shadowCandidateIds: Array.isArray(lastTickParsed.shadowCandidateIds)
                  ? (lastTickParsed.shadowCandidateIds as string[]).slice(0, 12)
                  : lastTickParsed.shadowCandidateIds,
              }
            : null,
        }
      : null,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper tick — ShadowCandidate bridge report");
  md.push("");
  md.push(`**Generated:** ${report.generatedAt}`);
  md.push(`**--run-tick:** ${runTick}`);
  md.push("");
  md.push("## Config");
  md.push("");
  md.push(`- shadowLookbackMinutes: ${config.shadowLookbackMinutes}`);
  md.push(`- shadowTickExtendedLookbackMinutes: ${config.shadowTickExtendedLookbackMinutes}`);
  md.push(`- paperTickShadowFunderFallback: ${config.paperTickShadowFunderFallback}`);
  md.push(`- paper trading enabled: ${config.enabled}`);
  md.push("");
  if (dbError) {
    md.push("## Database / runtime error");
    md.push("");
    md.push("```");
    md.push(dbError);
    md.push("```");
    md.push("");
  }
  md.push("## Model");
  md.push("");
  md.push(active ? `- ACTIVE/APPROVED: \`${active.run.id}\` (${active.run.targetLabel})` : "- No ACTIVE/APPROVED shadow model");
  md.push("");
  md.push("## Funder resolution");
  md.push("");
  md.push(`- getFunderForPaperTradingTick: \`${preferredRaw ?? "null"}\``);
  md.push(`- normalized preferred (null → auto top submitter): \`${preferred ?? "null"}\``);
  md.push("");
  md.push("## ShadowCandidate counts");
  md.push("");
  md.push(`- Submitted runtime rows (primary ${L}m window): **${countPrimary}**`);
  md.push(`- Submitted runtime rows (extended window to ${sinceExt.toISOString()}): **${countExt}**`);
  md.push("");
  md.push("### Top submitters (extended window)");
  md.push("");
  for (const t of topSubmittersSample) {
    md.push(`- \`${t.funderAddress}\`: ${t.count}`);
  }
  md.push("");
  md.push("## Loader dry run (loadShadowCandidatesForPaperTick)");
  md.push("");
  if (loaderDryRun) {
    md.push(`- candidatesLoaded: **${loaderDryRun.candidates.length}**`);
    md.push(`- shadowRowsQueried: **${loaderDryRun.shadowDiagnostics.shadowRowsQueried}**`);
    md.push(`- funderUsedForLoad: \`${loaderDryRun.shadowDiagnostics.funderUsedForLoad ?? ""}\``);
    md.push(`- usedFunderFallback: **${loaderDryRun.shadowDiagnostics.usedFunderFallback ?? false}**`);
    md.push(`- zeroCandidatesReason: \`${loaderDryRun.shadowDiagnostics.zeroCandidatesReason}\``);
    md.push(`- candidateIds (sample): ${loaderDryRun.shadowDiagnostics.candidateIds.slice(0, 8).join(", ") || "—"}`);
  } else {
    md.push("— (skipped: database unavailable or query failed)");
  }
  md.push("");
  if (tickResult) {
    md.push("## Live tick (--run-tick)");
    md.push("");
    md.push(`- opened: **${tickResult.opened}**`);
    md.push(`- candidatesLoaded: **${tickResult.candidatesLoaded}**`);
    md.push(`- candidatesScored: **${tickResult.candidatesScored}**`);
    md.push(`- aboveThresholdCount: **${tickResult.aboveThresholdCount}**`);
    md.push(`- funderUsedForCandidateLoad: \`${tickResult.funderUsedForCandidateLoad ?? ""}\``);
    if (tickResult.tickProof) {
      md.push("");
      md.push("### tickProof");
      md.push("");
      md.push("```json");
      md.push(JSON.stringify(tickResult.tickProof, null, 2));
      md.push("```");
    }
    md.push("");
  }
  md.push("## Last persisted PaperTradingState (summary)");
  md.push("");
  if (report.paperTradingState?.lastOpenTickResultSummary) {
    md.push("```json");
    md.push(JSON.stringify(report.paperTradingState.lastOpenTickResultSummary, null, 2));
    md.push("```");
  } else {
    md.push("—");
  }
  md.push("");

  fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");
  console.info("Wrote", OUT_JSON);
  console.info("Wrote", OUT_MD);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
