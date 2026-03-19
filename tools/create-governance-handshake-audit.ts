/**
 * Governance / runtime handshake audit report.
 * Writes: dump/governance-handshake-audit.json, dump/governance-handshake-audit.md
 * Read-only; does not change runtime or admission behavior.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getGovernanceHandshakeAudit } from "../lib/paper-trading/governance-handshake-audit";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const report = await getGovernanceHandshakeAudit(prisma);

  const jsonPath = path.join(DUMP_DIR, "governance-handshake-audit.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = renderMarkdown(report);
  const mdPath = path.join(DUMP_DIR, "governance-handshake-audit.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

function renderMarkdown(report: Awaited<ReturnType<typeof getGovernanceHandshakeAudit>>): string {
  const lines: string[] = [];
  lines.push("# Governance / runtime handshake audit");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`Runtime champion model run: \`${report.runtimeChampionModelRunId ?? "none"}\``);
  lines.push("");

  for (const a of report.audits) {
    lines.push(`## ${a.botType}`);
    lines.push("");
    lines.push("| Item | Value |");
    lines.push("|------|-------|");
    lines.push(`| Active revision | ${a.activeRevisionKey ?? "—"} (id: ${a.activeRevisionId ?? "—"}) |`);
    lines.push(`| Profile mismatch | ${a.profileMismatch ? "**yes**" : "no"} |`);
    if (a.mismatchFields.length > 0) {
      lines.push(`| Mismatch fields | ${a.mismatchFields.join(", ")} |`);
    }
    lines.push(`| Intended active model | \`${a.intendedActiveModelRunId ?? "—"}\` |`);
    lines.push(`| Runtime champion model | \`${a.runtimeSelectedChampionModelRunId ?? "—"}\` |`);
    lines.push(`| Model mismatch | ${a.modelMismatch ? "**yes**" : "no"} |`);
    lines.push("");
    if (a.warnings.length > 0) {
      lines.push("**Warnings:** " + a.warnings.join("; ") + "");
      lines.push("");
    }
    if (a.notes.length > 0) {
      lines.push("**Notes:** " + a.notes.join("; ") + "");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("*Audit is read-only. ACTIVE revisions and INTENDED_ACTIVE links are governance-only and not wired into runtime behavior.*");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
