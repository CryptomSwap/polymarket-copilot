/**
 * Runtime governance resolver report.
 * Shows per-bot: current behavior, resolver OFF result, governance-enabled hypothetical (ON) result,
 * whether they differ, fallback chain, and confirms default behavior is preserved.
 * Writes dump/runtime-governance-resolver-report.json and .md.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { resolveBotProfile, resolveAllBotProfiles } from "../lib/paper-trading/runtime-bot-profile-resolver";
import type { EffectiveBotProfile } from "../lib/paper-trading/bot-profiles";
import {
  compareBehavioralSnapshots,
  BEHAVIORAL_PROFILE_KEYS,
  type BehavioralSnapshot,
} from "../lib/paper-trading/governance-handshake-audit";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score/score-live";
import { resolveModelSelectionForBot } from "../lib/ml/runtime-model-selection-resolver";
import { BOT_PROFILES } from "../lib/paper-trading/bot-profiles";

const DUMP_DIR = path.join(process.cwd(), "dump");

function profileToBehavioralSnapshot(p: EffectiveBotProfile): BehavioralSnapshot {
  const out: BehavioralSnapshot = {};
  for (const k of BEHAVIORAL_PROFILE_KEYS) {
    if (k in p) {
      const v = (p as Record<string, unknown>)[k];
      out[k] = v === undefined ? null : v;
    }
  }
  return out;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const [currentProfiles, champion, profileResultsOff, profileResultsOn, modelResultsOff, modelResultsOn] =
    await Promise.all([
      getEffectiveBotProfiles(),
      getActiveOrApprovedShadowModel(),
      Promise.all(
        BOT_PROFILES.map((p) => p.botType).map((botType) => resolveBotProfile(botType))
      ),
      Promise.all(
        BOT_PROFILES.map((p) => p.botType).map((botType) =>
          resolveBotProfile(botType, { forceGovernancePath: true })
        )
      ),
      Promise.all(
        BOT_PROFILES.map((p) => p.botType).map((botType) => resolveModelSelectionForBot(botType))
      ),
      Promise.all(
        BOT_PROFILES.map((p) => p.botType).map((botType) =>
          resolveModelSelectionForBot(botType, { forceGovernancePath: true })
        )
      ),
    ]);

  const botTypes = BOT_PROFILES.map((p) => p.botType);
  const currentChampionRunId = champion?.run.id ?? null;

  const perBot = botTypes.map((botType, i) => {
    const currentProfile = currentProfiles.find((p) => p.botType === botType);
    const offProfile = profileResultsOff[i];
    const onProfile = profileResultsOn[i];
    const offModel = modelResultsOff[i];
    const onModel = modelResultsOn[i];

    const currentSnapshot = currentProfile ? profileToBehavioralSnapshot(currentProfile) : {};
    const offSnapshot = profileToBehavioralSnapshot(offProfile.profile);
    const onSnapshot = profileToBehavioralSnapshot(onProfile.profile);
    const profileOffMatchesCurrent =
      !!currentProfile && compareBehavioralSnapshots(currentSnapshot, offSnapshot).mismatchFields.length === 0;
    const profileOnDiffersFromOff = compareBehavioralSnapshots(offSnapshot, onSnapshot).mismatchFields.length > 0;
    const modelOffMatchesCurrent =
      (offModel.resolvedModelRunId === currentChampionRunId) &&
      (currentChampionRunId !== null || offModel.resolvedModelRunId === null);
    const modelOnDiffersFromOff = offModel.resolvedModelRunId !== onModel.resolvedModelRunId;

    return {
      botType,
      currentBehavior: {
        profileSnapshot: currentSnapshot,
        modelRunId: currentChampionRunId,
      },
      resolverOff: {
        profile: {
          source: offProfile.source,
          fallbackUsed: offProfile.fallbackUsed,
          warnings: offProfile.warnings,
          resolvedProfileRevisionId: offProfile.resolvedProfileRevisionId,
          resolvedProfileRevisionKey: offProfile.resolvedProfileRevisionKey,
          effectiveEnabled: offProfile.effectiveEnabled,
        },
        model: {
          resolvedModelRunId: offModel.resolvedModelRunId,
          source: offModel.source,
          fallbackUsed: offModel.fallbackUsed,
          warnings: offModel.warnings,
        },
      },
      resolverOnHypothetical: {
        profile: {
          source: onProfile.source,
          fallbackUsed: onProfile.fallbackUsed,
          warnings: onProfile.warnings,
          resolvedProfileRevisionId: onProfile.resolvedProfileRevisionId,
          resolvedProfileRevisionKey: onProfile.resolvedProfileRevisionKey,
          effectiveEnabled: onProfile.effectiveEnabled,
        },
        model: {
          resolvedModelRunId: onModel.resolvedModelRunId,
          source: onModel.source,
          fallbackUsed: onModel.fallbackUsed,
          warnings: onModel.warnings,
          resolvedProfileRevisionId: onModel.resolvedProfileRevisionId,
          linkageRoleUsed: onModel.linkageRoleUsed,
          targetLabel: onModel.targetLabel,
        },
      },
      differs: {
        profileOnDiffersFromOff: profileOnDiffersFromOff,
        profileMismatchFields: profileOnDiffersFromOff
          ? compareBehavioralSnapshots(offSnapshot, onSnapshot).mismatchFields
          : [],
        modelOnDiffersFromOff: modelOnDiffersFromOff,
      },
      defaultBehaviorPreserved: {
        profileOffMatchesCurrent: profileOffMatchesCurrent,
        modelOffMatchesCurrent: modelOffMatchesCurrent,
      },
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    flags: {
      ENABLE_PAPER_RUNTIME_PROFILE_FROM_ACTIVE_REVISION: process.env.ENABLE_PAPER_RUNTIME_PROFILE_FROM_ACTIVE_REVISION === "1" || process.env.ENABLE_PAPER_RUNTIME_PROFILE_FROM_ACTIVE_REVISION === "true",
      ENABLE_PAPER_PER_BOT_MODEL_SELECTION_FROM_GOVERNANCE:
        process.env.ENABLE_PAPER_PER_BOT_MODEL_SELECTION_FROM_GOVERNANCE === "1" ||
        process.env.ENABLE_PAPER_PER_BOT_MODEL_SELECTION_FROM_GOVERNANCE === "true",
    },
    currentGlobalChampionModelRunId: currentChampionRunId,
    perBot,
    summary: {
      allProfileOffMatchesCurrent: perBot.every((b) => b.defaultBehaviorPreserved.profileOffMatchesCurrent),
      allModelOffMatchesCurrent: perBot.every((b) => b.defaultBehaviorPreserved.modelOffMatchesCurrent),
      anyProfileWouldChangeWithGovernance: perBot.some((b) => b.differs.profileOnDiffersFromOff),
      anyModelWouldChangeWithGovernance: perBot.some((b) => b.differs.modelOnDiffersFromOff),
    },
  };

  const jsonPath = path.join(DUMP_DIR, "runtime-governance-resolver-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = renderMarkdown(report);
  const mdPath = path.join(DUMP_DIR, "runtime-governance-resolver-report.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

function renderMarkdown(report: {
  generatedAt: string;
  flags: Record<string, boolean>;
  currentGlobalChampionModelRunId: string | null;
  perBot: Array<{
    botType: string;
    resolverOff: unknown;
    resolverOnHypothetical: unknown;
    differs: { profileOnDiffersFromOff: boolean; profileMismatchFields: string[]; modelOnDiffersFromOff: boolean };
    defaultBehaviorPreserved: { profileOffMatchesCurrent: boolean; modelOffMatchesCurrent: boolean };
  }>;
  summary: Record<string, boolean>;
}): string {
  const lines: string[] = [];
  lines.push("# Runtime governance resolver report");
  lines.push("");
  lines.push("## 1) Fallback chains");
  lines.push("");
  lines.push("**Bot profile:** OFF = BOT_PROFILES + global config + env. ON = ACTIVE revision (if valid) + env overrides → else current behavior.");
  lines.push("**Model selection:** OFF = global champion (getActiveOrApprovedShadowModel). ON = INTENDED_ACTIVE link for ACTIVE revision (if usable) → else global champion.");
  lines.push("");
  lines.push("## 2) Feature flags (current env)");
  lines.push("");
  for (const [k, v] of Object.entries(report.flags)) {
    lines.push("- " + k + ": " + (v ? "**ON**" : "OFF"));
  }
  lines.push("");
  lines.push("## 3) Global champion");
  lines.push("");
  lines.push("Current runtime champion model run id: " + (report.currentGlobalChampionModelRunId ?? "—") + ".");
  lines.push("");
  lines.push("## 4) Per-bot summary");
  lines.push("");
  lines.push("| Bot | Profile OFF source | Profile ON source | Profile differs? | Model OFF | Model ON | Model differs? | Default preserved? |");
  lines.push("|-----|-------------------|-------------------|------------------|-----------|----------|----------------|---------------------|");
  for (const b of report.perBot) {
    const po = b.resolverOff as { profile: { source: string }; model: { resolvedModelRunId: string | null } };
    const pn = b.resolverOnHypothetical as { profile: { source: string }; model: { resolvedModelRunId: string | null } };
    const profileDiff = b.differs.profileOnDiffersFromOff ? "yes" : "no";
    const modelDiff = b.differs.modelOnDiffersFromOff ? "yes" : "no";
    const preserved =
      b.defaultBehaviorPreserved.profileOffMatchesCurrent && b.defaultBehaviorPreserved.modelOffMatchesCurrent
        ? "yes"
        : "no";
    lines.push(
      "| " +
        b.botType +
        " | " +
        po.profile.source +
        " | " +
        pn.profile.source +
        " | " +
        profileDiff +
        " | " +
        (po.model.resolvedModelRunId ?? "—") +
        " | " +
        (pn.model.resolvedModelRunId ?? "—") +
        " | " +
        modelDiff +
        " | " +
        preserved +
        " |"
    );
  }
  lines.push("");
  lines.push("## 5) Default behavior preserved?");
  lines.push("");
  lines.push("- All profile OFF results match current behavior: " + (report.summary.allProfileOffMatchesCurrent ? "yes" : "no"));
  lines.push("- All model OFF results match current champion: " + (report.summary.allModelOffMatchesCurrent ? "yes" : "no"));
  lines.push("");
  lines.push("## 6) Hypothetical governance impact");
  lines.push("");
  lines.push("- With flags ON, profile would change for at least one bot: " + (report.summary.anyProfileWouldChangeWithGovernance ? "yes" : "no"));
  lines.push("- With flags ON, model would change for at least one bot: " + (report.summary.anyModelWouldChangeWithGovernance ? "yes" : "no"));
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Resolvers are off by default. Runtime behavior is unchanged unless flags are explicitly enabled.*");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
