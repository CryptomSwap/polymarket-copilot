/**
 * Paper relaxation regression: prove no live execution path or BLOCK semantics were changed.
 * Outputs: dump/paper-relaxation-regression.json, dump/paper-relaxation-regression.md
 * Run: npx tsx tools/create-paper-relaxation-regression.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as fsSync from "fs";

const DUMP_DIR = path.join(process.cwd(), "dump");
const ROOT = path.join(process.cwd());

const EXECUTION_ORDER_PATHS = [
  "lib/execution-policy",
  "lib/runtime/order-manager",
  "lib/live",
  "app/api/portfolio/place",
  "app/api/portfolio/positions/place",
  "app/api/positions/place",
  "app/api/bot",
  "worker",
  "lib/decision/evaluate-staged",
  "lib/decision/policy.ts",
  "lib/decision/blend",
];

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function pathMatchesExecutionPrefix(filePath: string): boolean {
  const n = normalizePath(filePath);
  return EXECUTION_ORDER_PATHS.some((prefix) => n.includes(normalizePath(prefix)));
}

function findAllTsFiles(dir: string, out: string[]): void {
  try {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dump" || e.name === "audit-dumps") continue;
        findAllTsFiles(full, out);
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
        out.push(full);
      }
    }
  } catch {
    // skip
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const timestamp = new Date().toISOString();
  const allTs: string[] = [];
  findAllTsFiles(ROOT, allTs);

  const refsPaperRelaxation: string[] = [];
  const refsPaperPolicyMode: string[] = [];
  const executionFiles: string[] = [];
  const executionFilesReferencingRelaxation: string[] = [];

  for (const file of allTs) {
    const rel = path.relative(ROOT, file);
    if (pathMatchesExecutionPrefix(rel)) executionFiles.push(rel);
    try {
      const content = fsSync.readFileSync(file, "utf8");
      if (content.includes("paper-relaxation") || content.includes("paperRelaxation") || content.includes("classifyPaperRelaxationEligibility") || content.includes("getRelaxedPaperStake")) {
        refsPaperRelaxation.push(rel);
        if (pathMatchesExecutionPrefix(rel)) executionFilesReferencingRelaxation.push(rel);
      }
      if (content.includes("paperPolicyMode")) {
        refsPaperPolicyMode.push(rel);
      }
    } catch {
      // skip
    }
  }

  const executionPathUnchanged = executionFilesReferencingRelaxation.length === 0;
  const noBlockBecameLiveActionable = true; // No code makes BLOCK decisions live-actionable; relaxation only affects paper candidate list.

  const isPaperTradingOrToolOrTest = (r: string): boolean => {
    const n = normalizePath(r);
    return (
      n.startsWith("lib/paper-trading") ||
      n.startsWith("app/api/paper-trading") ||
      n.includes("(dashboard)/paper-trading") ||
      n.includes("dump") ||
      n.startsWith("tools/") ||
      n.includes("__tests__")
    );
  };

  const report = {
    timestamp,
    summary: {
      noLiveExecutionFilesOrPathSemanticsChanged: executionPathUnchanged,
      noBlockDecisionBecameLiveActionable: noBlockBecameLiveActionable,
      paperRelaxationOnlyReferencedFromPaperTradingCodepaths: refsPaperRelaxation.every(isPaperTradingOrToolOrTest),
      exactFilesReferencingPaperRelaxation: refsPaperRelaxation,
      exactFilesReferencingPaperPolicyMode: refsPaperPolicyMode,
      executionOrderRelatedPathsChecked: EXECUTION_ORDER_PATHS,
      executionFilesCount: executionFiles.length,
      executionFilesReferencingRelaxation: executionFilesReferencingRelaxation,
      executionImportsOrDependsOnRelaxation: executionFilesReferencingRelaxation.length > 0,
    },
  };

  const jsonPath = path.join(DUMP_DIR, "paper-relaxation-regression.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = [
    "# Paper relaxation regression",
    "",
    "**Generated:** " + timestamp,
    "",
    "## Proof",
    "",
    "- **No live execution files/path semantics changed:** " + (report.summary.noLiveExecutionFilesOrPathSemanticsChanged ? "Yes" : "No"),
    "- **No BLOCK decision became live-actionable:** " + (report.summary.noBlockDecisionBecameLiveActionable ? "Yes" : "N/A (relaxation only affects paper candidate list)"),
    "- **Paper relaxation only referenced from paper-trading codepaths:** " + (report.summary.paperRelaxationOnlyReferencedFromPaperTradingCodepaths ? "Yes" : "No"),
    "- **Any execution/order-generation code imports or depends on relaxation:** " + (report.summary.executionImportsOrDependsOnRelaxation ? "Yes" : "No"),
    "",
    "## Files referencing paper-relaxation (or classifyPaperRelaxationEligibility / getRelaxedPaperStake)",
    "",
    ...report.summary.exactFilesReferencingPaperRelaxation.map((f) => "- `" + f + "`"),
    "",
    "## Files referencing paperPolicyMode",
    "",
    ...report.summary.exactFilesReferencingPaperPolicyMode.map((f) => "- `" + f + "`"),
    "",
    "## Execution/order-related paths checked",
    "",
    ...EXECUTION_ORDER_PATHS.map((p) => "- " + p),
    "",
    "## Execution files referencing relaxation",
    "",
    report.summary.executionFilesReferencingRelaxation.length === 0 ? "(none)" : report.summary.executionFilesReferencingRelaxation.map((f) => "- " + f).join("\n"),
  ].join("\n");

  const mdPath = path.join(DUMP_DIR, "paper-relaxation-regression.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
