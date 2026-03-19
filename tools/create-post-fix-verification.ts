/**
 * Post-fix verification bundle: proves portfolio page now matches live Polymarket data.
 * Captures raw upstream positions/orders, app API positions/overview/intelligence,
 * and builds VERIFICATION_REPORT.md from the JSON only.
 *
 * Usage: npx tsx tools/create-post-fix-verification.ts
 * Env: AUDIT_BASE_URL (optional, default http://localhost:3000)
 *
 * No behavior change. Redacts secrets. Exact outputs preserved.
 */

import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";

const ROOT = path.resolve(process.cwd(), "audit-dumps", "post-fix-verification");
const BASE_URL = process.env.AUDIT_BASE_URL ?? "http://localhost:3000";
const DATA_API_BASE = "https://data-api.polymarket.com";

const MARCH_6_TITLE = /Will Iran strike Israel on March 6\?/i;
const CRUDE_OIL_TITLE = /crude oil|Crude Oil/i;

function toQueryAddress(funderAddress: string): string {
  const s = String(funderAddress ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("0x")) return s.length >= 42 ? s.slice(0, 42) : s;
  return "0x" + s.slice(0, 40);
}

function getGitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function getGitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });

  const baseUrl = process.env.AUDIT_BASE_URL ?? "http://localhost:3000";
  const positionsUrl = `${baseUrl}/api/portfolio/positions?canonical=true`;
  console.log("[post-fix-verification] AUDIT_BASE_URL set:", process.env.AUDIT_BASE_URL != null);
  console.log("[post-fix-verification] BASE_URL (used for app fetches):", baseUrl);
  console.log("[post-fix-verification] Positions URL requested:", positionsUrl);

  const timestamp = new Date().toISOString();
  const gitBranch = getGitBranch();
  const gitCommit = getGitCommit();

  let funder: string | null = null;
  try {
    const { getFunderForRecompute } = await import("../lib/polymarket/recompute");
    funder = await getFunderForRecompute();
  } catch {
    // continue without funder
  }

  // --- Raw upstream positions ---
  let rawPositions: unknown[] = [];
  if (funder) {
    const addressUsed = toQueryAddress(funder);
    const limit = 500;
    let offset = 0;
    try {
      for (;;) {
        const params = new URLSearchParams({ user: addressUsed, limit: String(limit), offset: String(offset) });
        const res = await fetch(`${DATA_API_BASE}/positions?${params.toString()}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) break;
        const page = (await res.json()) as unknown;
        const arr = Array.isArray(page) ? page : [];
        rawPositions = rawPositions.concat(arr);
        if (arr.length < limit) break;
        offset += limit;
        if (offset >= 10000) break;
      }
    } catch {
      rawPositions = [];
    }
  }
  await fs.writeFile(
    path.join(ROOT, "RAW_UPSTREAM_POSITIONS.json"),
    JSON.stringify(rawPositions, null, 2),
    "utf8"
  );

  // --- Raw upstream open orders ---
  let rawOpenOrders: unknown = { data: [], error: "no funder or credentials" };
  if (funder) {
    try {
      const { getStoredCredentials } = await import("../lib/polymarket/auth");
      const {
        clobGetWithL2Raw,
        GET_DATA_ORDERS,
        DATA_ORDERS_INITIAL_CURSOR,
      } = await import("../lib/polymarket/l2-readonly");
      const { credential: creds } = await getStoredCredentials();
      if (creds?.apiKey && creds?.secret && creds?.passphrase && creds?.funderAddress) {
        const l2Creds = {
          apiKey: creds.apiKey,
          secret: creds.secret,
          passphrase: creds.passphrase,
          funderAddress: creds.funderAddress,
          polyAddress: (creds as { polyAddress?: string }).polyAddress ?? creds.funderAddress,
        };
        const { status, body } = await clobGetWithL2Raw(l2Creds, GET_DATA_ORDERS, {
          next_cursor: DATA_ORDERS_INITIAL_CURSOR,
        });
        if (status === 200 && body) {
          try {
            rawOpenOrders = JSON.parse(body) as { data?: unknown[]; next_cursor?: string };
          } catch {
            rawOpenOrders = { data: [], rawBody: body.slice(0, 500), error: "Parse failed" };
          }
        } else {
          rawOpenOrders = { data: [], error: `HTTP ${status}`, raw: (body ?? "").slice(0, 200) };
        }
      }
    } catch (e) {
      rawOpenOrders = { data: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
  await fs.writeFile(
    path.join(ROOT, "RAW_UPSTREAM_OPEN_ORDERS.json"),
    JSON.stringify(rawOpenOrders, null, 2),
    "utf8"
  );

  // --- App API fetches ---
  let appPositions: Record<string, unknown> = {};
  let appOverview: Record<string, unknown> = {};
  let appIntelligence: Record<string, unknown> = {};
  let appReachable = false;
  let overviewHttpStatus = 0;

  try {
    const [posRes, ovRes, intRes] = await Promise.all([
      fetch(positionsUrl),
      fetch(`${BASE_URL}/api/portfolio/overview`),
      fetch(`${BASE_URL}/api/portfolio/intelligence`),
    ]);
    appReachable = true;
    overviewHttpStatus = ovRes.status;
    if (posRes.ok) appPositions = (await posRes.json()) as Record<string, unknown>;
    else appPositions = { error: "HTTP " + posRes.status, status: posRes.status };
    if (ovRes.ok) appOverview = (await ovRes.json()) as Record<string, unknown>;
    else appOverview = { error: "HTTP " + ovRes.status, status: ovRes.status };
    if (intRes.ok) appIntelligence = (await intRes.json()) as Record<string, unknown>;
    else appIntelligence = { error: "HTTP " + intRes.status, status: intRes.status };
  } catch (e) {
    appPositions = { error: e instanceof Error ? e.message : String(e) };
    appOverview = { error: e instanceof Error ? e.message : String(e) };
    appIntelligence = { error: e instanceof Error ? e.message : String(e) };
  }

  await fs.writeFile(path.join(ROOT, "APP_POSITIONS.json"), JSON.stringify(appPositions, null, 2), "utf8");
  await fs.writeFile(path.join(ROOT, "APP_OVERVIEW.json"), JSON.stringify(appOverview, null, 2), "utf8");
  await fs.writeFile(path.join(ROOT, "APP_INTELLIGENCE.json"), JSON.stringify(appIntelligence, null, 2), "utf8");

  // --- VERIFICATION_REPORT.md (from captured JSON only) ---
  const appPositionsList = Array.isArray(appPositions.positions) ? appPositions.positions : [];
  const upstreamTitles = rawPositions.map((r) => ((r as Record<string, unknown>).title ?? "").toString());
  const march6InUpstream = rawPositions.some((r) => MARCH_6_TITLE.test(((r as Record<string, unknown>).title ?? "").toString()));
  const appTitles = appPositionsList.map((p) => {
    const m = (p as Record<string, unknown>).market as Record<string, unknown> | undefined;
    return (m?.title ?? (p as Record<string, unknown>).marketTitle ?? "").toString();
  });
  const march6InApp = appTitles.some((t) => MARCH_6_TITLE.test(t));

  const posSourceOfTruth = (appPositions.sourceOfTruth as string) ?? "—";
  const posAsOf = (appPositions.asOf as string) ?? "—";
  const posFreshnessMs = appPositions.freshnessMs != null ? String(appPositions.freshnessMs) : "—";
  const overviewReturns200 = overviewHttpStatus === 200;

  const reportLines: string[] = [
    "# Post-fix verification report",
    "",
    "Built from captured JSON only. No guesswork.",
    "",
    "## March 6 row",
    "- **\"Will Iran strike Israel on March 6?\" in raw upstream positions**: " + (march6InUpstream ? "YES" : "NO"),
    "- **Same row in app /api/portfolio/positions**: " + (march6InApp ? "YES" : "NO"),
    "",
    "## Counts",
    "- **Raw upstream positions (this capture)**: " + rawPositions.length + " rows",
    "- **App open positions (/api/portfolio/positions positions array)**: " + appPositionsList.length + " rows",
    "",
    "## Positions source / freshness",
    "- **sourceOfTruth**: " + posSourceOfTruth,
    "- **asOf**: " + posAsOf,
    "- **freshnessMs**: " + posFreshnessMs,
    "",
    "## Overview",
    "- **GET /api/portfolio/overview**: " + (overviewReturns200 ? "200 OK" : "HTTP " + overviewHttpStatus + " (error or non-200)"),
    "- **Response has error key**: " + ("error" in appOverview && appOverview.error ? "yes" : "no"),
    "",
    "## Crude oil rows (compact table)",
    "",
    "| title | upstream curPrice | upstream currentValue | app lastPrice | app marketValue/currentValue | match |",
    "|-------|-------------------|------------------------|--------------|------------------------------|-------|",
  ];

  const crudeUpstream = rawPositions.filter((r) =>
    CRUDE_OIL_TITLE.test(((r as Record<string, unknown>).title ?? "").toString())
  ) as Record<string, unknown>[];
  for (const row of crudeUpstream) {
    const title = (row.title ?? "").toString().slice(0, 60);
    const upCur = row.curPrice != null ? String(row.curPrice) : "—";
    const upVal = row.currentValue != null ? String(row.currentValue) : "—";
    const assetId = (row.asset ?? row.asset_id ?? "").toString();
    const canonical = appPositionsList.find((p) => {
      const rec = p as Record<string, unknown>;
      const tok = rec.token as Record<string, unknown> | undefined;
      const m = rec.market as Record<string, unknown> | undefined;
      const pAssetId = (tok?.assetId ?? "").toString();
      const t = (m?.title ?? rec.marketTitle ?? "").toString();
      if (pAssetId && pAssetId === assetId) return true;
      if (!t || !title) return false;
      if (t === title) return true;
      const crudeMatch = t.includes("Crude Oil") && title.includes("Crude Oil") &&
        ((title.includes("$130") && t.includes("130")) || (title.includes("$120") && t.includes("120")) ||
         (title.includes("$140") && t.includes("140")) || (title.includes("$180") && t.includes("180")));
      return !!crudeMatch;
    }) as Record<string, unknown> | undefined;
    let appLastPrice = "—";
    let appMarketValue = "—";
    if (canonical) {
      const ec = canonical.economics as Record<string, unknown> | undefined;
      appLastPrice = (ec?.markPrice ?? "").toString() || "—";
      appMarketValue = (ec?.currentValue ?? ec?.exposure ?? "").toString() || "—";
    }
    const matchCur = upCur !== "—" && appLastPrice !== "—" ? Math.abs(parseFloat(upCur) - parseFloat(appLastPrice)) < 1e-6 : null;
    const matchVal = upVal !== "—" && appMarketValue !== "—" ? Math.abs(parseFloat(upVal) - parseFloat(appMarketValue)) < 0.01 : null;
    const match = matchCur === true && matchVal === true ? "exact match" : matchCur === false || matchVal === false ? "mismatch" : "—";
    reportLines.push(`| ${title} | ${upCur} | ${upVal} | ${appLastPrice} | ${appMarketValue} | ${match} |`);
  }
  if (crudeUpstream.length === 0) {
    reportLines.push("| (no crude oil rows in upstream capture) | — | — | — | — | — |");
  }

  reportLines.push("", "## Suspicious rows (upstream)");
  const suspicious: string[] = [];
  for (let i = 0; i < rawPositions.length; i++) {
    const row = rawPositions[i] as Record<string, unknown>;
    const title = (row.title ?? "").toString();
    const curPrice = row.curPrice != null ? Number(row.curPrice) : NaN;
    const currentValue = row.currentValue != null ? Number(row.currentValue) : NaN;
    const endDate = row.endDate;
    const redeemable = row.redeemable;
    const flags: string[] = [];
    if (Number.isFinite(curPrice) && curPrice === 0) flags.push("curPrice==0");
    if (Number.isFinite(currentValue) && currentValue === 0) flags.push("currentValue==0");
    if (redeemable === true) flags.push("redeemable");
    if (endDate == null || endDate === "") flags.push("endDate blank");
    if (MARCH_6_TITLE.test(title)) flags.push("March 6 title");
    if (flags.length > 0) suspicious.push(`Row ${i + 1}: ${title.slice(0, 50)} — ${flags.join(", ")}`);
  }
  if (suspicious.length === 0) reportLines.push("None detected in upstream capture.");
  else reportLines.push(...suspicious);

  reportLines.push("", "## App positions suspicious (curPrice 0, currentValue 0, etc.)");
  const appSuspicious: string[] = [];
  for (let i = 0; i < appPositionsList.length; i++) {
    const p = appPositionsList[i] as Record<string, unknown>;
    const ec = p.economics as Record<string, unknown> | undefined;
    const markPrice = ec?.markPrice != null ? parseFloat(String(ec.markPrice)) : NaN;
    const currentValue = ec?.currentValue ?? ec?.exposure;
    const cv = currentValue != null ? parseFloat(String(currentValue)) : NaN;
    const m = p.market as Record<string, unknown> | undefined;
    const title = (m?.title ?? p.marketTitle ?? "").toString();
    const flags: string[] = [];
    if (Number.isFinite(markPrice) && markPrice === 0) flags.push("markPrice==0");
    if (Number.isFinite(cv) && cv === 0) flags.push("currentValue==0");
    if (MARCH_6_TITLE.test(title)) flags.push("March 6 title");
    if (flags.length > 0) appSuspicious.push(`Position ${i + 1}: ${title.slice(0, 50)} — ${flags.join(", ")}`);
  }
  if (appSuspicious.length === 0) reportLines.push("None detected in app positions.");
  else reportLines.push(...appSuspicious);

  await fs.writeFile(path.join(ROOT, "VERIFICATION_REPORT.md"), reportLines.join("\n"), "utf8");

  // --- MANIFEST.md (write first so it can be included in bundle) ---
  const artifacts: { name: string; path: string }[] = [
    { name: "MANIFEST.md", path: path.join(ROOT, "MANIFEST.md") },
    { name: "RAW_UPSTREAM_POSITIONS.json", path: path.join(ROOT, "RAW_UPSTREAM_POSITIONS.json") },
    { name: "RAW_UPSTREAM_OPEN_ORDERS.json", path: path.join(ROOT, "RAW_UPSTREAM_OPEN_ORDERS.json") },
    { name: "APP_POSITIONS.json", path: path.join(ROOT, "APP_POSITIONS.json") },
    { name: "APP_OVERVIEW.json", path: path.join(ROOT, "APP_OVERVIEW.json") },
    { name: "APP_INTELLIGENCE.json", path: path.join(ROOT, "APP_INTELLIGENCE.json") },
    { name: "VERIFICATION_REPORT.md", path: path.join(ROOT, "VERIFICATION_REPORT.md") },
    { name: "CHATGPT_POST_FIX_BUNDLE.md", path: path.join(ROOT, "CHATGPT_POST_FIX_BUNDLE.md") },
  ];
  const manifestLines: string[] = [
    "# Post-fix verification bundle manifest",
    "",
    "- **Generation timestamp**: " + timestamp,
    "- **Git branch**: " + gitBranch,
    "- **Git commit**: " + gitCommit,
    "- **App reachable**: " + (appReachable ? "yes" : "no"),
    "",
    "## Artifacts",
    "",
  ];
  for (const { name, path: filePath } of artifacts) {
    let status = "NOT FOUND";
    try {
      await fs.access(filePath);
      status = "FOUND";
    } catch {
      if (name === "MANIFEST.md") status = "FOUND";
    }
    manifestLines.push("- **" + name + "**: " + status + " — `" + path.relative(process.cwd(), filePath) + "`");
  }
  await fs.writeFile(path.join(ROOT, "MANIFEST.md"), manifestLines.join("\n"), "utf8");

  // --- CHATGPT_POST_FIX_BUNDLE.md ---
  const bundleOrder = [
    "VERIFICATION_REPORT.md",
    "RAW_UPSTREAM_POSITIONS.json",
    "RAW_UPSTREAM_OPEN_ORDERS.json",
    "APP_POSITIONS.json",
    "APP_OVERVIEW.json",
    "APP_INTELLIGENCE.json",
    "MANIFEST.md",
  ];
  const bundleParts: string[] = [];
  for (const name of bundleOrder) {
    const filePath = path.join(ROOT, name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      bundleParts.push(
        "================================================================================\nFILE: " + name + "\nSTATUS: FOUND\n================================================================================\n" + content + "\n\n"
      );
    } catch {
      bundleParts.push(
        "================================================================================\nFILE: " + name + "\nSTATUS: NOT FOUND\n================================================================================\n\n"
      );
    }
  }
  await fs.writeFile(path.join(ROOT, "CHATGPT_POST_FIX_BUNDLE.md"), bundleParts.join(""), "utf8");

  // Update manifest so CHATGPT_POST_FIX_BUNDLE.md shows FOUND
  const manifestPath = path.join(ROOT, "MANIFEST.md");
  let manifestContent = await fs.readFile(manifestPath, "utf8");
  manifestContent = manifestContent.replace(
    "**CHATGPT_POST_FIX_BUNDLE.md**: NOT FOUND",
    "**CHATGPT_POST_FIX_BUNDLE.md**: FOUND"
  );
  await fs.writeFile(manifestPath, manifestContent, "utf8");

  console.log("");
  console.log("Post-fix verification bundle written to: " + ROOT);
  console.log("");
  console.log("How to run: npm run dump:post-fix-verification");
  console.log("Exact file to paste into ChatGPT first: audit-dumps/post-fix-verification/CHATGPT_POST_FIX_BUNDLE.md");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
