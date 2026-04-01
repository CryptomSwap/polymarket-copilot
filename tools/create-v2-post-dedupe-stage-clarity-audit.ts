import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import {
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
  type PaperTradingCandidate,
} from "../lib/paper-trading/candidates";

type Band = "<0.1" | "0.1-0.2" | "0.2-0.3" | "0.3-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-0.9" | ">=0.9" | "unknown";
type Stage = "raw" | "groupedByKey" | "winnersBeforePreference" | "winnersAfterPreference" | "finalSelected";

type RawRow = {
  id: string;
  recommendationId: string | null;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  decisionSnapshotJson: string | null;
  createdAt: Date;
};

const ALL_BANDS: Band[] = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9", "unknown"];

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function classifyBand(price: string | null | undefined): Band {
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

function resolvedMarket(row: RawRow): string | null {
  return row.marketId?.trim() || marketFromDecision(row.decisionSnapshotJson);
}

function dedupeKey(row: RawRow): string | null {
  const m = resolvedMarket(row);
  if (!m) return null;
  const side = row.side.toUpperCase() === "SELL" ? "SELL" : "BUY";
  return `${m}\0${side}`;
}

function emptyBandCounts(): Record<Band, number> {
  return {
    "<0.1": 0,
    "0.1-0.2": 0,
    "0.2-0.3": 0,
    "0.3-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 0,
    "0.8-0.9": 0,
    ">=0.9": 0,
    unknown: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preferGoodBandWinner(group: RawRow[]): RawRow {
  return (
    group.find((r) => classifyBand(r.intendedPrice) === "0.2-0.3") ??
    group.find((r) => classifyBand(r.intendedPrice) === "0.4-0.6") ??
    group[0]!
  );
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, Number(process.env.POST_DEDUPE_STAGE_CLARITY_TICKS ?? "24") || 24);
  const cadenceMs = Math.max(0, Number(process.env.POST_DEDUPE_STAGE_CLARITY_CADENCE_MS ?? "500") || 500);
  const preferred = normalizePreferredFunderForShadowLoad(await getFunderForPaperTradingTick());

  const stageCounts: Record<Stage, Record<Band, number>> = {
    raw: emptyBandCounts(),
    groupedByKey: emptyBandCounts(),
    winnersBeforePreference: emptyBandCounts(),
    winnersAfterPreference: emptyBandCounts(),
    finalSelected: emptyBandCounts(),
  };
  const stageUniqueMarkets: Record<Stage, Record<Band, Set<string>>> = {
    raw: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
    groupedByKey: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
    winnersBeforePreference: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
    winnersAfterPreference: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
    finalSelected: Object.fromEntries(ALL_BANDS.map((b) => [b, new Set<string>()])) as Record<Band, Set<string>>,
  };

  let totalKeys = 0;
  let keysChangedByPreference = 0;
  const changedBandFromTo = new Map<string, number>();

  for (let tick = 0; tick < ticks; tick++) {
    const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
    const funder = loaded.shadowDiagnostics.funderUsedForLoad?.trim().toLowerCase() ?? "";
    const lookbackMinutes = loaded.shadowDiagnostics.lookbackMinutes;
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);

    const rawRows: RawRow[] = funder
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

    const groups = new Map<string, RawRow[]>();
    for (const row of rawRows) {
      const b = classifyBand(row.intendedPrice);
      stageCounts.raw[b]++;
      const m = resolvedMarket(row) ?? "unknown_market";
      stageUniqueMarkets.raw[b].add(m);

      const k = dedupeKey(row);
      if (!k) continue;
      stageCounts.groupedByKey[b]++;
      stageUniqueMarkets.groupedByKey[b].add(m);
      const arr = groups.get(k) ?? [];
      arr.push(row);
      groups.set(k, arr);
    }

    for (const [_, group] of groups.entries()) {
      totalKeys++;
      const before = group[0]!;
      const after = preferGoodBandWinner(group);
      const beforeBand = classifyBand(before.intendedPrice);
      const afterBand = classifyBand(after.intendedPrice);
      const beforeMarket = resolvedMarket(before) ?? "unknown_market";
      const afterMarket = resolvedMarket(after) ?? "unknown_market";
      stageCounts.winnersBeforePreference[beforeBand]++;
      stageCounts.winnersAfterPreference[afterBand]++;
      stageUniqueMarkets.winnersBeforePreference[beforeBand].add(beforeMarket);
      stageUniqueMarkets.winnersAfterPreference[afterBand].add(afterMarket);
      if (before.id !== after.id) {
        keysChangedByPreference++;
        const key = `${beforeBand} -> ${afterBand}`;
        changedBandFromTo.set(key, (changedBandFromTo.get(key) ?? 0) + 1);
      }
    }

    for (const c of loaded.candidates) {
      const b = classifyBand(c.entryPrice);
      stageCounts.finalSelected[b]++;
      stageUniqueMarkets.finalSelected[b].add(c.marketId);
    }

    if (tick < ticks - 1 && cadenceMs > 0) await sleep(cadenceMs);
  }

  const stageTotal = (s: Stage): number => ALL_BANDS.reduce((acc, b) => acc + stageCounts[s][b], 0);
  const stageOrder: Stage[] = ["raw", "groupedByKey", "winnersBeforePreference", "winnersAfterPreference", "finalSelected"];
  const firstStageMissing = (band: Band): Stage | "none" => {
    for (const stage of stageOrder) {
      if (stageCounts[stage][band] === 0) return stage;
    }
    return "none";
  };

  const whereBandEnters = (band: Band): Stage | "never" => {
    for (const stage of stageOrder) {
      if (stageCounts[stage][band] > 0) return stage;
    }
    return "never";
  };

  const potentialMislabeledAudit =
    stageCounts.winnersBeforePreference["0.2-0.3"] === 0 &&
    stageCounts.winnersAfterPreference["0.2-0.3"] > 0 &&
    stageCounts.finalSelected["0.2-0.3"] > 0;

  const lines: string[] = [];
  lines.push("# V2 post-dedupe stage clarity audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- Preferred funder hint: ${preferred ?? "(auto)"}`);
  lines.push(`- Env PAPER_SHADOW_DEDUPE_PREFER_GOOD_BANDS: ${process.env.PAPER_SHADOW_DEDUPE_PREFER_GOOD_BANDS ?? "(unset)"}`);
  lines.push("");

  lines.push("## A. Stage definitions");
  lines.push("- `raw`: all runtime_automated submitted/unblocked rows in lookback (up to 500, newest-first)");
  lines.push("- `groupedByKey`: raw rows that have a resolvable dedupe key (`marketId+side`), before any winner selection");
  lines.push("- `winnersBeforePreference`: one winner per dedupe key using current legacy semantics (newest row wins)");
  lines.push("- `winnersAfterPreference`: one winner per dedupe key using good-band preference (0.2-0.3, then 0.4-0.6, else newest)");
  lines.push("- `finalSelected`: output of `loadShadowCandidatesForPaperTick` after downstream selection/bias steps");
  lines.push("");

  lines.push("## B. Counts by stage and band");
  lines.push("| stage | total rows | 0.2-0.3 rows | 0.2-0.3 unique markets | 0.4-0.6 rows | 0.4-0.6 unique markets |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const stage of stageOrder) {
    lines.push(
      `| ${stage} | ${stageTotal(stage)} | ${stageCounts[stage]["0.2-0.3"]} | ${stageUniqueMarkets[stage]["0.2-0.3"].size} | ${stageCounts[stage]["0.4-0.6"]} | ${stageUniqueMarkets[stage]["0.4-0.6"].size} |`
    );
  }
  lines.push("");

  lines.push("## C. Winner-choice impact");
  lines.push(`- dedupe keys evaluated: **${totalKeys}**`);
  lines.push(`- keys with winner changed by preference: **${keysChangedByPreference}**`);
  lines.push("- changed winner band transitions:");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries([...changedBandFromTo.entries()].sort((a, b) => b[1] - a[1])), null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## D. Stage-entry / stage-disappearance for target bands");
  lines.push(`- 0.2-0.3 first appears at stage: **${whereBandEnters("0.2-0.3")}**`);
  lines.push(`- 0.2-0.3 first missing stage: **${firstStageMissing("0.2-0.3")}**`);
  lines.push(`- 0.4-0.6 first appears at stage: **${whereBandEnters("0.4-0.6")}**`);
  lines.push(`- 0.4-0.6 first missing stage: **${firstStageMissing("0.4-0.6")}**`);
  lines.push("");

  lines.push("## E. Interpretation");
  if (stageCounts.winnersAfterPreference["0.2-0.3"] > stageCounts.winnersBeforePreference["0.2-0.3"]) {
    lines.push(
      `- 0.2-0.3 now enters at dedupe winner selection stage via preference: winnersBefore=${stageCounts.winnersBeforePreference["0.2-0.3"]}, winnersAfter=${stageCounts.winnersAfterPreference["0.2-0.3"]}.`
    );
  } else {
    lines.push("- 0.2-0.3 does not materially increase at winner-selection stage in this sample.");
  }
  if (stageCounts.raw["0.4-0.6"] === 0) {
    lines.push("- 0.4-0.6 absence is upstream supply absence (raw=0), not a downstream selection drop.");
  } else if (stageCounts.winnersAfterPreference["0.4-0.6"] === 0) {
    lines.push("- 0.4-0.6 exists upstream but does not survive winner selection.");
  } else if (stageCounts.finalSelected["0.4-0.6"] === 0) {
    lines.push("- 0.4-0.6 survives winner selection but is removed in downstream final selection/bias.");
  } else {
    lines.push("- 0.4-0.6 survives into final selected in this sample.");
  }
  lines.push(
    potentialMislabeledAudit
      ? "- At least one existing audit likely mislabels pre-vs-post preference dedupe winners (shows deduped 0.2-0.3=0 while final 0.2-0.3>0)."
      : "- No pre-vs-post dedupe winner labeling mismatch detected in this sample."
  );
  lines.push("");

  const blunt =
    stageCounts.raw["0.4-0.6"] === 0 && stageCounts.winnersAfterPreference["0.2-0.3"] > 0
      ? "winner preference fixes 0.2-0.3 at dedupe, but broader good-band scarcity is upstream supply (0.4-0.6 missing at raw)"
      : stageCounts.winnersAfterPreference["0.2-0.3"] > stageCounts.winnersBeforePreference["0.2-0.3"]
        ? "winner preference helps at dedupe stage, but broader pool size/rotation remains a downstream constraint"
        : "evidence insufficient";
  lines.push("## F. Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-post-dedupe-stage-clarity-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error("Failed to build post-dedupe stage clarity audit:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

