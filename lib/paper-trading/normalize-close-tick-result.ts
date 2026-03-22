/**
 * PaperTradingState.lastCloseTickResultJson may be legacy `{ closed, errors }` or full ClosePaperTradesAt12hResult.
 * Diagnostics and reports use this so dueCount / samples are visible for both shapes.
 */

export interface NormalizedCloseTickResult {
  /** True when persisted payload predates ClosePaperTradesAt12hResult (no dueCount / openTotalCount). */
  legacyShape: boolean;
  /** Unparseable JSON stored as { raw: string } on diagnostics parse failure. */
  parseFailed: boolean;
  openTotalCount: number | null;
  dueCount: number | null;
  closed: number | null;
  closedWithMarkout: number | null;
  closedWithoutMarkout: number | null;
  closeReasonCounts: Record<string, unknown> | null;
  /** First errors for display (prefers errorSample, else errors[].slice) */
  errorSample: string[];
  /** Length of errors array when present */
  errorsTotal: number | null;
}

export function normalizeCloseTickResult(
  parsed: Record<string, unknown> | null | undefined
): NormalizedCloseTickResult {
  const empty: NormalizedCloseTickResult = {
    legacyShape: false,
    parseFailed: false,
    openTotalCount: null,
    dueCount: null,
    closed: null,
    closedWithMarkout: null,
    closedWithoutMarkout: null,
    closeReasonCounts: null,
    errorSample: [],
    errorsTotal: null,
  };
  if (!parsed) return empty;
  if (typeof parsed.raw === "string" && !("closed" in parsed) && !("dueCount" in parsed)) {
    return {
      ...empty,
      parseFailed: true,
      errorSample: ["lastCloseTickResultJson could not be parsed as JSON"],
    };
  }

  const closed = typeof parsed.closed === "number" ? parsed.closed : null;
  const errors = Array.isArray(parsed.errors) ? (parsed.errors as string[]) : [];
  const hasNewShape =
    typeof parsed.dueCount === "number" ||
    typeof parsed.openTotalCount === "number" ||
    typeof parsed.closedWithMarkout === "number" ||
    typeof parsed.horizonMs === "number" ||
    typeof parsed.runAt === "string";

  const legacyShape = !hasNewShape && (errors.length > 0 || closed !== null);

  /** Legacy loop: each due trade either closed++ or errors.push — no mixed? Old code only had those paths. */
  const dueCountInferred =
    legacyShape && closed !== null ? closed + errors.length : null;

  const dueCount =
    typeof parsed.dueCount === "number" ? parsed.dueCount : dueCountInferred ?? null;

  const errorSample = Array.isArray(parsed.errorSample)
    ? (parsed.errorSample as string[])
    : errors.slice(0, 5);

  return {
    legacyShape,
    parseFailed: false,
    openTotalCount: typeof parsed.openTotalCount === "number" ? parsed.openTotalCount : null,
    dueCount,
    closed,
    closedWithMarkout: typeof parsed.closedWithMarkout === "number" ? parsed.closedWithMarkout : null,
    closedWithoutMarkout:
      typeof parsed.closedWithoutMarkout === "number" ? parsed.closedWithoutMarkout : null,
    closeReasonCounts:
      parsed.closeReasonCounts && typeof parsed.closeReasonCounts === "object" && parsed.closeReasonCounts !== null
        ? (parsed.closeReasonCounts as Record<string, unknown>)
        : null,
    errorSample,
    errorsTotal:
      typeof parsed.errorsTotal === "number"
        ? parsed.errorsTotal
        : errors.length > 0
          ? errors.length
          : null,
  };
}
