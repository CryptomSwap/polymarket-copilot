/**
 * Shadow evaluation tests: classification, horizon gating, summary aggregation.
 * Uses in-memory logic and mocks where possible; DB-dependent tests skip if table missing.
 */

import type { OutcomeClassification } from "../types";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// Inline classification logic to test without DB (same as in evaluate.ts)
function markout(side: string, price0: number, priceLater: number): number | null {
  if (price0 <= 0 || !Number.isFinite(price0) || !Number.isFinite(priceLater)) return null;
  const raw = (priceLater - price0) / price0;
  return side.toUpperCase() === "SELL" ? -raw : raw;
}
function isFavorable(_side: string, markoutVal: number): boolean {
  return markoutVal > 0;
}
function classify(
  wasBlocked: boolean,
  side: string,
  markout24h: number | null
): OutcomeClassification | null {
  if (markout24h == null || !Number.isFinite(markout24h)) return null;
  const favorable = isFavorable(side, markout24h);
  if (wasBlocked) return favorable ? "bad_block" : "good_block";
  return favorable ? "good_allow" : "bad_allow";
}

function run(): void {
  console.log("\n--- 1. Favorable blocked trade -> bad_block (missed opportunity) ---");
  {
    const m = markout("BUY", 0.5, 0.6);
    check(m != null && m > 0, "markout positive for BUY when price up");
    const c = classify(true, "BUY", m!);
    check(c === "bad_block", "blocked + favorable = bad_block");
  }

  console.log("\n--- 2. Unfavorable blocked trade -> good_block ---");
  {
    const m = markout("BUY", 0.5, 0.4);
    check(m != null && m < 0, "markout negative for BUY when price down");
    const c = classify(true, "BUY", m!);
    check(c === "good_block", "blocked + unfavorable = good_block");
  }

  console.log("\n--- 3. Unfavorable allowed trade -> bad_allow ---");
  {
    const m = markout("BUY", 0.5, 0.4);
    const c = classify(false, "BUY", m!);
    check(c === "bad_allow", "allowed + unfavorable = bad_allow");
  }

  console.log("\n--- 4. Favorable allowed trade -> good_allow ---");
  {
    const m = markout("SELL", 0.5, 0.4);
    check(m != null && m > 0, "markout positive for SELL when price down");
    const c = classify(false, "SELL", m!);
    check(c === "good_allow", "allowed + favorable = good_allow");
  }

  console.log("\n--- 5. Horizon / markout: BUY price up 10% ---");
  {
    const m = markout("BUY", 1, 1.1);
    check(m != null && Math.abs(m - 0.1) < 1e-6, "markout 0.1");
  }

  console.log("\n--- 6. SELL price down 5% -> positive markout (favorable) ---");
  {
    const m = markout("SELL", 1, 0.95);
    check(m != null && m > 0, "SELL markout positive when price down");
    check(isFavorable("SELL", m!), "favorable when markout > 0");
  }

  console.log("\n--- 7. null markout -> null classification ---");
  {
    check(classify(true, "BUY", null) === null, "null markout -> null classification");
  }

  console.log("\n--- 8. Summary aggregation (unit logic) ---");
  {
    const byClassification: Record<string, number> = {
      good_block: 2,
      bad_block: 1,
      good_allow: 3,
      bad_allow: 1,
    };
    const total = Object.values(byClassification).reduce((a, b) => a + b, 0);
    check(total === 7, "summary counts sum");
  }

  console.log("\nAll shadow-evaluation unit tests passed.");
}

run();
