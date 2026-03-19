/**
 * User feed freshness debug report.
 *
 * Writes:
 * - dump/user-feed-freshness-debug-report.json
 * - dump/user-feed-freshness-debug-report.md
 *
 * npm run dump:user-feed-freshness-debug-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForRecompute } from "../lib/polymarket/recompute";
import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "../lib/runtime/stream-watchdog-config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

function safeJsonParse(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function ageMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const funder = (await getFunderForRecompute()) ?? "";
  const rows = funder
    ? await prisma.websocketConnectionStatus.findMany({
        where: { funderAddress: funder.toLowerCase(), channel: { in: ["user-feed", "market-feed"] } },
      })
    : [];
  const byChannel: Record<string, { connected: boolean; lastHeartbeatAt: string | null; lastMessageAt: string | null; lastError: string | null }> =
    {};
  for (const r of rows) {
    byChannel[r.channel] = {
      connected: r.connected,
      lastHeartbeatAt: r.lastHeartbeatAt?.toISOString() ?? null,
      lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
      lastError: r.lastError ?? null,
    };
  }

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = safeJsonParse(hb?.metadataJson ?? null);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const streams = (runtimeHealth?.streams ?? null) as Record<string, unknown> | null;
  const userConn = (streams?.userConnection ?? null) as Record<string, unknown> | null;
  const marketConn = (streams?.marketConnection ?? null) as Record<string, unknown> | null;

  const inMemUserLastDataEventAt = isoOrNull(userConn?.lastDataEventAt);
  const inMemUserLastHeartbeatAt = isoOrNull(userConn?.lastHeartbeatAt);
  const inMemUserLastMessageAt = isoOrNull(userConn?.lastMessageAt);
  const inMemUserStatus = typeof userConn?.status === "string" ? (userConn.status as string) : null;

  const report = {
    generatedAt,
    workerName: WORKER_NAME,
    funderAddress: funder || null,
    thresholds: {
      userDataDegradedThresholdMs: DEFAULT_STREAM_WATCHDOG_CONFIG.userDataDegradedThresholdMs,
      userDataKillSwitchWithOrdersThresholdMs: DEFAULT_STREAM_WATCHDOG_CONFIG.userDataKillSwitchWithOrdersThresholdMs,
      runtimeSafetyDefaultUserStaleMs: 90_000,
      runtimeSafetyDefaultUserBlockMs: 300_000,
      wsStatusPersistDebounceMs: Number(process.env.WS_STATUS_PERSIST_DEBOUNCE_MS ?? "2500") || 2500,
    },
    inMemory: {
      user: {
        status: inMemUserStatus,
        lastDataEventAt: inMemUserLastDataEventAt,
        lastHeartbeatAt: inMemUserLastHeartbeatAt,
        lastMessageAt: inMemUserLastMessageAt,
        agesMs: {
          lastDataEventAgeMs: ageMs(inMemUserLastDataEventAt),
          lastHeartbeatAgeMs: ageMs(inMemUserLastHeartbeatAt),
          lastMessageAgeMs: ageMs(inMemUserLastMessageAt),
        },
      },
      market: {
        status: typeof marketConn?.status === "string" ? (marketConn.status as string) : null,
        lastDataEventAt: isoOrNull(marketConn?.lastDataEventAt),
        lastHeartbeatAt: isoOrNull(marketConn?.lastHeartbeatAt),
      },
    },
    database: {
      websocketConnectionStatus: byChannel,
      dbAgesMs: {
        user_lastMessageAgeMs: ageMs(byChannel["user-feed"]?.lastMessageAt ?? null),
        user_lastHeartbeatAgeMs: ageMs(byChannel["user-feed"]?.lastHeartbeatAt ?? null),
      },
    },
    diagnosis: {
      whyFreshnessUnknown:
        inMemUserLastDataEventAt == null
          ? "No user WS real data event has been observed yet (only heartbeat/PONG or no messages). This is distinct from DB persistence and uses in-memory stream state."
          : null,
      likelyBenignInPaperMode:
        inMemUserLastDataEventAt == null &&
        (ageMs(inMemUserLastHeartbeatAt) ?? Infinity) < 60_000
          ? "Often benign if there are no working orders: user feed may be quiet. Runtime safety previously treated this as unknown; we now also consider recent user truth fetch in runtime safety."
          : null,
      dbWriteDroppingPossible:
        byChannel["user-feed"]?.connected === true &&
        byChannel["user-feed"]?.lastMessageAt == null &&
        inMemUserLastMessageAt != null
          ? "DB lastMessageAt can lag due to debounced persistence or pool pressure; compare in-memory timestamps above."
          : null,
    },
  };

  const md = [
    "# User feed freshness debug report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Thresholds",
    "",
    "```json",
    JSON.stringify(report.thresholds, null, 2),
    "```",
    "",
    "## In-memory stream state (from worker heartbeat)",
    "",
    "```json",
    JSON.stringify(report.inMemory.user, null, 2),
    "```",
    "",
    "## DB websocketConnectionStatus (may be debounced)",
    "",
    "```json",
    JSON.stringify(report.database.websocketConnectionStatus, null, 2),
    "```",
    "",
    "## Diagnosis",
    "",
    "```json",
    JSON.stringify(report.diagnosis, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(DUMP_DIR, "user-feed-freshness-debug-report.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.writeFile(path.join(DUMP_DIR, "user-feed-freshness-debug-report.md"), md);
  console.log("Wrote dump/user-feed-freshness-debug-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

