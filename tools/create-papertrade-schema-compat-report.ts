/**
 * PaperTrade schema / DB / code alignment report.
 *
 * Writes: dump/papertrade-schema-compat-report.json, .md
 * npm run dump:papertrade-schema-compat-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { execSync } from "child_process";

const DUMP = path.join(process.cwd(), "dump");

const PAPERTRADE_FIELDS = [
  "botType",
  "botVersion",
  "targetLabel",
  "entryPriceBand",
  "championModelRunId",
  "challengerModelRunId",
  "championScore",
  "challengerScore",
  "challengerScoreDelta",
  "challengerAvailable",
  "explorationAdmissionMode",
  "profileSnapshotJson",
];

async function readSchemaPaperTradeBlock(): Promise<string> {
  const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
  const raw = await fs.readFile(schemaPath, "utf8");
  const start = raw.indexOf("model PaperTrade");
  if (start < 0) return "";
  const end = raw.indexOf("\n}", start);
  return end > start ? raw.slice(start, end + 2) : raw.slice(start);
}

function schemaHasField(block: string, field: string): boolean {
  const re = new RegExp(`^\\s+${field}\\s+`, "m");
  return re.test(block);
}

async function dbColumns(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (table_name = 'PaperTrade' OR LOWER(table_name) = 'papertrade')
    ORDER BY column_name
  `;
  return rows.map((r) => r.column_name);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });
  const schemaBlock = await readSchemaPaperTradeBlock();
  let dbCols: string[] = [];
  let dbError: string | null = null;
  try {
    dbCols = await dbColumns();
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const dbSet = new Set(dbCols.map((c) => c.toLowerCase()));

  const perField = PAPERTRADE_FIELDS.map((f) => ({
    field: f,
    inPrismaSchema: schemaHasField(schemaBlock, f),
    inDatabase: dbSet.has(f.toLowerCase()),
    aligned: schemaHasField(schemaBlock, f) && dbSet.has(f.toLowerCase()),
  }));

  const codeUsesBotType =
    schemaBlock.includes("botType") ||
    (await fs.readFile(path.join(process.cwd(), "lib", "paper-trading", "engine.ts"), "utf8"))
      .includes("botType");

  let migrateStatus = "";
  try {
    migrateStatus = execSync("npx prisma migrate status 2>&1", {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
  } catch (e) {
    migrateStatus =
      (e as { stdout?: string; stderr?: string }).stdout?.toString() ??
      (e as Error).message ??
      String(e);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      rootCauseNote:
        "If Prisma schema omits columns that exist in SQL migrations or that runtime code uses, the generated client rejects those fields (Unknown argument). If schema has fields DB lacks, migrate deploy is required.",
      botType: {
        inPrismaSchema: schemaHasField(schemaBlock, "botType"),
        inDatabase: dbSet.has("bottype"),
        referencedInEngine: (await fs.readFile(path.join(process.cwd(), "lib", "paper-trading", "engine.ts"), "utf8")).includes(
          "botType: profile.botType"
        ),
      },
    },
    driftFields: perField,
    databaseColumnCount: dbCols.length,
    databaseError: dbError,
    prismaMigrateStatusSnippet: migrateStatus.slice(0, 4000),
    alignment: {
      schemaAndDbMatchForCriticalFields: perField.filter((p) => p.field === "botType")[0]?.aligned ?? false,
      allListedFieldsAligned: perField.every((p) => p.aligned),
    },
  };

  const md = [
    "# PaperTrade schema compatibility",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## botType mismatch (typical failure)",
    "",
    `- **Prisma schema has botType:** ${report.summary.botType.inPrismaSchema}`,
    `- **Database has botType:** ${report.summary.botType.inDatabase}`,
    `- **Engine filters by botType:** ${report.summary.botType.referencedInEngine}`,
    "",
    "If schema lacked `botType` while SQL migration `20260317000000_paper_trade_bot_profiles` added it, the client would reject `where: { botType }` until schema + `prisma generate` align.",
    "",
    "## Field alignment (engine / analytics)",
    "",
    "| field | schema | DB | aligned |",
    "|-------|--------|-----|---------|",
    ...perField.map(
      (p) => `| ${p.field} | ${p.inPrismaSchema} | ${p.inDatabase} | ${p.aligned} |`
    ),
    "",
    "## DB columns (PaperTrade)",
    "",
    dbError ? `**DB error:** ${dbError}` : dbCols.join(", ") || "(none)",
    "",
    "## prisma migrate status (truncated)",
    "",
    "```",
    migrateStatus.slice(0, 2500),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP, "papertrade-schema-compat-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP, "papertrade-schema-compat-report.md"), md);
  console.log("Wrote dump/papertrade-schema-compat-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
