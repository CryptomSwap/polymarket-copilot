/**
 * Paper profile/model linkage report.
 * Outputs: dump/paper-profile-model-link-report.json, dump/paper-profile-model-link-report.md
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
  const links = await prisma.paperBotProfileModelLink.findMany({
    orderBy: [{ botType: "asc" }, { createdAt: "asc" }],
  });

  const byBot: Record<
    string,
    {
      botType: string;
      revisions: typeof revisions;
      links: typeof links;
    }
  > = {};

  for (const r of revisions) {
    if (!byBot[r.botType]) {
      byBot[r.botType] = { botType: r.botType, revisions: [], links: [] };
    }
    byBot[r.botType].revisions.push(r);
  }
  for (const l of links) {
    if (!byBot[l.botType]) {
      byBot[l.botType] = { botType: l.botType, revisions: [], links: [] };
    }
    byBot[l.botType].links.push(l);
  }

  const report = {
    generatedAt: timestamp,
    byBot,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-profile-model-link-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper profile / model linkage report");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");

  if (Object.keys(byBot).length === 0) {
    md.push("No revisions or profile/model links recorded yet.");
  } else {
    for (const [botType, group] of Object.entries(byBot)) {
      md.push(`## Bot ${botType}`);
      md.push("");
      const active = group.revisions.find((r) => r.status === "ACTIVE") ?? null;
      if (active) {
        const intendedLinks = group.links.filter(
          (l) =>
            l.profileRevisionId === active.id &&
            l.linkageRole === "INTENDED_ACTIVE"
        );
        const evaluatedLinks = group.links.filter(
          (l) =>
            l.profileRevisionId === active.id &&
            l.linkageRole === "EVALUATED_WITH"
        );
        md.push("**Active revision:**");
        md.push("");
        md.push(
          `- revisionKey: \`${active.revisionKey}\` (status=${active.status}, promotedAt=${active.promotedAt?.toISOString() ?? "n/a"})`
        );
        if (intendedLinks.length > 0) {
          const latest = intendedLinks[intendedLinks.length - 1];
          md.push(
            `- Intended model run: \`${latest.modelRunId}\` (last linked at ${latest.createdAt.toISOString()})`
          );
        } else {
          md.push("- Intended model run: none");
        }
        if (evaluatedLinks.length > 0) {
          const latestEval = evaluatedLinks[evaluatedLinks.length - 1];
          md.push(
            `- Latest evaluated-with model run: \`${latestEval.modelRunId}\` (last linked at ${latestEval.createdAt.toISOString()})`
          );
        } else {
          md.push("- Latest evaluated-with model run: none");
        }
      } else {
        md.push("**Active revision:** none");
      }
      md.push("");

      if (group.links.length > 0) {
        md.push("**All profile/model links:**");
        md.push("");
        md.push(
          "| revisionKey | profileRevisionId | modelRunId | role | createdAt | notes |"
        );
        md.push(
          "|------------|-------------------|-----------|------|-----------|-------|"
        );
        for (const link of group.links) {
          const rev = group.revisions.find((r) => r.id === link.profileRevisionId);
          md.push(
            `| \`${rev?.revisionKey ?? "unknown"}\` | \`${link.profileRevisionId}\` | \`${link.modelRunId}\` | ${link.linkageRole} | ${link.createdAt.toISOString()} | ${link.notes ?? "—"} |`
          );
        }
        md.push("");
      } else {
        md.push("No profile/model links for this bot yet.");
        md.push("");
      }
    }
  }

  const mdPath = path.join(DUMP_DIR, "paper-profile-model-link-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

