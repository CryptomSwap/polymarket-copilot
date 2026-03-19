/**
 * Tests for bot-readiness guardrails: payload shape, status derivation, blocking vs caution.
 * getGuardrailsReadiness() is deterministic and read-only.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/bot/__tests__/guardrails-readiness.test.ts
 */

import {
  getGuardrailsReadiness,
  type GuardrailsReadinessPayload,
  type GuardrailCheck,
} from "../guardrails";

function hasPayloadShape(p: unknown): p is GuardrailsReadinessPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.ready === "boolean" &&
    (o.status === "ready" || o.status === "caution" || o.status === "blocked") &&
    Array.isArray(o.checks) &&
    typeof o.asOf === "string"
  );
}

function isGuardrailCheck(c: unknown): c is GuardrailCheck {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    (o.status === "pass" || o.status === "warn" || o.status === "fail") &&
    typeof o.title === "string" &&
    typeof o.message === "string" &&
    typeof o.blocking === "boolean"
  );
}

export async function runGuardrailsReadinessTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  const testFunder = "0x0000000000000000000000000000000000000001";

  console.log("\n--- getGuardrailsReadiness: returns valid payload ---");
  const payload = await getGuardrailsReadiness(testFunder);
  check(hasPayloadShape(payload), "payload has required shape (ready, status, checks, asOf)");
  check(
    payload.status === "ready" || payload.status === "caution" || payload.status === "blocked",
    "status is one of ready | caution | blocked"
  );
  check(payload.ready === (payload.status === "ready"), "ready is true only when status is ready");
  check(Array.isArray(payload.checks), "checks is array");
  check(payload.checks.every(isGuardrailCheck), "every check has key, status, title, message, blocking");

  console.log("\n--- getGuardrailsReadiness: blocking implies status blocked ---");
  const blockingCount = payload.checks.filter((c) => c.blocking).length;
  if (blockingCount > 0) {
    check(payload.status === "blocked", "when any check is blocking, status is blocked");
    check(payload.ready === false, "when any check is blocking, ready is false");
  }

  console.log("\n--- getGuardrailsReadiness: check keys present ---");
  const alwaysPresent = ["high_severity_alerts", "reconciliation_mismatch", "recommendation_review"];
  for (const key of alwaysPresent) {
    check(payload.checks.some((c) => c.key === key), `check key "${key}" present`);
  }
  const hasPortfolioTruth = payload.checks.some((c) => c.key === "portfolio_truth");
  const hasPortfolioFreshness = payload.checks.some((c) => c.key === "portfolio_freshness");
  check(
    hasPortfolioTruth || hasPortfolioFreshness,
    "either portfolio_truth (intel failed) or portfolio_freshness (intel ok) present"
  );
  if (!hasPortfolioTruth) {
    check(payload.checks.some((c) => c.key === "unresolved_positions"), "unresolved_positions when intel ok");
    check(payload.checks.some((c) => c.key === "high_concentration"), "high_concentration when intel ok");
    check(payload.checks.some((c) => c.key === "stale_sync"), "stale_sync when intel ok");
  }

  console.log("\n--- getGuardrailsReadiness: asOf is valid ISO ---");
  const asOfTime = new Date(payload.asOf).getTime();
  check(Number.isFinite(asOfTime), "asOf is parseable date");

  console.log("\n--- Guardrails readiness tests result ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (require.main === module) {
  runGuardrailsReadinessTests()
    .then(({ failed }) => process.exit(failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error("Guardrails readiness tests error:", err);
      process.exit(1);
    });
}
