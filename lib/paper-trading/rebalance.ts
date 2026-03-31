/**
 * Per-bot maxOpenTotal overflow: deterministic selection + shared close pipeline (`closeOpenPaperTradeRows`).
 */

import type { PrismaClient } from "@prisma/client";
import { getPaperTradingConfig } from "./config";
import type { EffectiveBotProfile } from "./bot-profiles";
import {
  closeOpenPaperTradeRows,
  type PaperTradeCloseRow,
} from "./paper-trade-close-open-rows";

/** Same string as `metadataJson.paperClose.closeReason` / `closeReasonCode` for cap rebalance closes. */
export const REBALANCE_CAP_CLOSE_REASON = "rebalance_cap_adjustment";

/** Parsed admission score for tooling; null when absent from metadata. */
export function tryParseAdmissionScoreFromMetadata(metadataJson: string | null): number | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const cal = o.paperShadowScoreCalibration as Record<string, unknown> | undefined;
    const adm = cal?.admissionScore;
    if (typeof adm === "number" && Number.isFinite(adm)) return adm;
  } catch {
    /* ignore */
  }
  return null;
}

function admissionScoreForRebalanceSort(metadataJson: string | null, rowScore: number): number {
  const adm = tryParseAdmissionScoreFromMetadata(metadataJson);
  if (adm != null) return adm;
  return Number.isFinite(rowScore) ? rowScore : 0;
}

/**
 * Per-bot cap for rebalance/debug, aligned with multi-bot admission in `engine.ts`
 * (`maxOpenTotal > 0` gates opens). Uses {@link getEffectiveBotProfiles} merge
 * (`p.maxOpenTotal ?? global`). Effective value `0` means no cap (unlimited) for that bot —
 * must not fall back to global (legacy bug fix).
 */
export function resolveEffectiveRebalanceOpenCapForBot(
  botType: string,
  effectiveProfiles: EffectiveBotProfile[],
  globalCap: number
): number {
  const p = effectiveProfiles.find((x) => x.botType === botType);
  if (p) return p.maxOpenTotal;
  return globalCap;
}

export type RebalanceOpenRow = PaperTradeCloseRow & { createdAt: Date };

export type RebalanceDebugPerBot = {
  botType: string;
  maxOpenTotal: number;
  currentOpen: number;
  overflow: number;
  candidateTrades: Array<{
    id: string;
    admissionScore: number | null;
    rowScore: number;
    createdAt: string;
  }>;
};

/**
 * Read-only plan for tooling: who would be closed if rebalance ran now (no DB writes).
 */
export async function computeRebalanceDebugSnapshot(params: {
  prisma: PrismaClient;
  effectiveProfiles: EffectiveBotProfile[];
}): Promise<{
  generatedAt: string;
  globalMaxOpenTotal: number;
  perBot: RebalanceDebugPerBot[];
}> {
  const cfg = getPaperTradingConfig();
  const globalCap = cfg.maxOpenTotal > 0 ? cfg.maxOpenTotal : 0;

  const openRows = await params.prisma.paperTrade.findMany({
    where: { status: "open" },
    select: {
      id: true,
      botType: true,
      marketId: true,
      assetId: true,
      side: true,
      entryPrice: true,
      entryTime: true,
      metadataJson: true,
      status: true,
      score: true,
      createdAt: true,
    },
  });

  const byBotGroups = new Map<string, RebalanceOpenRow[]>();
  for (const r of openRows) {
    const row: RebalanceOpenRow = {
      id: r.id,
      botType: r.botType,
      marketId: r.marketId,
      assetId: r.assetId,
      side: r.side,
      entryPrice: r.entryPrice,
      entryTime: r.entryTime,
      metadataJson: r.metadataJson,
      status: r.status,
      score: r.score,
      createdAt: r.createdAt,
    };
    const list = byBotGroups.get(r.botType) ?? [];
    list.push(row);
    byBotGroups.set(r.botType, list);
  }

  const perBot: RebalanceDebugPerBot[] = [];

  byBotGroups.forEach((rows) => {
    const botType = rows[0]!.botType;
    const cap = resolveEffectiveRebalanceOpenCapForBot(
      botType,
      params.effectiveProfiles,
      globalCap
    );
    if (cap <= 0 || rows.length <= cap) {
      perBot.push({
        botType,
        maxOpenTotal: cap,
        currentOpen: rows.length,
        overflow: 0,
        candidateTrades: [],
      });
      return;
    }
    const overflow = rows.length - cap;
    const sorted = [...rows].sort((a, b) => {
      const sa = admissionScoreForRebalanceSort(a.metadataJson, a.score ?? NaN);
      const sb = admissionScoreForRebalanceSort(b.metadataJson, b.score ?? NaN);
      if (sa !== sb) return sa - sb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const chosen = sorted.slice(0, overflow);
    perBot.push({
      botType,
      maxOpenTotal: cap,
      currentOpen: rows.length,
      overflow,
      candidateTrades: chosen.map((t) => ({
        id: t.id,
        admissionScore: tryParseAdmissionScoreFromMetadata(t.metadataJson),
        rowScore: t.score ?? NaN,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  });

  const seen = new Set(perBot.map((p) => p.botType));
  for (const p of params.effectiveProfiles) {
    if (seen.has(p.botType)) continue;
    seen.add(p.botType);
    const cap = p.maxOpenTotal;
    perBot.push({
      botType: p.botType,
      maxOpenTotal: cap,
      currentOpen: 0,
      overflow: 0,
      candidateTrades: [],
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    globalMaxOpenTotal: cfg.maxOpenTotal,
    perBot: perBot.sort((a, b) => a.botType.localeCompare(b.botType)),
  };
}

/**
 * Close overflow opens per bot using {@link closeOpenPaperTradeRows} (same path as hold-due closes).
 * Each bot batch is isolated in try/catch so one failure does not abort others.
 *
 * @param effectiveProfiles — Typically {@link getEffectiveBotProfiles} (same cap source as admission).
 */
export async function rebalanceBotCapOverflow(params: {
  prisma: PrismaClient;
  effectiveProfiles: EffectiveBotProfile[];
  now?: Date;
}): Promise<{
  actions: Array<{ botType: string; overflow: number; closedTradeIds: string[] }>;
  errors: string[];
}> {
  const now = params.now ?? new Date();
  const errors: string[] = [];
  const actions: Array<{ botType: string; overflow: number; closedTradeIds: string[] }> = [];

  const cfg = getPaperTradingConfig();
  const globalCap = cfg.maxOpenTotal > 0 ? cfg.maxOpenTotal : 0;

  let openRows: RebalanceOpenRow[];
  try {
    const rows = await params.prisma.paperTrade.findMany({
      where: { status: "open" },
      select: {
        id: true,
        botType: true,
        marketId: true,
        assetId: true,
        side: true,
        entryPrice: true,
        entryTime: true,
        metadataJson: true,
        status: true,
        score: true,
        createdAt: true,
      },
    });
    openRows = rows.map((r) => ({
      id: r.id,
      botType: r.botType,
      marketId: r.marketId,
      assetId: r.assetId,
      side: r.side,
      entryPrice: r.entryPrice,
      entryTime: r.entryTime,
      metadataJson: r.metadataJson,
      status: r.status,
      score: r.score,
      createdAt: r.createdAt,
    }));
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return { actions, errors };
  }

  const byBotGroups = new Map<string, RebalanceOpenRow[]>();
  for (const r of openRows) {
    const list = byBotGroups.get(r.botType) ?? [];
    list.push(r);
    byBotGroups.set(r.botType, list);
  }

  const MS_PER_H = 60 * 60 * 1000;

  const botEntries = Array.from(byBotGroups.entries());

  for (const [, rows] of botEntries) {
    const botType = rows[0]!.botType;
    const cap = resolveEffectiveRebalanceOpenCapForBot(
      botType,
      params.effectiveProfiles,
      globalCap
    );
    if (cap <= 0) continue;
    if (rows.length <= cap) continue;

    const overflow = rows.length - cap;
    const sorted = [...rows].sort((a, b) => {
      const sa = admissionScoreForRebalanceSort(a.metadataJson, a.score ?? NaN);
      const sb = admissionScoreForRebalanceSort(b.metadataJson, b.score ?? NaN);
      if (sa !== sb) return sa - sb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const toClose: PaperTradeCloseRow[] = sorted.slice(0, overflow).map((r) => ({
      id: r.id,
      botType: r.botType,
      marketId: r.marketId,
      assetId: r.assetId,
      side: r.side,
      entryPrice: r.entryPrice,
      entryTime: r.entryTime,
      metadataJson: r.metadataJson,
      status: r.status,
      score: r.score,
    }));

    try {
      const loopRes = await closeOpenPaperTradeRows(toClose, now, (t) => {
        const elapsedMs = Math.max(0, now.getTime() - t.entryTime.getTime());
        return {
          holdHours: elapsedMs / MS_PER_H,
          reasonCode: REBALANCE_CAP_CLOSE_REASON,
          closeReason: REBALANCE_CAP_CLOSE_REASON,
        };
      });
      errors.push(...loopRes.errors);
      actions.push({
        botType,
        overflow,
        closedTradeIds: loopRes.closedTradeIds,
      });
    } catch (e) {
      errors.push(
        `rebalance bot=${botType}: ${e instanceof Error ? e.message : String(e)}`
      );
      actions.push({ botType, overflow, closedTradeIds: [] });
    }
  }

  return { actions, errors };
}
