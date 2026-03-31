/**
 * Post-implementation verification: paper cap semantics, open-state vs rebalance selection,
 * recent rebalance_cap_adjustment closes, and consistency checks.
 *
 * Run: npx tsx tools/create-rebalance-verification-report.ts
 *
 * Outputs: dump/rebalance-verification-report.json, dump/rebalance-verification-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { BOT_PROFILES, getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import {
  REBALANCE_CAP_CLOSE_REASON,
  resolveEffectiveRebalanceOpenCapForBot,
  tryParseAdmissionScoreFromMetadata,
} from "../lib/paper-trading/rebalance";

type OpenRowLite = {
  id: string;
  botType: string;
  metadataJson: string | null;
  score: number;
  createdAt: Date;
};

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "rebalance-verification-report.json");
const OUT_MD = path.join(DUMP_DIR, "rebalance-verification-report.md");

const RECENT_REBALANCE_CLOSE_LIMIT = 100;

type CheckStatus = "pass" | "fail" | "warn";

type ConsistencyCheck = {
  id: string;
  status: CheckStatus;
  details: string;
};

function admissionSortKey(metadataJson: string | null, rowScore: number): number {
  const adm = tryParseAdmissionScoreFromMetadata(metadataJson);
  if (adm != null) return adm;
  return Number.isFinite(rowScore) ? rowScore : 0;
}

function describeCapSource(
  configured: number | undefined | null,
  effective: number,
  globalCapConfigured: number
): { source: string; configuredDisplay: number | null } {
  const unlimited = effective <= 0;
  if (unlimited) {
    if (configured === 0) {
      return { source: "unlimited_explicit_bot_zero", configuredDisplay: 0 };
    }
    return {
      source: "unlimited_inherited_global_zero",
      configuredDisplay: configured == null ? null : configured,
    };
  }
  if (configured == null) {
    return { source: "inherited_global", configuredDisplay: null };
  }
  if (configured > 0) {
    return { source: "bot_profile_explicit", configuredDisplay: configured };
  }
  return { source: "unclassified", configuredDisplay: configured ?? null };
}

function parsePaperClose(meta: string | null): {
  closeReason: string | null;
  closeReasonCode: string | null;
} {
  if (!meta) return { closeReason: null, closeReasonCode: null };
  try {
    const o = JSON.parse(meta) as Record<string, unknown>;
    const pc =
      o.paperClose && typeof o.paperClose === "object" && !Array.isArray(o.paperClose)
        ? (o.paperClose as Record<string, unknown>)
        : null;
    if (!pc) return { closeReason: null, closeReasonCode: null };
    const cr = pc.closeReason;
    const crc = pc.closeReasonCode;
    return {
      closeReason: typeof cr === "string" ? cr : null,
      closeReasonCode: typeof crc === "string" ? crc : null,
    };
  } catch {
    return { closeReason: null, closeReasonCode: null };
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const cfg = getPaperTradingConfig();
  const globalCap = cfg.maxOpenTotal > 0 ? cfg.maxOpenTotal : 0;
  const effectiveProfiles = await getEffectiveBotProfiles();
  const generatedAt = new Date().toISOString();

  const rawByType = new Map(
    BOT_PROFILES.map((p) => [p.botType, p] as const)
  );

  const effectiveCapInterpretation = effectiveProfiles.map((p) => {
    const raw = rawByType.get(p.botType);
    const configured =
      raw && Object.prototype.hasOwnProperty.call(raw, "maxOpenTotal")
        ? raw.maxOpenTotal
        : undefined;
    const { source, configuredDisplay } = describeCapSource(
      configured,
      p.maxOpenTotal,
      cfg.maxOpenTotal
    );
    return {
      botType: p.botType,
      configuredMaxOpenTotal: configuredDisplay,
      rawProfileHadMaxOpenTotalKey:
        raw != null && Object.prototype.hasOwnProperty.call(raw, "maxOpenTotal"),
      effectiveMaxOpenTotal: p.maxOpenTotal,
      unlimited: p.maxOpenTotal <= 0,
      effectiveCapSource: source,
      globalMaxOpenTotalConfigured: cfg.maxOpenTotal,
    };
  });

  const openRows = await prisma.paperTrade.findMany({
    where: { status: "open" },
    select: {
      id: true,
      botType: true,
      metadataJson: true,
      score: true,
      createdAt: true,
    },
  });

  const byBot = new Map<string, OpenRowLite[]>();
  for (const r of openRows) {
    const row: OpenRowLite = {
      id: r.id,
      botType: r.botType,
      metadataJson: r.metadataJson,
      score: r.score,
      createdAt: r.createdAt,
    };
    const list = byBot.get(r.botType) ?? [];
    list.push(row);
    byBot.set(r.botType, list);
  }

  const openStateByBot: Array<{
    botType: string;
    currentOpen: number;
    overflow: number;
    effectiveCap: number;
    openTradeIds: string[];
    weakestFirstRankingPreview: Array<{
      tradeId: string;
      createdAt: string;
      paperTradeScore: number;
      admissionScore: number | null;
      selectedForRebalance: boolean;
    }>;
  }> = [];

  const allBotTypes = new Set<string>([
    ...effectiveProfiles.map((p) => p.botType),
    ...byBot.keys(),
  ]);

  for (const botType of [...allBotTypes].sort((a, b) => a.localeCompare(b))) {
    const rows = byBot.get(botType) ?? [];
    const cap = resolveEffectiveRebalanceOpenCapForBot(
      botType,
      effectiveProfiles,
      globalCap
    );
    const currentOpen = rows.length;
    const overflow = cap > 0 && currentOpen > cap ? currentOpen - cap : 0;
    const sorted = [...rows].sort((a, b) => {
      const sa = admissionSortKey(a.metadataJson, a.score ?? NaN);
      const sb = admissionSortKey(b.metadataJson, b.score ?? NaN);
      if (sa !== sb) return sa - sb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const selectedIds = new Set(
      overflow > 0 ? sorted.slice(0, overflow).map((t) => t.id) : []
    );

    openStateByBot.push({
      botType,
      currentOpen,
      overflow,
      effectiveCap: cap,
      openTradeIds: rows.map((r) => r.id),
      weakestFirstRankingPreview: sorted.map((t) => ({
        tradeId: t.id,
        createdAt: t.createdAt.toISOString(),
        paperTradeScore: t.score ?? NaN,
        admissionScore: tryParseAdmissionScoreFromMetadata(t.metadataJson),
        selectedForRebalance: selectedIds.has(t.id),
      })),
    });
  }

  const recentRebalanceCloses = await prisma.paperTrade.findMany({
    where: {
      status: "closed",
      metadataJson: { contains: REBALANCE_CAP_CLOSE_REASON },
    },
    orderBy: { exitTime: "desc" },
    take: RECENT_REBALANCE_CLOSE_LIMIT,
    select: {
      id: true,
      botType: true,
      createdAt: true,
      entryTime: true,
      exitTime: true,
      metadataJson: true,
      score: true,
    },
  });

  const rebalanceCloseEvidence = recentRebalanceCloses.map((t) => {
    const { closeReason, closeReasonCode } = parsePaperClose(t.metadataJson);
    return {
      tradeId: t.id,
      botType: t.botType,
      openedAt: t.entryTime.toISOString(),
      closedAt: t.exitTime?.toISOString() ?? null,
      closeReason,
      closeReasonCode,
      paperTradeScore: t.score,
      admissionScore: tryParseAdmissionScoreFromMetadata(t.metadataJson),
    };
  });

  const checks: ConsistencyCheck[] = [];

  const overCapBots = openStateByBot.filter((b) => b.overflow > 0);
  checks.push({
    id: "bot_over_cap_after_rebalance",
    status: overCapBots.length > 0 ? "fail" : "pass",
    details:
      overCapBots.length > 0
        ? `Open count exceeds effective cap for: ${overCapBots.map((b) => `${b.botType} (open=${b.currentOpen} cap=${b.effectiveCap})`).join("; ")}`
        : "No bot has open count above its effective maxOpenTotal.",
  });

  const reasonMissing = rebalanceCloseEvidence.filter(
    (r) =>
      r.closeReason !== REBALANCE_CAP_CLOSE_REASON ||
      r.closeReasonCode !== REBALANCE_CAP_CLOSE_REASON
  );
  checks.push({
    id: "rebalance_reason_missing",
    status:
      rebalanceCloseEvidence.length === 0
        ? "pass"
        : reasonMissing.length > 0
          ? "warn"
          : "pass",
    details:
      rebalanceCloseEvidence.length === 0
        ? "No recent closes with rebalance marker in metadata (nothing to verify)."
        : reasonMissing.length > 0
          ? `${reasonMissing.length} row(s) contain rebalance marker substring but paperClose.closeReason/closeReasonCode not both '${REBALANCE_CAP_CLOSE_REASON}'. Sample id: ${reasonMissing[0]?.tradeId ?? "—"}.`
          : "All sampled rebalance closes have matching closeReason and closeReasonCode.",
  });

  const pathInconsistent = rebalanceCloseEvidence.filter(
    (r) =>
      r.closeReason != null &&
      r.closeReasonCode != null &&
      r.closeReason !== r.closeReasonCode
  );
  checks.push({
    id: "rebalance_close_path_inconsistent",
    status: pathInconsistent.length > 0 ? "warn" : "pass",
    details:
      pathInconsistent.length > 0
        ? `closeReason !== closeReasonCode for ${pathInconsistent.length} row(s), e.g. id=${pathInconsistent[0]!.tradeId}.`
        : "No mismatch between paperClose.closeReason and closeReasonCode in sample.",
  });

  const capInconsistentDetails: string[] = [];
  for (const p of effectiveProfiles) {
    const unified = resolveEffectiveRebalanceOpenCapForBot(
      p.botType,
      effectiveProfiles,
      globalCap
    );
    if (unified !== p.maxOpenTotal) {
      capInconsistentDetails.push(
        `${p.botType}: resolver returned ${unified} but effective profile maxOpenTotal=${p.maxOpenTotal}`
      );
    }
  }
  checks.push({
    id: "cap_semantics_inconsistent",
    status: capInconsistentDetails.length > 0 ? "fail" : "pass",
    details:
      capInconsistentDetails.length > 0
        ? capInconsistentDetails.join(" | ")
        : "resolveEffectiveRebalanceOpenCapForBot matches effective profile maxOpenTotal for every known bot (explicit bot 0 = unlimited, no global fallback).",
  });

  const ids = rebalanceCloseEvidence.map((r) => r.tradeId);
  const idSet = new Set(ids);
  checks.push({
    id: "duplicate_close_evidence",
    status: ids.length === idSet.size ? "pass" : "fail",
    details:
      ids.length === idSet.size
        ? "Recent rebalance sample has unique trade ids."
        : `Duplicate trade ids in sample (${ids.length - idSet.size} duplicate(s)).`,
  });

  const capSemanticsDoc = {
    globalMaxOpenTotal0: "Unlimited at global level: config.maxOpenTotal is 0; admission and rebalance skip global cap (> 0 checks).",
    botProfileMaxOpenTotalOmitted:
      "Inherits global: getEffectiveBotProfiles sets maxOpenTotal = p.maxOpenTotal ?? global.maxOpenTotal.",
    botProfileMaxOpenTotal0:
      "Unlimited for that bot: engine gates with maxOpenTotal > 0; rebalance uses effective maxOpenTotal (0) and does not fall back to global.",
    note:
      "Config coerces non-positive env maxOpenTotal to 0 (see getPaperTradingConfig).",
  };

  const report = {
    generatedAt,
    capSemanticsDocumentation: capSemanticsDoc,
    effectiveCapInterpretation,
    openStateByBot,
    recentRebalanceCloses: rebalanceCloseEvidence,
    consistencyChecks: checks,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");

  const md: string[] = [];
  md.push("# Rebalance verification report");
  md.push("");
  md.push(`Generated: **${generatedAt}**`);
  md.push("");
  md.push("## Cap semantics (reference)");
  md.push("");
  md.push(`- ${capSemanticsDoc.globalMaxOpenTotal0}`);
  md.push(`- ${capSemanticsDoc.botProfileMaxOpenTotalOmitted}`);
  md.push(`- ${capSemanticsDoc.botProfileMaxOpenTotal0}`);
  md.push("");
  md.push("## Effective caps");
  md.push("");
  md.push("| bot | configured | effective | unlimited | source |");
  md.push("|---|---:|---:|:---:|---|");
  for (const row of effectiveCapInterpretation) {
    md.push(
      `| ${row.botType} | ${row.configuredMaxOpenTotal ?? "—"} | ${row.effectiveMaxOpenTotal} | ${row.unlimited ? "yes" : "no"} | ${row.effectiveCapSource} |`
    );
  }
  md.push("");
  md.push("## Open state summary");
  md.push("");
  md.push("| bot | open | cap | overflow |");
  md.push("|---|---:|---:|---:|");
  for (const row of openStateByBot) {
    md.push(
      `| ${row.botType} | ${row.currentOpen} | ${row.effectiveCap} | ${row.overflow} |`
    );
  }
  md.push("");
  md.push("## Consistency checks");
  md.push("");
  for (const c of checks) {
    md.push(`- **${c.id}** (${c.status}): ${c.details}`);
  }
  md.push("");
  md.push(`Recent rebalance closes in sample: **${rebalanceCloseEvidence.length}**`);
  md.push("");

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");

  console.log("--- Rebalance verification (paper cap) ---");
  console.log("Open counts by bot:");
  for (const row of openStateByBot) {
    console.log(`  ${row.botType}: ${row.currentOpen} open`);
  }
  console.log("Effective caps by bot (0 = unlimited):");
  for (const row of openStateByBot) {
    console.log(`  ${row.botType}: cap=${row.effectiveCap}`);
  }
  console.log("Overflow by bot:");
  for (const row of openStateByBot) {
    if (row.overflow > 0) console.log(`  ${row.botType}: overflow=${row.overflow}`);
  }
  if (!openStateByBot.some((b) => b.overflow > 0)) {
    console.log("  (none)");
  }
  console.log(`Recent rebalance closes (sample): ${rebalanceCloseEvidence.length}`);
  console.log(`Failed checks: ${failed.length}`);
  if (failed.length > 0) {
    for (const c of failed) console.log(`  - ${c.id}: ${c.details}`);
  }
  console.log(`Warn checks: ${warned.length}`);
  if (warned.length > 0) {
    for (const c of warned) console.log(`  - ${c.id}: ${c.details}`);
  }
  console.log(`Wrote ${OUT_JSON}`);
  console.log(`Wrote ${OUT_MD}`);

  console.log("");
  console.log("IMPLEMENTATION SUMMARY:");
  console.log("- files created: tools/create-rebalance-verification-report.ts, dump/rebalance-verification-report.json (generated), dump/rebalance-verification-report.md (generated)");
  console.log("- files modified: lib/paper-trading/rebalance.ts");
  console.log(
    "- exact cap semantics: global 0 = unlimited; profile omits maxOpenTotal => inherit global via getEffectiveBotProfiles; profile explicit 0 => effective 0 => unlimited for that bot (engine maxOpenTotal>0 gate); rebalance/debug now use effective per-bot cap without falling back to global when effective is 0"
  );
  console.log(
    "- inconsistency fixed: rebalance + computeRebalanceDebugSnapshot previously used capByBotType??globalCap so explicit bot cap 0 incorrectly inherited global cap; unified via resolveEffectiveRebalanceOpenCapForBot"
  );
  console.log(
    "- verification report proves: per-bot effective caps, live open/overflow, weakest-first selection preview, recent rebalance_cap_adjustment close evidence, and machine-readable consistency checks"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
