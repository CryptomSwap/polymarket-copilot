/**
 * Read-only: inspect reco-thesis keys on ShadowCandidate.decisionSnapshotJson (newest rows).
 *
 * Run: npx tsx tools/debug-shadow-decision-snapshot.ts
 * Env: DEBUG_SHADOW_DECISION_SNAPSHOT_N (default 50, clamped 10–200)
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const OUT_DIR = path.join(process.cwd(), "dump", "repo-exploration-pack");
const OUT_MD = path.join(OUT_DIR, "27-shadow-snapshot-reco-thesis-check.md");

function envN(): number {
  const raw = process.env.DEBUG_SHADOW_DECISION_SNAPSHOT_N?.trim();
  const n = raw ? Number(raw) : 50;
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(10, Math.floor(n)));
}

type RecoFields = {
  strategyFamily: string | null;
  strategyVariant: string | null;
  hypothesisType: string | null;
};

function parseRecoFromDecisionSnapshot(raw: string | null): RecoFields {
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

function allThree(r: RecoFields): boolean {
  return !!(r.strategyFamily && r.strategyVariant && r.hypothesisType);
}

function anyOne(r: RecoFields): boolean {
  return !!(r.strategyFamily || r.strategyVariant || r.hypothesisType);
}

type Shape = "missing_all" | "partial" | "has_reco_thesis";

function classifyShape(r: RecoFields): Shape {
  if (allThree(r)) return "has_reco_thesis";
  if (!anyOne(r)) return "missing_all";
  return "partial";
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
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

  type Row = {
    id: string;
    createdAt: Date;
    wasSubmitted: boolean;
    recommendationId: string | null;
    decisionSnapshotJson: string | null;
  };

  let rows: Row[] = [];
  let dbError: string | null = null;
  try {
    rows = (await prisma.shadowCandidate.findMany({
      orderBy: { createdAt: "desc" },
      take: N,
      select: {
        id: true,
        createdAt: true,
        wasSubmitted: true,
        recommendationId: true,
        decisionSnapshotJson: true,
      },
    })) as Row[];
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const analyzed = rows.map((row) => {
    const reco = parseRecoFromDecisionSnapshot(row.decisionSnapshotJson);
    return { row, reco, shape: classifyShape(reco) };
  });

  const total = rows.length;
  let nFamily = 0;
  let nAllThree = 0;
  const shapeCounts: Record<Shape, number> = { missing_all: 0, partial: 0, has_reco_thesis: 0 };
  for (const a of analyzed) {
    if (a.reco.strategyFamily) nFamily++;
    if (allThree(a.reco)) nAllThree++;
    shapeCounts[a.shape]++;
  }

  const md: string[] = [];
  md.push("# Shadow decision snapshot — reco-thesis check");
  md.push("");
  md.push(`Generated: **${new Date().toISOString()}**`);
  md.push("");
  md.push("## Parameters");
  md.push(`- Sample: **${N}** latest \`ShadowCandidate\` rows by \`createdAt\` (desc).`);
  if (dbError) {
    md.push(`- **Database:** query failed — ${briefDbError(dbError)}`);
  } else {
    md.push("- **Database:** query succeeded.");
  }
  md.push("");

  md.push("## 1. Summary");
  md.push(`- Total rows: **${total}**`);
  md.push(`- Rows with \`strategyFamily\` (non-empty): **${nFamily}**`);
  md.push(`- Rows with all three keys present: **${nAllThree}**`);
  md.push("");

  md.push("## 2. Sample table (first 20)");
  md.push(
    "| createdAt | wasSubmitted | recommendationId | strategyFamily | strategyVariant | hypothesisType |"
  );
  md.push("|-----------|--------------|------------------|----------------|-----------------|----------------|");
  const show = Math.min(20, analyzed.length);
  for (let i = 0; i < show; i++) {
    const { row, reco } = analyzed[i]!;
    const recId = row.recommendationId?.trim() || "—";
    md.push(
      `| ${escCell(row.createdAt.toISOString())} | ${row.wasSubmitted} | ${escCell(recId)} | ${escCell(reco.strategyFamily ?? "—")} | ${escCell(reco.strategyVariant ?? "—")} | ${escCell(reco.hypothesisType ?? "—")} |`
    );
  }
  if (analyzed.length > show) md.push("");
  if (analyzed.length > show) md.push(`_…${analyzed.length - show} more rows in sample (counts use full sample)._`);
  md.push("");

  md.push("## 3. Shape classification (row counts)");
  md.push(`- \`missing_all\`: **${shapeCounts.missing_all}** (no reco-thesis keys)`);
  md.push(`- \`partial\`: **${shapeCounts.partial}** (some but not all three)`);
  md.push(`- \`has_reco_thesis\`: **${shapeCounts.has_reco_thesis}** (all three present)`);
  md.push("");

  md.push("## 4. Conclusion");
  if (total === 0) {
    md.push(
      `- **Indeterminate** — no rows loaded${dbError ? " (database error; see Parameters)" : ""}.`
    );
  } else if (nAllThree === 0 && nFamily === 0) {
    md.push("- **missing at shadow level** — no \`strategyFamily\` and no complete triple in this sample.");
  } else if (nAllThree / total >= 0.25 || nFamily / total >= 0.25) {
    md.push("- **present at shadow level** — material share of rows carry reco-thesis fields in \`decisionSnapshotJson\`.");
  } else {
    md.push("- **missing at shadow level** — reco-thesis fields are rare in this sample (< 25% with family or full triple).");
  }
  md.push("");
  md.push(
    "_Parse: root or \`recoThesis\` / \`reco_thesis\` nested object; same key names as paper metadata reports._"
  );

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log("[debug-shadow-decision-snapshot]", { total, nFamily, nAllThree, shapes: shapeCounts, out: OUT_MD });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
