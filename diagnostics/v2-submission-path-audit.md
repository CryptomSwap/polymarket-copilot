# V2 submission path audit (read-only)

- Generated: 2026-03-31T23:02:33.031Z
- Env: `SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE` = **1 (writes skipped in record.ts)**
- Loader-visible definition: `wasSubmitted=true` AND `wasBlocked=false` AND `candidateSource=runtime_automated` (same as V2 paper loader).
- **Method:** DB replay only (no runtime code changes). Per-candidate `wasSubmitted` / `wasBlocked` / policy outcome are inferred from `OrderIntentEvent` timelines and `ShadowCandidate` / `decisionSnapshotJson`, not from live console logs.

## 1. Code path (OrderIntent → execution policy → recordShadowCandidate)
| Step | Location | What happens |
| --- | --- | --- |
| `order.intent.created` | `worker/stream-runtime.ts` (~1911–2585) | Serial queue; journal append `INTENT_CREATED` |
| Automation gate | `stream-runtime.ts` (~1928–1930) | `isAutomationAllowed()` false → **return** (no `OrderIntent`, no `recordShadowCandidate`) |
| Execution policy gate | `stream-runtime.ts` (~1932–1942) | `isExecutionAllowed("runtime_automated")` false → **return** (no ledger row, no shadow) |
| Runtime guardrails | `stream-runtime.ts` (~2126–2275) | `!allowed` → `recordShadowCandidate` **wasBlocked=true, wasSubmitted=false**; **no** `createIntentWithEvent` |
| Durable intent | `stream-runtime.ts` (~2306–2314) | `createIntentWithEvent` → `OrderIntent` + `CREATED` event |
| Execution policy deny | `stream-runtime.ts` (~2433–2490) | `!policyResult.allow` → `recordShadowCandidate` blocked + `EXECUTION_POLICY_BLOCKED` on ledger |
| Execution policy allow | `stream-runtime.ts` (~2498–2564) | `persistExecutionPolicyPassed` + `READY_FOR_RECONCILIATION` → `recordShadowCandidate` **wasSubmitted=true, wasBlocked=false** |
| Persist shadow row | `lib/shadow-telemetry/record.ts` | `prisma.shadowCandidate.create`; skipped when env is exactly `"1"` |

## 2. Cohort counts (DB)
### runtime_automated `OrderIntent` rows
| window | count |
| --- | ---: |
| last 1h | 3049 |
| last 24h | 63401 |

### Distinct intents with `READY_FOR_RECONCILIATION` (proxy: policy allow → reconcile path)
- last 24h: **2247**

### `OrderIntentEvent` histogram (joined to runtime_automated intents)
#### last 1h
```json
{
  "CREATED": 24243,
  "EXECUTION_POLICY_BLOCKED": 24007,
  "EXECUTION_POLICY_PASSED": 236,
  "READY_FOR_RECONCILIATION": 236
}
```
#### last 24h
```json
{
  "CREATED": 302525,
  "EXECUTION_POLICY_BLOCKED": 299968,
  "EXECUTION_POLICY_PASSED": 2552,
  "READY_FOR_RECONCILIATION": 2552
}
```

### `ShadowCandidate` groupBy (wasSubmitted, wasBlocked, candidateSource)
#### last 1h
```json
[]
```
#### last 24h
```json
[
  {
    "_count": {
      "id": 28
    },
    "wasSubmitted": false,
    "wasBlocked": false,
    "candidateSource": "paper_trading"
  },
  {
    "_count": {
      "id": 555372
    },
    "wasSubmitted": false,
    "wasBlocked": true,
    "candidateSource": "runtime_automated"
  },
  {
    "_count": {
      "id": 696
    },
    "wasSubmitted": true,
    "wasBlocked": false,
    "candidateSource": "runtime_automated"
  }
]
```

### Loader-visible ShadowCandidate counts
- last 1h: **0**
- last 24h: **696**
- runtime_automated rows in 24h with **null** `orderIntentId` (typical guardrail-pre-intent shadow): **0**
- loader-visible in 24h with non-null `orderIntentId`: **696**

## 3. Per-cohort path classification (newest sample of intents)
- Sample: **newest 600** runtime_automated intents in last 24h (cap 600; total in window: **63401**).
- Outcome definitions:
  - **loader_visible_submission_path** — timeline contains `READY_FOR_RECONCILIATION` (same handler path that calls `recordShadowCandidate` with wasSubmitted=true).
  - **policy_blocked_after_ledger** — contains `EXECUTION_POLICY_BLOCKED`.
  - **policy_passed_no_ready_event** — has `EXECUTION_POLICY_PASSED` but no `READY_FOR_RECONCILIATION` (abnormal / partial failure).
  - **ledger_created_only** — only `CREATED` (or unknown types) and no policy terminal events.
  - **empty_timeline** — no events (data issue).

| outcome | count in sample |
| --- | ---: |
| loader_visible_submission_path | 59 |
| policy_blocked_after_ledger | 541 |
| policy_passed_no_ready_event | 0 |
| ledger_created_only | 0 |
| empty_timeline | 0 |

### EXECUTION_POLICY_BLOCKED reason codes (24h events, up to 5000 rows)
```json
[
  [
    "exposure:single_market_concentration_breach; single_theme_concentration_breach",
    3691
  ],
  [
    "operational:runtime_safety_blocked",
    1281
  ],
  [
    "operational:runtime_safety_blocked; exchange_truth_unavailable",
    28
  ],
  [
    "freshness:user_data_stale",
    14
  ]
]
```

### Blocked ShadowCandidate `terminalAttribution.stage` (24h, up to 2000 rows)
```json
{
  "execution_policy": 1941,
  "runtime_guardrails": 59
}
```

## 4. Verification: any loader-visible row?
- **Any in last 24h:** yes (count 696)
```json
{
  "id": "cmnemsle72w5du73oxewtjqrs",
  "createdAt": "2026-03-31T13:06:55.952Z",
  "orderIntentId": "cmnemsl5b2w4hu73ocwrjgq2j",
  "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
  "wasSubmitted": true,
  "wasBlocked": false
}
```

## 5. Dominant blocker & conclusion
- **Dominant blocker (heuristic):** shadow telemetry gate (env)
- **Top EXECUTION_POLICY_BLOCKED reason:** `exposure:single_market_concentration_breach; single_theme_concentration_breach` (3691 in aggregated policy-block events)
- **Top blocked shadow terminal stage:** `execution_policy` (1941 in recent blocked shadow snapshots)
- **Blunt conclusion:** SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1 — new runtime_automated shadow rows are skipped; last 1h loader-visible count is 0 while 24h still shows older rows. Restart worker with env=0 to resume persistence.

## 6. JSON summary
```json
{
  "generatedAt": "2026-03-31T23:02:33.031Z",
  "shadowWriteDisabled": true,
  "intentCount1h": 3049,
  "intentCount24h": 63401,
  "readyForReconciliationDistinctIntents24h": 2247,
  "eventHist1h": [
    {
      "eventType": "CREATED",
      "count": 24243
    },
    {
      "eventType": "EXECUTION_POLICY_BLOCKED",
      "count": 24007
    },
    {
      "eventType": "EXECUTION_POLICY_PASSED",
      "count": 236
    },
    {
      "eventType": "READY_FOR_RECONCILIATION",
      "count": 236
    }
  ],
  "eventHist24h": [
    {
      "eventType": "CREATED",
      "count": 302525
    },
    {
      "eventType": "EXECUTION_POLICY_BLOCKED",
      "count": 299968
    },
    {
      "eventType": "EXECUTION_POLICY_PASSED",
      "count": 2552
    },
    {
      "eventType": "READY_FOR_RECONCILIATION",
      "count": 2552
    }
  ],
  "shadowCombo1h": [],
  "shadowCombo24h": [
    {
      "_count": {
        "id": 28
      },
      "wasSubmitted": false,
      "wasBlocked": false,
      "candidateSource": "paper_trading"
    },
    {
      "_count": {
        "id": 555372
      },
      "wasSubmitted": false,
      "wasBlocked": true,
      "candidateSource": "runtime_automated"
    },
    {
      "_count": {
        "id": 696
      },
      "wasSubmitted": true,
      "wasBlocked": false,
      "candidateSource": "runtime_automated"
    }
  ],
  "loaderVisible1h": 0,
  "loaderVisible24h": 696,
  "shadowRuntimeAutomatedNullOrderIntentId24h": 0,
  "shadowLoaderVisibleWithOrderIntentId24h": 696,
  "sampledIntentPathOutcomes": {
    "loader_visible_submission_path": 59,
    "policy_blocked_after_ledger": 541
  },
  "sampleSize": 600,
  "policyBlockReasonTop": [
    [
      "exposure:single_market_concentration_breach; single_theme_concentration_breach",
      3691
    ],
    [
      "operational:runtime_safety_blocked",
      1281
    ],
    [
      "operational:runtime_safety_blocked; exchange_truth_unavailable",
      28
    ],
    [
      "freshness:user_data_stale",
      14
    ]
  ],
  "blockedShadowTerminalStage": {
    "execution_policy": 1941,
    "runtime_guardrails": 59
  },
  "dominantBlocker": "shadow telemetry gate (env)",
  "bluntConclusion": "SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE=1 — new runtime_automated shadow rows are skipped; last 1h loader-visible count is 0 while 24h still shows older rows. Restart worker with env=0 to resume persistence.",
  "anyLoaderVisibleLast24h": true,
  "newestLoaderVisible": {
    "id": "cmnemsle72w5du73oxewtjqrs",
    "createdAt": "2026-03-31T13:06:55.952Z",
    "orderIntentId": "cmnemsl5b2w4hu73ocwrjgq2j",
    "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
    "wasSubmitted": true,
    "wasBlocked": false
  }
}
```