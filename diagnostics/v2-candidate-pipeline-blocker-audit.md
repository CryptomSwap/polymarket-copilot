# V2 candidate pipeline blocker audit

- Generated: 2026-04-01T15:01:23.870Z
- Read-only: `ScheduledJobRun`, `ScheduledJobLease`, `PaperTradingState`, `MarketSignal`, `Recommendation`, `OrderIntent`, `ShadowCandidate`.
- Telemetry gate: `SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE` = **unset/≠1** — see `lib/shadow-telemetry/record.ts`.
- **Persistence path (live):** submitted intents → `recordShadowCandidate` in `worker/stream-runtime.ts` (e.g. `order.intent.created`) with `wasSubmitted: true`, `candidateSource: runtime_automated`.
- **Recommendations:** `Recommendation` rows (DB) are downstream of `MarketSignal`; `recommendation_recompute` scheduled job materializes them.

## A. Scheduler / trigger stage
### PaperTradingState (id=default)
```json
{
  "lastOpenTickAt": "2026-04-01T15:00:18.799Z",
  "lastOpenTickError": null,
  "updatedAt": "2026-04-01T15:00:26.266Z"
}
```

### ScheduledJobRun (pipeline jobs, last 24h, newest 200 rows total)
- total sampled rows: **200**
- success / failure by job (same window):
```json
{
  "recommendation_recompute": {
    "success": 18,
    "failure": 3
  },
  "decision_recompute": {
    "success": 19,
    "failure": 2
  },
  "position_decision_recompute": {
    "success": 31,
    "failure": 0
  },
  "paper_trading_tick": {
    "success": 64,
    "failure": 1
  },
  "stream_repair": {
    "success": 59,
    "failure": 3
  }
}
```

### Recent `recommendation_recompute` runs (up to 8)
| startedAt | status | durationMs | error |
| --- | --- | ---: | --- |
| 2026-04-01T14:50:16.072Z | success | 286009 |  |
| 2026-04-01T14:35:16.091Z | success | 303518 |  |
| 2026-04-01T14:20:15.972Z | success | 218250 |  |
| 2026-04-01T14:04:25.350Z | failure | 300000 | abandoned_stale_run:300000ms |
| 2026-04-01T13:49:25.295Z | success | 415273 |  |
| 2026-04-01T13:34:25.302Z | success | 354838 |  |
| 2026-04-01T13:19:24.931Z | success | 333003 |  |
| 2026-04-01T13:04:24.960Z | success | 336161 |  |

### Recent `paper_trading_tick` runs (up to 8)
| startedAt | status | durationMs | error |
| --- | --- | ---: | --- |
| 2026-04-01T15:00:16.955Z | success | 9400 |  |
| 2026-04-01T14:55:16.624Z | success | 13162 |  |
| 2026-04-01T14:50:16.574Z | success | 16891 |  |
| 2026-04-01T14:45:16.275Z | success | 11863 |  |
| 2026-04-01T14:40:16.157Z | success | 10812 |  |
| 2026-04-01T14:35:16.091Z | success | 32354 |  |
| 2026-04-01T14:30:16.027Z | success | 9292 |  |
| 2026-04-01T14:25:16.032Z | success | 7269 |  |

### ScheduledJobLease heartbeats (pipeline jobs)
```json
[
  {
    "jobName": "position_decision_recompute",
    "leasedAt": "2026-04-01T14:55:16.449Z",
    "leaseExpiresAt": "1970-01-01T00:00:00.000Z",
    "lastHeartbeatAt": "2026-04-01T14:55:19.026Z",
    "lastRunId": "cmng63ry03cvo2i5e13l1szhh"
  },
  {
    "jobName": "recommendation_recompute",
    "leasedAt": "2026-04-01T14:50:16.157Z",
    "leaseExpiresAt": "1970-01-01T00:00:00.000Z",
    "lastHeartbeatAt": "2026-04-01T14:55:02.124Z",
    "lastRunId": "cmng5xc8e33r62i5eyycdf4h6"
  },
  {
    "jobName": "decision_recompute",
    "leasedAt": "2026-04-01T14:50:16.073Z",
    "leaseExpiresAt": "1970-01-01T00:00:00.000Z",
    "lastHeartbeatAt": "2026-04-01T14:52:29.195Z",
    "lastRunId": "cmng5xc6533r12i5emcpcmtgh"
  },
  {
    "jobName": "paper_trading_tick",
    "leasedAt": "2026-04-01T15:00:17.002Z",
    "leaseExpiresAt": "1970-01-01T00:00:00.000Z",
    "lastHeartbeatAt": "2026-04-01T15:00:26.722Z",
    "lastRunId": "cmng6a7uv3l5v2i5exp1y3xnl"
  },
  {
    "jobName": "stream_repair",
    "leasedAt": "2026-04-01T15:00:17.002Z",
    "leaseExpiresAt": "2026-04-01T15:07:17.881Z",
    "lastHeartbeatAt": "2026-04-01T15:01:17.881Z",
    "lastRunId": "cmng6a7uv3l5x2i5eddo6ojvx"
  }
]
```

## B. Recommendation generation stage (DB counts)
### MarketSignal.createdAt
| window | count |
| --- | ---: |
| 1 min | 0 |
| 5 min | 0 |
| 15 min | 400 |
| 1 hour | 400 |
| 24 hours | 400 |

### Recommendation.createdAt
| window | count |
| --- | ---: |
| 1 min | 0 |
| 5 min | 0 |
| 15 min | 400 |
| 1 hour | 400 |
| 24 hours | 400 |

### OrderIntent.createdAt (bridge toward runtime / intents)
| window | count |
| --- | ---: |
| 1 min | 48 |
| 5 min | 225 |
| 15 min | 653 |
| 1 hour | 1881 |
| 24 hours | 78001 |

## C. ShadowCandidate persistence (all rows, by time)
| window | any candidateSource / flags |
| --- | ---: |
| 1 min | 96 |
| 5 min | 505 |
| 15 min | 1553 |
| 1 hour | 39667 |
| 24 hours | 308336 |

### Last ShadowCandidate row (global)
```json
{
  "id": "cmng6boy53mk02i5ezw1o36ok",
  "createdAt": "2026-04-01T15:01:25.901Z",
  "candidateSource": "runtime_automated",
  "wasSubmitted": false,
  "wasBlocked": true,
  "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69"
}
```

### groupBy candidateSource (last 1h)
```json
[
  {
    "_count": {
      "id": 39668
    },
    "candidateSource": "runtime_automated"
  }
]
```

### groupBy (wasSubmitted, wasBlocked, candidateSource) — last 1h
```json
[
  {
    "_count": {
      "id": 561
    },
    "wasSubmitted": true,
    "wasBlocked": false,
    "candidateSource": "runtime_automated"
  },
  {
    "_count": {
      "id": 39107
    },
    "wasSubmitted": false,
    "wasBlocked": true,
    "candidateSource": "runtime_automated"
  }
]
```

### Top funderAddress — last 1h (any flags)
```json
[
  {
    "_count": {
      "id": 39668
    },
    "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69"
  }
]
```

## D. Loader-visible subset
Filter: `wasSubmitted=true` AND `wasBlocked=false` AND `candidateSource=runtime_automated`
| window | count |
| --- | ---: |
| 1 min | 0 |
| 5 min | 0 |
| 15 min | 0 |
| 1 hour | 561 |
| 24 hours | 3251 |

- Set `SHADOW_AUDIT_FUNDER` to test whether loader-visible rows exist for the paper tick wallet only.
- same filter, last **24h** (all funders): **3251**
- **top funderAddress** for loader-visible rows (24h):
```json
[
  {
    "_count": {
      "id": 3251
    },
    "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69"
  }
]
```

## E. Blocker classification
- **First empty / failing stage:** E — use blunt conclusion below
- **Blunt conclusion:** **evidence insufficient**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T15:01:23.870Z",
  "shadowWriteDisabled": false,
  "paperTradingState": {
    "lastOpenTickAt": "2026-04-01T15:00:18.799Z",
    "lastOpenTickError": null,
    "updatedAt": "2026-04-01T15:00:26.266Z"
  },
  "scheduledJobSuccessFailure24h": {
    "recommendation_recompute": {
      "success": 18,
      "failure": 3
    },
    "decision_recompute": {
      "success": 19,
      "failure": 2
    },
    "position_decision_recompute": {
      "success": 31,
      "failure": 0
    },
    "paper_trading_tick": {
      "success": 64,
      "failure": 1
    },
    "stream_repair": {
      "success": 59,
      "failure": 3
    }
  },
  "firstFailureStage": "E — use blunt conclusion below",
  "counts": {
    "marketSignal": [
      {
        "label": "1 min",
        "count": 0
      },
      {
        "label": "5 min",
        "count": 0
      },
      {
        "label": "15 min",
        "count": 400
      },
      {
        "label": "1 hour",
        "count": 400
      },
      {
        "label": "24 hours",
        "count": 400
      }
    ],
    "recommendation": [
      {
        "label": "1 min",
        "count": 0
      },
      {
        "label": "5 min",
        "count": 0
      },
      {
        "label": "15 min",
        "count": 400
      },
      {
        "label": "1 hour",
        "count": 400
      },
      {
        "label": "24 hours",
        "count": 400
      }
    ],
    "orderIntent": [
      {
        "label": "1 min",
        "count": 48
      },
      {
        "label": "5 min",
        "count": 225
      },
      {
        "label": "15 min",
        "count": 653
      },
      {
        "label": "1 hour",
        "count": 1881
      },
      {
        "label": "24 hours",
        "count": 78001
      }
    ],
    "shadowAny": [
      {
        "label": "1 min",
        "count": 96
      },
      {
        "label": "5 min",
        "count": 505
      },
      {
        "label": "15 min",
        "count": 1553
      },
      {
        "label": "1 hour",
        "count": 39667
      },
      {
        "label": "24 hours",
        "count": 308336
      }
    ],
    "shadowLoaderVisible": [
      {
        "label": "1 min",
        "count": 0
      },
      {
        "label": "5 min",
        "count": 0
      },
      {
        "label": "15 min",
        "count": 0
      },
      {
        "label": "1 hour",
        "count": 561
      },
      {
        "label": "24 hours",
        "count": 3251
      }
    ]
  },
  "shadowGroupingLast1h": {
    "bySource": [
      {
        "_count": {
          "id": 39668
        },
        "candidateSource": "runtime_automated"
      }
    ],
    "byFlags": [
      {
        "_count": {
          "id": 561
        },
        "wasSubmitted": true,
        "wasBlocked": false,
        "candidateSource": "runtime_automated"
      },
      {
        "_count": {
          "id": 39107
        },
        "wasSubmitted": false,
        "wasBlocked": true,
        "candidateSource": "runtime_automated"
      }
    ],
    "topFunders": [
      {
        "_count": {
          "id": 39668
        },
        "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69"
      }
    ]
  },
  "loaderVisibleLast24h": 3251,
  "shadowAuditFunder1hLoaderVisible": null,
  "loaderVisibleByFunder24h": [
    {
      "_count": {
        "id": 3251
      },
      "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69"
    }
  ],
  "newestShadowCandidate": {
    "id": "cmng6boy53mk02i5ezw1o36ok",
    "createdAt": "2026-04-01T15:01:25.901Z",
    "candidateSource": "runtime_automated",
    "wasSubmitted": false,
    "wasBlocked": true,
    "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69"
  },
  "conclusion": "evidence insufficient"
}
```