/**
 * Read-only: compare extreme vs mid price-band pressure (concentration blocks, readiness, markout proxy).
 * Writes diagnostics/v2-extreme-band-pressure-audit.md — no trading/policy/scoring changes.
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { resolveRuntimeIntentRecommendationLink } from "../lib/runtime/intent-recommendation-link";

type Mega = "extreme" | "mid" | "other";
type ExtremeSide = "extreme_low" | "extreme_high";

function lookbackDate(): Date {
  const h = Number(process.env.EXTREME_BAND_AUDIT_LOOKBACK_HOURS ?? "24");
  const hours = Number.isFinite(h) && h > 0 && h <= 720 ? h : 24;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function extremeSide(limitPrice: string | null | undefined): ExtremeSide | null {
  const p = parseNum(limitPrice);
  if (p == null) return null;
  if (p < 0.1) return "extreme_low";
  if (p >= 0.9) return "extreme_high";
  return null;
}

function megaBucket(limitPrice: string | null | undefined): Mega {
  const p = parseNum(limitPrice);
  if (p == null) return "other";
  if (p < 0.1 || p >= 0.9) return "extreme";
  if ((p >= 0.2 && p < 0.3) || (p >= 0.4 && p < 0.6) || (p >= 0.6 && p < 0.8)) return "mid";
  return "other";
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type PolicyBlockPayload = { blockingReasons?: string[] };

function parseBlockingReasons(payloadJson: string | null | undefined): string[] {
  const o = parseJson<PolicyBlockPayload>(payloadJson);
  if (!o?.blockingReasons || !Array.isArray(o.blockingReasons)) return [];
  return o.blockingReasons.filter((x): x is string => typeof x === "string");
}

function expandReasonTokens(reasons: string[]): string[] {
  const out: string[] = [];
  for (const r of reasons) {
    for (const part of r.split(";").map((x) => x.trim()).filter(Boolean)) {
      out.push(part);
    }
  }
  return out;
}

function tokenHasMarketConc(t: string): boolean {
  const s = t.toLowerCase();
  return s.includes("single_market_concentration") || s.includes("market_concentration_breach");
}

function tokenHasThemeConc(t: string): boolean {
  const s = t.toLowerCase();
  return s.includes("single_theme_concentration") || s.includes("theme_concentration_breach");
}

function hasConcentrationToken(payloadJson: string | null | undefined): boolean {
  const tokens = expandReasonTokens(parseBlockingReasons(payloadJson));
  return tokens.some(tokenHasMarketConc) || tokens.some(tokenHasThemeConc);
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

type RecoSig = { theme: string; category: string };

type IntentMini = {
  id: string;
  limitPrice: string;
  marketId: string;
  recommendationId: string | null;
  funderAddress: string;
  outcome: string;
  metadataJson: string | null;
};

function resolverCacheKey(i: IntentMini): string {
  return JSON.stringify([
    i.funderAddress.toLowerCase().trim(),
    i.marketId?.trim() ?? "",
    i.outcome?.trim() ?? "",
  ]);
}

async function warmResolver(
  intents: IntentMini[],
  recoById: Map<string, { marketSignal: RecoSig | null }>,
  cache: Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>>
): Promise<void> {
  const pending = new Map<string, IntentMini>();
  for (const intent of intents) {
    const reco = intent.recommendationId ? recoById.get(intent.recommendationId) : undefined;
    const jt = reco?.marketSignal?.theme?.trim() ?? "";
    if (isUsableTheme(jt)) continue;
    const meta = parseLinkage(intent.metadataJson);
    if (isUsableTheme(meta?.theme?.trim())) continue;
    const k = resolverCacheKey(intent);
    if (!cache.has(k)) pending.set(k, intent);
  }
  for (const intent of pending.values()) {
    const k = resolverCacheKey(intent);
    const link = await resolveRuntimeIntentRecommendationLink({
      funderAddress: intent.funderAddress,
      marketId: intent.marketId,
      outcome: intent.outcome,
    });
    cache.set(k, link);
  }
}

function themeFor(
  i: IntentMini,
  recoById: Map<string, { marketSignal: RecoSig | null }>,
  cache: Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>>
): string {
  const reco = i.recommendationId ? recoById.get(i.recommendationId) : undefined;
  const jt = reco?.marketSignal?.theme?.trim() ?? "";
  if (isUsableTheme(jt)) return jt;
  const meta = parseLinkage(i.metadataJson)?.theme?.trim() ?? "";
  if (isUsableTheme(meta)) return meta;
  const link = cache.get(resolverCacheKey(i));
  const rt = link?.theme?.trim() ?? "";
  return isUsableTheme(rt) ? rt : "unknown_theme";
}

type MegaStats = {
  candidates: number;
  eligible: number;
  concBlocks: number;
  ready: number;
  anyPolicyBlock: number;
  markout1hSum: number;
  markout1hN: number;
  markout1hAbsSum: number;
};

function emptyMega(): MegaStats {
  return {
    candidates: 0,
    eligible: 0,
    concBlocks: 0,
    ready: 0,
    anyPolicyBlock: 0,
    markout1hSum: 0,
    markout1hN: 0,
    markout1hAbsSum: 0,
  };
}

type SideStats = { eligible: number; concBlocks: number; ready: number };

function bluntConclusion(args: {
  ext: MegaStats;
  mid: MegaStats;
  low: SideStats;
  high: SideStats;
  totalConc: number;
  /** Share of concentration-block intents (event sample) that fall in extreme mega-bucket */
  concShareExtreme: number;
}):
  | "extreme bands should be capped upstream"
  | "only one extreme side should be capped"
  | "extremes are concentrated but still valuable"
  | "evidence insufficient" {
  const { ext, mid, low, high, totalConc, concShareExtreme } = args;
  const extE = ext.eligible;
  const midE = mid.eligible;
  const extCR = extE > 0 ? ext.concBlocks / extE : 0;
  const midCR = midE > 0 ? mid.concBlocks / midE : 0;
  const extMean = ext.markout1hN > 0 ? ext.markout1hSum / ext.markout1hN : null;
  const midMean = mid.markout1hN > 0 ? mid.markout1hSum / mid.markout1hN : null;

  if (totalConc < 40 || extE < 100 || midE < 100) return "evidence insufficient";

  const ratio = midCR > 0 ? extCR / midCR : extCR > 0 ? 99 : 0;
  const markoutOk = ext.markout1hN >= 20 && mid.markout1hN >= 20;
  const extremeWorseQuality = extMean != null && midMean != null && extMean < midMean - 0.001;

  if (markoutOk && extMean != null && midMean != null && extMean > midMean + 0.002) {
    if (ratio < 1.35 || extCR < 0.12) return "extremes are concentrated but still valuable";
  }

  const lowCR = low.eligible > 0 ? low.concBlocks / low.eligible : 0;
  const highCR = high.eligible > 0 ? high.concBlocks / high.eligible : 0;
  if (low.eligible >= 80 && high.eligible >= 80) {
    if (lowCR > highCR * 1.45 && lowCR > 0.06) return "only one extreme side should be capped";
    if (highCR > lowCR * 1.45 && highCR > 0.06) return "only one extreme side should be capped";
  }

  /** Volume argument: most concentration blocks sit in extremes even when per-eligible rate is only modestly higher. */
  if (totalConc >= 200 && concShareExtreme >= 0.65 && extCR > midCR && extCR >= 0.06) {
    return "extreme bands should be capped upstream";
  }

  if (extCR >= 0.1 && ratio >= 1.25 && (!markoutOk || extremeWorseQuality || extMean == null)) {
    return "extreme bands should be capped upstream";
  }

  if (ratio >= 1.4 && extCR >= 0.08) return "extreme bands should be capped upstream";

  if (markoutOk && extMean != null && midMean != null && extMean > midMean + 0.0015 && ratio < 1.2) {
    return "extremes are concentrated but still valuable";
  }

  return "evidence insufficient";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const since = lookbackDate();
  const lookbackHours = Number(process.env.EXTREME_BAND_AUDIT_LOOKBACK_HOURS ?? "24");
  const EVENT_CAP = Math.min(80_000, Number(process.env.EXTREME_BAND_AUDIT_EVENT_CAP ?? "50000") || 50000);
  const SHADOW_CAP = Math.min(120_000, Number(process.env.EXTREME_BAND_AUDIT_SHADOW_CAP ?? "80000") || 80000);
  const INTENT_BATCH = Math.min(25_000, Number(process.env.EXTREME_BAND_AUDIT_INTENT_BATCH ?? "25000") || 25000);

  const megaShadow = {
    extreme: emptyMega(),
    mid: emptyMega(),
    other: emptyMega(),
  };
  const megaIntent = {
    extreme: emptyMega(),
    mid: emptyMega(),
    other: emptyMega(),
  };
  const sideIntent: Record<ExtremeSide, SideStats> = {
    extreme_low: { eligible: 0, concBlocks: 0, ready: 0 },
    extreme_high: { eligible: 0, concBlocks: 0, ready: 0 },
  };

  const shadows = await prisma.shadowCandidate.findMany({
    where: { candidateSource: "runtime_automated", createdAt: { gte: since } },
    select: {
      intendedPrice: true,
      orderIntentId: true,
      wasSubmitted: true,
      markout1h: true,
    },
    orderBy: { createdAt: "desc" },
    take: SHADOW_CAP,
  });

  for (const s of shadows) {
    const m = megaBucket(s.intendedPrice);
    megaShadow[m].candidates++;
    if (s.orderIntentId) megaShadow[m].eligible++;
    if (s.wasSubmitted && s.markout1h != null && s.markout1h !== "") {
      const mv = parseNum(s.markout1h);
      if (mv != null) {
        megaShadow[m].markout1hSum += mv;
        megaShadow[m].markout1hN++;
        megaShadow[m].markout1hAbsSum += Math.abs(mv);
      }
    }
  }

  let skip = 0;
  for (;;) {
    const batch = await prisma.orderIntent.findMany({
      where: { source: "runtime_automated", createdAt: { gte: since } },
      select: { id: true, limitPrice: true },
      take: INTENT_BATCH,
      skip,
    });
    if (batch.length === 0) break;
    for (const r of batch) {
      const m = megaBucket(r.limitPrice);
      megaIntent[m].eligible++;
      const side = extremeSide(r.limitPrice);
      if (side) sideIntent[side].eligible++;
    }
    skip += batch.length;
    if (batch.length < INTENT_BATCH) break;
  }

  const blockEvents = await prisma.orderIntentEvent.findMany({
    where: {
      eventType: "EXECUTION_POLICY_BLOCKED",
      createdAt: { gte: since },
      orderIntent: { source: "runtime_automated" },
    },
    select: { orderIntentId: true, payloadJson: true },
    orderBy: { createdAt: "desc" },
    take: EVENT_CAP,
  });

  const policyBlockIntentIds = new Set<string>();
  const concIntentIds = new Set<string>();
  for (const ev of blockEvents) {
    policyBlockIntentIds.add(ev.orderIntentId);
    if (hasConcentrationToken(ev.payloadJson)) concIntentIds.add(ev.orderIntentId);
  }

  const readyEvents = await prisma.orderIntentEvent.findMany({
    where: {
      eventType: "READY_FOR_RECONCILIATION",
      createdAt: { gte: since },
      orderIntent: { source: "runtime_automated" },
    },
    select: { orderIntentId: true },
    orderBy: { createdAt: "desc" },
    take: EVENT_CAP,
  });
  const readyIntentIds = new Set(readyEvents.map((e) => e.orderIntentId));

  const intentIdsToLoad = new Set<string>([...policyBlockIntentIds, ...readyIntentIds, ...concIntentIds]);
  const intentRows: IntentMini[] = [];
  const idList = [...intentIdsToLoad];
  const CHUNK = 800;
  for (let i = 0; i < idList.length; i += CHUNK) {
    const chunk = idList.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const rows = await prisma.orderIntent.findMany({
      where: { id: { in: chunk } },
      select: {
        id: true,
        limitPrice: true,
        marketId: true,
        recommendationId: true,
        funderAddress: true,
        outcome: true,
        metadataJson: true,
      },
    });
    intentRows.push(...rows);
  }
  const intentById = new Map(intentRows.map((r) => [r.id, r]));

  for (const id of policyBlockIntentIds) {
    const row = intentById.get(id);
    if (!row) continue;
    const m = megaBucket(row.limitPrice);
    megaIntent[m].anyPolicyBlock++;
  }

  for (const id of concIntentIds) {
    const row = intentById.get(id);
    if (!row) continue;
    const m = megaBucket(row.limitPrice);
    megaIntent[m].concBlocks++;
    const side = extremeSide(row.limitPrice);
    if (side) sideIntent[side].concBlocks++;
  }

  for (const id of readyIntentIds) {
    const row = intentById.get(id);
    if (!row) continue;
    const m = megaBucket(row.limitPrice);
    megaIntent[m].ready++;
    const side = extremeSide(row.limitPrice);
    if (side) sideIntent[side].ready++;
  }

  const totalConc = concIntentIds.size;
  const totalReady = readyIntentIds.size;
  const concExt = megaIntent.extreme.concBlocks;
  const concMid = megaIntent.mid.concBlocks;
  const readyExt = megaIntent.extreme.ready;
  const readyMid = megaIntent.mid.ready;

  const concShareExtreme = totalConc > 0 ? concExt / totalConc : 0;
  const concShareMid = totalConc > 0 ? concMid / totalConc : 0;
  const readyShareExtreme = totalReady > 0 ? readyExt / totalReady : 0;
  const readyShareMid = totalReady > 0 ? readyMid / totalReady : 0;

  const extCRElig = megaIntent.extreme.eligible > 0 ? concExt / megaIntent.extreme.eligible : 0;
  const midCRElig = megaIntent.mid.eligible > 0 ? concMid / megaIntent.mid.eligible : 0;
  const extMeanM = megaShadow.extreme.markout1hN > 0 ? megaShadow.extreme.markout1hSum / megaShadow.extreme.markout1hN : null;
  const midMeanM = megaShadow.mid.markout1hN > 0 ? megaShadow.mid.markout1hSum / megaShadow.mid.markout1hN : null;
  const medAbsExt =
    megaShadow.extreme.markout1hN > 0 ? megaShadow.extreme.markout1hAbsSum / megaShadow.extreme.markout1hN : null;
  const medAbsMid =
    megaShadow.mid.markout1hN > 0 ? megaShadow.mid.markout1hAbsSum / megaShadow.mid.markout1hN : null;

  const qAdjExt =
    medAbsExt != null && medAbsExt > 1e-9 ? extCRElig / medAbsExt : extCRElig > 0 ? extCRElig / 0.01 : 0;
  const qAdjMid =
    medAbsMid != null && medAbsMid > 1e-9 ? midCRElig / medAbsMid : midCRElig > 0 ? midCRElig / 0.01 : 0;
  const qAdjRatio = qAdjMid > 0 ? qAdjExt / qAdjMid : qAdjExt > 0 ? 99 : 0;

  const recIds = [...new Set(intentRows.map((r) => r.recommendationId).filter(Boolean))] as string[];
  const recos = await prisma.recommendation.findMany({
    where: { id: { in: recIds } },
    select: { id: true, marketSignal: { select: { theme: true, category: true } } },
  });
  const recoById = new Map(recos.map((r) => [r.id, r]));

  const resolverCache: Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>> = new Map();
  const concRows = [...concIntentIds].map((id) => intentById.get(id)).filter(Boolean) as IntentMini[];
  await warmResolver(concRows, recoById, resolverCache);

  const themeExt = new Map<string, number>();
  const themeMid = new Map<string, number>();
  const marketExt = new Map<string, number>();
  const marketMid = new Map<string, number>();

  for (const id of concIntentIds) {
    const row = intentById.get(id);
    if (!row) continue;
    const m = megaBucket(row.limitPrice);
    const th = themeFor(row, recoById, resolverCache);
    const mk = row.marketId?.trim() || "unknown_market";
    if (m === "extreme") {
      themeExt.set(th, (themeExt.get(th) ?? 0) + 1);
      marketExt.set(mk, (marketExt.get(mk) ?? 0) + 1);
    } else if (m === "mid") {
      themeMid.set(th, (themeMid.get(th) ?? 0) + 1);
      marketMid.set(mk, (marketMid.get(mk) ?? 0) + 1);
    }
  }

  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const blunt = bluntConclusion({
    ext: {
      ...megaIntent.extreme,
      candidates: megaShadow.extreme.candidates,
      markout1hSum: megaShadow.extreme.markout1hSum,
      markout1hN: megaShadow.extreme.markout1hN,
      markout1hAbsSum: megaShadow.extreme.markout1hAbsSum,
    },
    mid: {
      ...megaIntent.mid,
      candidates: megaShadow.mid.candidates,
      markout1hSum: megaShadow.mid.markout1hSum,
      markout1hN: megaShadow.mid.markout1hN,
      markout1hAbsSum: megaShadow.mid.markout1hAbsSum,
    },
    low: sideIntent.extreme_low,
    high: sideIntent.extreme_high,
    totalConc,
    concShareExtreme,
  });

  const fmt = (s: MegaStats, label: string) => ({
    bucket: label,
    candidates: s.candidates,
    eligible_intents: s.eligible,
    concentration_block_intents: s.concBlocks,
    ready_intents: s.ready,
    any_policy_block_intents: s.anyPolicyBlock,
    block_rate_conc_per_eligible: s.eligible > 0 ? s.concBlocks / s.eligible : 0,
    block_rate_any_policy_per_eligible: s.eligible > 0 ? s.anyPolicyBlock / s.eligible : 0,
    ready_rate_per_eligible: s.eligible > 0 ? s.ready / s.eligible : 0,
    markout1h_mean_submitted_shadow: s.markout1hN > 0 ? s.markout1hSum / s.markout1hN : null,
    markout1h_n_submitted_shadow: s.markout1hN,
    mean_abs_markout1h_submitted: s.markout1hN > 0 ? s.markout1hAbsSum / s.markout1hN : null,
  });

  const lines: string[] = [];
  lines.push("# V2 extreme-band pressure audit (read-only)");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(
    `- Lookback: **${lookbackHours}h** (\`EXTREME_BAND_AUDIT_LOOKBACK_HOURS\`). Caps: blocked events **${EVENT_CAP}**, shadow rows **${SHADOW_CAP}**, intent scan batch **${INTENT_BATCH}**.`
  );
  lines.push("- **Extreme bucket:** `<0.1` ∪ `>=0.9` (limit / intended price).");
  lines.push("- **Mid bucket:** `0.2-0.3` ∪ `0.4-0.6` ∪ `0.6-0.8`.");
  lines.push("- **Other:** `0.1-0.2`, `0.3-0.4`, `0.8-0.9`, unknown — excluded from A vs B headline comparison.");
  lines.push("");
  lines.push("## Definitions");
  lines.push("- **Candidates:** `ShadowCandidate` rows (`candidateSource = runtime_automated`) in window, bucketed by `intendedPrice`.");
  lines.push("- **Eligible intents:** `OrderIntent` rows (`source = runtime_automated`) in window, bucketed by `limitPrice` (reached durable ledger / post-guardrail path).");
  lines.push(
    "- **Concentration-block intents:** distinct intents with `EXECUTION_POLICY_BLOCKED` whose payload mentions market/theme concentration (same token rules as concentration audit)."
  );
  lines.push("- **READY intents:** distinct intents with `READY_FOR_RECONCILIATION` in window (sample capped).");
  lines.push(
    "- **Markout proxy:** mean / mean-abs of `markout1h` on shadow rows with `wasSubmitted=true` in each bucket (sparse; interpret cautiously)."
  );
  lines.push(
    "- **Quality-adjusted pressure:** `conc_block_rate_eligible / mean_abs_markout1h` per bucket (higher = more blocks per unit realized volatility proxy); ratio **extreme/mid** in summary."
  );
  lines.push("");

  lines.push("## A vs B — aggregate table (extreme vs mid)");
  lines.push("");
  lines.push("| Metric | Extreme (<0.1 ∪ >=0.9) | Mid (0.2–0.3, 0.4–0.6, 0.6–0.8) |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Shadow candidates (capped sample) | ${megaShadow.extreme.candidates} | ${megaShadow.mid.candidates} |`);
  lines.push(`| Eligible intents (full scan in window) | ${megaIntent.extreme.eligible} | ${megaIntent.mid.eligible} |`);
  lines.push(`| Concentration-block intents (event sample) | ${megaIntent.extreme.concBlocks} | ${megaIntent.mid.concBlocks} |`);
  lines.push(`| READY intents (event sample) | ${megaIntent.extreme.ready} | ${megaIntent.mid.ready} |`);
  lines.push(`| Conc block / eligible | ${(extCRElig * 100).toFixed(2)}% | ${(midCRElig * 100).toFixed(2)}% |`);
  lines.push(
    `| Any EXECUTION_POLICY_BLOCKED / eligible | ${megaIntent.extreme.eligible > 0 ? ((megaIntent.extreme.anyPolicyBlock / megaIntent.extreme.eligible) * 100).toFixed(2) : "0"}% | ${megaIntent.mid.eligible > 0 ? ((megaIntent.mid.anyPolicyBlock / megaIntent.mid.eligible) * 100).toFixed(2) : "0"}% |`
  );
  lines.push(`| READY / eligible | ${megaIntent.extreme.eligible > 0 ? ((megaIntent.extreme.ready / megaIntent.extreme.eligible) * 100).toFixed(2) : "0"}% | ${megaIntent.mid.eligible > 0 ? ((megaIntent.mid.ready / megaIntent.mid.eligible) * 100).toFixed(2) : "0"}% |`);
  lines.push(
    `| Mean markout1h (submitted shadow, n) | ${extMeanM != null ? extMeanM.toFixed(5) : "n/a"} (${megaShadow.extreme.markout1hN}) | ${midMeanM != null ? midMeanM.toFixed(5) : "n/a"} (${megaShadow.mid.markout1hN}) |`
  );
  lines.push(
    `| Mean \\|markout1h\\| (submitted) | ${medAbsExt != null ? medAbsExt.toFixed(5) : "n/a"} | ${medAbsMid != null ? medAbsMid.toFixed(5) : "n/a"} |`
  );
  lines.push(`| Quality-adj. conc pressure (conc/eligible ÷ mean\\|markout\\|) | ${qAdjExt.toFixed(2)} | ${qAdjMid.toFixed(2)} |`);
  lines.push("");

  lines.push("## Concentration-block & READY share by mega-bucket");
  lines.push(`- Concentration blocks in sample: **${totalConc}** — extreme share **${(concShareExtreme * 100).toFixed(1)}%**, mid share **${(concShareMid * 100).toFixed(1)}%**.`);
  lines.push(`- READY intents in sample: **${totalReady}** — extreme share **${(readyShareExtreme * 100).toFixed(1)}%**, mid share **${(readyShareMid * 100).toFixed(1)}%**.`);
  lines.push(`- Quality-adj. pressure ratio (extreme / mid): **${qAdjRatio.toFixed(2)}**`);
  lines.push("");

  const dominantFinding =
    `In the blocked-event sample, **${(concShareExtreme * 100).toFixed(1)}%** of concentration blocks are in the extreme mega-bucket vs **${(concShareMid * 100).toFixed(1)}%** in mid; per-eligible concentration-block rate is **${(extCRElig * 100).toFixed(2)}%** (extreme) vs **${(midCRElig * 100).toFixed(2)}%** (mid). ` +
    `READY share by bucket is **${(readyShareExtreme * 100).toFixed(1)}%** extreme / **${(readyShareMid * 100).toFixed(1)}%** mid of sampled READY intents. ` +
    (megaShadow.extreme.markout1hN === 0 && megaShadow.mid.markout1hN === 0
      ? "**Markout1h** was unavailable in the shadow sample for submitted rows, so quality comparison relies on structure (rates + volume share) only."
      : `Mean markout1h (submitted shadow): extreme **${extMeanM?.toFixed(5) ?? "n/a"}**, mid **${midMeanM?.toFixed(5) ?? "n/a"}**.`);

  lines.push("## Dominant finding");
  lines.push(dominantFinding);
  lines.push("");

  lines.push("## Extreme split: `<0.1` vs `>=0.9` (intent-level)");
  lines.push("| Side | Eligible | Conc blocks | READY | Conc / eligible |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const side of ["extreme_low", "extreme_high"] as const) {
    const s = sideIntent[side];
    const cr = s.eligible > 0 ? s.concBlocks / s.eligible : 0;
    lines.push(
      `| ${side === "extreme_low" ? "<0.1" : ">=0.9"} | ${s.eligible} | ${s.concBlocks} | ${s.ready} | ${(cr * 100).toFixed(2)}% |`
    );
  }
  lines.push("");

  lines.push("## Top themes (concentration-blocked intents only)");
  lines.push("### Extreme bucket");
  lines.push("```json");
  lines.push(JSON.stringify(top(themeExt, 12), null, 2));
  lines.push("```");
  lines.push("### Mid bucket");
  lines.push("```json");
  lines.push(JSON.stringify(top(themeMid, 12), null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## Top markets (concentration-blocked intents only)");
  lines.push("### Extreme bucket");
  lines.push("```json");
  lines.push(JSON.stringify(top(marketExt, 10), null, 2));
  lines.push("```");
  lines.push("### Mid bucket");
  lines.push("```json");
  lines.push(JSON.stringify(top(marketMid, 10), null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## JSON summary (machine-readable)");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        lookbackHours,
        caps: { EVENT_CAP, SHADOW_CAP, INTENT_BATCH },
        extreme: fmt(
          {
            ...megaIntent.extreme,
            candidates: megaShadow.extreme.candidates,
            markout1hSum: megaShadow.extreme.markout1hSum,
            markout1hN: megaShadow.extreme.markout1hN,
            markout1hAbsSum: megaShadow.extreme.markout1hAbsSum,
          },
          "extreme"
        ),
        mid: fmt(
          {
            ...megaIntent.mid,
            candidates: megaShadow.mid.candidates,
            markout1hSum: megaShadow.mid.markout1hSum,
            markout1hN: megaShadow.mid.markout1hN,
            markout1hAbsSum: megaShadow.mid.markout1hAbsSum,
          },
          "mid"
        ),
        shares: {
          concBlockTotalSample: totalConc,
          concShareExtreme,
          concShareMid,
          readyTotalSample: totalReady,
          readyShareExtreme,
          readyShareMid,
        },
        qualityAdjusted: {
          extreme: qAdjExt,
          mid: qAdjMid,
          ratioExtremeOverMid: qAdjRatio,
        },
        extremeSideSplit: sideIntent,
        topThemesConc: { extreme: top(themeExt, 15), mid: top(themeMid, 15) },
        topMarketsConc: { extreme: top(marketExt, 12), mid: top(marketMid, 12) },
        dominantFinding,
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");

  lines.push("## Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-extreme-band-pressure-audit.md");
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
