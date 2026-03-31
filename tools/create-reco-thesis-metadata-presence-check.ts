/**
 * Read-only check: do the newest PaperTrade rows persist reco-thesis keys in metadataJson
 * (strategyFamily, strategyVariant, hypothesisType)? Writes a compact markdown report only.
 *
 * Run: npx tsx tools/create-reco-thesis-metadata-presence-check.ts
 * Env: RECO_THESIS_PRESENCE_CHECK_N (default 100, clamped 10–500)
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const OUT_DIR = path.join(process.cwd(), "dump", "repo-exploration-pack");
const OUT_MD = path.join(OUT_DIR, "24-reco-thesis-metadata-presence-check.md");

function envN(): number {
  const raw = process.env.RECO_THESIS_PRESENCE_CHECK_N?.trim();
  const n = raw ? Number(raw) : 100;
  if (!Number.isFinite(n)) return 100;
  return Math.min(500, Math.max(10, Math.floor(n)));
}

type RecoFields = {
  strategyFamily: string | null;
  strategyVariant: string | null;
  hypothesisType: string | null;
};

function parseRecoFields(raw: string | null): RecoFields {
  const empty: RecoFields = { strategyFamily: null, strategyVariant: null, hypothesisType: null };
  if (!raw) return empty;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const nest = (o.recoThesis ?? o.reco_thesis) as Record<string, unknown> | undefined;
    const pick = (k: string): string | null => {
      const v = o[k] ?? nest?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      return null;
    };
    return {
      strategyFamily: pick("strategyFamily"),
      strategyVariant: pick("strategyVariant"),
      hypothesisType: pick("hypothesisType"),
    };
  } catch {
    return empty;
  }
}

function parseRecommendationId(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function hasOpenAttribution(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const a = o.openAttribution;
    return a != null && typeof a === "object";
  } catch {
    return false;
  }
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

type Row = {
  id: string;
  entryTime: Date;
  botType: string;
  status: string;
  metadataJson: string | null;
};

function allThree(r: RecoFields): boolean {
  return !!(r.strategyFamily && r.strategyVariant && r.hypothesisType);
}

function briefDbError(msg: string): string {
  const reach = msg.match(/Can't reach database[^\n]*/);
  const hint = msg.match(/Please make sure[^\n]*/);
  if (reach) return [reach[0]!.trim(), hint?.[0]?.trim()].filter(Boolean).join(" ");
  return msg.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function main(): Promise<void> {
  const N = envN();
  await fs.mkdir(OUT_DIR, { recursive: true });

  let rows: Row[] = [];
  let dbError: string | null = null;
  try {
    rows = (await prisma.paperTrade.findMany({
      orderBy: { entryTime: "desc" },
      take: N,
      select: {
        id: true,
        entryTime: true,
        botType: true,
        status: true,
        metadataJson: true,
      },
    })) as Row[];
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const md: string[] = [];
  md.push("# Reco-thesis metadata presence (newest PaperTrades)");
  md.push("");
  md.push(`Generated: **${new Date().toISOString()}**`);
  md.push("");
  md.push("## Parameters");
  md.push(`- Sample: **${N}** most recent rows by \`entryTime\` (desc).`);
  if (dbError) md.push(`- **Database:** ${briefDbError(dbError)}`);
  else md.push("- **Database:** query succeeded.");
  md.push("");

  let nFamily = 0;
  let nVariant = 0;
  let nHypo = 0;
  let nAllThree = 0;
  const missingAllShape: Record<string, number> = {};

  const analyzed = rows.map((row) => {
    const reco = parseRecoFields(row.metadataJson);
    const recId = parseRecommendationId(row.metadataJson);
    const oa = hasOpenAttribution(row.metadataJson);
    if (reco.strategyFamily) nFamily++;
    if (reco.strategyVariant) nVariant++;
    if (reco.hypothesisType) nHypo++;
    if (allThree(reco)) nAllThree++;

    if (!allThree(reco)) {
      const key =
        row.metadataJson == null || row.metadataJson === ""
          ? "metadata_empty"
          : !oa && !recId
            ? "no_openAttribution_no_recommendationId"
            : oa && !recId
              ? "openAttribution_no_recommendationId"
              : !oa && recId
                ? "recommendationId_only"
                : "openAttribution_and_recommendationId_no_recoThesis";
      missingAllShape[key] = (missingAllShape[key] ?? 0) + 1;
    }

    return { row, reco, recId, oa };
  });

  const total = rows.length;
  const half = total > 0 ? Math.max(1, Math.floor(total / 2)) : 0;
  const newestSlice = half ? analyzed.slice(0, half) : [];
  const oldestInSample = half ? analyzed.slice(-half) : [];
  const rate = (xs: typeof analyzed) =>
    xs.length ? xs.filter((x) => allThree(x.reco)).length / xs.length : 0;
  const rNew = rate(newestSlice);
  const rOld = rate(oldestInSample);

  md.push("## Summary counts");
  md.push(`- Total rows inspected: **${total}**`);
  md.push(`- Rows with \`strategyFamily\` (non-empty): **${nFamily}**`);
  md.push(`- Rows with \`strategyVariant\` (non-empty): **${nVariant}**`);
  md.push(`- Rows with \`hypothesisType\` (non-empty): **${nHypo}**`);
  md.push(`- Rows with **all three** present: **${nAllThree}**`);
  md.push("");

  md.push("## Sample table (newest first)");
  md.push(
    "| entryTime | botType | status | recommendationId | strategyFamily | strategyVariant | hypothesisType |"
  );
  md.push("|-----------|---------|--------|------------------|----------------|-----------------|----------------|");
  const show = Math.min(25, analyzed.length);
  for (let i = 0; i < show; i++) {
    const { row, reco, recId } = analyzed[i]!;
    md.push(
      `| ${escCell(row.entryTime.toISOString())} | ${escCell(row.botType || "")} | ${escCell(row.status)} | ${escCell(recId ?? "—")} | ${escCell(reco.strategyFamily ?? "—")} | ${escCell(reco.strategyVariant ?? "—")} | ${escCell(reco.hypothesisType ?? "—")} |`
    );
  }
  if (analyzed.length > show) {
    md.push("");
    md.push(`_…${analyzed.length - show} older rows in sample omitted from table (still counted above)._`);
  }
  md.push("");

  md.push("## Recency vs metadata shape (incomplete triple)");
  if (total === 0) {
    md.push("- _(skipped — no rows in sample)._");
  } else {
    md.push(
      `- Newer half of sample (first ${half} by \`entryTime\` desc): **${(100 * rNew).toFixed(1)}%** have all three.`
    );
    md.push(
      `- Older half of this same fetch (last ${half}): **${(100 * rOld).toFixed(1)}%** have all three.`
    );
    if (total >= 10 && rNew - rOld > 0.15) {
      md.push(
        "- _Heuristic:_ newer rows in this window show materially higher completeness → **possible partial rollout** (reco-thesis added after older rows in sample)."
      );
    } else if (total >= 10 && rOld - rNew > 0.15) {
      md.push(
        "- _Heuristic:_ older rows in sample are more complete than newest → unusual; re-check deployment or data source."
      );
    } else {
      md.push("- _Heuristic:_ no strong recency gradient inside this single slice; use counts + table above.");
    }
  }
  md.push("");
  md.push("### Shape buckets for rows without all three keys");
  const shapeKeys = Object.entries(missingAllShape).sort((a, b) => b[1] - a[1]);
  if (total === 0) {
    md.push("- _(skipped — no rows in sample)._");
  } else if (!shapeKeys.length) {
    md.push("- _(none — every row had the full triple)_");
  } else {
    for (const [k, v] of shapeKeys) md.push(`- \`${k}\`: **${v}**`);
    md.push("");
    md.push(
      "_`openAttribution_and_recommendationId_no_recoThesis`: typical “paper open attribution” row without reco-thesis keys._"
    );
  }
  md.push("");

  const pctAll = total > 0 ? nAllThree / total : 0;
  const pctAnyFamily = total > 0 ? nFamily / total : 0;
  let verdict: "metadata is present on new trades" | "metadata is still not being written" | "mixed / partial rollout" | null =
    null;
  if (total > 0) {
    if (pctAll >= 0.85) verdict = "metadata is present on new trades";
    else if (pctAll <= 0.05 && pctAnyFamily <= 0.05) verdict = "metadata is still not being written";
    else verdict = "mixed / partial rollout";
  }

  md.push("## Conclusion");
  if (verdict) {
    md.push(`- **${verdict}**`);
    md.push(`- All-three coverage in sample: **${(100 * pctAll).toFixed(1)}%**; \`strategyFamily\` any: **${(100 * pctAnyFamily).toFixed(1)}%**.`);
  } else {
    md.push(
      `- **Indeterminate** — no rows loaded${dbError ? " (database error; see Parameters)" : ""}; cannot apply the three verdict labels.`
    );
  }
  md.push(
    "- This tool does not know your deploy timestamp; the recency split and shape buckets are soft signals only."
  );
  if (dbError && total === 0) md.push("- Re-run with a reachable `DATABASE_URL` to populate the sample.");
  md.push("");

  md.push("## Implementation note");
  md.push("- **Tool:** `tools/create-reco-thesis-metadata-presence-check.ts`");
  md.push("- **Source:** `PaperTrade` read-only, ordered by `entryTime` desc.");
  md.push(
    "- **Parse:** \`strategyFamily\` / \`strategyVariant\` / \`hypothesisType\` from JSON root or \`recoThesis\` / \`reco_thesis\` object; \`recommendationId\` from root."
  );

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log("[reco-thesis-metadata-presence-check]", { n: total, nAllThree, out: OUT_MD, dbError: !!dbError });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
