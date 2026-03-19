/**
 * CLI: generate offline historical MlShadowTrainingExample rows from MarketPriceSnapshot.
 * No live trading, ShadowCandidate, or execution policy. Run from project root:
 *   npm run generate:offline-shadow-dataset -- --from=2025-01-01 --to=2025-03-15 [--dry-run] [--interval=24] [--limit=10000]
 * Supports both --key value and --key=value.
 */

import { persistOfflineHistoricalExamples } from "../lib/ml/shadow-dataset/offline-historical";

/** Expand --key=value to ["--key", "value"] so a single loop can handle both forms. */
function expandArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      out.push(a.slice(0, eq), a.slice(eq + 1));
    } else {
      out.push(a);
    }
  }
  return out;
}

/** Drop first element if it looks like the script path (so only flags/values remain). */
function dropScriptPath(args: string[]): string[] {
  if (args.length > 0 && !args[0].startsWith("-")) {
    return args.slice(1);
  }
  return args;
}

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

function main(): void {
  const rawArgv = process.argv.slice(2);
  let args = expandArgs(rawArgv);
  args = dropScriptPath(args);

  let from: Date | null = null;
  let to: Date | null = null;
  let dryRun = false;
  let intervalHours = 24;
  let limit = 10_000;
  let funder = "offline";
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--from" || args[i] === "-f") && args[i + 1]) {
      from = parseDate(args[++i]);
    } else if ((args[i] === "--to" || args[i] === "-t") && args[i + 1]) {
      to = parseDate(args[++i]);
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--interval" && args[i + 1]) {
      intervalHours = Math.max(1, parseInt(args[++i], 10) || 24);
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = Math.max(1, parseInt(args[++i], 10) || 10_000);
    } else if (args[i] === "--funder" && args[i + 1]) {
      funder = args[++i];
    } else if (args[i] === "--debug") {
      debug = true;
    }
  }

  const now = new Date();
  if (!from) from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  if (!to) to = new Date(now.getTime() - 25 * 60 * 60 * 1000);

  if (from > to) {
    console.error("--from must be before --to");
    process.exit(1);
  }

  console.log("Offline historical shadow dataset generation");
  console.log("  [argv]", JSON.stringify(rawArgv));
  console.log("  from:", from.toISOString());
  console.log("  to:", to.toISOString());
  console.log("  funder:", funder);
  console.log("  intervalHours:", intervalHours);
  console.log("  limit:", limit);
  console.log("  dryRun:", dryRun);
  console.log("  debug:", debug);

  persistOfflineHistoricalExamples({
    from,
    to,
    funderAddress: funder,
    intervalHours,
    limit,
    dryRun,
    debug,
  })
    .then((result) => {
      console.log("");
      console.log("Result:");
      console.log("  examplesBuilt:", result.examplesBuilt);
      console.log("  persisted:", result.persisted);
      console.log("  skipped (already exist):", result.skipped);
      if (result.errors.length > 0) {
        console.log("  errors:", result.errors.length);
        result.errors.slice(0, 5).forEach((e) => console.log("    ", e));
        if (result.errors.length > 5) console.log("    ... and", result.errors.length - 5, "more");
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
