/**
 * Read-only audit: OrderIntent → execution policy → recordShadowCandidate submission outcomes.
 * Writes diagnostics/v2-submission-path-audit.md — no runtime/trading logic changes.
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

const LOADER_WHERE = {
  wasSubmitted: true,
  wasBlocked: false,
  candidateSource: "runtime_automated" as const,
};

function msAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type DecisionSnap = {
  terminalAttribution?: { stage?: string; module?: string; function?: string };
  conciseBlockingReasons?: string[];
  wasSubmitted?: boolean;
  wasBlocked?: boolean;
};

function parseDecisionSnapshot(json: string | null | undefined): DecisionSnap | null {
  return parseJson<DecisionSnap>(json);
}

type PolicyBlockPayload = { blockingReasons?: string[] };

function parsePolicyBlockPayload(payloadJson: string | null | undefined): string[] {
  const o = parseJson<PolicyBlockPayload>(payloadJson);
  if (!o?.blockingReasons || !Array.isArray(o.blockingReasons)) return [];
  return o.blockingReasons.filter((x): x is string => typeof x === "string");
}

type IntentPathOutcome =
  | "loader_visible_submission_path"
  | "policy_blocked_after_ledger"
  | "policy_passed_no_ready_event"
  | "ledger_created_only"
  | "empty_timeline";

function classifyIntentTimeline(eventTypesChronological: string[]): IntentPathOutcome {
  if (eventTypesChronological.length === 0) return "empty_timeline";
  if (eventTypesChronological.includes("EXECUTION_POLICY_BLOCKED")) return "policy_blocked_after_ledger";
  if (eventTypesChronological.includes("READY_FOR_RECONCILIATION")) return "loader_visible_submission_path";
  if (eventTypesChronological.includes("EXECUTION_POLICY_PASSED")) return "policy_passed_no_ready_event";
  if (eventTypesChronological.includes("CREATED")) return "ledger_created_only";
  return "ledger_created_only";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const shadowWriteDisabled = process.env.SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE === "1";

  const since1h = msAgo(60);
  const since24h = msAgo(24 * 60);

  const codePathTable = [
    "| Step | Location | What happens |",
    "| --- | --- | --- |",
    "| `order.intent.created` | `worker/stream-runtime.ts` (~1911–2585) | Serial queue; journal append `INTENT_CREATED` |",
    "| Automation gate | `stream-runtime.ts` (~1928–1930) | `isAutomationAllowed()` false → **return** (no `OrderIntent`, no `recordShadowCandidate`) |",
    "| Execution policy gate | `stream-runtime.ts` (~1932–1942) | `isExecutionAllowed(\"runtime_automated\")` false → **return** (no ledger row, no shadow) |",
    "| Runtime guardrails | `stream-runtime.ts` (~2126–2275) | `!allowed` → `recordShadowCandidate` **wasBlocked=true, wasSubmitted=false**; **no** `createIntentWithEvent` |",
    "| Durable intent | `stream-runtime.ts` (~2306–2314) | `createIntentWithEvent` → `OrderIntent` + `CREATED` event |",
    "| Execution policy deny | `stream-runtime.ts` (~2433–2490) | `!policyResult.allow` → `recordShadowCandidate` blocked + `EXECUTION_POLICY_BLOCKED` on ledger |",
    "| Execution policy allow | `stream-runtime.ts` (~2498–2564) | `persistExecutionPolicyPassed` + `READY_FOR_RECONCILIATION` → `recordShadowCandidate` **wasSubmitted=true, wasBlocked=false** |",
    "| Persist shadow row | `lib/shadow-telemetry/record.ts` | `prisma.shadowCandidate.create`; skipped when env is exactly `\"1\"` |",
  ].join("\n");

  const intentCount1h = await prisma.orderIntent.count({
    where: { source: "runtime_automated", createdAt: { gte: since1h } },
  });
  const intentCount24h = await prisma.orderIntent.count({
    where: { source: "runtime_automated", createdAt: { gte: since24h } },
  });

  const eventHist1h = await prisma.$queryRaw<{ eventType: string; cnt: bigint }[]>`
    SELECT e."eventType" AS "eventType", COUNT(*)::bigint AS cnt
    FROM "OrderIntentEvent" e
    INNER JOIN "OrderIntent" o ON o.id = e."orderIntentId"
    WHERE o.source = 'runtime_automated' AND o."createdAt" >= ${since1h}
    GROUP BY e."eventType"
    ORDER BY cnt DESC
  `;
  const eventHist24h = await prisma.$queryRaw<{ eventType: string; cnt: bigint }[]>`
    SELECT e."eventType" AS "eventType", COUNT(*)::bigint AS cnt
    FROM "OrderIntentEvent" e
    INNER JOIN "OrderIntent" o ON o.id = e."orderIntentId"
    WHERE o.source = 'runtime_automated' AND o."createdAt" >= ${since24h}
    GROUP BY e."eventType"
    ORDER BY cnt DESC
  `;

  const policyBlockEvents24h = await prisma.orderIntentEvent.findMany({
    where: {
      eventType: "EXECUTION_POLICY_BLOCKED",
      createdAt: { gte: since24h },
      orderIntent: { source: "runtime_automated" },
    },
    select: { id: true, payloadJson: true, orderIntentId: true, createdAt: true },
    take: 5000,
    orderBy: { createdAt: "desc" },
  });

  const reasonCounts = new Map<string, number>();
  for (const ev of policyBlockEvents24h) {
    for (const r of parsePolicyBlockPayload(ev.payloadJson)) {
      reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    }
  }
  const reasonBreakdown = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);

  const shadowCombo1h = await prisma.shadowCandidate.groupBy({
    by: ["wasSubmitted", "wasBlocked", "candidateSource"],
    where: { createdAt: { gte: since1h } },
    _count: { id: true },
  });
  const shadowCombo24h = await prisma.shadowCandidate.groupBy({
    by: ["wasSubmitted", "wasBlocked", "candidateSource"],
    where: { createdAt: { gte: since24h } },
    _count: { id: true },
  });

  const loader1h = await prisma.shadowCandidate.count({
    where: { ...LOADER_WHERE, createdAt: { gte: since1h } },
  });
  const loader24h = await prisma.shadowCandidate.count({
    where: { ...LOADER_WHERE, createdAt: { gte: since24h } },
  });

  const shadowGuardrailPreIntent24h = await prisma.shadowCandidate.count({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte: since24h },
      orderIntentId: null,
    },
  });

  const newestLoaderVisible = await prisma.shadowCandidate.findFirst({
    where: LOADER_WHERE,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      orderIntentId: true,
      funderAddress: true,
      wasSubmitted: true,
      wasBlocked: true,
    },
  });

  const SAMPLE = 600;
  const sampledIntents = await prisma.orderIntent.findMany({
    where: { source: "runtime_automated", createdAt: { gte: since24h } },
    orderBy: { createdAt: "desc" },
    take: SAMPLE,
    select: {
      id: true,
      createdAt: true,
      funderAddress: true,
      assetId: true,
      status: true,
      intentEvents: {
        select: { eventType: true, createdAt: true, payloadJson: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const outcomeTally = new Map<IntentPathOutcome, number>();

  for (const intent of sampledIntents) {
    const types = intent.intentEvents.map((e) => e.eventType);
    const outcome = classifyIntentTimeline(types);
    outcomeTally.set(outcome, (outcomeTally.get(outcome) ?? 0) + 1);
  }

  const readyIntentIds24h = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(DISTINCT e."orderIntentId")::bigint AS c
    FROM "OrderIntentEvent" e
    INNER JOIN "OrderIntent" o ON o.id = e."orderIntentId"
    WHERE o.source = 'runtime_automated'
      AND o."createdAt" >= ${since24h}
      AND e."eventType" = 'READY_FOR_RECONCILIATION'
  `;
  const readyCount24h = Number(readyIntentIds24h[0]?.c ?? 0n);

  const shadowLinkedLoaderVisible24h = await prisma.shadowCandidate.count({
    where: {
      ...LOADER_WHERE,
      createdAt: { gte: since24h },
      orderIntentId: { not: null },
    },
  });

  const terminalStageTally = new Map<string, number>();
  const recentBlockedShadows = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      wasBlocked: true,
      createdAt: { gte: since24h },
    },
    select: { decisionSnapshotJson: true },
    take: 2000,
    orderBy: { createdAt: "desc" },
  });
  for (const row of recentBlockedShadows) {
    const d = parseDecisionSnapshot(row.decisionSnapshotJson);
    const stage = d?.terminalAttribution?.stage ?? "unknown_stage";
    terminalStageTally.set(stage, (terminalStageTally.get(stage) ?? 0) + 1);
  }

  const dominantPolicyReason = reasonBreakdown[0]?.[0] ?? null;
  const dominantPolicyCount = reasonBreakdown[0]?.[1] ?? 0;
  const dominantTerminalStage = [...terminalStageTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const dominantTerminalCount = [...terminalStageTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0;

  let dominantBlocker = "evidence insufficient";
  let blunt = "Could not determine a single dominant blocker from DB cohorts.";
  if (shadowWriteDisabled) {
    dominantBlocker = "shadow telemetry gate (env)";
    if (loader1h === 0 && loader24h > 0) {
      blunt =
        "SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1 — new runtime_automated shadow rows are skipped; last 1h loader-visible count is 0 while 24h still shows older rows. Restart worker with env=0 to resume persistence.";
    } else {
      blunt = "SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1 — runtime_automated ShadowCandidate creates are skipped in record.ts regardless of policy outcome.";
    }
  } else if (intentCount24h === 0) {
    dominantBlocker = "pre-ledger gates or no intents emitted";
    blunt =
      "Zero runtime_automated OrderIntent rows in 24h — handler returns at isAutomationAllowed / isExecutionAllowed before ledger, or no order.intent.created throughput.";
  } else if (readyCount24h > 0 && loader24h === 0) {
    dominantBlocker = "persistence / recordShadowCandidate after policy allow";
    blunt =
      "READY_FOR_RECONCILIATION exists but no loader-visible ShadowCandidate rows in window — inspect record.ts errors or historical write-disable.";
  } else if (readyCount24h === 0 && policyBlockEvents24h.length > 0) {
    dominantBlocker = dominantPolicyReason ? `execution policy: ${dominantPolicyReason}` : "execution policy deny (post-guardrail)";
    blunt =
      "Intents reach the ledger but no READY_FOR_RECONCILIATION in 24h while EXECUTION_POLICY_BLOCKED events exist — evaluateExecutionPolicy is denying the cohort.";
  } else if (dominantTerminalStage === "runtime_guardrails" && dominantTerminalCount >= 10 && readyCount24h === 0) {
    dominantBlocker = "runtime guardrails (pre-intent)";
    blunt =
      "Blocked ShadowCandidates mostly terminate at runtime_guardrails and no intents reached READY_FOR_RECONCILIATION — guardrails block before createIntentWithEvent.";
  } else if (shadowGuardrailPreIntent24h > intentCount24h && readyCount24h === 0) {
    dominantBlocker = "runtime guardrails (pre-intent)";
    blunt =
      "Many runtime_automated shadow rows have null orderIntentId vs few READY intents — most traffic dies in guardrails, not execution policy.";
  } else if (dominantPolicyReason) {
    dominantBlocker = `execution policy: ${dominantPolicyReason}`;
    blunt = `Top EXECUTION_POLICY_BLOCKED reason in 24h: ${dominantPolicyReason} (${dominantPolicyCount} hits in sampled policy-block events).`;
  }

  const anyLoaderVisible = loader24h > 0 || newestLoaderVisible != null;

  const lines: string[] = [];
  lines.push("# V2 submission path audit (read-only)");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(
    `- Env: \`SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE\` = **${shadowWriteDisabled ? "1 (writes skipped in record.ts)" : "unset/≠1 (writes allowed)"}**`
  );
  lines.push(
    "- Loader-visible definition: `wasSubmitted=true` AND `wasBlocked=false` AND `candidateSource=runtime_automated` (same as V2 paper loader)."
  );
  lines.push(
    "- **Method:** DB replay only (no runtime code changes). Per-candidate `wasSubmitted` / `wasBlocked` / policy outcome are inferred from `OrderIntentEvent` timelines and `ShadowCandidate` / `decisionSnapshotJson`, not from live console logs."
  );
  lines.push("");

  lines.push("## 1. Code path (OrderIntent → execution policy → recordShadowCandidate)");
  lines.push(codePathTable);
  lines.push("");

  lines.push("## 2. Cohort counts (DB)");
  lines.push("### runtime_automated `OrderIntent` rows");
  lines.push("| window | count |");
  lines.push("| --- | ---: |");
  lines.push(`| last 1h | ${intentCount1h} |`);
  lines.push(`| last 24h | ${intentCount24h} |`);
  lines.push("");
  lines.push("### Distinct intents with `READY_FOR_RECONCILIATION` (proxy: policy allow → reconcile path)");
  lines.push(`- last 24h: **${readyCount24h}**`);
  lines.push("");
  lines.push("### `OrderIntentEvent` histogram (joined to runtime_automated intents)");
  lines.push("#### last 1h");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries(eventHist1h.map((r) => [r.eventType, Number(r.cnt)])), null, 2));
  lines.push("```");
  lines.push("#### last 24h");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries(eventHist24h.map((r) => [r.eventType, Number(r.cnt)])), null, 2));
  lines.push("```");
  lines.push("");

  lines.push("### `ShadowCandidate` groupBy (wasSubmitted, wasBlocked, candidateSource)");
  lines.push("#### last 1h");
  lines.push("```json");
  lines.push(JSON.stringify(shadowCombo1h, null, 2));
  lines.push("```");
  lines.push("#### last 24h");
  lines.push("```json");
  lines.push(JSON.stringify(shadowCombo24h, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Loader-visible ShadowCandidate counts");
  lines.push(`- last 1h: **${loader1h}**`);
  lines.push(`- last 24h: **${loader24h}**`);
  lines.push(`- runtime_automated rows in 24h with **null** \`orderIntentId\` (typical guardrail-pre-intent shadow): **${shadowGuardrailPreIntent24h}**`);
  lines.push(`- loader-visible in 24h with non-null \`orderIntentId\`: **${shadowLinkedLoaderVisible24h}**`);
  lines.push("");

  lines.push("## 3. Per-cohort path classification (newest sample of intents)");
  lines.push(`- Sample: **newest ${sampledIntents.length}** runtime_automated intents in last 24h (cap ${SAMPLE}; total in window: **${intentCount24h}**).`);
  lines.push("- Outcome definitions:");
  lines.push("  - **loader_visible_submission_path** — timeline contains `READY_FOR_RECONCILIATION` (same handler path that calls `recordShadowCandidate` with wasSubmitted=true).");
  lines.push("  - **policy_blocked_after_ledger** — contains `EXECUTION_POLICY_BLOCKED`.");
  lines.push("  - **policy_passed_no_ready_event** — has `EXECUTION_POLICY_PASSED` but no `READY_FOR_RECONCILIATION` (abnormal / partial failure).");
  lines.push("  - **ledger_created_only** — only `CREATED` (or unknown types) and no policy terminal events.");
  lines.push("  - **empty_timeline** — no events (data issue).");
  lines.push("");
  lines.push("| outcome | count in sample |");
  lines.push("| --- | ---: |");
  for (const k of [
    "loader_visible_submission_path",
    "policy_blocked_after_ledger",
    "policy_passed_no_ready_event",
    "ledger_created_only",
    "empty_timeline",
  ] as IntentPathOutcome[]) {
    lines.push(`| ${k} | ${outcomeTally.get(k) ?? 0} |`);
  }
  lines.push("");
  lines.push("### EXECUTION_POLICY_BLOCKED reason codes (24h events, up to 5000 rows)");
  lines.push("```json");
  lines.push(JSON.stringify(reasonBreakdown.slice(0, 40), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Blocked ShadowCandidate `terminalAttribution.stage` (24h, up to 2000 rows)");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries([...terminalStageTally.entries()].sort((a, b) => b[1] - a[1])), null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## 4. Verification: any loader-visible row?");
  lines.push(`- **Any in last 24h:** ${anyLoaderVisible ? "yes" : "no"} (count ${loader24h})`);
  lines.push("```json");
  lines.push(JSON.stringify(newestLoaderVisible, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## 5. Dominant blocker & conclusion");
  lines.push(`- **Dominant blocker (heuristic):** ${dominantBlocker}`);
  if (dominantPolicyReason) {
    lines.push(`- **Top EXECUTION_POLICY_BLOCKED reason:** \`${dominantPolicyReason}\` (${dominantPolicyCount} in aggregated policy-block events)`);
  }
  if (dominantTerminalStage) {
    lines.push(`- **Top blocked shadow terminal stage:** \`${dominantTerminalStage}\` (${dominantTerminalCount} in recent blocked shadow snapshots)`);
  }
  lines.push(`- **Blunt conclusion:** ${blunt}`);
  lines.push("");

  lines.push("## 6. JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        shadowWriteDisabled,
        intentCount1h,
        intentCount24h,
        readyForReconciliationDistinctIntents24h: readyCount24h,
        eventHist1h: eventHist1h.map((r) => ({ eventType: r.eventType, count: Number(r.cnt) })),
        eventHist24h: eventHist24h.map((r) => ({ eventType: r.eventType, count: Number(r.cnt) })),
        shadowCombo1h,
        shadowCombo24h,
        loaderVisible1h: loader1h,
        loaderVisible24h: loader24h,
        shadowRuntimeAutomatedNullOrderIntentId24h: shadowGuardrailPreIntent24h,
        shadowLoaderVisibleWithOrderIntentId24h: shadowLinkedLoaderVisible24h,
        sampledIntentPathOutcomes: Object.fromEntries([...outcomeTally.entries()]),
        sampleSize: sampledIntents.length,
        policyBlockReasonTop: reasonBreakdown.slice(0, 25),
        blockedShadowTerminalStage: Object.fromEntries([...terminalStageTally.entries()].sort((a, b) => b[1] - a[1])),
        dominantBlocker,
        bluntConclusion: blunt,
        anyLoaderVisibleLast24h: anyLoaderVisible,
        newestLoaderVisible,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-submission-path-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
