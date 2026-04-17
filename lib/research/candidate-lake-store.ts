import * as fs from "fs/promises";
import * as path from "path";

import type { PaperDecisionTraceEntry } from "@/lib/paper-trading/decision-trace-types";
import {
  buildCandidateLakePersistedRecordFromTrace,
  type CandidateLakePersistedRecord,
} from "./candidate-lake";

const CANDIDATE_LAKE_PATH = path.join(process.cwd(), "diagnostics", "candidate-lake.ndjson");

function serializeNdjson(records: CandidateLakePersistedRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

export async function appendCandidateLakeRecordsForTick(params: {
  tickAt: Date;
  tickBatchId?: string | null;
  engineBranch: string;
  traces: PaperDecisionTraceEntry[];
  modelRunId?: string | null;
}): Promise<{ path: string; appended: number }> {
  const { tickAt, tickBatchId, engineBranch, traces, modelRunId } = params;
  if (!traces.length) {
    return { path: CANDIDATE_LAKE_PATH, appended: 0 };
  }
  const tickTimestampIso = tickAt.toISOString();
  let tracesWithSourceEconomicsComponents = 0;
  for (const trace of traces) {
    if (trace.sourceEconomicsComponents != null) tracesWithSourceEconomicsComponents++;
  }
  const records = traces.map((trace) =>
    buildCandidateLakePersistedRecordFromTrace({
      trace,
      tickTimestampIso,
      tickBatchId: tickBatchId ?? null,
      engineBranch,
      modelRunId: modelRunId ?? null,
    })
  );
  let recordsWithSourceEconomicsComponentsKey = 0;
  let recordsWithSourceEconomicsComponentsObject = 0;
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(record, "sourceEconomicsComponents")) {
      recordsWithSourceEconomicsComponentsKey++;
      if (record.sourceEconomicsComponents != null) recordsWithSourceEconomicsComponentsObject++;
    }
  }
  await fs.mkdir(path.dirname(CANDIDATE_LAKE_PATH), { recursive: true });
  await fs.appendFile(CANDIDATE_LAKE_PATH, serializeNdjson(records), "utf8");
  console.info("[candidate-lake] append proof", {
    tickTimestampIso,
    engineBranch,
    tracesCount: traces.length,
    tracesWithSourceEconomicsComponents,
    recordsCount: records.length,
    recordsWithSourceEconomicsComponentsKey,
    recordsWithSourceEconomicsComponentsObject,
    writerSchemaTagSample: records[0]?.writerSchemaTag ?? null,
  });
  return { path: CANDIDATE_LAKE_PATH, appended: records.length };
}

/** Append pre-built lake rows (e.g. diagnostics `event_triggered_news`) without trace provenance. */
export async function appendDiagnosticsCandidateLakeRecords(
  records: CandidateLakePersistedRecord[]
): Promise<{ path: string; appended: number }> {
  if (!records.length) {
    return { path: CANDIDATE_LAKE_PATH, appended: 0 };
  }
  await fs.mkdir(path.dirname(CANDIDATE_LAKE_PATH), { recursive: true });
  await fs.appendFile(CANDIDATE_LAKE_PATH, serializeNdjson(records), "utf8");
  console.info("[candidate-lake] diagnostics-only append", {
    appended: records.length,
    writerSchemaTagSample: records[0]?.writerSchemaTag ?? null,
  });
  return { path: CANDIDATE_LAKE_PATH, appended: records.length };
}
