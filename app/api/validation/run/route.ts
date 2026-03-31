import { NextRequest, NextResponse } from "next/server";
import { runValidationChecks, type ValidationCheckName } from "@/lib/control-plane/validation";

export const dynamic = "force-dynamic";

const DEFAULT_CHECKS: ValidationCheckName[] = [
  "lint",
  "typecheck",
  "relevant_tests",
  "repo_diagnostics",
  "paper_smoke",
];

/**
 * POST /api/validation/run
 * Run deterministic validation checks and return structured pass/fail (fail-closed).
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { checks?: string[] };
    const requested = Array.isArray(body.checks) ? body.checks : DEFAULT_CHECKS;
    const checks = requested.filter((c): c is ValidationCheckName =>
      c === "lint" ||
      c === "typecheck" ||
      c === "relevant_tests" ||
      c === "repo_diagnostics" ||
      c === "paper_smoke"
    );
    if (checks.length === 0) {
      return NextResponse.json(
        { error: "No supported checks requested", supportedChecks: DEFAULT_CHECKS },
        { status: 400 }
      );
    }
    const result = await runValidationChecks(checks);
    return NextResponse.json({
      ...result,
      failClosed: true,
      scope: "paper_only",
    });
  } catch (error) {
    console.error("[POST /api/validation/run]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Validation run failed" },
      { status: 500 }
    );
  }
}
