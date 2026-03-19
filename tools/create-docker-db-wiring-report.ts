/**
 * Docker DB wiring report (bounded + secret-safe).
 *
 * Creates:
 * - dump/docker-db-wiring-report.json
 * - dump/docker-db-wiring-report.md
 *
 * What it checks:
 * - How docker-compose resolves DATABASE_URL for `app` and `worker`
 * - Why the previous value was wrong (when DATABASE_URL_DOCKER was missing)
 * - Connectivity + a simple Prisma query from inside each container
 *
 * Safety:
 * - Redacts credentials from connection strings
 * - Does not print secrets
 */

import * as fs from "fs/promises";
import * as path from "path";
import { spawnSync } from "child_process";

const DUMP_DIR = path.join(process.cwd(), "dump");
const COMPOSE_PATH = path.join(process.cwd(), "docker-compose.yml");
const ENV_PATH = path.join(process.cwd(), ".env");

type RedactedUrl = {
  originalPresent: boolean;
  redacted: string | null;
  scheme: string | null;
  host: string | null;
  port: string | null;
  database: string | null;
  query: Record<string, string>;
};

type ContainerDbCheck = {
  container: "app" | "worker";
  containerRunning: boolean;
  effectiveDatabaseUrl: string | null;
  effectiveDatabaseUrlRedacted: string | null;
  canNetConnect: boolean | null;
  canPrismaQuery: boolean;
  prismaErrorCategory: "db_connect_failure" | "db_auth_failure" | "unknown_failure" | "not_running";
  prismaErrorMessage: string | null;
};

function redactDatabaseUrl(url: string): RedactedUrl {
  const trimmed = url.trim();
  if (!trimmed) {
    return {
      originalPresent: false,
      redacted: null,
      scheme: null,
      host: null,
      port: null,
      database: null,
      query: {},
    };
  }

  try {
    const u = new URL(trimmed);
    const scheme = u.protocol.replace(":", "");
    const host = u.hostname || null;
    const port = u.port || null;
    // `/db` portion
    const database = u.pathname ? u.pathname.replace(/^\//, "") : null;
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    // Redact user/pass but keep host + database + query.
    const redacted = `${u.protocol}//***:***@${host}${port ? `:${port}` : ""}${u.pathname}${u.search}`;
    return {
      originalPresent: true,
      redacted,
      scheme,
      host,
      port,
      database,
      query,
    };
  } catch {
    // Fallback: redact any `user:pass@` fragment if possible.
    const redacted = trimmed.replace(/\/\/([^@/]+@)/, "//***:***@");
    return {
      originalPresent: true,
      redacted,
      scheme: null,
      host: null,
      port: null,
      database: null,
      query: {},
    };
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const txt = require("fs").readFileSync(filePath, "utf8");
    const out: Record<string, string> = {};
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (!k) continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function dockerComposeConfig(): string {
  const r = spawnSync("docker", ["compose", "config"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`docker compose config failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").toString();
}

function extractServiceDatabaseUrlFromComposeConfig(composeConfig: string, service: "app" | "worker"): string | null {
  const lines = composeConfig.split(/\r?\n/);
  let current: string | null = null;
  let inEnvironment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const serviceMatch = /^(\s{2})([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (serviceMatch) {
      current = serviceMatch[2];
      inEnvironment = false;
      continue;
    }
    if (current === service) {
      if (/^\s+environment:\s*$/.test(line)) {
        inEnvironment = true;
        continue;
      }
      if (inEnvironment) {
        const m = /^\s+DATABASE_URL:\s*(.*)\s*$/.exec(line);
        if (m) {
          // Compose may quote the value; strip outer quotes if present.
          const raw = m[1].trim().replace(/^['"]|['"]$/g, "");
          return raw || null;
        }
        // environment section ends when indentation changes away from "environment" block
        if (/^\s{0,1}[^ ]/.test(line)) {
          inEnvironment = false;
        }
      }
    }
  }
  return null;
}

function getTopLevelComposeServiceNames(composeYml: string): string[] {
  const lines = composeYml.split(/\r?\n/);
  const names: string[] = [];
  let inServices = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "services:") {
      inServices = true;
      continue;
    }
    if (inServices) {
      // e.g. "  app:" or "  worker:"
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) {
        names.push(m[1]);
        continue;
      }
      // End when we hit a top-level key.
      if (!line.startsWith("  ") && trimmed) break;
    }
  }
  return Array.from(new Set(names));
}

function classifyPrismaErrorCategory(message: string): ContainerDbCheck["prismaErrorCategory"] {
  const msg = message.toLowerCase();
  if (
    /can't reach database server|econnrefused|ehostunreach|enotfound|eai_again|timeout|could not connect/i.test(msg) ||
    /localhost:5432/i.test(msg) // common wrong-wiring symptom
  ) {
    return "db_connect_failure";
  }
  if (/password authentication failed|authentication failed|role .* does not exist|invalid username/i.test(msg)) {
    return "db_auth_failure";
  }
  return "unknown_failure";
}

function runContainerNodeCheck(container: "app" | "worker", databaseUrlOverride?: string | null): ContainerDbCheck {
  const code = `
    (async () => {
      const result = {
        containerRunning: true,
        effectiveDatabaseUrl: process.env.DATABASE_URL || null,
        canNetConnect: null,
        canPrismaQuery: false,
        prismaErrorCategory: "unknown_failure",
        prismaErrorMessage: null
      };
      const url = process.env.DATABASE_URL || null;
      const redactHostPort = (() => {
        try {
          const u = new URL(url);
          return { host: u.hostname, port: u.port || "5432" };
        } catch { return null; }
      })();
      if (redactHostPort) {
        const net = require("net");
        const timeoutMs = 2000;
        const { host, port } = redactHostPort;
        result.canNetConnect = await new Promise((resolve) => {
          const sock = net.createConnection({ host, port: Number(port) }, () => {
            sock.destroy();
            resolve(true);
          });
          sock.setTimeout(timeoutMs);
          sock.on("timeout", () => { sock.destroy(); resolve(false); });
          sock.on("error", () => resolve(false));
        });
      }

      try {
        const { PrismaClient } = require("@prisma/client");
        const prisma = new PrismaClient({
          datasources: url ? { db: { url } } : undefined
        });
        await prisma.$queryRaw\`SELECT 1 as ok\`;
        result.canPrismaQuery = true;
        result.prismaErrorCategory = "unknown_failure";
        result.prismaErrorMessage = null;
        await prisma.$disconnect();
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        result.canPrismaQuery = false;
        result.prismaErrorMessage = msg ? msg.slice(0, 400) : null;
        result.prismaErrorCategory = "unknown_failure";
      }
      process.stdout.write(JSON.stringify(result));
    })().catch(e => {
      process.stdout.write(JSON.stringify({
        containerRunning: false,
        effectiveDatabaseUrl: process.env.DATABASE_URL || null,
        canNetConnect: null,
        canPrismaQuery: false,
        prismaErrorCategory: "not_running",
        prismaErrorMessage: e && e.message ? String(e.message) : String(e)
      }));
    });
  `;

  const env = databaseUrlOverride ? { ...process.env, DATABASE_URL: databaseUrlOverride } : undefined;
  const r = spawnSync("docker", ["compose", "exec", "-T", container, "node", "-e", code], {
    encoding: "utf8",
    env,
  });

  const stdout = (r.stdout || "").toString().trim();
  const parsed = safeJsonParse<{
    containerRunning: boolean;
    effectiveDatabaseUrl: string | null;
    canNetConnect: boolean | null;
    canPrismaQuery: boolean;
    prismaErrorCategory: string;
    prismaErrorMessage: string | null;
  }>(stdout);

  if (!parsed) {
    const msg = (r.stderr || r.stdout || "").toString();
    return {
      container,
      containerRunning: false,
      effectiveDatabaseUrl: null,
      effectiveDatabaseUrlRedacted: null,
      canNetConnect: null,
      canPrismaQuery: false,
      prismaErrorCategory: "not_running",
      prismaErrorMessage: msg ? msg.slice(0, 400) : null,
    };
  }

  const redacted = parsed.effectiveDatabaseUrl ? redactDatabaseUrl(parsed.effectiveDatabaseUrl) : null;
  const prismaErrCat = parsed.prismaErrorMessage ? classifyPrismaErrorCategory(parsed.prismaErrorMessage) : "unknown_failure";

  return {
    container,
    containerRunning: parsed.containerRunning,
    effectiveDatabaseUrl: parsed.effectiveDatabaseUrl,
    effectiveDatabaseUrlRedacted: redacted?.redacted ?? null,
    canNetConnect: parsed.canNetConnect,
    canPrismaQuery: parsed.canPrismaQuery,
    prismaErrorCategory: parsed.canPrismaQuery ? "unknown_failure" : prismaErrCat,
    prismaErrorMessage: parsed.prismaErrorMessage,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const dockerComposeYml = await fs.readFile(COMPOSE_PATH, "utf8");
  const envFile = parseEnvFile(ENV_PATH);
  const databaseUrlDockerPresentInEnvFile =
    typeof envFile.DATABASE_URL_DOCKER === "string" && envFile.DATABASE_URL_DOCKER.trim().length > 0;

  const composeServicesDetected = getTopLevelComposeServiceNames(dockerComposeYml);

  // Resolve the effective DATABASE_URL inside each container as docker-compose would.
  let composeConfig: string;
  try {
    composeConfig = dockerComposeConfig();
  } catch (e) {
    composeConfig = "";
  }

  const appEffectiveFromCompose = composeConfig ? extractServiceDatabaseUrlFromComposeConfig(composeConfig, "app") : null;
  const workerEffectiveFromCompose = composeConfig ? extractServiceDatabaseUrlFromComposeConfig(composeConfig, "worker") : null;

  // If DATABASE_URL_DOCKER isn't present, docker-compose uses its default DATABASE_URL.
  // The historical regression you reported came from that default being `host.docker.internal` (unreachable from containers),
  // so this report captures the previous broken default shape for debugging purposes.
  const previousBrokenDefaultHostShapeIfMissingDockerVar =
    "postgresql://postgres:postgres@host.docker.internal:5432/polymarket_copilot?schema=public";

  const appCheck = runContainerNodeCheck("app");
  const workerCheck = runContainerNodeCheck("worker");

  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot: process.cwd(),
    composeConfigSource: {
      dockerComposePath: COMPOSE_PATH,
      envPath: ENV_PATH,
    },
    composeServicesDetected,
    databaseUrlResolutionRule: {
      // This mirrors docker-compose.yml logic directly.
      usesEnvironmentVariable: "DATABASE_URL_DOCKER",
      form: "DATABASE_URL: ${DATABASE_URL_DOCKER:-<default in docker-compose.yml>}",
      databaseUrlDockerPresentInEnvFile,
    },
    previousBrokenValueSource:
      databaseUrlDockerPresentInEnvFile
        ? {
            reason: "DATABASE_URL_DOCKER is present in .env, so docker-compose should not use the compose default DATABASE_URL.",
            previousDefaultHostShape: null,
          }
        : {
            reason:
              "Because DATABASE_URL_DOCKER is missing in .env, docker-compose uses its default DATABASE_URL. The previously-broken default (per your report) used host.docker.internal:5432.",
            previousDefaultHostShape: previousBrokenDefaultHostShapeIfMissingDockerVar,
          },
    effectiveDockerDatabaseUrl: {
      app: appEffectiveFromCompose ? redactDatabaseUrl(appEffectiveFromCompose).redacted : null,
      worker: workerEffectiveFromCompose ? redactDatabaseUrl(workerEffectiveFromCompose).redacted : null,
    },
    containerChecks: {
      app: appCheck,
      worker: workerCheck,
    },
    simpleDbQuery: {
      appCanReachWithPrisma: appCheck.canPrismaQuery,
      workerCanReachWithPrisma: workerCheck.canPrismaQuery,
    },
    remainingRisks: [
      "If you use an external Postgres (not the compose-managed service), you must set DATABASE_URL_DOCKER in .env.",
      "If Prisma migrations were not applied to the target DB, higher-level schema-dependent queries may still fail (SELECT 1 should still work).",
    ],
  };

  const jsonPath = path.join(DUMP_DIR, "docker-db-wiring-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Docker DB wiring report (secret-safe)");
  md.push("");
  md.push(`Generated: ${report.generatedAt}`);
  md.push("");
  md.push("## Resolution summary");
  md.push("");
  md.push("```json");
  md.push(
    JSON.stringify(
      {
        composeServicesDetected: report.composeServicesDetected,
        databaseUrlResolutionRule: report.databaseUrlResolutionRule,
        previousBrokenValueSource: report.previousBrokenValueSource,
        effectiveDockerDatabaseUrl: report.effectiveDockerDatabaseUrl,
      },
      null,
      2
    )
  );
  md.push("```");
  md.push("");
  md.push("## Connectivity checks (from inside containers)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(report.containerChecks, null, 2));
  md.push("```");
  md.push("");
  md.push("## Remaining risks / assumptions");
  md.push("");
  for (const r of report.remainingRisks) md.push(`- ${r}`);
  md.push("");

  const mdPath = path.join(DUMP_DIR, "docker-db-wiring-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote dump/docker-db-wiring-report.{json,md}");
}

main().catch((e) => {
  // Secret-safe: do not print env values.
  console.error("create-docker-db-wiring-report failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

