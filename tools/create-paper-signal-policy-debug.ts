/**
 * Read-only debug dump for paper signal policy.
 * Shows effective disabled signal types, score multipliers, and recent candidate score adjustments.
 */
import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { filterShadowCandidatesForProfile, getPaperTradingCandidates } from "../lib/paper-trading/candidates";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { scoreShadowCandidate } from "../lib/ml/shadow-score";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "paper-signal-policy-debug.json");
const SAMPLE_N = Math.min(200, Math.max(20, Number(process.env.PAPER_SIGNAL_POLICY_DEBUG_N ?? "60") || 60));

function paperSignalTypeFromExecutionPolicy(executionPolicyState: string | null | undefined): string {
  const t = (executionPolicyState ?? "").trim().toLowerCase();
  return t || "unknown";
}

function paperRuleBasedFallbackAdmissionScore(stagedPolicyState: string | null | undefined): number {
  const s = (stagedPolicyState ?? "").toUpperCase().trim();
  if (s === "ALLOW_HIGH_CONVICTION") return 0.85;
  if (s === "ALLOW_NORMAL") return 0.7;
  if (s === "ALLOW_SMALL") return 0.6;
  if (s === "TRIM" || s === "EXIT") return 0.65;
  if (s === "REVIEW_REQUIRED") return 0.55;
  if (s === "BLOCK") return 0;
  return 0.65;
}

function resolveSignalMultiplier(
  botType: string,
  signalType: string,
  cfg: ReturnType<typeof getPaperTradingConfig>
): { multiplier: number; source: "bot_specific" | "global" | "default" } {
  const botNorm = (botType ?? "").trim().toLowerCase();
  const botMap = cfg.paperTradingBotSignalScoreMultipliers[botNorm];
  const botM = botMap?.[signalType];
  if (Number.isFinite(botM)) return { multiplier: botM, source: "bot_specific" };
  const g = cfg.paperTradingSignalScoreMultipliers[signalType];
  if (Number.isFinite(g)) return { multiplier: g, source: "global" };
  return { multiplier: 1, source: "default" };
}

function signalDisabledByBotPolicy(
  botType: string,
  signalType: string,
  cfg: ReturnType<typeof getPaperTradingConfig>
): boolean {
  const botNorm = (botType ?? "").trim().toLowerCase();
  const list = cfg.paperTradingBotDisableSignalTypes[botNorm];
  return Array.isArray(list) && list.includes(signalType);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const cfg = getPaperTradingConfig();
  const candidates = await getPaperTradingCandidates();
  const profiles = (await getEffectiveBotProfiles()).filter((p) => p.effectiveEnabled);
  const sample = candidates.slice(0, SAMPLE_N);

  const sampled: Array<{
    recommendationId: string;
    shadowCandidateId: string | null;
    botType: string;
    assetId: string;
    side: string;
    signalType: string;
    originalScore: number | null;
    adjustedScore: number | null;
    skippedBySignalPolicy: boolean;
    signalDisabledByBotPolicy: boolean;
    signalScoreMultiplier: number;
    signalScoreMultiplierSource: "bot_specific" | "global" | "default";
    scoreSource: "ml_raw" | "ml_calibrated" | "fallback";
  }> = [];

  for (const c of sample) {
    const signalType = paperSignalTypeFromExecutionPolicy(c.executionPolicyState);
    const skippedBySignalPolicy = cfg.paperTradingDisableSignalTypes.includes(signalType);
    const eligibleBotTypes = profiles
      .filter((p) => filterShadowCandidatesForProfile([c], p).length > 0)
      .map((p) => p.botType);
    const scopedBotTypes = eligibleBotTypes.length > 0 ? eligibleBotTypes : ["default"];

    let originalScore: number | null = null;
    let scoreSource: "ml_raw" | "ml_calibrated" | "fallback" = "fallback";
    const fallbackScore = paperRuleBasedFallbackAdmissionScore(c.paperStagedPolicyState);

    if (!skippedBySignalPolicy) {
      if (cfg.paperTradingUseMl) {
        const s = await scoreShadowCandidate(c.shadowInput);
        if (s.success && s.result) {
          originalScore = cfg.paperShadowUseCalibratedScoreForPaper
            ? s.result.shadowMlScoreCalibrated
            : s.result.shadowMlScore;
          scoreSource = cfg.paperShadowUseCalibratedScoreForPaper ? "ml_calibrated" : "ml_raw";
        } else {
          originalScore = null;
        }
      } else {
        originalScore = fallbackScore;
        scoreSource = "fallback";
      }
    }

    for (const botType of scopedBotTypes) {
      const resolved = resolveSignalMultiplier(botType, signalType, cfg);
      const botPolicySkip = signalDisabledByBotPolicy(botType, signalType, cfg);
      sampled.push({
        recommendationId: c.recommendationId,
        shadowCandidateId: c.shadowCandidateId ?? null,
        botType,
        assetId: c.assetId,
        side: c.side,
        signalType,
        originalScore,
        adjustedScore: originalScore == null ? null : originalScore * resolved.multiplier,
        skippedBySignalPolicy,
        signalDisabledByBotPolicy: botPolicySkip,
        signalScoreMultiplier: resolved.multiplier,
        signalScoreMultiplierSource: resolved.source,
        scoreSource,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    policy: {
      disabledSignalTypes: cfg.paperTradingDisableSignalTypes,
      botDisabledSignalTypes: cfg.paperTradingBotDisableSignalTypes,
      signalScoreMultipliers: cfg.paperTradingSignalScoreMultipliers,
      botSignalScoreMultipliers: cfg.paperTradingBotSignalScoreMultipliers,
      defaultsWhenUnset: {
        disabledSignalTypes: [],
        botDisabledSignalTypes: {},
        signalScoreMultipliers: {},
        botSignalScoreMultipliers: {},
      },
    },
    sampleCount: sampled.length,
    candidateSample: sampled,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");
  console.log("[paper-signal-policy-debug] wrote", OUT_JSON);
  console.log(
    "[paper-signal-policy-debug] summary",
    JSON.stringify(
      {
        disabledSignalTypes: report.policy.disabledSignalTypes,
        multipliers: report.policy.signalScoreMultipliers,
        sampleCount: report.sampleCount,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("[paper-signal-policy-debug] failed", err);
  process.exitCode = 1;
});

