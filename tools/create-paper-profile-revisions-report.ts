/**
 * Paper bot profile revisions report.
 * Outputs: dump/paper-profile-revisions-report.json, dump/paper-profile-revisions-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const revisions = await prisma.paperBotProfileRevision.findMany({
    orderBy: [{ botType: "asc" }, { createdAt: "asc" }],
  });

  const byBot: Record<
    string,
    {
      botType: string;
      revisions: typeof revisions;
      active?: typeof revisions[number];
      staged: typeof revisions;
    }
  > = {};

  for (const r of revisions) {
    if (!byBot[r.botType]) {
      byBot[r.botType] = {
        botType: r.botType,
        revisions: [],
        staged: [],
      };
    }
    byBot[r.botType].revisions.push(r);
    if (r.status === "ACTIVE") {
      byBot[r.botType].active = r;
    } else if (r.status === "STAGED") {
      byBot[r.botType].staged.push(r);
    }
  }

  const report = {
    generatedAt: timestamp,
    revisionsByBot: byBot,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-profile-revisions-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper bot profile revisions report");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");

  if (revisions.length === 0) {
    md.push("No profile revisions recorded yet.");
  } else {
    for (const [botType, group] of Object.entries(byBot)) {
      md.push(`## Bot ${botType}`);
      md.push("");
      if (!group.active) {
        md.push("**Active revision:** none");
      } else {
        md.push("**Active revision:**");
        md.push("");
        md.push(
          `- revisionKey: \`${group.active.revisionKey}\` (status=${group.active.status}, promotedAt=${group.active.promotedAt?.toISOString() ?? "n/a"})`
        );
        md.push(
          `- targetLabel: \`${group.active.targetLabel ?? "-"}\`, rollbackTargetRevision: \`${group.active.rollbackTargetRevision ?? "-"}\``
        );
        md.push(`- notes: ${group.active.notes ?? "—"}`);
      }
      md.push("");
      if (group.staged.length > 0) {
        md.push("**Staged/candidate revisions:**");
        md.push("");
        for (const r of group.staged) {
          md.push(
            `- \`${r.revisionKey}\` (status=${r.status}, createdAt=${r.createdAt.toISOString()}, notes=${r.notes ?? "—"})`
          );
        }
      }
      md.push("");
      md.push("**All revisions:**");
      md.push("");
      md.push(
        "| revisionKey | status | targetLabel | createdAt | promotedAt | rollbackTargetRevision | notes |"
      );
      md.push(
        "|------------|--------|------------|-----------|-----------|-------------------------|-------|"
      );
      for (const r of group.revisions) {
        md.push(
          `| \`${r.revisionKey}\` | ${r.status} | \`${r.targetLabel ?? "-"}\` | ${
            r.createdAt.toISOString()
          } | ${r.promotedAt ? r.promotedAt.toISOString() : "—"} | \`${
            r.rollbackTargetRevision ?? "-"
          }\` | ${r.notes ?? "—"} |`
        );
      }
      md.push("");
    }
  }

  const mdPath = path.join(DUMP_DIR, "paper-profile-revisions-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

