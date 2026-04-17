/**
 * Diagnostics-only: RSS → `event_triggered_news` candidate-lake rows + `event-triggered-news-diagnostics.json`.
 * Run: npx tsx tools/run-event-triggered-news-diagnostics.ts
 */
import "dotenv/config";
import { appendDiagnosticsCandidateLakeRecords } from "@/lib/research/candidate-lake-store";
import {
  runEventTriggeredNewsDiagnosticsCycle,
  writeEventTriggeredNewsDiagnosticsFile,
} from "@/lib/research/event-triggered-news-candidates";
import type { FetchedItem } from "@/lib/news/fetch";

async function main(): Promise<void> {
  const now = new Date();
  const maxRss = Math.min(200, Math.max(10, Number(process.env.DIAGNOSTICS_EVENT_TRIGGERED_NEWS_RSS_CAP ?? "80") || 80));
  const maxMkts = Math.min(
    6000,
    Math.max(200, Number(process.env.DIAGNOSTICS_EVENT_TRIGGERED_NEWS_MARKET_CAP ?? "2500") || 2500)
  );

  let rssOverride: FetchedItem[] | null = null;
  const mock = process.argv.includes("--mock");
  if (mock) {
    rssOverride = [
      {
        url: "https://example.invalid/mock-news-item",
        title: "Mock headline about election market keywords placeholder",
        body: "This is synthetic body text for diagnostics when --mock is passed.",
        summary: null,
        publishedAt: now,
        sourceId: "mock",
        dedupeHash: "mock-etn-item",
        language: "en",
      },
    ];
  }

  const { diagnostics, records } = await runEventTriggeredNewsDiagnosticsCycle({
    now,
    tickBatchId: null,
    tickTimestampIso: now.toISOString(),
    engineBranch: "diagnostics_tool",
    botType: "event_triggered_news_diagnostics",
    maxRssItems: maxRss,
    maxMarkets: maxMkts,
    rssItemsOverride: rssOverride,
  });

  const lake = await appendDiagnosticsCandidateLakeRecords(records);
  const diagPath = await writeEventTriggeredNewsDiagnosticsFile(diagnostics);
  console.log(
    JSON.stringify(
      {
        verdict: diagnostics.verdict,
        effectiveConfig: diagnostics.effectiveConfig,
        rssItemsBySourceId: diagnostics.rssItemsBySourceId,
        totals: diagnostics.totals,
        diagnosticsPath: diagPath,
        candidateLakeAppended: lake.appended,
      },
      null,
      2
    )
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
