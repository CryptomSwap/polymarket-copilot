/**
 * Background worker: WebSockets, heartbeat, and scheduled jobs. No autonomous trading.
 * Run with: npx ts-node -r tsconfig-paths/register worker/index.ts
 * Or: node --import tsx worker/index.ts (if using tsx)
 *
 * Set USE_STREAM_RUNTIME=true to run the composed StreamRuntime (event bus, market engine,
 * position store, risk, bot, order manager, paper adapter) with existing WS flows. Paper only;
 * global automation off by default.
 */

import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { startWebsockets, stopWebsockets } from "./websockets";
import { StreamRuntime } from "./stream-runtime";
import { JOB_NAMES, JOB_INTERVALS_MS, runJob, type JobName } from "./jobs";

const WORKER_NAME = "polymarket-copilot-worker";
const USE_STREAM_RUNTIME = process.env.USE_STREAM_RUNTIME === "true";

let jobIntervals: ReturnType<typeof setInterval>[] = [];
let streamRuntime: StreamRuntime | null = null;

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  const prefix = `[worker]`;
  switch (level) {
    case "info":
      console.info(prefix, line);
      break;
    case "warn":
      console.warn(prefix, line);
      break;
    case "error":
      console.error(prefix, line);
      break;
  }
}

function scheduleJobs(): void {
  for (const name of JOB_NAMES) {
    const intervalMs = JOB_INTERVALS_MS[name as JobName];
    const id = setInterval(async () => {
      try {
        log("info", `Scheduled job started: ${name}`, {});
        const result = await runJob(name as JobName);
        log("info", `Scheduled job finished: ${name}`, { status: result.status, durationMs: result.durationMs });
        if (result.error) log("error", `Job ${name} error`, { error: result.error });
      } catch (err) {
        log("error", `Scheduled job threw: ${name}`, { error: String(err) });
      }
    }, intervalMs);
    jobIntervals.push(id);
  }
  log("info", "Scheduled jobs registered", { count: JOB_NAMES.length });
}

function clearScheduledJobs(): void {
  for (const id of jobIntervals) clearInterval(id);
  jobIntervals = [];
}

async function shutdown(): Promise<void> {
  log("info", "Shutdown requested", {});
  clearScheduledJobs();
  if (streamRuntime) {
    await streamRuntime.stop();
    streamRuntime = null;
  } else {
    stopWebsockets();
  }
  await stopHeartbeat(WORKER_NAME);
  log("info", "Shutdown complete", {});
  process.exit(0);
}

function main(): void {
  if (typeof (globalThis as unknown as { WebSocket?: unknown }).WebSocket === "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Ws = require("ws");
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = Ws;
      log("info", "WebSocket polyfill installed (ws)", {});
    } catch {
      log("warn", "WebSocket not available; install 'ws' for worker WebSocket support", {});
    }
  }

  startHeartbeat({
    workerName: WORKER_NAME,
    intervalMs: 30_000,
    metadata: { pid: process.pid, nodeVersion: process.version },
    getMetadata: () =>
      streamRuntime ? { runtimeHealth: streamRuntime.getHealth() } : {},
  });

  if (USE_STREAM_RUNTIME) {
    streamRuntime = new StreamRuntime({
      paperMode: true,
      globalAutomationDisabledByDefault: true,
    });
    streamRuntime.start().then(
      () => log("info", "StreamRuntime started", { mode: "paper" }),
      (err) => log("error", "StreamRuntime start failed", { error: String(err) })
    );
  } else {
    startWebsockets().catch((err) => log("error", "startWebsockets failed", { error: String(err) }));
  }

  scheduleJobs();

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log("info", "Worker started", { workerName: WORKER_NAME, useStreamRuntime: USE_STREAM_RUNTIME });
}

main();
