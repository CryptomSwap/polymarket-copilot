import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { getActiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { loadShadowCandidatesForPaperTick, normalizePreferredFunderForShadowLoad } from "../lib/paper-trading/candidates";
import { runPaperTradingTickV1Comparable } from "../lib/paper-trading/engine";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

type TraceLike = {
  botType: string;
  recommendationId: string;
  assetId: string;
  side: string;
  score: number | null;
  admitted: boolean;
  rejectReason: string | null;
};

function keyOf(t: TraceLike): string {
  return `${t.botType}|${t.recommendationId}|${t.assetId}|${t.side}`;
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(n: number | null): string {
  return n == null ? "-" : n.toFixed(6);
}

function dominantRejectByBot(trace: TraceLike[]): Record<string, { reason: string; count: number }> {
  const byBot = new Map<string, Map<string, number>>();
  for (const t of trace) {
    if (t.admitted || !t.rejectReason) continue;
    const m = byBot.get(t.botType) ?? new Map<string, number>();
    m.set(t.rejectReason, (m.get(t.rejectReason) ?? 0) + 1);
    byBot.set(t.botType, m);
  }
  const out: Record<string, { reason: string; count: number }> = {};
  for (const [bot, reasons] of byBot) {
    const ordered = [...reasons.entries()].sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]));
    if (ordered[0]) out[bot] = { reason: ordered[0][0], count: ordered[0][1] };
  }
  return out;
}

async function main(): Promise<void> {
  const explicitFunder = process.argv[2]?.trim() || undefined;
  const preferredFunder = normalizePreferredFunderForShadowLoad(
    explicitFunder ?? (await getFunderForPaperTradingTick())
  );

  const [activeModel, profiles, loaded, initialOpenTotal] = await Promise.all([
    getActiveOrApprovedShadowModel(),
    getActiveBotProfiles(),
    loadShadowCandidatesForPaperTick({ preferredFunder }),
    prisma.paperTrade.count({ where: { status: "open" } }),
  ]);

  const initialOpenByBotEntries = await Promise.all(
    profiles.map(async (p) => [
      p.botType,
      await prisma.paperTrade.count({ where: { status: "open", botType: p.botType } }),
    ] as const)
  );
  const initialOpenByBot = Object.fromEntries(initialOpenByBotEntries);

  const v1 = await runPaperTradingTickV1Comparable({
    funderAddress: preferredFunder ?? undefined,
    preloadedCandidates: loaded.candidates,
    preloadedProfiles: profiles,
    initialOpenTotal,
    initialOpenByBot,
  });
  const v2 = await runPaperTradingTickV2({
    funderAddress: preferredFunder ?? undefined,
    dryRun: true,
    preloadedCandidates: loaded.candidates,
    preloadedShadowDiagnostics: loaded.shadowDiagnostics,
    preloadedProfiles: profiles,
    initialOpenTotal,
    initialOpenByBot,
  });

  const v1Opens = v1.trace.filter((t) => t.admitted);
  const v2Opens = v2.trace.filter((t) => t.admitted);
  const v1Set = new Set(v1Opens.map((t) => keyOf(t)));
  const v2Set = new Set(v2Opens.map((t) => keyOf(t)));
  const both = [...v1Set].filter((k) => v2Set.has(k));
  const onlyV1 = [...v1Set].filter((k) => !v2Set.has(k));
  const onlyV2 = [...v2Set].filter((k) => !v1Set.has(k));

  const v1AvgOpenScore = avg(v1Opens.map((t) => t.score).filter((x): x is number => x != null));
  const v2AvgOpenScore = avg(v2Opens.map((t) => t.score).filter((x): x is number => x != null));

  const v1OpensByBot = Object.fromEntries(
    profiles.map((p) => [p.botType, v1Opens.filter((t) => t.botType === p.botType).length])
  );
  const v2OpensByBot = Object.fromEntries(
    profiles.map((p) => [p.botType, v2Opens.filter((t) => t.botType === p.botType).length])
  );
  const v1DominantReject = dominantRejectByBot(v1.trace);
  const v2DominantReject = dominantRejectByBot(v2.trace);

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "06-v1-v2-paper-tick-comparison.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# V1 vs V2 Paper Tick Comparison");
  lines.push("");
  lines.push("## Shared run metadata");
  lines.push(`- modelRunId: ${activeModel?.run.id ?? v1.modelRunId ?? v2.modelRunId ?? "-"}`);
  lines.push(`- funder: ${loaded.shadowDiagnostics.funderUsedForLoad || preferredFunder || "-"}`);
  lines.push(`- candidate count loaded: ${loaded.candidates.length}`);
  lines.push("");
  lines.push("## V1 summary");
  lines.push(`- candidates considered: ${v1.candidatesConsidered}`);
  lines.push(`- opened count: ${v1.opened}`);
  lines.push(`- reject reason distribution: ${JSON.stringify(v1.rejectReasonDistribution)}`);
  lines.push("");
  lines.push("## V2 summary");
  lines.push(`- candidates considered: ${v2.trace.length}`);
  lines.push(`- opened count: ${v2.tradesOpened}`);
  lines.push(`- reject reason distribution: ${JSON.stringify(v2.rejectReasonDistribution)}`);
  lines.push("");
  lines.push("## Overlap analysis");
  lines.push(`- opened by both: ${both.length}`);
  lines.push(`- opened only by V1: ${onlyV1.length}`);
  lines.push(`- opened only by V2: ${onlyV2.length}`);
  lines.push("");
  lines.push("## Score comparison");
  lines.push(`- avg score of opens in V1: ${fmt(v1AvgOpenScore)}`);
  lines.push(`- avg score of opens in V2: ${fmt(v2AvgOpenScore)}`);
  lines.push("");
  lines.push("## Per-bot comparison");
  lines.push("| bot | v1 opens | v1 dominant reject | v2 opens | v2 dominant reject |");
  lines.push("| --- | ---: | --- | ---: | --- |");
  for (const p of profiles) {
    const r1 = v1DominantReject[p.botType];
    const r2 = v2DominantReject[p.botType];
    lines.push(
      `| ${p.botType} | ${v1OpensByBot[p.botType] ?? 0} | ${r1 ? `${r1.reason} (${r1.count})` : "-"} | ${v2OpensByBot[p.botType] ?? 0} | ${r2 ? `${r2.reason} (${r2.count})` : "-"} |`
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("- Comparison mode is read-only: no PaperTrade rows are created.");
  lines.push("- Both engines run on the same preloaded candidates/profile set and same initial open-cap state.");
  if (v1.errors.length > 0 || v2.errors.length > 0) {
    lines.push("- errors:");
    for (const e of [...v1.errors, ...v2.errors]) lines.push(`  - ${e}`);
  }

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
