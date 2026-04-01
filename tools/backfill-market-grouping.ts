import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { buildEventGroupingMaps } from "../lib/polymarket/markets";

type Row = {
  id: string;
  conditionId: string | null;
  slug: string;
  title: string;
  category: string | null;
  eventId: string | null;
  groupKey: string | null;
  groupTitle: string | null;
};

function normalizeConditionIdLike(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t.startsWith("0x")) return t;
  if (/^[0-9a-f]{64}$/.test(t)) return `0x${t}`;
  return raw;
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function computeGroupStats(rows: Row[]): { groupsFormed: number; avgGroupSize: number; groupsGte2: number; maxGroupSize: number } {
  const by = new Map<string, number>();
  for (const r of rows) {
    const key = r.groupKey?.trim();
    if (!key) continue;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  const sizes = [...by.values()];
  const groupsFormed = sizes.length;
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    groupsFormed,
    avgGroupSize: groupsFormed > 0 ? total / groupsFormed : 0,
    groupsGte2: sizes.filter((x) => x >= 2).length,
    maxGroupSize: sizes.length > 0 ? Math.max(...sizes) : 0,
  };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const rows = (await prisma.syncedMarket.findMany({
    select: {
      id: true,
      conditionId: true,
      slug: true,
      title: true,
      category: true,
      eventId: true,
      groupKey: true,
      groupTitle: true,
    },
    take: 5000,
  })) as Row[];

  const before = computeGroupStats(rows);
  const beforeEventId = rows.filter((r) => !!r.eventId).length;
  const beforeGroupKey = rows.filter((r) => !!r.groupKey).length;

  const grouping = await buildEventGroupingMaps({
    limit: Math.max(1, Number.parseInt(process.env.GROUPING_BACKFILL_EVENTS_LIMIT ?? "200", 10)),
    maxPages: Math.max(1, Number.parseInt(process.env.GROUPING_BACKFILL_EVENTS_MAX_PAGES ?? "50", 10)),
  });

  let updated = 0;
  let matchedByConditionId = 0;
  let matchedBySlug = 0;

  for (const r of rows) {
    const conditionId = normalizeConditionIdLike(r.conditionId);
    const fromCondition = conditionId ? grouping.byConditionId.get(conditionId) : undefined;
    const fromSlug = grouping.bySlug.get(r.slug);
    const meta = fromCondition ?? fromSlug;
    if (!meta) continue;
    if (fromCondition) matchedByConditionId++;
    else if (fromSlug) matchedBySlug++;

    const nextEventId = meta.eventId ?? null;
    const nextGroupKey = meta.groupKey ?? null;
    const nextGroupTitle = meta.groupTitle ?? null;
    if (r.eventId === nextEventId && r.groupKey === nextGroupKey && r.groupTitle === nextGroupTitle) continue;

    await prisma.syncedMarket.update({
      where: { id: r.id },
      data: {
        eventId: nextEventId ?? undefined,
        groupKey: nextGroupKey ?? undefined,
        groupTitle: nextGroupTitle ?? undefined,
      },
    });
    updated++;
  }

  const afterRows = (await prisma.syncedMarket.findMany({
    select: {
      id: true,
      conditionId: true,
      slug: true,
      title: true,
      category: true,
      eventId: true,
      groupKey: true,
      groupTitle: true,
    },
    take: 5000,
  })) as Row[];

  const after = computeGroupStats(afterRows);
  const afterEventId = afterRows.filter((r) => !!r.eventId).length;
  const afterGroupKey = afterRows.filter((r) => !!r.groupKey).length;

  const topGroups = new Map<string, { count: number; sample: string[]; category: string | null }>();
  for (const r of afterRows) {
    const k = r.groupKey?.trim();
    if (!k) continue;
    const cur = topGroups.get(k) ?? { count: 0, sample: [], category: r.category ?? null };
    cur.count++;
    if (cur.sample.length < 3) cur.sample.push(r.title);
    topGroups.set(k, cur);
  }
  const top = [...topGroups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);

  let conclusion = "grouping still insufficient";
  if (after.groupsGte2 > 0 && after.avgGroupSize >= 1.2) conclusion = "grouping fixed and usable";
  else if (afterGroupKey > 0) conclusion = "grouping partially usable";

  const lines: string[] = [];
  lines.push("# Polymarket Grouping Fixed Verification");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("- Source-of-truth grouping endpoint: `https://gamma-api.polymarket.com/events`");
  lines.push("- Fields used from events payload: `id` (eventId), `series[0].id` (group series id), `series[0].title` / `title`");
  lines.push("- Mapping to SyncedMarket: by `markets[].conditionId` first, fallback by market `slug`");
  lines.push("");
  lines.push("## Backfill run");
  lines.push(`- Synced markets scanned: ${rows.length}`);
  lines.push(`- Updated markets: ${updated}`);
  lines.push(`- Matched by conditionId: ${matchedByConditionId}`);
  lines.push(`- Matched by slug fallback: ${matchedBySlug}`);
  lines.push(`- Event fetch errors: ${grouping.errors.length}`);
  lines.push("");
  lines.push("## Before vs after grouping stats");
  lines.push("| metric | before | after |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| markets with eventId | ${beforeEventId} | ${afterEventId} |`);
  lines.push(`| markets with groupKey | ${beforeGroupKey} | ${afterGroupKey} |`);
  lines.push(`| groups formed | ${before.groupsFormed} | ${after.groupsFormed} |`);
  lines.push(`| avg group size | ${fmt(before.avgGroupSize)} | ${fmt(after.avgGroupSize)} |`);
  lines.push(`| groups >=2 | ${before.groupsGte2} | ${after.groupsGte2} |`);
  lines.push(`| max group size | ${before.maxGroupSize} | ${after.maxGroupSize} |`);
  lines.push("");
  lines.push("## Example groups (top 5)");
  lines.push("| groupKey | size | category | sample titles |");
  lines.push("| --- | ---: | --- | --- |");
  for (const [k, v] of top) {
    lines.push(`| ${k.replace(/\|/g, "/")} | ${v.count} | ${(v.category ?? "-").replace(/\|/g, "/")} | ${v.sample.map((s) => s.replace(/\|/g, "/")).join(" ; ")} |`);
  }
  lines.push("");
  lines.push("## Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-grouping-fixed.md");
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

