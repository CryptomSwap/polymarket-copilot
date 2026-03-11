/**
 * Heuristic classification of markets into category and theme for portfolio analytics.
 * TODO: Recommendation engine can plug in richer taxonomy later.
 */

export type MarketCategory = "commodities" | "geopolitics" | "politics" | "crypto" | "other";

const CATEGORY_PATTERNS: Array<{ category: MarketCategory; patterns: RegExp[] }> = [
  {
    category: "commodities",
    patterns: [
      /oil\b/i,
      /crude/i,
      /brent/i,
      /\bwti\b/i,
      /barrel/i,
      /commodit/i,
    ],
  },
  {
    category: "geopolitics",
    patterns: [
      /iran/i,
      /israel/i,
      /strike/i,
      /supreme\s*leader/i,
      /successor/i,
      /nuclear/i,
      /gaza/i,
      /ukraine/i,
      /russia/i,
      /nato/i,
    ],
  },
  {
    category: "politics",
    patterns: [
      /trump/i,
      /election/i,
      /president/i,
      /senate/i,
      /\bhouse\b/i,
      /congress/i,
      /republican/i,
      /democrat/i,
      /vote/i,
      /inaugur/i,
    ],
  },
  {
    category: "crypto",
    patterns: [
      /\bbtc\b/i,
      /bitcoin/i,
      /\beth\b/i,
      /ethereum/i,
      /\bsol\b/i,
      /solana/i,
      /crypto/i,
      /token/i,
    ],
  },
];

/**
 * Classify market title into category (commodities, geopolitics, politics, crypto, other).
 */
export function classifyCategory(title: string): MarketCategory {
  const t = title.trim();
  if (!t) return "other";
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((p) => p.test(t))) return category;
  }
  return "other";
}

/**
 * Derive a short theme string for grouping (e.g. "Oil", "Trump 2024", "BTC").
 * Uses first matching category keyword or a truncated title segment.
 */
export function deriveTheme(title: string, category: MarketCategory): string {
  const t = title.trim();
  if (!t) return "Other";

  if (category === "commodities") return "Commodities";
  if (category === "crypto") {
    if (/\bbtc\b|bitcoin/i.test(t)) return "Bitcoin";
    if (/\beth\b|ethereum/i.test(t)) return "Ethereum";
    if (/\bsol\b|solana/i.test(t)) return "Solana";
    return "Crypto";
  }
  if (category === "politics") {
    if (/trump/i.test(t)) return "Trump";
    if (/election|president/i.test(t)) return "Election";
    return "Politics";
  }
  if (category === "geopolitics") {
    if (/iran/i.test(t)) return "Iran";
    if (/israel|gaza/i.test(t)) return "Israel/Gaza";
    if (/ukraine|russia/i.test(t)) return "Ukraine/Russia";
    return "Geopolitics";
  }

  // Other: use first significant words (max 3)
  const words = t.split(/\s+/).filter((w) => w.length > 2).slice(0, 3);
  return words.length ? words.join(" ") : "Other";
}
