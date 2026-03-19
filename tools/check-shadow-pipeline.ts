/**
 * Shadow pipeline diagnostics: verify whether shadow candidates, evaluations, and ML shadow dataset rows exist.
 * Read-only; no trading logic. Run from project root: npm run check:shadow-pipeline
 */

import { prisma } from "../lib/db";

const RECENT = 10;

function section(title: string): void {
  console.log("");
  console.log("--- " + title + " ---");
}

function row(
  id: string,
  createdAt: string,
  wasBlocked: boolean,
  wasSubmitted: boolean,
  evaluatedAt: string | null,
  markout24h: string | null,
  outcomeClassification: string | null
): void {
  const evalStr = evaluatedAt ? "eval" : "—";
  const m24 = markout24h ?? "—";
  const oc = outcomeClassification ?? "—";
  console.log(`  ${id.slice(0, 12)}…  ${createdAt}  blocked=${wasBlocked}  submitted=${wasSubmitted}  ${evalStr}  markout24h=${m24}  outcome=${oc}`);
}

function mlRow(
  id: string,
  shadowCandidateId: string,
  createdAt: string,
  wasBlocked: boolean,
  outcomeClassification: string | null
): void {
  const oc = outcomeClassification ?? "—";
  console.log(`  ${id.slice(0, 12)}…  sc=${shadowCandidateId.slice(0, 12)}…  ${createdAt}  blocked=${wasBlocked}  outcome=${oc}`);
}

async function main(): Promise<void> {
  console.log("Shadow pipeline diagnostics (read-only)");
  console.log("Database: " + (process.env.DATABASE_URL ? "configured" : "DATABASE_URL not set"));

  try {
    // --- ShadowCandidate counts ---
    section("ShadowCandidate");
    const [
      totalCandidates,
      blockedCount,
      allowedCount,
      submittedCount,
      evaluatedCount,
      withMarkout24hCount,
    ] = await Promise.all([
      prisma.shadowCandidate.count(),
      prisma.shadowCandidate.count({ where: { wasBlocked: true } }),
      prisma.shadowCandidate.count({ where: { wasBlocked: false } }),
      prisma.shadowCandidate.count({ where: { wasSubmitted: true } }),
      prisma.shadowCandidate.count({ where: { evaluatedAt: { not: null } } }),
      prisma.shadowCandidate.count({ where: { markout24h: { not: null } } }),
    ]);

    console.log("  total:              " + totalCandidates);
    console.log("  blocked:           " + blockedCount);
    console.log("  allowed:           " + allowedCount);
    console.log("  submitted:          " + submittedCount);
    console.log("  evaluated:          " + evaluatedCount);
    console.log("  with markout24h:    " + withMarkout24hCount);

    const recentCandidates = await prisma.shadowCandidate.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT,
      select: {
        id: true,
        createdAt: true,
        wasBlocked: true,
        wasSubmitted: true,
        evaluatedAt: true,
        markout24h: true,
        outcomeClassification: true,
        blockingReasons: true,
      },
    });
    console.log("");
    console.log("  Recent " + RECENT + " ShadowCandidate rows:");
    if (recentCandidates.length === 0) {
      console.log("  (none)");
    } else {
      for (const c of recentCandidates) {
        row(
          c.id,
          c.createdAt.toISOString().slice(0, 19),
          c.wasBlocked,
          c.wasSubmitted,
          c.evaluatedAt ? c.evaluatedAt.toISOString().slice(0, 19) : null,
          c.markout24h,
          c.outcomeClassification
        );
        if (c.wasBlocked && c.blockingReasons != null) {
          const reasons = Array.isArray(c.blockingReasons) ? c.blockingReasons : [];
          console.log("    blockingReasons: " + (reasons.length > 0 ? JSON.stringify(reasons) : "[]"));
        }
      }
    }

    section("Blocked vs runtime counters");
    const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
    try {
      const res = await fetch(`${BASE_URL}/api/ops/runtime/dashboard`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const dash = (await res.json()) as {
          diagnostics?: {
            orderIntentsGenerated?: number;
            intentsBlockedByGuardrails?: number;
            intentsBlockedByFreshness?: number;
          };
        };
        const diag = dash.diagnostics ?? {};
        console.log("  orderIntentsGenerated:     " + (diag.orderIntentsGenerated ?? "—"));
        console.log("  intentsBlockedByGuardrails: " + (diag.intentsBlockedByGuardrails ?? "—"));
        console.log("  intentsBlockedByFreshness:  " + (diag.intentsBlockedByFreshness ?? "—"));
        console.log("  ShadowCandidate blocked:   " + blockedCount);
        if (
          blockedCount > 0 &&
          (diag.intentsBlockedByGuardrails ?? 0) > 0 &&
          (diag.intentsBlockedByFreshness ?? 0) > 0
        ) {
          console.log("  (Blocked candidates typically match guardrail blocks; freshness count = intents with freshness reason codes.)");
        }
      } else {
        console.log("  Dashboard unreachable (start app + worker to compare).");
      }
    } catch {
      console.log("  Dashboard unreachable (start app + worker to compare).");
    }

    // --- MlShadowTrainingExample ---
    section("MlShadowTrainingExample");
    const totalExamples = await prisma.mlShadowTrainingExample.count();
    console.log("  total:              " + totalExamples);

    const recentExamples = await prisma.mlShadowTrainingExample.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT,
      select: {
        id: true,
        shadowCandidateId: true,
        createdAt: true,
        wasBlocked: true,
        outcomeClassification: true,
      },
    });
    console.log("");
    console.log("  Recent " + RECENT + " MlShadowTrainingExample rows:");
    if (recentExamples.length === 0) {
      console.log("  (none)");
    } else {
      for (const e of recentExamples) {
        mlRow(e.id, e.shadowCandidateId, e.createdAt.toISOString().slice(0, 19), e.wasBlocked, e.outcomeClassification);
      }
    }

    // --- Can run meaningfully? ---
    section("Pipeline readiness");
    const disagreementOk =
      totalExamples > 0 &&
      evaluatedCount > 0;
    console.log(
      "  Shadow disagreement: " +
        (disagreementOk
          ? "yes (evaluated candidates + ML examples present)"
          : "no (need evaluated ShadowCandidates and MlShadowTrainingExample rows)")
    );
    const calibrationOk = totalCandidates > 0;
    console.log(
      "  Calibration:         " +
        (calibrationOk
          ? "yes (ShadowCandidate rows present)"
          : "no (need ShadowCandidate rows)")
    );

    console.log("");
    console.log("Done.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("ShadowCandidate") || msg.includes("MlShadowTrainingExample")) {
      console.error("");
      console.error("Database tables missing. Run migrations first:");
      console.error("  npx prisma migrate deploy");
      console.error("");
      console.error("Error: " + msg);
    } else {
      console.error("Error: " + msg);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
