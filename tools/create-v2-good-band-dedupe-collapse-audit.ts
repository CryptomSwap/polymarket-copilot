import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import {
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
  parseRecoThesisFromDecisionSnapshotJson,
} from "../lib/paper-trading/candidates";

type RawRow = {
  id: string;
  recommendationId: string | null;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  decisionSnapshotJson: string | null;
  createdAt: Date;
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function bandOf(price: string | null | undefined): string {
  const p = parseNum(price);
  if (p == null) return "unknown";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function marketFromDecision(decisionSnapshotJson: string | null): string | null {
  if (!decisionSnapshotJson?.trim()) return null;
  try {
    const o = JSON.parse(decisionSnapshotJson) as Record<string, unknown>;
    return typeof o.marketId === "string" && o.marketId.trim() ? o.marketId.trim() : null;
  } catch {
    return null;
  }
}

function dedupeKey(r: RawRow): string | null {
  const market = r.marketId?.trim() || marketFromDecision(r.decisionSnapshotJson);
  if (!market) return null;
  const side = r.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
  return `${market}\0${side}`;
}

type CollapseClass =
  | "replaced by newer row in same band"
  | "replaced by newer row in different band"
  | "replaced by same market+side stale row"
  | "unable to tell";

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const fallbackLookbackMinutes = Math.max(
    5,
    Number(process.env.GOOD_BAND_DEDUPE_AUDIT_LOOKBACK_MINUTES ?? "30") || 30
  );
  const preferred = normalizePreferredFunderForShadowLoad(await getFunderForPaperTradingTick());
  const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
  const funder = loaded.shadowDiagnostics.funderUsedForLoad?.trim().toLowerCase() ?? (preferred ?? "");
  const lookbackMinutes = loaded.shadowDiagnostics.lookbackMinutes || fallbackLookbackMinutes;
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);

  const rows: RawRow[] = funder
    ? await prisma.shadowCandidate.findMany({
        where: {
          funderAddress: funder,
          wasSubmitted: true,
          wasBlocked: false,
          candidateSource: "runtime_automated",
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
          id: true,
          recommendationId: true,
          marketId: true,
          side: true,
          intendedPrice: true,
          decisionSnapshotJson: true,
          createdAt: true,
        },
      })
    : [];

  const byKey = new Map<string, RawRow[]>();
  for (const r of rows) {
    const k = dedupeKey(r);
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  const target = rows.filter((r) => bandOf(r.intendedPrice) === "0.2-0.3");
  const ageMinutes = target
    .map((r) => (Date.now() - r.createdAt.getTime()) / 60000)
    .sort((a, b) => a - b);
  const q = (p: number): number | null => {
    if (!ageMinutes.length) return null;
    const i = Math.min(ageMinutes.length - 1, Math.max(0, Math.floor((ageMinutes.length - 1) * p)));
    return ageMinutes[i]!;
  };

  const collapseClassCounts = new Map<CollapseClass, number>();
  const perRowAnalysis: Array<Record<string, unknown>> = [];
  let lostCount = 0;

  for (const r of target) {
    const k = dedupeKey(r);
    if (!k) {
      perRowAnalysis.push({
        rowId: r.id,
        recommendationId: r.recommendationId,
        rowBand: bandOf(r.intendedPrice),
        dedupeKey: null,
        winnerId: null,
        classification: "unable to tell",
        reason: "no_dedupe_key",
      });
      continue;
    }
    const group = byKey.get(k) ?? [];
    const winner = group[0] ?? null;
    const isWinner = winner?.id === r.id;
    let cls: CollapseClass = "unable to tell";
    if (!isWinner && winner) {
      lostCount++;
      const winnerBand = bandOf(winner.intendedPrice);
      if (winner.createdAt.getTime() > r.createdAt.getTime() && winnerBand === "0.2-0.3") {
        cls = "replaced by newer row in same band";
      } else if (winner.createdAt.getTime() > r.createdAt.getTime() && winnerBand !== "0.2-0.3") {
        cls = "replaced by newer row in different band";
      } else if (winner.createdAt.getTime() <= r.createdAt.getTime()) {
        cls = "replaced by same market+side stale row";
      } else {
        cls = "unable to tell";
      }
      collapseClassCounts.set(cls, (collapseClassCounts.get(cls) ?? 0) + 1);
    }

    const thesis = parseRecoThesisFromDecisionSnapshotJson(r.decisionSnapshotJson);
    const wThesis = winner ? parseRecoThesisFromDecisionSnapshotJson(winner.decisionSnapshotJson) : {};
    perRowAnalysis.push({
      rowId: r.id,
      recommendationId: r.recommendationId,
      marketId: r.marketId ?? marketFromDecision(r.decisionSnapshotJson),
      side: r.side,
      rowBand: bandOf(r.intendedPrice),
      rowCreatedAt: r.createdAt.toISOString(),
      rowPrice: r.intendedPrice,
      rowThesis: thesis,
      dedupeKey: k,
      winnerId: winner?.id ?? null,
      winnerRecommendationId: winner?.recommendationId ?? null,
      winnerBand: winner ? bandOf(winner.intendedPrice) : null,
      winnerCreatedAt: winner?.createdAt.toISOString() ?? null,
      winnerPrice: winner?.intendedPrice ?? null,
      winnerThesis: wThesis,
      losesUnderCurrentSemantics: !isWinner,
      whyLoses: !isWinner
        ? "same dedupe key uses newest row winner"
        : "row is newest winner for key",
      classification: !isWinner ? cls : null,
    });
  }

  // Counterfactual: for each key pick first good-band row (0.2-0.3 then 0.4-0.6), else keep current winner.
  let keysChanged = 0;
  let currentGoodWinners = 0;
  let counterfactualGoodWinners = 0;
  for (const group of byKey.values()) {
    const current = group[0]!;
    const currentBand = bandOf(current.intendedPrice);
    if (currentBand === "0.2-0.3" || currentBand === "0.4-0.6") currentGoodWinners++;
    let counter = current;
    const firstGood = group.find((x) => bandOf(x.intendedPrice) === "0.2-0.3") ??
      group.find((x) => bandOf(x.intendedPrice) === "0.4-0.6");
    if (firstGood) counter = firstGood;
    if (counter.id !== current.id) keysChanged++;
    const cb = bandOf(counter.intendedPrice);
    if (cb === "0.2-0.3" || cb === "0.4-0.6") counterfactualGoodWinners++;
  }

  const markets = [...new Set(target.map((r) => r.marketId ?? marketFromDecision(r.decisionSnapshotJson)).filter(Boolean))];
  const recs = [...new Set(target.map((r) => r.recommendationId ?? `shadow:${r.id}`))];

  let blunt:
    | "dedupe is incorrectly eliminating distinct 0.2-0.3 opportunities"
    | "0.2-0.3 rows are mostly noisy duplicates"
    | "winner choice inside dedupe is the issue, not dedupe key itself"
    | "evidence insufficient";
  if (target.length === 0) blunt = "evidence insufficient";
  else {
    const diffBand = collapseClassCounts.get("replaced by newer row in different band") ?? 0;
    const sameBand = collapseClassCounts.get("replaced by newer row in same band") ?? 0;
    const noisyLike = sameBand;
    if (keysChanged > 0 && diffBand >= Math.ceil(target.length * 0.5)) {
      blunt = "winner choice inside dedupe is the issue, not dedupe key itself";
    } else if (noisyLike >= Math.ceil(target.length * 0.7)) {
      blunt = "0.2-0.3 rows are mostly noisy duplicates";
    } else if (lostCount > 0 && (recs.length > 1 || diffBand > 0)) {
      blunt = "dedupe is incorrectly eliminating distinct 0.2-0.3 opportunities";
    } else {
      blunt = "evidence insufficient";
    }
  }

  const lines: string[] = [];
  lines.push("# V2 good-band dedupe collapse audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Funder: ${funder || "(none)"}`);
  lines.push(`- Lookback minutes: ${lookbackMinutes}`);
  lines.push(`- Raw rows scanned: ${rows.length}`);
  lines.push("");
  lines.push("## A. Raw 0.2-0.3 rows");
  lines.push(`- Count: **${target.length}**`);
  lines.push(`- recommendationIds: **${recs.length}**`);
  lines.push(`- markets: **${markets.length}**`);
  lines.push(`- sides: **${[...new Set(target.map((r) => r.side.toUpperCase()))].join(", ") || "-" }**`);
  lines.push(
    `- createdAt age (minutes): p50 **${q(0.5)?.toFixed(2) ?? "-"}**, p90 **${q(0.9)?.toFixed(2) ?? "-"}**, max **${q(1)?.toFixed(2) ?? "-"}**`
  );
  lines.push(`- intendedPrice min/max: **${target.length ? Math.min(...target.map((r) => parseNum(r.intendedPrice) ?? 999)).toFixed(4) : "-"} / ${target.length ? Math.max(...target.map((r) => parseNum(r.intendedPrice) ?? -1)).toFixed(4) : "-"}**`);
  lines.push("");
  lines.push("## B. Dedupe-key analysis");
  lines.push("```json");
  lines.push(JSON.stringify(perRowAnalysis, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## C. Collapse classification");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        totalTargetRows: target.length,
        lostUnderCurrentSemantics: lostCount,
        classificationCounts: Object.fromEntries(collapseClassCounts.entries()),
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("## D. Counterfactual");
  lines.push(`- Keys changed if winner preference is (0.2-0.3 -> 0.4-0.6 -> current newest): **${keysChanged}**`);
  lines.push(`- Current good-band winners among dedupe keys: **${currentGoodWinners}**`);
  lines.push(`- Counterfactual good-band winners among dedupe keys: **${counterfactualGoodWinners}**`);
  lines.push(`- Net good-band winner gain: **${counterfactualGoodWinners - currentGoodWinners}**`);
  lines.push("");
  lines.push("## E. Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");
  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        funder,
        lookbackMinutes,
        rawRowsScanned: rows.length,
        targetBand: "0.2-0.3",
        targetRows: target.length,
        targetUniqueRecommendationIds: recs.length,
        targetUniqueMarkets: markets.length,
        lostUnderCurrentSemantics: lostCount,
        classificationCounts: Object.fromEntries(collapseClassCounts.entries()),
        counterfactual: {
          keysChanged,
          currentGoodWinners,
          counterfactualGoodWinners,
          netGain: counterfactualGoodWinners - currentGoodWinners,
        },
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-good-band-dedupe-collapse-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

