/**
 * Verifies runtime_automated OrderIntent theme/category linkage (stored vs resolver).
 * Writes diagnostics/v2-theme-linkage-verification.md
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { resolveRuntimeIntentRecommendationLink } from "../lib/runtime/intent-recommendation-link";

function lookback(): Date {
  const h = Number(process.env.THEME_LINKAGE_VERIFY_LOOKBACK_HOURS ?? "24");
  const hours = Number.isFinite(h) && h > 0 && h <= 720 ? h : 24;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function parseLinkage(metadataJson: string | null): { theme?: string; category?: string } | null {
  if (!metadataJson?.trim()) return null;
  try {
    const o = JSON.parse(metadataJson) as { linkage?: { theme?: string; category?: string } };
    return o?.linkage && typeof o.linkage === "object" ? o.linkage : null;
  } catch {
    return null;
  }
}

function isUsableTheme(t: string | null | undefined): boolean {
  const s = (t ?? "").trim();
  return s.length > 0 && s !== "unknown_theme";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const since = lookback();
  const hours = Number(process.env.THEME_LINKAGE_VERIFY_LOOKBACK_HOURS ?? "24");
  const SAMPLE = Math.min(12_000, Number(process.env.THEME_LINKAGE_VERIFY_SAMPLE ?? "2500") || 2500);

  const blockedIntentIds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT o.id
    FROM "OrderIntent" o
    INNER JOIN "OrderIntentEvent" e ON e."orderIntentId" = o.id
    WHERE o.source = 'runtime_automated'
      AND o."createdAt" >= ${since}
      AND e."eventType" = 'EXECUTION_POLICY_BLOCKED'
    LIMIT ${SAMPLE * 2}
  `;
  const allowedIntentIds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT o.id
    FROM "OrderIntent" o
    INNER JOIN "OrderIntentEvent" e ON e."orderIntentId" = o.id
    WHERE o.source = 'runtime_automated'
      AND o."createdAt" >= ${since}
      AND e."eventType" = 'READY_FOR_RECONCILIATION'
    LIMIT ${SAMPLE * 2}
  `;

  const takeBlocked = blockedIntentIds.slice(0, SAMPLE).map((r) => r.id);
  const takeAllowed = allowedIntentIds.slice(0, SAMPLE).map((r) => r.id);

  type IntentRow = {
    id: string;
    funderAddress: string;
    marketId: string;
    outcome: string;
    recommendationId: string | null;
    metadataJson: string | null;
    joinTheme: string;
    joinCategory: string;
  };

  async function loadIntents(ids: string[]): Promise<IntentRow[]> {
    if (ids.length === 0) return [];
    const base = await prisma.orderIntent.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        funderAddress: true,
        marketId: true,
        outcome: true,
        recommendationId: true,
        metadataJson: true,
      },
    });
    const recIds = [...new Set(base.map((r) => r.recommendationId).filter(Boolean))] as string[];
    const recMap = new Map<string, { theme: string; category: string }>();
    if (recIds.length > 0) {
      const recs = await prisma.recommendation.findMany({
        where: { id: { in: recIds } },
        select: { id: true, marketSignal: { select: { theme: true, category: true } } },
      });
      for (const r of recs) {
        recMap.set(r.id, {
          theme: r.marketSignal.theme?.trim() ?? "",
          category: r.marketSignal.category?.trim() ?? "",
        });
      }
    }
    return base.map((r) => {
      const ms = r.recommendationId ? recMap.get(r.recommendationId) : undefined;
      return {
        ...r,
        joinTheme: ms?.theme ?? "",
        joinCategory: ms?.category ?? "",
      };
    });
  }

  const blockedRows = await loadIntents(takeBlocked);
  const allowedRows = await loadIntents(takeAllowed);

  type Metrics = {
    n: number;
    storedRecNonNull: number;
    joinThemeUsable: number;
    metadataThemeUsable: number;
    resolverThemeUsable: number;
    effectiveUsable: number;
    unknownShare: number;
    themeCounts: Map<string, number>;
    catCounts: Map<string, number>;
  };

  async function scoreCohort(rows: typeof blockedRows): Promise<Metrics> {
    let storedRecNonNull = 0;
    let joinThemeUsable = 0;
    let metadataThemeUsable = 0;
    let resolverThemeUsable = 0;
    let effectiveUsable = 0;
    const themeCounts = new Map<string, number>();
    const catCounts = new Map<string, number>();
    const resolverCache = new Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>>();

    async function cachedResolve(funder: string, marketId: string, outcome: string) {
      const k = `${funder.toLowerCase().trim()}\0${marketId}\0${outcome}`;
      if (resolverCache.has(k)) return resolverCache.get(k)!;
      const link = await resolveRuntimeIntentRecommendationLink({
        funderAddress: funder,
        marketId,
        outcome,
      });
      resolverCache.set(k, link);
      return link;
    }

    for (const r of rows) {
      if (r.recommendationId) storedRecNonNull++;

      const joinTheme = r.joinTheme;
      if (isUsableTheme(joinTheme)) joinThemeUsable++;

      const meta = parseLinkage(r.metadataJson);
      const metaTheme = meta?.theme?.trim() ?? "";
      if (isUsableTheme(metaTheme) && !isUsableTheme(joinTheme)) metadataThemeUsable++;

      let resTheme = "";
      let resCategory = "";
      const needResolver = !isUsableTheme(joinTheme) && !isUsableTheme(metaTheme);
      if (needResolver) {
        const link = await cachedResolve(r.funderAddress, r.marketId, r.outcome);
        resTheme = link?.theme?.trim() ?? "";
        resCategory = link?.category?.trim() ?? "";
        if (isUsableTheme(resTheme)) resolverThemeUsable++;
      }

      const effectiveTheme =
        isUsableTheme(joinTheme) ? joinTheme : isUsableTheme(metaTheme) ? metaTheme : isUsableTheme(resTheme) ? resTheme : "";

      const joinCat = r.joinCategory;
      const metaCat = meta?.category?.trim() ?? "";
      const effectiveCat =
        joinCat.length > 0 ? joinCat : metaCat.length > 0 ? metaCat : resCategory.length > 0 ? resCategory : "";

      if (effectiveTheme) {
        effectiveUsable++;
        themeCounts.set(effectiveTheme, (themeCounts.get(effectiveTheme) ?? 0) + 1);
        if (effectiveCat) catCounts.set(effectiveCat, (catCounts.get(effectiveCat) ?? 0) + 1);
      }
    }

    const n = rows.length;
    return {
      n,
      storedRecNonNull,
      joinThemeUsable,
      metadataThemeUsable,
      resolverThemeUsable,
      effectiveUsable,
      unknownShare: n > 0 ? 1 - effectiveUsable / n : 1,
      themeCounts,
      catCounts,
    };
  }

  const blockedMetrics = await scoreCohort(blockedRows);
  const allowedMetrics = await scoreCohort(allowedRows);

  const topBlockedThemes = [...blockedMetrics.themeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topAllowedThemes = [...allowedMetrics.themeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topBlockedCats = [...blockedMetrics.catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topAllowedCats = [...allowedMetrics.catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const joinOnlyBlockedPct = blockedMetrics.n > 0 ? blockedMetrics.joinThemeUsable / blockedMetrics.n : 0;
  const effectiveBlockedPct = blockedMetrics.n > 0 ? blockedMetrics.effectiveUsable / blockedMetrics.n : 0;
  const joinOnlyAllowedPct = allowedMetrics.n > 0 ? allowedMetrics.joinThemeUsable / allowedMetrics.n : 0;
  const effectiveAllowedPct = allowedMetrics.n > 0 ? allowedMetrics.effectiveUsable / allowedMetrics.n : 0;
  const unknownJoinBlockedPct = blockedMetrics.n > 0 ? 1 - joinOnlyBlockedPct : 1;
  const unknownJoinAllowedPct = allowedMetrics.n > 0 ? 1 - joinOnlyAllowedPct : 1;

  let blunt: "theme linkage fixed and usable" | "linkage partially fixed" | "linkage still insufficient";
  if (effectiveBlockedPct >= 0.65 && effectiveAllowedPct >= 0.65) blunt = "theme linkage fixed and usable";
  else if (effectiveBlockedPct >= 0.35 || effectiveAllowedPct >= 0.35) blunt = "linkage partially fixed";
  else blunt = "linkage still insufficient";

  const lines: string[] = [];
  lines.push("# V2 theme linkage verification");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Lookback: **${hours}h** (\`THEME_LINKAGE_VERIFY_LOOKBACK_HOURS\`), sample up to **${SAMPLE}** intents per cohort.`);
  lines.push("");
  lines.push("## A. Diagnosis (where linkage was lost)");
  lines.push("- **Emitter:** `DefaultBotRuntime.emitIntentIfNeeded` (`lib/runtime/bot-runtime/bot-runtime.ts`) publishes `order.intent.created` **without** `recommendationId`.");
  lines.push("- **Consumer:** `worker/stream-runtime.ts` persisted `OrderIntent.recommendationId` only from the bus payload → almost always **null**.");
  lines.push("- **Resolver keying:** Runtime `OrderIntent.marketId` is often Polymarket **condition_id** (hex); `MarketSignal` stores that in `conditionId` while `marketId` may be the venue’s other id. `resolveRuntimeIntentRecommendationLink` matches **either** field plus funder (outcome match is case-insensitive).");
  lines.push("- **Repair:** After guardrails, that resolver sets `OrderIntent.recommendationId` and optional `metadataJson.linkage` **without changing** the runtime idempotency key segment (still uses bus `recommendationId` only).");
  lines.push("- **Idempotent reuse:** `lib/execution-ledger/repository.ts` backfills `recommendationId` / `metadataJson` when the same idempotency key is reused.");
  lines.push("");

  lines.push("## B. Metrics: blocked cohort (EXECUTION_POLICY_BLOCKED)");
  lines.push(`- Sample size: **${blockedMetrics.n}**`);
  lines.push(`- **Before fix (join only):** usable theme via \`recommendationId → MarketSignal\`: **${(joinOnlyBlockedPct * 100).toFixed(1)}%** (${blockedMetrics.joinThemeUsable}/${blockedMetrics.n})`);
  lines.push(`- **unknown_theme / missing theme share (join only, before):** **${(unknownJoinBlockedPct * 100).toFixed(1)}%**`);
  lines.push(
    `- **After effective:** join **OR** \`metadataJson.linkage.theme\` **OR** resolver: **${(effectiveBlockedPct * 100).toFixed(1)}%** (${blockedMetrics.effectiveUsable}/${blockedMetrics.n})`
  );
  lines.push(`- \`recommendationId\` non-null: **${blockedMetrics.storedRecNonNull}**`);
  lines.push(`- Usable theme from metadata linkage only (no join): **${blockedMetrics.metadataThemeUsable}**`);
  lines.push(`- Usable theme from resolver only (no join/metadata): **${blockedMetrics.resolverThemeUsable}**`);
  lines.push(`- **unknown_theme share (effective):** **${(blockedMetrics.unknownShare * 100).toFixed(1)}%**`);
  lines.push("");

  lines.push("## C. Metrics: allowed cohort (READY_FOR_RECONCILIATION)");
  lines.push(`- Sample size: **${allowedMetrics.n}**`);
  lines.push(`- **Before fix (join only):** **${(joinOnlyAllowedPct * 100).toFixed(1)}%**`);
  lines.push(`- **unknown_theme / missing (join only, before):** **${(unknownJoinAllowedPct * 100).toFixed(1)}%**`);
  lines.push(`- **After effective:** **${(effectiveAllowedPct * 100).toFixed(1)}%**`);
  lines.push(`- **unknown_theme share (effective):** **${(allowedMetrics.unknownShare * 100).toFixed(1)}%**`);
  lines.push("");

  lines.push("## D. Top themes / categories (effective theme)");
  lines.push("### Blocked — themes");
  lines.push("```json");
  lines.push(JSON.stringify(topBlockedThemes, null, 2));
  lines.push("```");
  lines.push("### Allowed — themes");
  lines.push("```json");
  lines.push(JSON.stringify(topAllowedThemes, null, 2));
  lines.push("```");
  lines.push("### Blocked — categories");
  lines.push("```json");
  lines.push(JSON.stringify(topBlockedCats, null, 2));
  lines.push("```");
  lines.push("### Allowed — categories");
  lines.push("```json");
  lines.push(JSON.stringify(topAllowedCats, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## E. Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");

  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        lookbackHours: hours,
        sampleCap: SAMPLE,
        blocked: {
          n: blockedMetrics.n,
          joinThemeUsablePct: joinOnlyBlockedPct,
          effectiveThemeUsablePct: effectiveBlockedPct,
          unknownThemeShareEffective: blockedMetrics.unknownShare,
          storedRecommendationIdCount: blockedMetrics.storedRecNonNull,
        },
        allowed: {
          n: allowedMetrics.n,
          joinThemeUsablePct: joinOnlyAllowedPct,
          effectiveThemeUsablePct: effectiveAllowedPct,
          unknownThemeShareEffective: allowedMetrics.unknownShare,
          storedRecommendationIdCount: allowedMetrics.storedRecNonNull,
        },
        topThemesBlocked: topBlockedThemes,
        topThemesAllowed: topAllowedThemes,
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-theme-linkage-verification.md");
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
