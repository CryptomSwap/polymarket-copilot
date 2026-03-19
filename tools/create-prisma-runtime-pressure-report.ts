/**
 * Documents Prisma hot paths and pressure-reduction measures.
 *
 * Writes: dump/prisma-runtime-pressure-report.json, .md
 * npm run dump:prisma-runtime-pressure-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";

const DUMP = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    knownHotPaths: {
      websocketConnectionStatus: {
        file: "lib/live/status.ts",
        before: "Every WS heartbeat/message could trigger immediate upsert (2 channels × high message rate).",
        after:
          "Debounced coalesced upsert (~2.5s, env WS_STATUS_PERSIST_DEBOUNCE_MS). Immediate flush on disconnect or non-empty lastError. Skip DB when serialized state unchanged since last successful write.",
      },
      stream_sync_state: {
        file: "lib/live/streaming-sync.ts",
        before:
          "Each stream event: findUnique + update (or upsert). Startup/refresh: trackedAssetCount write every 90s even if unchanged.",
        after:
          "lastEventAt: debounced (~3s, STREAM_SYNC_LAST_EVENT_DEBOUNCE_MS). trackedAssetCount: skip write when value equals last flushed (in-process). Reconciliation timestamps: immediate single upsert (no read-before-write).",
      },
      authCredentialReads: {
        file: "lib/polymarket/auth.ts",
        before: "getStoredCredentials: findMany + count on every hot-path caller.",
        after:
          "In-memory cache TTL ~5s (POLY_CREDENTIAL_CACHE_TTL_MS); invalidateCredentialLookupCache() on credential upsert/delete so updates are visible immediately.",
      },
    },
    expectedReduction: {
      websocketUpserts:
        "Rough order: from O(messages) to O(flush_interval) per channel+funder, plus disconnect/error immediate.",
      streamSyncWrites:
        "lastEventAt from O(events) to ≤1 per debounce window; duplicate trackedAssetCount suppressed.",
      credentialQueries:
        "Up to ~80% reduction when many code paths call getStoredCredentials within TTL window.",
    },
    remainingRisks: [
      "WS status can lag up to debounce interval during steady connected operation (health APIs see slightly stale lastMessageAt/heartbeat).",
      "lastEventAt in DB can lag up to STREAM_SYNC_LAST_EVENT_DEBOUNCE_MS; reconciliation and tracked count paths stay authoritative.",
      "Credential cache: new credentials or validation changes visible after TTL (default 5s).",
      "P2024 can still occur under extreme parallel load; consider connection pool size / DATABASE_URL params separately.",
    ],
    envTuning: {
      WS_STATUS_PERSIST_DEBOUNCE_MS: "Default 2500",
      STREAM_SYNC_LAST_EVENT_DEBOUNCE_MS: "Default 3000",
      POLY_CREDENTIAL_CACHE_TTL_MS: "Default 5000",
    },
  };

  const md = [
    "# Prisma runtime pressure report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Hot paths and mitigations",
    "",
    "### websocketConnectionStatus",
    "",
    `- **Where:** ${report.knownHotPaths.websocketConnectionStatus.file}`,
    `- **Was:** ${report.knownHotPaths.websocketConnectionStatus.before}`,
    `- **Now:** ${report.knownHotPaths.websocketConnectionStatus.after}`,
    "",
    "### stream_sync_state",
    "",
    `- **Where:** ${report.knownHotPaths.stream_sync_state.file}`,
    `- **Was:** ${report.knownHotPaths.stream_sync_state.before}`,
    `- **Now:** ${report.knownHotPaths.stream_sync_state.after}`,
    "",
    "### Auth / credential reads",
    "",
    `- **Where:** ${report.knownHotPaths.authCredentialReads.file}`,
    `- **Was:** ${report.knownHotPaths.authCredentialReads.before}`,
    `- **Now:** ${report.knownHotPaths.authCredentialReads.after}`,
    "",
    "## Expected reduction",
    "",
    JSON.stringify(report.expectedReduction, null, 2),
    "",
    "## Remaining risks",
    "",
    ...report.remainingRisks.map((r) => `- ${r}`),
    "",
    "## Env tuning",
    "",
    "```json",
    JSON.stringify(report.envTuning, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP, "prisma-runtime-pressure-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP, "prisma-runtime-pressure-report.md"), md);
  console.log("Wrote dump/prisma-runtime-pressure-report.{json,md}");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
