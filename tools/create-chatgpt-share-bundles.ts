/**
 * Creates shareable audit bundle files for ChatGPT: exact source contents with
 * clear delimiters, one bundle per category. Run from repo root.
 *
 * Usage: npx tsx tools/create-chatgpt-share-bundles.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "audit-dumps", "chatgpt-share-bundles");

const SEP = "================================================================================\n";

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "unknown";
  }
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "unknown";
  }
}

async function readFileSafe(filePath: string): Promise<{ found: boolean; content: string; lines: number }> {
  const abs = path.join(ROOT, filePath);
  try {
    const content = await fs.readFile(abs, "utf8");
    const lines = content.split(/\r?\n/).length;
    return { found: true, content, lines };
  } catch {
    return { found: false, content: "", lines: 0 };
  }
}

function section(path: string, found: boolean, content: string): string {
  const status = found ? "FOUND" : "NOT FOUND";
  return `${SEP}FILE: ${path}\nSTATUS: ${status}\n${SEP}${found ? content + "\n\n" : "\n"}`;
}

interface BundleSpec {
  name: string;
  filename: string;
  files: string[];
}

const BUNDLES: BundleSpec[] = [
  {
    name: "bundle-1-portfolio-core",
    filename: "bundle-1-portfolio-core.md",
    files: [
      "app/api/portfolio/overview/route.ts",
      "app/api/portfolio/positions/route.ts",
      "app/api/portfolio/intelligence/route.ts",
      "lib/portfolio/live-portfolio-service.ts",
      "lib/portfolio/intelligence.ts",
      "lib/portfolio/open-positions-from-official.ts",
      "lib/portfolio/enrich-positions.ts",
      "lib/portfolio/canonical-position-view.ts",
      "lib/portfolio/canonical-position-insight.ts",
      "lib/portfolio/live-open-orders-service.ts",
    ],
  },
  {
    name: "bundle-2-ui-and-tests",
    filename: "bundle-2-ui-and-tests.md",
    files: [
      "components/dashboard/portfolio-overview-widget.tsx",
      "components/portfolio/portfolio-freshness-indicator.tsx",
      "lib/portfolio/__tests__/portfolio-api-regression-tests.ts",
      "lib/portfolio/__tests__/live-truth-tests.ts",
      "docs/PORTFOLIO_LIVE_TRUTH_RESPONSE_CONTRACT.md",
      "docs/LIVE_TRUTH_ARCHITECTURE.md",
      "docs/LIVE_TRUTH_FALLBACK_BEHAVIOR.md",
      "docs/TRUTH_MODEL.md",
      "docs/RUNTIME_RECONCILIATION.md",
    ],
  },
  {
    name: "bundle-3-runtime",
    filename: "bundle-3-runtime.md",
    files: [
      "audit-dumps/live-truth-audit/runtime/overview-response.json",
      "audit-dumps/live-truth-audit/runtime/positions-response.json",
      "audit-dumps/live-truth-audit/runtime/intelligence-response.json",
      "audit-dumps/live-truth-audit/runtime/runtime-capture-meta.json",
      "audit-dumps/live-truth-audit/runtime/consistency-summary.md",
      "audit-dumps/live-truth-audit/MANIFEST.md",
    ],
  },
  {
    name: "bundle-4-trees-and-schema",
    filename: "bundle-4-trees-and-schema.md",
    files: [
      "prisma/schema.prisma",
      "audit-dumps/live-truth-audit/portfolio-tree.txt",
      "audit-dumps/live-truth-audit/repo-tree.txt",
    ],
  },
];

interface IndexEntry {
  path: string;
  found: boolean;
  bundle: string;
  lines: number;
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const branch = gitBranch();
  const commit = gitCommit();

  await fs.mkdir(OUT_DIR, { recursive: true });

  const allIndexEntries: IndexEntry[] = [];
  const createdPaths: string[] = [];

  for (const spec of BUNDLES) {
    let includedCount = 0;
    const parts: string[] = [
      `# ${spec.name}`,
      "",
      `- Generated: ${timestamp}`,
      `- Included file count: (computed below)`,
      "",
      "---",
      "",
    ];

    for (const filePath of spec.files) {
      const { found, content, lines } = await readFileSafe(filePath);
      if (found) includedCount++;
      allIndexEntries.push({
        path: filePath,
        found,
        bundle: spec.filename,
        lines,
      });
      parts.push(section(filePath, found, content));
    }

    parts[3] = `- Included file count: ${includedCount}`;
    const outPath = path.join(OUT_DIR, spec.filename);
    await fs.writeFile(outPath, parts.join("\n"), "utf8");
    createdPaths.push(outPath);
  }

  const indexLines: string[] = [
    "# ChatGPT Share Bundles — Index",
    "",
    `- **Generation timestamp:** ${timestamp}`,
    `- **Git branch:** ${branch}`,
    `- **Git commit:** ${commit}`,
    "",
    "## Bundled files",
    "",
  ];

  allIndexEntries.forEach((e, i) => {
    const status = e.found ? "FOUND" : "NOT FOUND";
    const lineInfo = e.found ? ` (~${e.lines} lines)` : "";
    indexLines.push(`${i + 1}. **${status}** — \`${e.path}\` → \`${e.bundle}\`${lineInfo}`);
  });

  const indexPath = path.join(OUT_DIR, "BUNDLE_INDEX.md");
  await fs.writeFile(indexPath, indexLines.join("\n") + "\n", "utf8");
  createdPaths.unshift(indexPath);

  const recommendedOrder = [
    "bundle-1-portfolio-core.md",
    "bundle-2-ui-and-tests.md",
    "bundle-3-runtime.md",
    "bundle-4-trees-and-schema.md",
  ];

  console.log("\nCreated bundle files:");
  const sizes: { name: string; kb: number }[] = [];
  for (const p of [path.join(OUT_DIR, "BUNDLE_INDEX.md"), ...recommendedOrder.map((f) => path.join(OUT_DIR, f))]) {
    try {
      const stat = await fs.stat(p);
      const kb = Math.round(stat.size / 1024);
      sizes.push({ name: path.basename(p), kb });
      console.log(`  ${p}`);
    } catch {
      console.log(`  ${p} (size unknown)`);
    }
  }

  console.log("\nRecommended send order to ChatGPT:");
  recommendedOrder.forEach((name, i) => {
    const s = sizes.find((x) => x.name === name);
    console.log(`  ${i + 1}. ${name}${s ? ` (~${s.kb} KB)` : ""}`);
  });

  console.log("\nApproximate size per bundle:");
  sizes.forEach((s) => console.log(`  ${s.name}: ${s.kb} KB`));

  console.log("\nBest to send first for code audit: bundle-1-portfolio-core.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
