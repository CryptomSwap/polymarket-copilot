/**
 * Regression tests: /api/portfolio/overview 500 error handling.
 * Ensures the route never returns a blank 500 and surfaces structured JSON with stage and message.
 * Run with (from repo root):
 *   npx tsx lib/portfolio/__tests__/overview-500-error-handling.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  buildOverviewErrorResponse,
  safeErrorMessage,
  toIsoSafe,
  OVERVIEW_STAGES,
  type OverviewStage,
} from "../../../app/api/portfolio/overview/route";

function run(cond: boolean, msg: string, passed: { n: number }, failed: { n: number }): void {
  if (cond) {
    passed.n++;
    console.log("  OK:", msg);
  } else {
    failed.n++;
    console.error("  FAIL:", msg);
  }
}

export async function runOverview500ErrorHandlingTests(): Promise<void> {
  const passed = { n: 0 };
  const failed = { n: 0 };

  console.log("\n--- Overview 500: safeErrorMessage ---");
  run(safeErrorMessage(new Error("foo")) === "foo", "safeErrorMessage(Error) returns message", passed, failed);
  run(safeErrorMessage("string err") === "string err", "safeErrorMessage(string) returns string", passed, failed);
  run(safeErrorMessage(123) === "123", "safeErrorMessage(number) returns string", passed, failed);

  console.log("\n--- Overview 500: buildOverviewErrorResponse returns structured JSON ---");
  const stage: OverviewStage = "fetchData";
  const res = buildOverviewErrorResponse(stage, new Error("simulated fetch failure"));
  run(res.status === 500, "buildOverviewErrorResponse returns status 500", passed, failed);
  const body = (await res.json()) as { error?: string; stage?: string; message?: string };
  run(body?.error === "overview_failed", "response body has error: overview_failed", passed, failed);
  run(body?.stage === "fetchData", "response body has stage", passed, failed);
  run(body?.message === "simulated fetch failure", "response body has message", passed, failed);

  console.log("\n--- Overview 500: route source has try/catch and structured error ---");
  const overviewPath = path.resolve(__dirname, "../../../app/api/portfolio/overview/route.ts");
  const source = fs.readFileSync(overviewPath, "utf8");
  run(source.includes("try {") && source.includes("} catch ("), "overview route wrapped in try/catch", passed, failed);
  run(source.includes('error: "overview_failed"'), "overview catch returns error: overview_failed", passed, failed);
  run(source.includes("stage:") && source.includes("message"), "overview catch returns stage and message", passed, failed);
  run(source.includes("status: 500"), "overview catch returns status 500", passed, failed);
  run(source.includes("currentStage"), "overview uses currentStage for instrumentation", passed, failed);
  for (const s of OVERVIEW_STAGES) {
    run(source.includes(`"${s}"`) || source.includes(`'${s}'`), `overview defines stage: ${s}`, passed, failed);
  }
  run(source.includes("buildOverviewErrorResponse"), "overview catch uses buildOverviewErrorResponse", passed, failed);
  run(source.includes("console.error"), "overview catch logs error with context", passed, failed);

  console.log("\n--- Overview fetchData: minimal PortfolioSnapshot select (avoids schema/DB column drift 500) ---");
  run(
    source.includes("portfolioSnapshot.findFirst") && source.includes("select:") && source.includes("id: true") && source.includes("createdAt: true"),
    "overview uses select: { id: true, createdAt: true } for portfolioSnapshot so missing DB columns (e.g. topThemeConcentrationPct) do not cause fetchData 500",
    passed,
    failed
  );

  console.log("\n--- Overview computeOverview: safe endDate (invalid date must not throw) ---");
  run(source.includes("toIsoSafe") && source.includes("e.endDate"), "overview uses toIsoSafe(e.endDate) so invalid endDate never throws in computeOverview", passed, failed);
  run(toIsoSafe(null) === null, "toIsoSafe(null) returns null", passed, failed);
  run(toIsoSafe(undefined) === null, "toIsoSafe(undefined) returns null", passed, failed);
  run(toIsoSafe("") === null, "toIsoSafe(empty string) returns null", passed, failed);
  run(toIsoSafe(new Date("invalid")) === null, "toIsoSafe(invalid Date) returns null and does not throw", passed, failed);
  const validIso = toIsoSafe(new Date("2026-03-31T00:00:00.000Z"));
  run(validIso !== null && validIso.includes("2026"), "toIsoSafe(valid Date) returns ISO string", passed, failed);

  console.log("\n--- Overview 500: summary ---");
  console.log("  Passed:", passed.n, " Failed:", failed.n);
  if (failed.n > 0) process.exit(1);
}

if (require.main === module) {
  runOverview500ErrorHandlingTests().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
