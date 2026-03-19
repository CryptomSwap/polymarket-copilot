/**
 * Creates trading-bot audit dump bundles for ChatGPT.
 * Run from repo root: npx tsx tools/create-trading-bot-audit-bundles.ts
 * No app behavior changes; only creates files under audit-dumps/trading-bot-audit/
 */

import * as fs from "fs/promises";
import * as path from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "audit-dumps", "trading-bot-audit");
const BASE_URL = process.env.AUDIT_BASE_URL ?? "http://localhost:3000";

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

function nodeVersion(): string {
  return process.version;
}

function packageManager(): string {
  if (existsSync(path.join(ROOT, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(ROOT, "yarn.lock"))) return "yarn";
  return "npm";
}

async function readFileSafe(
  filePath: string
): Promise<{ found: boolean; content: string; lines: number }> {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  try {
    const content = await fs.readFile(abs, "utf8");
    const lines = content.split(/\r?\n/).length;
    return { found: true, content, lines };
  } catch {
    return { found: false, content: "", lines: 0 };
  }
}

function section(filePath: string, found: boolean, content: string): string {
  const status = found ? "FOUND" : "NOT FOUND";
  return `${SEP}FILE: ${filePath}\nSTATUS: ${status}\n${SEP}${found ? content + "\n\n" : "\n"}`;
}

async function listTsFilesInDir(relativeDir: string): Promise<string[]> {
  const abs = path.join(ROOT, relativeDir);
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
        files.push(path.join(relativeDir, e.name).split(path.sep).join("/"));
      }
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        const sub = await listTsFilesInDir(path.join(relativeDir, e.name).split(path.sep).join("/"));
        files.push(...sub);
      }
    }
    return files.sort();
  } catch {
    return [];
  }
}

async function dirExists(relativeDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(ROOT, relativeDir));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

interface ManifestEntry {
  index: number;
  name: string;
  found: boolean;
  originalPath: string;
  dumpPath: string;
  lines: number;
}

async function writeBundle(
  filename: string,
  filePaths: string[],
  manifestEntries: ManifestEntry[],
  startIndex: number
): Promise<{ path: string; entries: ManifestEntry[] }> {
  const parts: string[] = [];
  let idx = startIndex;
  const entries: ManifestEntry[] = [];

  for (const filePath of filePaths) {
    const { found, content, lines } = await readFileSafe(filePath);
    entries.push({
      index: idx,
      name: filePath,
      found,
      originalPath: filePath,
      dumpPath: filename,
      lines: found ? lines : 0,
    });
    manifestEntries.push(entries[entries.length - 1]);
    idx++;
    parts.push(section(filePath, found, content));
  }

  const outPath = path.join(OUT_DIR, filename);
  await fs.writeFile(outPath, parts.join("\n"), "utf8");
  return { path: outPath, entries };
}

function redactSecrets(obj: unknown): unknown {
  const sensitiveKeys = /^(apiKey|api_key|token|secret|password|authorization|cookie|privateKey|private_key|encryptedSecret|encryptedPassphrase)$/i;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sensitiveKeys.test(k) ? "[REDACTED]" : redactSecrets(v);
  }
  return out;
}

async function fetchSnapshot(url: string): Promise<{ status: number; ok: boolean; body: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    let body = text;
    try {
      const json = JSON.parse(text);
      body = JSON.stringify(redactSecrets(json), null, 2);
    } catch {
      // leave body as-is
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: -1, ok: false, body: `Error: ${message}` };
  }
}

async function buildRuntimeSnapshot(): Promise<string> {
  const endpoints: { name: string; url: string }[] = [
    { name: "/api/portfolio/positions?canonical=true", url: `${BASE_URL}/api/portfolio/positions?canonical=true` },
    { name: "/api/portfolio/overview", url: `${BASE_URL}/api/portfolio/overview` },
    { name: "/api/portfolio/intelligence", url: `${BASE_URL}/api/portfolio/intelligence` },
    { name: "/api/dashboard/summary-strip", url: `${BASE_URL}/api/dashboard/summary-strip` },
    { name: "/api/alerts/feed?resolved=false&limit=50&source=all", url: `${BASE_URL}/api/alerts/feed?resolved=false&limit=50&source=all` },
    { name: "/api/bot/guardrails", url: `${BASE_URL}/api/bot/guardrails` },
    { name: "/api/recommendations/list", url: `${BASE_URL}/api/recommendations/list` },
    { name: "/api/analytics/data", url: `${BASE_URL}/api/analytics/data` },
  ];

  const lines: string[] = [
    "# Trading bot runtime snapshot",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${BASE_URL}`,
    "",
    "---",
    "",
  ];

  for (const { name, url } of endpoints) {
    const { status, ok, body } = await fetchSnapshot(url);
    lines.push(`## ${name}`);
    lines.push("");
    lines.push(`- Status: ${status}`);
    lines.push(`- OK: ${ok}`);
    const parsed = status >= 200 && status < 300 && body.startsWith("{");
    lines.push(`- JSON parsed/redacted: ${parsed}`);
    lines.push("");
    const maxLen = 8000;
    const truncated = body.length > maxLen;
    lines.push("```json");
    lines.push(truncated ? body.slice(0, maxLen) + "\n... [truncated]" : body);
    lines.push("```");
    if (truncated) lines.push("", "(Response truncated for readability.)");
    lines.push("");
  }

  return lines.join("\n");
}

async function buildRepoTree(): Promise<string> {
  const dirs = ["app/api", "app/(dashboard)", "components", "lib", "worker", "prisma", "docs"];
  const exclude = new Set(["node_modules", ".next", "dist", "build"]);
  const lines: string[] = ["# Repo tree (bot-relevant)", "", "```", ""];

  async function walk(rel: string, prefix: string): Promise<void> {
    const abs = path.join(ROOT, rel);
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = (await fs.readdir(abs, { withFileTypes: true }))
        .filter((e) => !exclude.has(e.name) && !e.name.endsWith(".map"))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const last = i === entries.length - 1;
      const branch = last ? "└── " : "├── ";
      const nextPrefix = last ? "    " : "│   ";
      lines.push(prefix + branch + e.name);
      if (e.isDir) await walk(path.join(rel, e.name), prefix + nextPrefix);
    }
  }

  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    try {
      await fs.access(abs);
    } catch {
      lines.push(d + "/ (not found)");
      continue;
    }
    lines.push(d + "/");
    await walk(d, "");
    lines.push("");
  }
  lines.push("```");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const branch = gitBranch();
  const commit = gitCommit();
  const nodeVer = nodeVersion();
  const pkgMgr = packageManager();

  await fs.mkdir(OUT_DIR, { recursive: true });

  const allManifestEntries: ManifestEntry[] = [];
  let manifestIndex = 1;

  // --- Bundle 1: core decision
  const bundle1Files = [
    "lib/decision/recompute.ts",
    "lib/polymarket/recommendations-recompute.ts",
    "lib/portfolio/intelligence.ts",
    "lib/recommendations/explainability.ts",
    "lib/bot/guardrails.ts",
    "lib/alerts/engine.ts",
    "app/api/bot/guardrails/route.ts",
    "app/api/alerts/feed/route.ts",
    "app/api/recommendations/[id]/explain/route.ts",
  ];
  const { path: p1 } = await writeBundle(
    "bot-bundle-1-core-decision.md",
    bundle1Files,
    allManifestEntries,
    manifestIndex
  );
  manifestIndex += bundle1Files.length;

  // --- Bundle 2: execution and risk
  const bundle2Paths: string[] = [];
  const execDir = "lib/execution";
  const riskDir = "lib/risk";
  const ordersDir = "lib/orders";
  const liveDir = "lib/live";

  if (await dirExists(execDir)) {
    bundle2Paths.push(...(await listTsFilesInDir(execDir)));
  } else {
    bundle2Paths.push(execDir + "/ (directory)");
  }
  if (await dirExists(riskDir)) {
    bundle2Paths.push(...(await listTsFilesInDir(riskDir)));
  } else {
    bundle2Paths.push(riskDir + "/ (directory)");
  }
  if (await dirExists(ordersDir)) {
    bundle2Paths.push(...(await listTsFilesInDir(ordersDir)));
  } else {
    bundle2Paths.push(ordersDir + "/ (directory)");
  }
  if (await dirExists(liveDir)) {
    bundle2Paths.push(...(await listTsFilesInDir(liveDir)).sort());
  } else {
    bundle2Paths.push(liveDir + "/ (directory)");
  }
  bundle2Paths.push(
    "app/api/live/alerts/route.ts",
    "app/api/live/alerts/resolve/route.ts",
    "app/api/portfolio/orders-reconciliation-debug/route.ts",
    "app/api/portfolio/timeline/route.ts"
  );
  await writeBundle("bot-bundle-2-execution-and-risk.md", bundle2Paths, allManifestEntries, manifestIndex);
  manifestIndex += bundle2Paths.length;

  // --- Bundle 3: worker and runtime
  const workerFiles = (await listTsFilesInDir("worker")).filter((f) => f.endsWith(".ts"));
  const opsFiles = await listTsFilesInDir("lib/ops");
  const polyTrading = [
    "lib/polymarket/ws-market.ts",
    "lib/polymarket/official-positions.ts",
    "lib/polymarket/l2-readonly.ts",
  ];
  const polyRest = (await listTsFilesInDir("lib/polymarket"))
    .filter((f) => !f.includes("__tests__") && (f.endsWith(".ts") || f.endsWith(".tsx")))
    .sort();
  const polyOthers = polyRest.filter(
    (f) =>
      f !== "lib/polymarket/ws-market.ts" &&
      f !== "lib/polymarket/official-positions.ts" &&
      f !== "lib/polymarket/l2-readonly.ts"
  );
  const bundle3Paths = [
    ...workerFiles.sort(),
    ...opsFiles.sort(),
    ...polyTrading,
    ...polyOthers,
    "app/api/portfolio/positions/route.ts",
    "app/api/portfolio/overview/route.ts",
    "app/api/portfolio/intelligence/route.ts",
  ];
  await writeBundle("bot-bundle-3-worker-and-runtime.md", bundle3Paths, allManifestEntries, manifestIndex);
  manifestIndex += bundle3Paths.length;

  // --- Bundle 4: schema and data model
  const mlFiles = await listTsFilesInDir("lib/ml");
  const bundle4Paths = [
    "prisma/schema.prisma",
    "lib/ml/dataset.ts",
    "lib/ml/features.ts",
    "lib/ml/score-live.ts",
    ...mlFiles
      .filter((f) => f !== "lib/ml/dataset.ts" && f !== "lib/ml/features.ts" && f !== "lib/ml/score-live.ts")
      .sort(),
    "app/api/analytics/data/route.ts",
  ];
  await writeBundle("bot-bundle-4-schema-and-data-model.md", bundle4Paths, allManifestEntries, manifestIndex);
  manifestIndex += bundle4Paths.length;

  // --- Bundle 5: UI surfaces
  const bundle5Paths = [
    "app/(dashboard)/page.tsx",
    "app/(dashboard)/ops/page.tsx",
    "app/(dashboard)/portfolio/page.tsx",
    "app/(dashboard)/recommendations/[id]/page.tsx",
    "components/dashboard/summary-strip.tsx",
    "components/bot/guardrails-card.tsx",
    "components/dashboard/portfolio-overview-widget.tsx",
    "components/portfolio/portfolio-freshness-indicator.tsx",
    "components/dashboard/recommendations-widget.tsx",
    "components/dashboard/alerts-widget.tsx",
  ];
  await writeBundle("bot-bundle-5-ui-surfaces.md", bundle5Paths, allManifestEntries, manifestIndex);
  manifestIndex += bundle5Paths.length;

  // --- Bundle 6: tests and docs
  const portfolioTests = await listTsFilesInDir("lib/portfolio/__tests__");
  const botTests = (await dirExists("lib/bot/tests"))
    ? await listTsFilesInDir("lib/bot/tests")
    : await listTsFilesInDir("lib/bot/__tests__");
  const alertsTests = (await dirExists("lib/alerts/tests"))
    ? await listTsFilesInDir("lib/alerts/tests")
    : await listTsFilesInDir("lib/alerts/__tests__");
  const recTests = await listTsFilesInDir("lib/recommendations/__tests__");
  const decisionTests = await listTsFilesInDir("lib/decision/__tests__");
  const riskTests = await listTsFilesInDir("lib/risk/__tests__");
  const executionTests = await listTsFilesInDir("lib/execution/__tests__");
  const liveTests = (await listTsFilesInDir("lib/live")).filter((f) => f.includes("test") || f.includes("__tests__"));

  const bundle6Paths: string[] = [
    ...portfolioTests.sort(),
    ...botTests.sort(),
    ...alertsTests.sort(),
    ...recTests.sort(),
    ...decisionTests.sort(),
    ...riskTests.sort(),
    ...executionTests.sort(),
    ...liveTests.sort(),
  ];
  const docsDir = path.join(ROOT, "docs");
  let docFiles: string[] = [];
  try {
    docFiles = (await fs.readdir(docsDir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => "docs/" + f);
  } catch {
    // no docs
  }
  const keywords = [
    "TRUTH_MODEL",
    "PORTFOLIO",
    "CONCENTRATION",
    "RUNTIME",
    "RECONCILIATION",
    "ALERT",
    "BOT",
    "RECOMMEND",
    "GUARDRAIL",
    "EXECUTION",
    "RISK",
  ];
  const matchingDocs = docFiles.filter((f) => keywords.some((k) => path.basename(f).toUpperCase().includes(k)));
  bundle6Paths.push("docs/NEXT_PHASE_IMPLEMENTATION_PLAN.md");
  for (const d of matchingDocs.sort()) {
    if (d !== "docs/NEXT_PHASE_IMPLEMENTATION_PLAN.md") bundle6Paths.push(d);
  }
  await writeBundle("bot-bundle-6-tests-and-docs.md", bundle6Paths, allManifestEntries, manifestIndex);

  // --- Runtime snapshot
  let snapshotContent: string;
  try {
    snapshotContent = await buildRuntimeSnapshot();
  } catch (err) {
    snapshotContent = `# Trading bot runtime snapshot\n\nGenerated: ${new Date().toISOString()}\n\nBase URL: ${BASE_URL}\n\n**App unreachable.**\n\nError: ${err instanceof Error ? err.message : String(err)}`;
  }
  const snapshotPath = path.join(OUT_DIR, "bot-runtime-snapshot.md");
  await fs.writeFile(snapshotPath, snapshotContent, "utf8");

  // --- Repo tree
  const treeContent = await buildRepoTree();
  const treePath = path.join(OUT_DIR, "repo-tree-bot.txt");
  await fs.writeFile(treePath, treeContent, "utf8");

  // --- MANIFEST.md
  const manifestLines: string[] = [
    "# Trading bot audit — MANIFEST",
    "",
    `- **Generation timestamp:** ${timestamp}`,
    `- **Git branch:** ${branch}`,
    `- **Git commit:** ${commit}`,
    `- **Node version:** ${nodeVer}`,
    `- **Package manager:** ${pkgMgr}`,
    "",
    "## Artifacts",
    "",
  ];
  for (const e of allManifestEntries) {
    const status = e.found ? "FOUND" : "NOT FOUND";
    const lineInfo = e.lines ? ` (~${e.lines} lines)` : "";
    manifestLines.push(`${e.index}. **${status}** — \`${e.originalPath}\` → \`${e.dumpPath}\`${lineInfo}`);
  }
  manifestLines.push("");
  manifestLines.push("## Runtime & tree");
  manifestLines.push("");
  manifestLines.push(`- bot-runtime-snapshot.md (runtime API snapshot)`);
  manifestLines.push(`- repo-tree-bot.txt (repo tree)`);
  await fs.writeFile(path.join(OUT_DIR, "MANIFEST.md"), manifestLines.join("\n") + "\n", "utf8");

  // --- BUNDLE_INDEX.md
  const bundleFiles = [
    "bot-bundle-1-core-decision.md",
    "bot-bundle-2-execution-and-risk.md",
    "bot-bundle-3-worker-and-runtime.md",
    "bot-bundle-4-schema-and-data-model.md",
    "bot-bundle-5-ui-surfaces.md",
    "bot-bundle-6-tests-and-docs.md",
    "bot-runtime-snapshot.md",
    "repo-tree-bot.txt",
  ];
  const sizes: { name: string; kb: number }[] = [];
  for (const f of bundleFiles) {
    try {
      const stat = await fs.stat(path.join(OUT_DIR, f));
      sizes.push({ name: f, kb: Math.round(stat.size / 1024) });
    } catch {
      sizes.push({ name: f, kb: 0 });
    }
  }
  const recommendedOrder = [
    "bot-bundle-1-core-decision.md",
    "bot-bundle-2-execution-and-risk.md",
    "bot-bundle-3-worker-and-runtime.md",
    "bot-bundle-4-schema-and-data-model.md",
    "bot-bundle-5-ui-surfaces.md",
    "bot-bundle-6-tests-and-docs.md",
    "bot-runtime-snapshot.md",
    "repo-tree-bot.txt",
  ];
  const indexLines: string[] = [
    "# Trading bot audit — BUNDLE INDEX",
    "",
    "## Created bundle files",
    "",
    ...sizes.map((s) => `- \`${s.name}\` — ~${s.kb} KB`),
    "",
    "## Recommended send order to ChatGPT",
    "",
    ...recommendedOrder.map((name, i) => {
      const s = sizes.find((x) => x.name === name);
      return `${i + 1}. ${name}${s ? ` (~${s.kb} KB)` : ""}`;
    }),
  ];
  await fs.writeFile(path.join(OUT_DIR, "BUNDLE_INDEX.md"), indexLines.join("\n") + "\n", "utf8");

  // --- Console output
  const createdPaths = [
    path.join(OUT_DIR, "MANIFEST.md"),
    path.join(OUT_DIR, "BUNDLE_INDEX.md"),
    ...bundleFiles.map((f) => path.join(OUT_DIR, f)),
  ];
  console.log("\nCreated file paths:");
  for (const p of createdPaths) {
    console.log("  ", p);
  }
  console.log("\nWhich bundle to send first: bot-bundle-1-core-decision.md");
  console.log("\nApproximate size of each bundle:");
  for (const s of sizes) {
    console.log("  ", s.name, "~", s.kb, "KB");
  }
  console.log("\nExact folder: audit-dumps/trading-bot-audit/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
