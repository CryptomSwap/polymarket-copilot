import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import { normalizePreferredFunderForShadowLoad } from "../lib/paper-trading/candidates";

type Band = "<0.1" | "0.1-0.2" | "0.2-0.3" | "0.3-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-0.9" | ">=0.9" | "unknown";
type WindowKey = "1h" | "6h" | "24h";
type Stage = "recommendation" | "orderIntent" | "shadowCandidate";

const ALL_BANDS: Band[] = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9", "unknown"];
const WINDOWS: Record<WindowKey, number> = { "1h": 60, "6h": 360, "24h": 1440 };

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function classifyBandFromNum(n: number | null): Band {
  if (n == null) return "unknown";
  if (n < 0.1) return "<0.1";
  if (n < 0.2) return "0.1-0.2";
  if (n < 0.3) return "0.2-0.3";
  if (n < 0.4) return "0.3-0.4";
  if (n < 0.6) return "0.4-0.6";
  if (n < 0.8) return "0.6-0.8";
  if (n < 0.9) return "0.8-0.9";
  return ">=0.9";
}

function classifyBand(price: string | null | undefined): Band {
  return classifyBandFromNum(parseNum(price));
}

function recommendationBand(suggestedEntryMin: string | null, suggestedEntryMax: string | null): Band {
  const min = parseNum(suggestedEntryMin);
  const max = parseNum(suggestedEntryMax);
  if (min != null && max != null) return classifyBandFromNum((min + max) / 2);
  if (min != null) return classifyBandFromNum(min);
  if (max != null) return classifyBandFromNum(max);
  return "unknown";
}

function emptyCounts(): Record<Band, number> {
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

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const preferred = normalizePreferredFunderForShadowLoad(await getFunderForPaperTradingTick());
  const funder = preferred?.trim().toLowerCase() ?? "";
  const now = Date.now();

  const byWindow: Record<WindowKey, Record<Band, number>> = {
    "1h": emptyCounts(),
    "6h": emptyCounts(),
    "24h": emptyCounts(),
  };
  const stageByWindow: Record<WindowKey, Record<Stage, Record<Band, number>>> = {
    "1h": { recommendation: emptyCounts(), orderIntent: emptyCounts(), shadowCandidate: emptyCounts() },
    "6h": { recommendation: emptyCounts(), orderIntent: emptyCounts(), shadowCandidate: emptyCounts() },
    "24h": { recommendation: emptyCounts(), orderIntent: emptyCounts(), shadowCandidate: emptyCounts() },
  };
  const shadowMidMarkets24h = new Map<string, number>();
  const shadowMidMarketsPrev24h = new Map<string, number>();

  for (const [windowKey, minutes] of Object.entries(WINDOWS) as [WindowKey, number][]) {
    const since = new Date(now - minutes * 60 * 1000);

    const shadows = await prisma.shadowCandidate.findMany({
      where: {
        funderAddress: funder,
        candidateSource: "runtime_automated",
        wasSubmitted: true,
        wasBlocked: false,
        createdAt: { gte: since },
      },
      select: { intendedPrice: true, marketId: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });
    for (const s of shadows) {
      const b = classifyBand(s.intendedPrice);
      byWindow[windowKey][b]++;
      stageByWindow[windowKey].shadowCandidate[b]++;
      if (windowKey === "24h" && b === "0.4-0.6" && s.marketId?.trim()) {
        shadowMidMarkets24h.set(s.marketId.trim(), (shadowMidMarkets24h.get(s.marketId.trim()) ?? 0) + 1);
      }
    }

    const intents = await prisma.orderIntent.findMany({
      where: {
        funderAddress: funder,
        source: "runtime_automated",
        createdAt: { gte: since },
      },
      select: { limitPrice: true },
      take: 10000,
      orderBy: { createdAt: "desc" },
    });
    for (const i of intents) {
      stageByWindow[windowKey].orderIntent[classifyBand(i.limitPrice)]++;
    }

    const lifecycle = await prisma.recommendationLifecycleEvent.findMany({
      where: {
        funderAddress: funder,
        createdAt: { gte: since },
      },
      select: { recommendationId: true },
      take: 30000,
      orderBy: { createdAt: "desc" },
    });
    const recIds = [...new Set(lifecycle.map((r) => r.recommendationId))];
    if (recIds.length > 0) {
      const recs = await prisma.recommendation.findMany({
        where: { id: { in: recIds } },
        select: { suggestedEntryMin: true, suggestedEntryMax: true },
      });
      for (const r of recs) {
        stageByWindow[windowKey].recommendation[recommendationBand(r.suggestedEntryMin, r.suggestedEntryMax)]++;
      }
    }
  }

  const prev24hSince = new Date(now - 48 * 60 * 60 * 1000);
  const prev24hUntil = new Date(now - 24 * 60 * 60 * 1000);
  const shadowsPrev24 = await prisma.shadowCandidate.findMany({
    where: {
      funderAddress: funder,
      candidateSource: "runtime_automated",
      wasSubmitted: true,
      wasBlocked: false,
      createdAt: { gte: prev24hSince, lt: prev24hUntil },
    },
    select: { intendedPrice: true, marketId: true },
    take: 10000,
  });
  for (const s of shadowsPrev24) {
    if (classifyBand(s.intendedPrice) === "0.4-0.6" && s.marketId?.trim()) {
      shadowMidMarketsPrev24h.set(s.marketId.trim(), (shadowMidMarketsPrev24h.get(s.marketId.trim()) ?? 0) + 1);
    }
  }

  const firstDisappearanceStage = (windowKey: WindowKey): Stage | "none" => {
    const order: Stage[] = ["recommendation", "orderIntent", "shadowCandidate"];
    for (const s of order) {
      if (stageByWindow[windowKey][s]["0.4-0.6"] === 0) return s;
    }
    return "none";
  };

  const absentAllWindows = (Object.keys(WINDOWS) as WindowKey[]).every((w) => byWindow[w]["0.4-0.6"] === 0);
  const recHasMidAny = (Object.keys(WINDOWS) as WindowKey[]).some((w) => stageByWindow[w].recommendation["0.4-0.6"] > 0);
  const oiHasMidAny = (Object.keys(WINDOWS) as WindowKey[]).some((w) => stageByWindow[w].orderIntent["0.4-0.6"] > 0);
  const scHasMidAny = (Object.keys(WINDOWS) as WindowKey[]).some((w) => stageByWindow[w].shadowCandidate["0.4-0.6"] > 0);

  let blunt:
    | "0.4-0.6 is temporarily absent"
    | "0.4-0.6 is persistently under-generated upstream"
    | "0.4-0.6 exists upstream but is lost before ShadowCandidate"
    | "evidence insufficient";
  if (!absentAllWindows) blunt = "0.4-0.6 is temporarily absent";
  else if ((recHasMidAny || oiHasMidAny) && !scHasMidAny) blunt = "0.4-0.6 exists upstream but is lost before ShadowCandidate";
  else if (absentAllWindows && !oiHasMidAny && !scHasMidAny) blunt = "0.4-0.6 is persistently under-generated upstream";
  else blunt = "evidence insufficient";

  const topN = (m: Map<string, number>, n: number): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const lines: string[] = [];
  lines.push("# V2 mid-band upstream absence audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Funder analyzed: ${funder || "(none resolved)"}`);
  lines.push("- Scope for supply windows uses `ShadowCandidate` raw loader basis (runtime_automated, submitted, unblocked).");
  lines.push("- Recommendation band is approximate (`suggestedEntryMin/Max` midpoint when both exist).");
  lines.push("");

  lines.push("## A. 0.4-0.6 presence over 1h/6h/24h raw ShadowCandidate supply");
  lines.push("| window | <0.1 | 0.1-0.2 | 0.2-0.3 | 0.3-0.4 | 0.4-0.6 | 0.6-0.8 | 0.8-0.9 | >=0.9 | unknown | total |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const w of Object.keys(WINDOWS) as WindowKey[]) {
    const c = byWindow[w];
    const total = ALL_BANDS.reduce((acc, b) => acc + c[b], 0);
    lines.push(
      `| ${w} | ${c["<0.1"]} | ${c["0.1-0.2"]} | ${c["0.2-0.3"]} | ${c["0.3-0.4"]} | ${c["0.4-0.6"]} | ${c["0.6-0.8"]} | ${c["0.8-0.9"]} | ${c[">=0.9"]} | ${c.unknown} | ${total} |`
    );
  }
  lines.push("");

  lines.push("## B. Upstream source stage (where possible)");
  lines.push("| window | recommendation 0.4-0.6 | orderIntent 0.4-0.6 | shadowCandidate 0.4-0.6 | first stage where 0.4-0.6 disappears |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const w of Object.keys(WINDOWS) as WindowKey[]) {
    lines.push(
      `| ${w} | ${stageByWindow[w].recommendation["0.4-0.6"]} | ${stageByWindow[w].orderIntent["0.4-0.6"]} | ${stageByWindow[w].shadowCandidate["0.4-0.6"]} | ${firstDisappearanceStage(w)} |`
    );
  }
  lines.push("");
  lines.push("### Stage-by-band JSON");
  lines.push("```json");
  lines.push(JSON.stringify(stageByWindow, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## C. 0.4-0.6 market coverage and recency");
  lines.push(`- 0.4-0.6 markets in last 24h: **${shadowMidMarkets24h.size}**`);
  lines.push(`- 0.4-0.6 markets in prior 24h (24h-48h ago): **${shadowMidMarketsPrev24h.size}**`);
  lines.push("- top 0.4-0.6 markets last 24h:");
  lines.push("```json");
  lines.push(JSON.stringify(topN(shadowMidMarkets24h, 20), null, 2));
  lines.push("```");
  lines.push("- top 0.4-0.6 markets prior 24h:");
  lines.push("```json");
  lines.push(JSON.stringify(topN(shadowMidMarketsPrev24h, 20), null, 2));
  lines.push("```");
  lines.push(
    shadowMidMarketsPrev24h.size > 0 && shadowMidMarkets24h.size === 0
      ? "- Interpretation: 0.4-0.6 markets appeared previously but stopped appearing recently."
      : shadowMidMarkets24h.size > 0
        ? "- Interpretation: 0.4-0.6 appears in current longer window; current absence is not persistent."
        : "- Interpretation: no 0.4-0.6 market coverage observed in current and prior 24h windows."
  );
  lines.push("");

  lines.push("## D. Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-midband-upstream-absence-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error("Failed to build v2-midband-upstream-absence-audit:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

