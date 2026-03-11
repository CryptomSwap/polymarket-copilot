/**
 * Polymarket types and Zod schemas for API responses and normalized sync data.
 */

import { z } from "zod";

// ---- Gamma API (markets) ----

export const gammaMarketSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string().optional().default(""),
  conditionId: z.string().optional(),
  slug: z.string().optional(),
  endDate: z.string().optional(),
  endDateIso: z.string().optional(),
  end_date: z.string().optional(),
  category: z.string().optional(),
  outcomes: z.string().optional(),
  outcomePrices: z.string().optional(),
  clobTokenIds: z.string().optional(),
  closed: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
  active: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
  archived: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
  acceptingOrders: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
  enableOrderBook: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
  volume: z.string().optional(),
  volumeNum: z.number().optional(),
  liquidity: z.string().optional(),
  liquidityNum: z.number().optional(),
  closedTime: z.string().optional(),
  startDate: z.string().optional(),
  start_date: z.string().optional(),
}).passthrough();

export type GammaMarket = z.infer<typeof gammaMarketSchema>;

export const gammaMarketsResponseSchema = z.array(gammaMarketSchema);

// ---- Normalized sync types ----

export const normalizedMarketSchema = z.object({
  conditionId: z.string().nullable(),
  slug: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  endDate: z.string().nullable(),
  category: z.string().nullable(),
  volumeNum: z.number().nullable(),
  liquidityNum: z.number().nullable(),
  raw: z.record(z.unknown()).optional(),
});

export type NormalizedMarket = z.infer<typeof normalizedMarketSchema>;

export const normalizedAssetSchema = z.object({
  tokenId: z.string(),
  outcome: z.string(),
  outcomeIndex: z.number(),
});

export type NormalizedAsset = z.infer<typeof normalizedAssetSchema>;

// ---- CLOB / user data (for validation) ----

export const openOrderSchema = z.object({
  id: z.string(),
  market: z.string(),
  asset_id: z.string(),
  side: z.string(),
  original_size: z.string(),
  size_matched: z.string(),
  price: z.string(),
  status: z.string(),
  outcome: z.string().optional(),
  created_at: z.number().optional(),
});

export type OpenOrderLike = z.infer<typeof openOrderSchema>;

export const tradeSchema = z.object({
  id: z.string(),
  market: z.string(),
  asset_id: z.string(),
  side: z.string(),
  size: z.string(),
  price: z.string(),
  match_time: z.string().optional(),
  last_update: z.string().optional(),
  outcome: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

export type TradeLike = z.infer<typeof tradeSchema>;

// ---- Legacy / compatibility ----

export interface PolymarketMarket {
  id: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  volume?: number;
  liquidity?: number;
  outcomes?: string;
  outcomePrices?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface PolymarketPosition {
  assetId: string;
  size: string;
  side: "BUY" | "SELL";
  avgPrice?: string;
  marketSlug?: string;
  [key: string]: unknown;
}

export interface PolymarketUserBalance {
  balance: string;
  currency: string;
  [key: string]: unknown;
}

export interface PolymarketOrder {
  id: string;
  market: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}
