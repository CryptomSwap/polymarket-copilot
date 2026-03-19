/**
 * Creates live-truth audit runtime dumps: fetches portfolio API responses and writes
 * raw JSON + metadata + consistency summary. Run with app at baseUrl (default localhost:3000).
 *
 * Usage: npx tsx tools/create-live-truth-audit-dumps.ts
 * Env: AUDIT_BASE_URL (optional, default http://localhost:3000)
 */

import * as fs from "fs/promises";
import * as path from "path";

const BASE_URL = process.env.AUDIT_BASE_URL ?? "http://localhost:3000";
const AUDIT_ROOT = path.resolve(process.cwd(), "audit-dumps", "live-truth-audit");
const RUNTIME_DIR = path.join(AUDIT_ROOT, "runtime");

interface EndpointResult {
  url: string;
  status: number;
  startAt: string;
  endAt: string;
  error?: string;
  body?: unknown;
}

async function fetchEndpoint(url: string): Promise<EndpointResult> {
  const startAt = new Date().toISOString();
  try {
    const res = await fetch(url);
    const endAt = new Date().toISOString();
    let body: unknown = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        body = await res.json();
      } catch {
        body = { _parseError: "JSON parse failed" };
      }
    }
    return {
      url,
      status: res.status,
      startAt,
      endAt,
      body: res.ok ? body : { error: body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : res.statusText, status: res.status },
    };
  } catch (err) {
    const endAt = new Date().toISOString();
    return {
      url,
      status: 0,
      startAt,
      endAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildConsistencySummary(results: Map<string, EndpointResult>): string {
  const lines: string[] = [
    "# Live-Truth Consistency Summary",
    "",
    "Generated from captured runtime responses. Factual only.",
    "",
  ];

  const overview = results.get("/api/portfolio/overview")?.body as Record<string, unknown> | undefined;
  const positions = results.get("/api/portfolio/positions")?.body as Record<string, unknown> | undefined;
  const intelligence = results.get("/api/portfolio/intelligence")?.body as Record<string, unknown> | undefined;

  // Overview
  lines.push("## Overview response");
  if (overview && overview.error == null) {
    lines.push(`- sourceOfTruth: ${String(overview.sourceOfTruth ?? "absent")}`);
    lines.push(`- asOf: ${String(overview.asOf ?? "absent")}`);
    lines.push(`- freshnessMs: ${overview.freshnessMs === null ? "null" : String(overview.freshnessMs)}`);
    const snapshot = overview.snapshot as Record<string, unknown> | undefined;
    if (snapshot) {
      const hasId = "id" in snapshot && snapshot.id != null;
      const hasCreatedAt = "createdAt" in snapshot && snapshot.createdAt != null;
      lines.push(`- snapshot has forbidden 'id': ${hasId ? "YES (contract violation)" : "no"}`);
      lines.push(`- snapshot has forbidden 'createdAt': ${hasCreatedAt ? "YES (contract violation)" : "no"}`);
    }
    lines.push(`- persistedSnapshotMeta present: ${overview.persistedSnapshotMeta != null ? "yes" : "no"}`);
  } else {
    lines.push("- (no successful overview response captured)");
  }
  lines.push("");

  // Positions
  lines.push("## Positions response");
  if (positions && positions.error == null) {
    lines.push(`- sourceOfTruth: ${String(positions.sourceOfTruth ?? "absent")}`);
    lines.push(`- asOf: ${String(positions.asOf ?? "absent")}`);
    lines.push(`- freshnessMs: ${positions.freshnessMs === null ? "null" : String(positions.freshnessMs)}`);
    const posList = positions.positions as unknown[] | undefined;
    const first = Array.isArray(posList) && posList.length > 0 ? (posList[0] as Record<string, unknown>) : null;
    const provenanceKeys = first
      ? ["quantitySource", "priceSource", "basisSource", "pnlSource", "rowSource"].filter((k) => k in first)
      : [];
    lines.push(`- field-level provenance on first position: ${provenanceKeys.length > 0 ? provenanceKeys.join(", ") : "none"}`);
  } else {
    lines.push("- (no successful positions response captured)");
  }
  lines.push("");

  // Intelligence
  lines.push("## Intelligence response");
  if (intelligence && intelligence.error == null && intelligence.ok) {
    lines.push(`- sourceOfTruth: ${String(intelligence.sourceOfTruth ?? "absent")}`);
    lines.push(`- asOf: ${String(intelligence.asOf ?? "absent")}`);
    lines.push(`- freshnessMs: ${intelligence.freshnessMs === null ? "null" : String(intelligence.freshnessMs)}`);
  } else {
    lines.push("- (no successful intelligence response captured)");
  }
  lines.push("");

  // Cross-endpoint
  lines.push("## Cross-endpoint consistency");
  const overviewAsOf = overview && overview.error == null ? String(overview.asOf ?? "") : "";
  const positionsAsOf = positions && positions.error == null ? String(positions.asOf ?? "") : "";
  const intelAsOf = intelligence && intelligence.error == null && intelligence.ok ? String(intelligence.asOf ?? "") : "";
  if (overviewAsOf && positionsAsOf) {
    const same = overviewAsOf === positionsAsOf;
    lines.push(`- Overview asOf vs Positions asOf: ${same ? "equal" : "divergent"}`);
    if (!same) lines.push(`  - Overview: ${overviewAsOf}`);
    if (!same) lines.push(`  - Positions: ${positionsAsOf}`);
  }
  if (overviewAsOf && intelAsOf) {
    lines.push(`- Overview asOf vs Intelligence asOf: ${overviewAsOf === intelAsOf ? "equal" : "divergent"}`);
  }
  const overviewSource = overview && overview.error == null ? String(overview.sourceOfTruth ?? "") : "";
  const positionsSource = positions && positions.error == null ? String(positions.sourceOfTruth ?? "") : "";
  const intelSource = intelligence && intelligence.ok ? String(intelligence.sourceOfTruth ?? "") : "";
  if ([overviewSource, positionsSource, intelSource].some(Boolean)) {
    const sources = [overviewSource, positionsSource, intelSource].filter(Boolean);
    const allSame = sources.every((s) => s === sources[0]);
    lines.push(`- sourceOfTruth labels across endpoints: ${allSame ? "same" : "differ"}`);
  }
  lines.push("");

  // Mixed live + persisted
  lines.push("## Live vs persisted separation");
  if (overview && overview.error == null && overview.snapshot) {
    const snap = overview.snapshot as Record<string, unknown>;
    const hasPersistedInSnapshot = "id" in snap || "createdAt" in snap;
    lines.push(`- Overview snapshot mixes persisted metadata (id/createdAt): ${hasPersistedInSnapshot ? "YES (violation)" : "no"}`);
    lines.push(`- persistedSnapshotMeta is separate: ${overview.persistedSnapshotMeta != null ? "yes" : "no"}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  const captureStartedAt = new Date().toISOString();
  await fs.mkdir(RUNTIME_DIR, { recursive: true });

  const endpoints = [
    "/api/portfolio/overview",
    "/api/portfolio/positions",
    "/api/portfolio/intelligence",
  ];

  const results = new Map<string, EndpointResult>();
  for (const ep of endpoints) {
    const url = `${BASE_URL}${ep}`;
    const result = await fetchEndpoint(url);
    results.set(ep, result);
  }

  const captureFinishedAt = new Date().toISOString();

  const meta: Record<string, unknown> = {
    captureStartedAt,
    captureFinishedAt,
    baseUrl: BASE_URL,
    endpoints: {} as Record<string, { status: number; startAt: string; endAt: string; error?: string }>,
  };
  for (const [ep, r] of results) {
    (meta.endpoints as Record<string, unknown>)[ep] = {
      status: r.status,
      startAt: r.startAt,
      endAt: r.endAt,
      ...(r.error != null ? { error: r.error } : {}),
    };
  }

  await fs.writeFile(
    path.join(RUNTIME_DIR, "runtime-capture-meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  const outNames: Record<string, string> = {
    "/api/portfolio/overview": "overview-response.json",
    "/api/portfolio/positions": "positions-response.json",
    "/api/portfolio/intelligence": "intelligence-response.json",
  };
  for (const [ep, r] of results) {
    const name = outNames[ep];
    if (!name) continue;
    const toWrite = r.body ?? { error: r.error, status: r.status };
    await fs.writeFile(
      path.join(RUNTIME_DIR, name),
      JSON.stringify(toWrite, null, 2),
      "utf8"
    );
  }

  const summary = buildConsistencySummary(results);
  await fs.writeFile(path.join(RUNTIME_DIR, "consistency-summary.md"), summary, "utf8");

  console.log("Live-truth audit dumps written to:", RUNTIME_DIR);
  for (const [ep, r] of results) {
    console.log(`  ${ep} -> ${r.status}${r.error ? ` (${r.error})` : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
